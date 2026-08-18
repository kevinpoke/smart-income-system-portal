import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { hashPassword, generateTempPassword, generateId } from "@/lib/auth-crypto";
import { sendEmail } from "@/lib/mailer";

// Simulates the purchase webhook (e.g. JVZoo) that fires when someone buys
// the program. Creates an account with a temp password (if one doesn't
// already exist for that email) and emails the temp password to the buyer.
//
// Real integration: point your payment processor's webhook at this URL and
// map its payload fields to { email, name } below. Add webhook signature
// verification before going live.
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const email = (body.email || "").trim().toLowerCase();
  const name = (body.name || "").trim() || email.split("@")[0];
  // Optional: only used by the Admin Panel's "Simulate JVZoo Purchase" test
  // button so testers can log in with a known password. A real JVZoo
  // payload will never include this field, so it's ignored unless present.
  const requestedPassword = (body.password || "").trim();

  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
  }

  const db = getDb();
  const existing = db.prepare(`SELECT id FROM accounts WHERE email = ?`).get(email);

  if (existing) {
    return NextResponse.json({
      ok: true,
      created: false,
      message: `An account already exists for ${email}. No new account created.`,
    });
  }

  const tempPassword = requestedPassword || generateTempPassword();
  const { hash, salt } = hashPassword(tempPassword);
  const id = generateId("acct");

  db.prepare(
    `INSERT INTO accounts (id, email, name, password_hash, password_salt, must_change_password, role, created_at)
     VALUES (?, ?, ?, ?, ?, 1, 'customer', ?)`
  ).run(id, email, name, hash, salt, new Date().toISOString());

  const subject = "Your Smart Income System Rewards Portal login";
  const text = `Hi ${name},

Thanks for your purchase! Your Smart Income System Rewards Portal account is ready.

Login: ${process.env.APP_URL || "http://localhost:3000"}/login
Email: ${email}
Temporary password: ${tempPassword}

Please log in and change your password from your account settings.

— Smart Income System Team`;

  const mailResult = await sendEmail({ to: email, subject, text });

  return NextResponse.json({
    ok: true,
    created: true,
    accountId: id,
    email,
    // Only included so you can test the flow before SendGrid is wired up.
    // Remove this field once real email delivery is confirmed working.
    devTempPassword: tempPassword,
    emailDelivered: mailResult.delivered,
    emailNote: mailResult.reason || "Sent via SendGrid.",
  });
}
