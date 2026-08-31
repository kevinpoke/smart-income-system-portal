import { getDb } from "./db";
import { generateId } from "./auth-crypto";
import { buildLoginLinkUrl } from "./loginLink";

// Phase 7: dedicated transactional mailer for automatic JVZoo onboarding
// welcome emails. Deliberately separate from lib/mailer.js sendEmail()
// (the generic mailer used by the manual admin/simulate-purchase flow),
// because that function's outbox-fallback path persists the FULL email
// body into SQLite as plaintext whenever the provider isn't configured.
//
// Provider: Resend (https://resend.com). Domain smart-income-system.com
// is authenticated in Resend; RESEND_API_KEY is a Sending-access-only,
// domain-restricted production key (never Full Access).
//
// PASSWORDLESS-CUSTOMER-LOGIN batch: this email no longer contains a
// temporary password at all -- customer login is now passwordless via
// a unique, per-account signed login link (see lib/loginLink.js). The
// exact subject/body below (including paragraph spacing) is per
// explicit spec text and must not be altered without a fresh
// confirmation. Every send dynamically inserts THIS customer's own
// unique login link and THIS customer's own registered email -- never
// a shared/universal login URL (spec Part 8/9).
const SUBJECT = "Your Smart Income System Account Is Ready";

function buildWelcomeEmailContent({ email, loginLinkUrl }) {
  const text = `Welcome to the Smart Income System!

Your account setup is complete and is ready to start earning immediately.

You can now log in using your special login link and the email address you registered with.

Your login link is unique to your account. Please do not share it with anyone.

Login Link: ${loginLinkUrl}

Email: ${email}

If you have any trouble logging in, email us at jenny@smart-income-system.com and we’ll help you get access.

Warm Regards,
Jenny`;

  const html = `<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background-color:#0c0c10;font-family:Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0c0c10;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" style="max-width:480px;background-color:#161616;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:32px 32px 8px 32px;">
                <h1 style="color:#ffffff;font-size:20px;margin:0 0 16px 0;">Welcome to the Smart Income System!</h1>
                <p style="color:#B0B0B0;font-size:14px;line-height:1.6;margin:0 0 16px 0;">
                  Your account setup is complete and is ready to start earning immediately.
                </p>
                <p style="color:#B0B0B0;font-size:14px;line-height:1.6;margin:0 0 16px 0;">
                  You can now log in using your special login link and the email address you registered with.
                </p>
                <p style="color:#B0B0B0;font-size:14px;line-height:1.6;margin:0 0 24px 0;">
                  Your login link is unique to your account. Please do not share it with anyone.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px;">
                <table role="presentation" width="100%" style="background-color:#0c0c10;border-radius:8px;border:1px solid rgba(255,255,255,0.1);">
                  <tr>
                    <td style="padding:20px;">
                      <p style="color:#707070;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 4px 0;">Login Link</p>
                      <p style="margin:0 0 16px 0;word-break:break-all;"><a href="${loginLinkUrl}" style="color:#32B5FF;font-size:14px;text-decoration:none;">${loginLinkUrl}</a></p>
                      <p style="color:#707070;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 4px 0;">Email</p>
                      <p style="color:#ffffff;font-size:14px;margin:0;">${email}</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 8px 32px;">
                <p style="color:#B0B0B0;font-size:13px;line-height:1.6;margin:0 0 24px 0;">
                  If you have any trouble logging in, email us at
                  <a href="mailto:jenny@smart-income-system.com" style="color:#32B5FF;text-decoration:none;">jenny@smart-income-system.com</a>
                  and we&rsquo;ll help you get access.
                </p>
                <p style="color:#B0B0B0;font-size:13px;line-height:1.6;margin:0 0 4px 0;">Warm Regards,</p>
                <p style="color:#707070;font-size:13px;margin:0 0 24px 0;">Jenny</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { text, html };
}

// AUDIT/OUTBOX REDACTION (spec Part 16 -- "never log/store the raw
// login URL in audit logs or normal listing APIs"): the outbox record
// kept for the existing admin "Recent Emails" UI intentionally
// redacts the unique login link itself -- only a placeholder is
// stored, exactly mirroring how the previous version of this file
// redacted the one-time temporary password. The link is not a secret
// in the same sense a password is (it can be regenerated any time by
// an admin from the User Management Actions menu), but avoiding a
// second at-rest copy of every customer's live login credential
// keeps this mailer's own outbox honoring the same "no raw link in
// logs/records" discipline as every other new login-link surface in
// this batch.
const LOGIN_LINK_PLACEHOLDER = "[REDACTED — see live email; use Admin > User Management > Copy Login Link to regenerate]";

function buildRedactedOutboxBody({ email }) {
  return `Welcome to the Smart Income System!

Your account setup is complete and is ready to start earning immediately.

You can now log in using your special login link and the email address you registered with.

Your login link is unique to your account. Please do not share it with anyone.

Login Link: ${LOGIN_LINK_PLACEHOLDER}

Email: ${email}

If you have any trouble logging in, email us at jenny@smart-income-system.com and we’ll help you get access.

Warm Regards,
Jenny`;
}

// Sends the JVZoo onboarding welcome email. Returns { delivered: boolean,
// reason?: string }. Never throws -- a delivery failure must never abort
// the caller's already-committed account creation.
//
// `accountId` + `loginLinkVersion` (the account's CURRENT
// login_link_version at send time) are required so this function can
// mint the customer's real unique login link itself -- callers never
// pass a pre-built URL in, which would risk a stale/already-superseded
// link being emailed if something reset the version between account
// creation and this call.
export async function sendWelcomeEmail({ to, accountId, loginLinkVersion }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  const db = getDb();

  const recordOutbox = (sentVia) => {
    db.prepare(
      `INSERT INTO outbox (id, to_email, subject, body, sent_via, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(generateId("mail"), to, SUBJECT, buildRedactedOutboxBody({ email: to }), sentVia, new Date().toISOString());
  };

  const loginLinkUrl = buildLoginLinkUrl(accountId, loginLinkVersion);
  if (!loginLinkUrl) {
    // Fail closed rather than ever sending/recording an email with no
    // (or a broken) login link -- see lib/loginLink.js's production
    // guard on a missing LOGIN_LINK_SECRET.
    recordOutbox("blocked-no-login-link-secret");
    console.log(`[JVZoo onboarding email BLOCKED] to=${to} reason="LOGIN_LINK_SECRET not configured"`);
    return { delivered: false, reason: "Login link signing secret not configured — account created, email not sent." };
  }

  if (!apiKey || !from) {
    recordOutbox("blocked-no-resend");
    console.log(`[JVZoo onboarding email BLOCKED] to=${to} reason="Resend not configured"`);
    return { delivered: false, reason: "Resend not configured — account created, email not sent." };
  }

  const { text, html } = buildWelcomeEmailContent({ email: to, loginLinkUrl });

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        reply_to: from,
        subject: SUBJECT,
        text,
        html,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      recordOutbox("failed-resend");
      console.log(`[JVZoo onboarding email FAILED] to=${to} status=${res.status}`);
      return { delivered: false, reason: `Resend error ${res.status}: ${errBody.slice(0, 300)}` };
    }

    recordOutbox("resend");
    console.log(`[JVZoo onboarding email SENT] to=${to}`);
    return { delivered: true };
  } catch (err) {
    recordOutbox("failed-resend");
    console.log(`[JVZoo onboarding email FAILED] to=${to} error=${err.message}`);
    return { delivered: false, reason: `Resend request failed: ${err.message}` };
  }
}
