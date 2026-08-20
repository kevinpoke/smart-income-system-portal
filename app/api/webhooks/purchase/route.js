import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { hashPassword, generateTempPassword, generateId } from "@/lib/auth-crypto";
import { sendEmail } from "@/lib/mailer";

// Phase 4.5 (manual-launch security pass): this route originally simulated
// a public, unauthenticated JVZoo purchase webhook. For initial production
// launch, JVZoo IPN automation is DEFERRED (see Phase 7) and customer
// accounts are created manually by an admin instead, reusing this same
// account-creation logic via the Admin Panel's "Simulate JVZoo Purchase"
// button. Until real webhook signature/HMAC verification is implemented in
// Phase 7, this endpoint MUST stay admin-only -- do NOT remove the
// requireAdmin() guard below or otherwise open this route to unauthenticated
// public requests, or anyone can self-provision an account (and previously
// could read its temp password straight out of the JSON response).
export async function POST(request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

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
