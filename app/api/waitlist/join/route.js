import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentAccountRaw } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { generateId } from "@/lib/auth-crypto";
import { computeWaitlistStatus } from "@/lib/waitlistEngine";
import { scheduleWaitlistSelectionMessage } from "@/lib/supportAutomation";
import { requestAutomationWake } from "@/lib/automationWake";
import {
  normalizeState,
  isValidStateCode,
  normalizeOtherStateText,
  OTHER_STATE_CODE,
} from "@/lib/locationNormalize";

// BRIDGES-WAITLIST-LOCATION batch: same State/Other validation shape as
// ISP Setup (lib/isp/submit/route.js) -- reused, not reinvented.
function validateLocation(body) {
  if (typeof body.zip !== "string" || body.zip.trim().length < 3 || body.zip.trim().length > 12) {
    return "ZIP / Postal Code looks invalid.";
  }
  const normalizedState = normalizeState(body.state || "");
  const isOther = normalizedState === OTHER_STATE_CODE;
  if (!isOther && !isValidStateCode(normalizedState)) {
    return "State / Region must be a valid US state, or Other.";
  }
  if (isOther && !normalizeOtherStateText(body.stateOther).length) {
    return "Please enter your State / Province / Region / Territory.";
  }
  return null;
}

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

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
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

    // BRIDGES-REDESIGN batch: countdown/deadline gating removed -- anyone
    // may join at any time, so there is no expiry check here anymore.

    const validationError = validateLocation(body);
    if (validationError) {
      db.exec("ROLLBACK");
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const normalizedState = normalizeState(body.state);
    const isOther = normalizedState === OTHER_STATE_CODE;
    const stateOtherText = isOther ? normalizeOtherStateText(body.stateOther) : null;
    const zip = body.zip.trim();

    const now = new Date().toISOString();

    // waitlist_started_at is set alongside waitlist_joined_at (once) purely
    // as a durable record of when the join transaction occurred.
    db.prepare(
      `UPDATE accounts
       SET waitlist_joined_at = COALESCE(waitlist_joined_at, ?),
           waitlist_started_at = COALESCE(waitlist_started_at, ?)
       WHERE id = ?`
    ).run(now, now, account.id);

    // BRIDGES-WAITLIST-LOCATION batch: the waitlist's OWN location record,
    // separate from accounts.isp_city/isp_state (never overwritten here).
    db.prepare(
      `INSERT INTO waitlist_submissions (id, account_id, state, state_is_other, state_other_text, zip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO NOTHING`
    ).run(generateId("wlsub"), account.id, normalizedState, isOther ? 1 : 0, stateOtherText, zip, now);

    // WAITLIST-48H-MESSAGE batch (spec sections D/E/F/G): this is the
    // ONE, explicit "successful new waitlist JOIN action" hook -- fresh
    // was just confirmed NOT already on the waitlist (the 409 branch
    // above), so reaching here always means a genuinely NEW join, never
    // a pre-existing member. Scheduling happens INSIDE this same
    // transaction (scheduleMessage() issues no BEGIN/COMMIT of its own --
    // see lib/supportAutomation.js) so the join write and the message
    // schedule commit atomically together.
    scheduleWaitlistSelectionMessage(db, { accountId: account.id, joinedAtIso: now });

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const updated = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(account.id);
  const status = computeWaitlistStatus(updated);

  // SECOND-LEVEL-TIMING batch: a JOIN_WAITLIST-anchored generic automation
  // (or a DID_NOT_JOIN_WAITLIST state gate on some OTHER automation that
  // might now need to be suppressed) should react promptly -- see
  // lib/automationWake.js. Outside the transaction above (after COMMIT),
  // purely a latency optimization, never required for correctness.
  try {
    requestAutomationWake();
  } catch (err) {
    console.error("[waitlist/join] automation wake request failed:", err);
  }

  return NextResponse.json({ ok: true, status });
}
