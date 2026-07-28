import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { generateId } from "@/lib/auth-crypto";

// Disable or re-enable a customer account. Disabling immediately
// invalidates all of that account's existing sessions (belt-and-suspenders
// -- lib/authz.js getAccountByToken() also refuses any session for a
// disabled account even if one somehow survives). Admin cannot disable
// their OWN account through this route without a deliberate client-side
// confirmation calling that out explicitly (enforced in the admin UI);
// server-side we still allow it if genuinely intended (an admin might
// legitimately want to disable their own account), but we flag it in the
// response so the client can require the extra confirmation step.
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

  if (typeof body.disabled !== "boolean") {
    return NextResponse.json({ error: '"disabled" (boolean) is required.' }, { status: 400 });
  }

  const db = getDb();
  const target = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(targetId);
  if (!target) {
    return NextResponse.json({ error: "Account not found." }, { status: 404 });
  }

  const nextStatus = body.disabled ? "disabled" : "active";
  const before = { account_status: target.account_status };

  db.exec("BEGIN");
  try {
    db.prepare(`UPDATE accounts SET account_status = ? WHERE id = ?`).run(nextStatus, targetId);
    if (body.disabled) {
      // Invalidate every existing session for this account immediately.
      db.prepare(`DELETE FROM sessions WHERE account_id = ?`).run(targetId);
    }
    db.prepare(
      `INSERT INTO audit_log (id, admin_account_id, target_account_id, action, before_json, after_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      generateId("audit"),
      guard.account.id,
      targetId,
      body.disabled ? "account_disable" : "account_enable",
      JSON.stringify(before),
      JSON.stringify({ account_status: nextStatus }),
      new Date().toISOString()
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const updated = db
    .prepare(`SELECT id, email, account_status FROM accounts WHERE id = ?`)
    .get(targetId);

  return NextResponse.json({
    ok: true,
    account: updated,
    isSelf: targetId === guard.account.id,
  });
}
