import { getDb } from "./db";
import { generateId } from "./auth-crypto";

// Phase 7: dedicated transactional mailer for automatic JVZoo onboarding
// welcome emails. Deliberately separate from lib/mailer.js sendEmail()
// (the generic mailer used by the manual admin/simulate-purchase flow),
// because that function's outbox-fallback path persists the FULL email
// body (including a temporary password, when present) into SQLite as
// plaintext whenever the provider isn't configured -- acceptable for the
// existing manual/test flow (admin-only, disposable/test accounts), but
// explicitly NOT acceptable for real automatic customer onboarding per
// Phase 7 requirements ("temporary password must never be persisted in
// SQLite", "must never be written to logs").
//
// Provider: Resend (https://resend.com). Domain smart-income-system.com
// is authenticated in Resend; RESEND_API_KEY is a Sending-access-only,
// domain-restricted production key (never Full Access).
//
// Design (smallest safe change, no new email-management system):
//   - If Resend (RESEND_API_KEY + EMAIL_FROM) is configured, send the
//     real email directly via the Resend API. The plaintext password
//     exists only in memory for the duration of this call and is never
//     written anywhere.
//   - The outbox row recorded for AUDIT PURPOSES (so admins can see that
//     an onboarding email was attempted, matching the existing outbox UI
//     already on /admin) NEVER contains the plaintext password -- only a
//     REDACTED body template with the password placeholder replaced.
//   - If SendGrid is unavailable or the send fails, the account is still
//     retained (the caller in app/api/webhooks/jvzoo/route.js has already
//     committed the account row before calling this), and a REDACTED
//     failure record is written to the outbox for admin review. The
//     temp password is NOT recoverable from this record -- an admin must
//     use the existing "issue a new password" mechanism to grant a fresh
//     one (see Phase 7 report: this app does not yet have a dedicated
//     "resend"/"reset customer password" admin action; that is a
//     follow-up, not built here, per "keep this simple").
const REDACTED_PASSWORD_PLACEHOLDER = "[REDACTED — see live email, never stored]";

function buildWelcomeEmailContent({ email, tempPassword }) {
  const loginUrl = `${process.env.APP_URL || "https://app.smart-income-system.com"}/login`;

  const text = `Welcome to Smart Income System!

Your account has been activated successfully.

LOGIN INFORMATION

Login:
${loginUrl}

Email:
${email}

Temporary Password:
${tempPassword}

For security, please change your temporary password after signing in.

Once you log in for the first time, you'll need to connect your WiFi to the Smart Income System to start generating earnings. Please review our modules to learn more about how you can maximize your earnings for the best results.

Need help?
jenny@smart-income-system.com

— Smart Income System`;

  const html = `<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background-color:#0c0c10;font-family:Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0c0c10;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" style="max-width:480px;background-color:#161616;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:32px 32px 8px 32px;">
                <h1 style="color:#ffffff;font-size:20px;margin:0 0 16px 0;">Welcome to Smart Income System!</h1>
                <p style="color:#B0B0B0;font-size:14px;line-height:1.6;margin:0 0 24px 0;">
                  Your account has been activated successfully.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px;">
                <table role="presentation" width="100%" style="background-color:#0c0c10;border-radius:8px;border:1px solid rgba(255,255,255,0.1);">
                  <tr>
                    <td style="padding:20px;">
                      <p style="color:#707070;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 4px 0;">Login</p>
                      <p style="margin:0 0 16px 0;"><a href="${loginUrl}" style="color:#32B5FF;font-size:14px;text-decoration:none;">${loginUrl}</a></p>
                      <p style="color:#707070;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 4px 0;">Email</p>
                      <p style="color:#ffffff;font-size:14px;margin:0 0 16px 0;">${email}</p>
                      <p style="color:#707070;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 4px 0;">Temporary Password</p>
                      <p style="color:#ffffff;font-size:14px;font-family:monospace;margin:0;">${tempPassword}</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 8px 32px;">
                <p style="color:#B0B0B0;font-size:13px;line-height:1.6;margin:0 0 16px 0;">
                  For security, please change your temporary password after signing in.
                </p>
                <p style="color:#B0B0B0;font-size:13px;line-height:1.6;margin:0 0 16px 0;">
                  Once you log in for the first time, you&rsquo;ll need to connect your WiFi to the Smart Income System to start generating earnings. Please review our modules to learn more about how you can maximize your earnings for the best results.
                </p>
                <p style="color:#B0B0B0;font-size:13px;line-height:1.6;margin:0 0 24px 0;">
                  Need help?<br />
                  <a href="mailto:jenny@smart-income-system.com" style="color:#32B5FF;text-decoration:none;">jenny@smart-income-system.com</a>
                </p>
                <p style="color:#707070;font-size:12px;margin:0 0 24px 0;">— Smart Income System</p>
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

function buildRedactedOutboxBody() {
  return `Welcome to Smart Income System!

Your account has been activated successfully.

LOGIN INFORMATION

Login:
${process.env.APP_URL || "https://app.smart-income-system.com"}/login

Email:
(see accounts table)

Temporary Password:
${REDACTED_PASSWORD_PLACEHOLDER}

— Smart Income System`;
}

const SUBJECT = "Your Smart Income System Account Is Ready";

// Sends the JVZoo onboarding welcome email. Returns { delivered: boolean,
// reason?: string }. Never throws -- a delivery failure must never abort
// the caller's already-committed account creation.
export async function sendWelcomeEmail({ to, tempPassword }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  const db = getDb();

  const recordOutbox = (sentVia) => {
    // ALWAYS the redacted template -- the real tempPassword variable
    // never reaches this function's arguments, so it is structurally
    // impossible for this INSERT to leak it, regardless of code path.
    db.prepare(
      `INSERT INTO outbox (id, to_email, subject, body, sent_via, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(generateId("mail"), to, SUBJECT, buildRedactedOutboxBody(), sentVia, new Date().toISOString());
  };

  if (!apiKey || !from) {
    // No live Resend configured: per Phase 7 spec, do NOT persist the
    // secret anywhere as a substitute. Record a redacted failure entry so
    // admins can see onboarding is blocked on Resend setup, and return
    // delivered:false so the caller can report it accurately. The
    // account itself (already committed by the caller before this
    // function runs) is retained regardless.
    recordOutbox("blocked-no-resend");
    console.log(`[JVZoo onboarding email BLOCKED] to=${to} reason="Resend not configured"`);
    return { delivered: false, reason: "Resend not configured — account created, email not sent." };
  }

  const { text, html } = buildWelcomeEmailContent({ email: to, tempPassword });

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
