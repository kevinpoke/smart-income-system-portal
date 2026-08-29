import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { generateId } from "@/lib/auth-crypto";

// Admin-portal batch (Waitlist edit): admin-only editable Waitlist
// Yes/No toggle for the User Management table.
//
// AUTHORITATIVE FIELD: accounts.waitlist_joined_at (see lib/db.js
// ACCOUNT_COLUMNS and lib/waitlistEngine.js#computeWaitlistStatus, the
// existing customer-facing "joined = Boolean(account.waitlist_joined_at)"
// derivation). This route is the ONLY place an ADMIN may write this
// column directly -- the customer's own POST /api/waitlist/join route is
// completely separate and unaffected by this route's existence.
// Per spec: "Do NOT add a new boolean or duplicate waitlist field" --
// this route reads/writes waitlist_joined_at exclusively, exactly the
// same column every other consumer (Support Chat's Waitlist badge via
// lib/supportEngine.js#listConversationsForAdmin's
// `accountWaitlistJoined`, the User Management "waitlist" sort in
// app/api/admin/accounts/route.js, and the customer-facing waitlist
// widget) already reads, so a change here is instantly visible
// everywhere else on the next normal fetch/re-render with zero extra
// synchronization code.
//
// No -> Yes: sets waitlist_joined_at to the CURRENT server timestamp
// (the same authoritative "now" every other timestamp column in this
// app uses -- never a client-supplied date).
// Yes -> No: clears waitlist_joined_at to NULL.
export async function POST(request, { params }) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const { id: targetId } = await params;
  if (typeof targetId !== "string" || !targetId.trim()) {
    return NextResponse.json({ error: "Invalid account id." }, { status: 400 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (typeof body.joined !== "boolean") {
    return NextResponse.json({ error: "joined must be a boolean." }, { status: 400 });
  }

  const db = getDb();
  const target = db
    .prepare(`SELECT id, email, role, waitlist_joined_at FROM accounts WHERE id = ?`)
    .get(targetId);
  if (!target) {
    return NextResponse.json({ error: "Account not found." }, { status: 404 });
  }
  if (target.role !== "customer") {
    return NextResponse.json(
      { error: "Waitlist editing only applies to customer accounts." },
      { status: 400 }
    );
  }

  const before = { waitlistJoinedAt: target.waitlist_joined_at || null };
  const now = new Date().toISOString();
  const newValue = body.joined ? now : null;

  db.exec("BEGIN");
  try {
    db.prepare(`UPDATE accounts SET waitlist_joined_at = ? WHERE id = ?`).run(newValue, targetId);
    db.prepare(
      `INSERT INTO audit_log (id, admin_account_id, target_account_id, action, before_json, after_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      generateId("audit"),
      guard.account.id,
      targetId,
      "admin_waitlist_updated",
      JSON.stringify(before),
      JSON.stringify({ waitlistJoinedAt: newValue }),
      now
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const updated = db.prepare(`SELECT waitlist_joined_at FROM accounts WHERE id = ?`).get(targetId);

  return NextResponse.json({
    ok: true,
    waitlistJoined: Boolean(updated.waitlist_joined_at),
    waitlistJoinedAt: updated.waitlist_joined_at || null,
  });
}
