import { getDb } from "./db";
import { generateId } from "./auth-crypto";

// Sends transactional email via SendGrid if SENDGRID_API_KEY + EMAIL_FROM are
// configured. Otherwise (e.g. local testing before credentials are wired up),
// falls back to writing the email into a local "outbox" table so the whole
// signup/reset flow can be exercised end-to-end without a live provider.
export async function sendEmail({ to, subject, text, html }) {
  const apiKey = process.env.SENDGRID_API_KEY;
  const from = process.env.EMAIL_FROM;

  const db = getDb();
  const record = () =>
    db
      .prepare(
        `INSERT INTO outbox (id, to_email, subject, body, sent_via, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        generateId("mail"),
        to,
        subject,
        text,
        apiKey && from ? "sendgrid" : "outbox-fallback",
        new Date().toISOString()
      );

  if (!apiKey || !from) {
    record();
    // eslint-disable-next-line no-console
    console.log(
      `[Email Sent] (outbox-fallback, SendGrid not configured) to=${to} subject="${subject}"`
    );
    return { delivered: false, reason: "SendGrid not configured — saved to local outbox instead." };
  }

  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from },
        subject,
        content: [
          { type: "text/plain", value: text },
          ...(html ? [{ type: "text/html", value: html }] : []),
        ],
      }),
    });

    record();

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      // eslint-disable-next-line no-console
      console.log(`[Email Send FAILED] to=${to} subject="${subject}" status=${res.status}`);
      return { delivered: false, reason: `SendGrid error ${res.status}: ${errBody}` };
    }
    // eslint-disable-next-line no-console
    console.log(`[Email Sent] (via SendGrid) to=${to} subject="${subject}"`);
    return { delivered: true };
  } catch (err) {
    record();
    // eslint-disable-next-line no-console
    console.log(`[Email Send FAILED] to=${to} subject="${subject}" error=${err.message}`);
    return { delivered: false, reason: `SendGrid request failed: ${err.message}` };
  }
}
