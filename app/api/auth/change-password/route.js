import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentAccount } from "@/lib/session";
import { hashPassword, verifyPassword } from "@/lib/auth-crypto";

export async function POST(request) {
  const account = await getCurrentAccount();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { currentPassword, newPassword } = body;
  if (!newPassword || newPassword.length < 8) {
    return NextResponse.json(
      { error: "New password must be at least 8 characters." },
      { status: 400 }
    );
  }

  const db = getDb();
  const full = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(account.id);

  // Skip the current-password check only on a forced first-time reset.
  if (!full.must_change_password) {
    if (!currentPassword || !verifyPassword(currentPassword, full.password_hash, full.password_salt)) {
      return NextResponse.json(
        { error: "Current password is incorrect." },
        { status: 401 }
      );
    }
  }

  const { hash, salt } = hashPassword(newPassword);
  db.prepare(
    `UPDATE accounts SET password_hash = ?, password_salt = ?, must_change_password = 0 WHERE id = ?`
  ).run(hash, salt, account.id);

  return NextResponse.json({ ok: true });
}
