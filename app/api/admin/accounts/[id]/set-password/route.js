import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { hashPassword, generateId } from "@/lib/auth-crypto";

// Admin-only "Set Password" action for User Management. Lets an admin
// directly assign a customer's ACTIVE password (distinct from the
// customer's own self-service /api/auth/change-password route, which
// requires knowing the current password -- an admin resetting a locked-out
// customer's password obviously cannot supply that).
//
// Security invariants (mirrors app/api/admin/accounts/[id]/disable and
// .../email exactly -- same isSameOrigin CSRF check, same requireAdmin
// guard, same audit_log insert pattern):
// - same-origin check before any auth/DB work
// - admin-only (requireAdmin rejects logged-out AND non-admin/customer
//   callers, including a customer trying to hit this route for anyone,
//   themselves included -- there is no "customer" path into this route)
// - target account must exist
// - new password validated against the EXACT SAME minimum-length policy
//   used everywhere else in this app (MIN_PASSWORD_LENGTH = 8 -- see
//   app/api/admin/accounts/create, app/api/auth/change-password,
//   components/layout/ProfileModal.js)
// - hashed via the EXACT SAME scrypt-based lib/auth-crypto.js
//   hashPassword() every other account-creation/password-change path
//   uses, with a freshly generated per-account salt (hashPassword()
//   always generates a new random salt) -- there is no second hashing
//   implementation anywhere in this route
// - the plaintext password is never persisted, logged, or echoed back in
//   the JSON response -- only { ok: true } is returned on success
// - must_change_password is explicitly set to 0: the admin is
//   deliberately assigning the ACTIVE password here, not issuing a
//   forced-reset temporary one (that is the separate existing
//   temp-password/webhook flow), so the customer should NOT be prompted
//   to change it again on next login
// - ALL of the target customer's existing sessions are revoked
//   (DELETE FROM sessions WHERE account_id = target) so a session
//   established under the old password stops working immediately; the
//   admin's OWN session is completely untouched since only rows scoped
//   to targetId are ever deleted
// - audit_log records the event with SAFE metadata only (target account
//   id, acting admin id, timestamp) -- before/after JSON deliberately
//   contains no password/hash/salt material, only a static marker
// - nothing else about the target account (balance, modules, ISP
//   status, Bridges/nodes, earnings, JVZoo purchase metadata, Support
//   messages, first_login_at, etc.) is touched by this route
const MIN_PASSWORD_LENGTH = 8;

export async function POST(request, { params }) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const { id: targetId } = await params;
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  const confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : "";

  if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` },
      { status: 400 }
    );
  }
  if (newPassword !== confirmPassword) {
    return NextResponse.json(
      { error: "New password and confirmation do not match." },
      { status: 400 }
    );
  }

  const db = getDb();
  const target = db.prepare(`SELECT id FROM accounts WHERE id = ?`).get(targetId);
  if (!target) {
    return NextResponse.json({ error: "Account not found." }, { status: 404 });
  }

  const { hash, salt } = hashPassword(newPassword);

  db.exec("BEGIN");
  try {
    db.prepare(
      `UPDATE accounts SET password_hash = ?, password_salt = ?, must_change_password = 0 WHERE id = ?`
    ).run(hash, salt, targetId);
    // Revoke every existing session for the TARGET account only -- the
    // admin's own session lives under a different account_id and is
    // never touched by this DELETE.
    db.prepare(`DELETE FROM sessions WHERE account_id = ?`).run(targetId);
    db.prepare(
      `INSERT INTO audit_log (id, admin_account_id, target_account_id, action, before_json, after_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      generateId("audit"),
      guard.account.id,
      targetId,
      "admin_password_reset",
      JSON.stringify({}),
      JSON.stringify({ passwordChanged: true }),
      new Date().toISOString()
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return NextResponse.json({ ok: true });
}
