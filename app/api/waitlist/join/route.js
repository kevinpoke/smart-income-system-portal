import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentAccountRaw } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { computeWaitlistStatus, waitlistDeadlineMs } from "@/lib/waitlistEngine";

// Customer joins the Nodes waitlist. Account is derived ENTIRELY from the
// authenticated session -- the request body is never read for an account
// id, so a customer cannot join (or read) another customer's waitlist
// state by supplying a different id.
//
// NOTE on auditing: audit_log.admin_account_id is a NOT NULL column that
// is semantically an ADMIN actor id (see app/api/admin/isp/[id]/approve,
// the only other writer of this table). A customer joining their own
// waitlist is a self-service action with no admin actor, so this route
// deliberately does NOT write an audit_log row -- storing the customer's
// own id in a column named admin_account_id would be a semantic
// mislabeling of the audit trail (it would look like an admin acted on
// themselves). Since SQLite can't drop a NOT NULL constraint via ALTER
// TABLE without a full table rebuild, the smallest correct fix is to keep
// audit_log admin-actions-only and skip it here rather than force a
// migration. waitlist_joined_at itself IS the durable, timestamped event
// record for this action (visible to the account owner and, in Phase 5,
// to admins via the customer detail view) -- a generic
// actor_account_id/actor_type audit model can be introduced later if a
// broader customer-action audit trail becomes a requirement.
export async function POST(request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const db = getDb();

  // Wrap the check-then-write in a transaction so a burst of concurrent
  // duplicate-click requests can't race past the NULL check.
  db.exec("BEGIN");
  try {
    const fresh = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(account.id);

    if (fresh.waitlist_joined_at) {
      db.exec("ROLLBACK");
      return NextResponse.json(
        { error: "You have already joined the waitlist." },
        { status: 409 }
      );
    }

    const deadlineMs = waitlistDeadlineMs(fresh.first_login_at);
    if (deadlineMs != null && Date.now() >= deadlineMs) {
      db.exec("ROLLBACK");
      return NextResponse.json(
        { error: "The waitlist has closed for this account." },
        { status: 409 }
      );
    }

    const now = new Date().toISOString();

    // waitlist_started_at is set alongside waitlist_joined_at (once) purely
    // as a durable record of when the join transaction occurred; the
    // countdown itself is always computed from first_login_at per spec.
    db.prepare(
      `UPDATE accounts
       SET waitlist_joined_at = COALESCE(waitlist_joined_at, ?),
           waitlist_started_at = COALESCE(waitlist_started_at, ?)
       WHERE id = ?`
    ).run(now, now, account.id);

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const updated = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(account.id);
  const status = computeWaitlistStatus(updated);

  return NextResponse.json({ ok: true, status });
}
