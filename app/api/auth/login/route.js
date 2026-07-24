import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { verifyPassword } from "@/lib/auth-crypto";
import { createSession } from "@/lib/session";

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";

  if (!email || !password) {
    return NextResponse.json(
      { error: "Email and password are required." },
      { status: 400 }
    );
  }

  const db = getDb();
  const account = db
    .prepare(`SELECT * FROM accounts WHERE email = ?`)
    .get(email);

  if (!account || !verifyPassword(password, account.password_hash, account.password_salt)) {
    return NextResponse.json(
      { error: "Invalid email or password." },
      { status: 401 }
    );
  }

  await createSession(account.id);

  return NextResponse.json({
    account: {
      id: account.id,
      email: account.email,
      name: account.name,
      mustChangePassword: !!account.must_change_password,
      role: account.role,
    },
  });
}
