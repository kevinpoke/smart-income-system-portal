import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { generateId } from "@/lib/auth-crypto";
import { buildLoginLinkUrl } from "@/lib/loginLink";
import { sendWelcomeEmail } from "@/lib/onboardingMailer";

// PASSWORDLESS-CUSTOMER-LOGIN batch: admin "Reset Login Link" /
// "Reset & Send Login Email" action (spec Parts 14/15). Both share
// this one route -- `sendEmail: true` in the request body opts into
// also sending the updated onboarding/login-access email via Resend
// after resetting; plain "Copy Login Link" (the other route in this
// directory) never touches this route at all, so it can never
// accidentally trigger a send.
//
// Reset semantics: increments login_link_version (same column, same
// mechanism the disable path uses in lib/accountDisable.js) so the
// PREVIOUS link becomes immediately invalid (parseLoginLinkToken's
// version check in lib/loginLinkAccess.js will no longer match) --
// account email/ISP/earnings/modules/enable-disable status are
// completely untouched (a single-column UPDATE, nothing else).
export async function POST(request, { params }) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const { id: targetId } = await params;
  let body = {};
  try {
    body = await request.json();
  } catch {
    // Body is optional -- plain "Reset Login Link" with no email send
    // sends no body at all.
  }
  const alsoSendEmail = body?.sendEmail === true;

  const db = getDb();
  const target = db
    .prepare(`SELECT id, email, role, auth_mode, login_link_version FROM accounts WHERE id = ?`)
    .get(targetId);
  if (!target) {
    return NextResponse.json({ error: "Account not found." }, { status: 404 });
  }
  if (target.auth_mode !== "login_link") {
    // PASSWORDLESS-CUSTOMER-LOGIN batch: durable legacy/new gate (spec
    // Part 2/3) -- resetting/generating a login link for a
    // legacy_password account would create the exact unique login URL
    // spec Part 2 says existing customers must never receive.
    return NextResponse.json({ error: "This account does not use passwordless login links." }, { status: 400 });
  }

  const previousVersion = target.login_link_version;
  const nextVersion = previousVersion + 1;

  db.prepare(`UPDATE accounts SET login_link_version = ? WHERE id = ?`).run(nextVersion, targetId);

  // AUDIT LOGGING (spec Part 16): records the event type only, plus
  // the non-secret before/after version numbers -- never the raw
  // URL/signature for either the old (now-dead) or new link.
  db.prepare(
    `INSERT INTO audit_log (id, admin_account_id, target_account_id, action, before_json, after_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    generateId("audit"),
    guard.account.id,
    targetId,
    "login_link_reset",
    JSON.stringify({ loginLinkVersion: previousVersion }),
    JSON.stringify({ loginLinkVersion: nextVersion }),
    new Date().toISOString()
  );

  const newUrl = buildLoginLinkUrl(targetId, nextVersion);
  if (!newUrl) {
    return NextResponse.json({ error: "Login link signing is not configured." }, { status: 500 });
  }

  if (!alsoSendEmail) {
    return NextResponse.json({ ok: true, url: newUrl });
  }

  const mailResult = await sendWelcomeEmail({
    to: target.email,
    accountId: targetId,
    loginLinkVersion: nextVersion,
  });

  db.prepare(
    `INSERT INTO audit_log (id, admin_account_id, target_account_id, action, before_json, after_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    generateId("audit"),
    guard.account.id,
    targetId,
    "login_link_reset_email_sent",
    null,
    JSON.stringify({ delivered: mailResult.delivered }),
    new Date().toISOString()
  );

  return NextResponse.json({ ok: true, url: newUrl, emailDelivered: mailResult.delivered, emailReason: mailResult.reason });
}
