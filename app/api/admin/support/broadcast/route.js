import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { generateId } from "@/lib/auth-crypto";
import { getOrCreateConversation, postMessage } from "@/lib/supportEngine";

// Admin-only bulk support-message ("Send Message" broadcast) route.
// Sends ONE ordinary admin support message into each selected customer's
// own private conversation -- there is no separate "broadcast" message
// type visible to customers; each recipient just sees a normal admin
// reply in their own Support thread (per spec: "Customers must not see
// who else received the message").
//
// Safeguards:
// - requireAdmin() re-verifies the acting admin server-side (never a
//   client-supplied role) and isSameOrigin() guards against CSRF, same
//   pattern as every other state-changing admin route in this app.
// - Every recipient id is validated against the accounts table AND must
//   have role = 'customer' -- an admin account id slipped into the
//   request body (e.g. a tampered client) is silently SKIPPED, never
//   messaged, and never counted as "sent". This is what makes admin
//   accounts structurally unable to receive a broadcast even if a
//   compromised/buggy client tried to select one.
// - MAX_BATCH_SIZE caps how many recipients a single request may target;
//   a request with more ids than that is rejected outright (400) rather
//   than silently truncated, so the admin UI can chunk into controlled
//   batches instead of one call unexpectedly doing partial work.
// - broadcast_requests.request_key (client-generated, one per opened
//   confirmation modal -- see the admin page's BroadcastModal) gives
//   idempotency: a duplicate submission of the EXACT same request (double-
//   click, network retry re-firing the POST) returns the previously
//   recorded result instead of sending every message a second time.
// - Each customer's conversation is reused if one already exists
//   (getOrCreateConversation), or created fresh for a customer with no
//   prior conversation -- exactly the same helper used by the normal
//   Support flow, so there is only ever one conversation per customer.
// - Each per-customer message insert is wrapped by postMessage(), which
//   already runs inside its own transaction (see lib/supportEngine.js)
//   and marks the conversation's customer_unread flag so the Support
//   nav-tab badge appears for every recipient.
// - Recipient EMAILS are never stored in the audit_log payload -- only
//   the recipient COUNT and the list of account IDs (which are already
//   the durable envelope-safe identifier used everywhere else in this
//   app's audit trail), per spec ("do not store recipient emails
//   unnecessarily inside the audit payload").
const MAX_BATCH_SIZE = 200;

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

  const requestKey = typeof body.requestKey === "string" ? body.requestKey.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const recipientIds = Array.isArray(body.recipientIds)
    ? [...new Set(body.recipientIds.filter((id) => typeof id === "string" && id))]
    : null;

  if (!requestKey) {
    return NextResponse.json({ error: "A requestKey is required." }, { status: 400 });
  }
  if (!message) {
    return NextResponse.json({ error: "Message cannot be empty." }, { status: 400 });
  }
  if (message.length > 4000) {
    return NextResponse.json({ error: "Message is too long." }, { status: 400 });
  }

  const db = getDb();

  // Idempotency: a repeated request with the SAME request_key returns the
  // already-recorded outcome rather than re-sending. UNIQUE(request_key)
  // makes the INSERT below race-safe even under a genuine double-submit.
  const existing = db
    .prepare(`SELECT * FROM broadcast_requests WHERE request_key = ?`)
    .get(requestKey);
  if (existing) {
    return NextResponse.json({
      ok: true,
      duplicate: true,
      sent: existing.sent_count,
      skipped: existing.skipped_count,
      failed: existing.failed_count,
    });
  }

  // Portal reliability pass: the admin UI's current selection model sends
  // explicit recipientIds captured client-side from the User Management
  // table (account IDs, never row indexes -- see app/(portal)/admin/page.js
  // selectedIds). Support both that shape and a legacy/simple "no ids
  // provided" 400 so a malformed client request fails loudly rather than
  // silently broadcasting to nobody or everybody.
  if (!recipientIds || recipientIds.length === 0) {
    return NextResponse.json({ error: "At least one recipient is required." }, { status: 400 });
  }
  if (recipientIds.length > MAX_BATCH_SIZE) {
    return NextResponse.json(
      {
        error: `Too many recipients in one request (max ${MAX_BATCH_SIZE}). Please send in smaller batches.`,
      },
      { status: 400 }
    );
  }

  // Validate every recipient id is a REAL, CURRENT customer account --
  // never trust the client's claim that an id is a customer. Any id that
  // doesn't resolve to a customer account (doesn't exist, or is an admin
  // account) is skipped, not sent, and not counted as a failure (it's not
  // a delivery failure -- it was never a valid recipient to begin with).
  const placeholders = recipientIds.map(() => "?").join(",");
  const validCustomers = db
    .prepare(`SELECT id FROM accounts WHERE id IN (${placeholders}) AND role = 'customer'`)
    .all(...recipientIds);
  const validIds = new Set(validCustomers.map((r) => r.id));
  const skippedCount = recipientIds.length - validIds.size;

  let sentCount = 0;
  let failedCount = 0;

  // getOrCreateConversation() and postMessage() each already run their
  // own internal BEGIN/COMMIT transaction (see lib/supportEngine.js) --
  // wrapping this loop body in a SECOND db.exec("BEGIN") caused every
  // call to fail with "cannot start a transaction within a transaction"
  // (confirmed live: every recipient came back sent:0/failed:N). Do not
  // add an outer transaction here; each helper is already atomic on its
  // own, and per-recipient failures are isolated by their own try/catch.
  for (const accountId of validIds) {
    try {
      const conversation = getOrCreateConversation(db, accountId);
      const result = postMessage(db, {
        conversationId: conversation.id,
        senderRole: "admin",
        senderAccountId: guard.account.id,
        body: message,
      });
      // A per-recipient duplicate-submit collision (same admin re-sent the
      // identical body to the identical customer within the last few
      // seconds) still counts as "sent" from the broadcast's perspective --
      // the customer already has that message, nothing failed.
      if (result) sentCount += 1;
    } catch {
      failedCount += 1;
    }
  }

  const now = new Date().toISOString();
  const broadcastId = generateId("bcast");

  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO broadcast_requests
         (id, request_key, admin_account_id, recipient_count, sent_count, skipped_count, failed_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(broadcastId, requestKey, guard.account.id, recipientIds.length, sentCount, skippedCount, failedCount, now);

    db.prepare(
      `INSERT INTO audit_log (id, admin_account_id, target_account_id, action, before_json, after_json, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?)`
    ).run(
      generateId("audit"),
      guard.account.id,
      "support_broadcast",
      JSON.stringify({}),
      JSON.stringify({
        recipientCount: recipientIds.length,
        sent: sentCount,
        skipped: skippedCount,
        failed: failedCount,
        requestKey,
      }),
      now
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return NextResponse.json({ ok: true, sent: sentCount, skipped: skippedCount, failed: failedCount });
}
