import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { generateId } from "@/lib/auth-crypto";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Admin updates a customer's email address. Validates + normalizes
// (trim + lowercase), rejects duplicates (accounts.email is UNIQUE, but
// we check explicitly first for a clean 409 rather than relying on the
// DB constraint to throw), and invalidates that account's existing
// sessions after the change (a customer logged in under the old identity
// should not silently keep using it).
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

  const newEmail = (body.email || "").trim().toLowerCase();
  if (!newEmail || !EMAIL_RE.test(newEmail)) {
    return NextResponse.json({ error: "A valid email address is required." }, { status: 400 });
  }

  const db = getDb();
  const target = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(targetId);
  if (!target) {
    return NextResponse.json({ error: "Account not found." }, { status: 404 });
  }

  const duplicate = db
    .prepare(`SELECT id FROM accounts WHERE email = ? AND id != ?`)
    .get(newEmail, targetId);
  if (duplicate) {
    return NextResponse.json({ error: "That email address is already in use." }, { status: 409 });
  }

  const before = { email: target.email };

  db.exec("BEGIN");
  try {
    db.prepare(`UPDATE accounts SET email = ? WHERE id = ?`).run(newEmail, targetId);
    db.prepare(`DELETE FROM sessions WHERE account_id = ?`).run(targetId);
    db.prepare(
      `INSERT INTO audit_log (id, admin_account_id, target_account_id, action, before_json, after_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      generateId("audit"),
      guard.account.id,
      targetId,
      "email_change",
      JSON.stringify(before),
      JSON.stringify({ email: newEmail }),
      new Date().toISOString()
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const updated = db.prepare(`SELECT id, email FROM accounts WHERE id = ?`).get(targetId);
  return NextResponse.json({ ok: true, account: updated });
}
