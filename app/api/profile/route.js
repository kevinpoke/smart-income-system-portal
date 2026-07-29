import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentAccountRaw, toPublicAccount } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";

// Authenticated account's own profile management (first/last name).
// Every write here is scoped to the session's own account id -- there is
// no account id parameter anywhere in this route, so a customer can only
// ever update their own profile, and an admin editing their own profile
// through this same route can only affect their own account too (per
// spec: "Admins may update only their own profile through the profile
// editor unless a separate admin-management action already exists" --
// the existing admin User Management email/balance/disable actions
// remain the only place an admin can touch ANOTHER account).
const MAX_NAME_LENGTH = 80;

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

  const firstName = typeof body.firstName === "string" ? body.firstName.trim() : "";
  const lastName = typeof body.lastName === "string" ? body.lastName.trim() : "";

  if (!firstName) {
    return NextResponse.json({ error: "First name is required." }, { status: 400 });
  }
  if (firstName.length > MAX_NAME_LENGTH || lastName.length > MAX_NAME_LENGTH) {
    return NextResponse.json({ error: "Name is too long." }, { status: 400 });
  }

  const db = getDb();
  db.prepare(`UPDATE accounts SET first_name = ?, last_name = ? WHERE id = ?`).run(
    firstName,
    lastName || null,
    account.id
  );

  const updated = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(account.id);
  return NextResponse.json({ ok: true, account: toPublicAccount(updated) });
}
