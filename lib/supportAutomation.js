import { generateId } from "./auth-crypto";
import { getOrCreateConversation, postMessageInner } from "./supportEngine";

// Production feature/fix batch: durable, server-persisted scheduling for
// automated Support messages (first-login welcome, ISP-approved
// congratulations, every-login check-in). Deliberately NOT built on
// setTimeout()/setInterval() -- the production container can restart at
// any time, and every one of these messages must survive a refresh,
// logout, or full server restart per spec. See lib/db.js
// scheduled_support_messages for the schema.
//
// Design: LAZY delivery, no server-side timer/cron process at all.
// scheduleMessage() just inserts a row with a future `deliver_at`
// timestamp; deliverDueMessages() is called at the start of every
// customer-facing Support read (GET /api/support/messages, GET
// /api/support/unread) and copies any row whose deliver_at has already
// passed into the real support_messages table, exactly once. Both
// scheduling AND delivery are protected by a UNIQUE constraint on
// event_key / by an atomic UPDATE...WHERE delivered_at IS NULL guard
// respectively, so:
//   - refreshing a page 20 times cannot schedule (or deliver) the same
//     message twice
//   - a container restart between "scheduled" and "delivered" loses
//     nothing -- the row is still there, still due, on the next request
//   - two concurrent requests racing to deliver the same due row can
//     only ever have one of them win the UPDATE and actually post the
//     message (see deliverDueMessages below)

// Fixed, pre-written support-team display identity for automated
// messages ONLY. Reuses the app's existing single-admin display
// convention (see lib/supportEngine.js ADMIN_FALLBACK_DISPLAY_NAME) --
// automated messages are attributed to sender_role='admin' with a NULL
// sender_account_id, which lib/supportEngine.js enrichMessagesWithIdentity
// already resolves to the same "Ashley" support-team display name/photo
// every other admin-authored message without a resolvable admin account
// falls back to. This keeps automated messages visually indistinguishable
// from a real admin reply in the customer's own inbox, per spec ("sender
// should appear as the existing customer support team/support identity").

// Idempotently schedules ONE message for delivery at `deliverAt` (a Date
// or ISO string). `eventKey` is the sole idempotency guard -- if a row
// with this exact key already exists (this account already has this
// event scheduled, whether already delivered or not), this is a
// completely safe no-op: returns { scheduled: false, reason: "already_scheduled" }
// rather than throwing or creating a duplicate.
export function scheduleMessage(db, { accountId, eventKey, body, deliverAt }) {
  const deliverAtIso =
    deliverAt instanceof Date ? deliverAt.toISOString() : new Date(deliverAt).toISOString();
  const now = new Date().toISOString();
  const id = generateId("schedmsg");

  try {
    const result = db
      .prepare(
        `INSERT INTO scheduled_support_messages (id, account_id, event_key, body, deliver_at, delivered_at, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`
      )
      .run(id, accountId, eventKey, body, deliverAtIso, now);
    if (result.changes > 0) {
      return { scheduled: true, id };
    }
    return { scheduled: false, reason: "already_scheduled" };
  } catch (err) {
    // UNIQUE constraint violation on event_key -- this exact event was
    // already scheduled (possibly by a concurrent request that won the
    // race). Treat identically to the changes===0 case above: a safe,
    // expected no-op, never an error surfaced to the caller.
    if (String(err?.message || "").includes("UNIQUE")) {
      return { scheduled: false, reason: "already_scheduled" };
    }
    throw err;
  }
}

// Delivers every message for this account whose deliver_at has already
// passed and which hasn't been delivered yet. Safe to call on every
// Support read (cheap: at most a handful of due rows per account, almost
// always zero). Each row is delivered via an atomic
// "UPDATE ... WHERE delivered_at IS NULL" claim followed by the actual
// support_messages INSERT inside the same transaction, so two concurrent
// requests (e.g. two open tabs polling at once) can never both deliver
// the same row -- whichever request's UPDATE affects a row wins the
// right to post the message; the loser's UPDATE affects zero rows and it
// moves on.
//
// Uses postMessageInner() (the transaction-free core of
// lib/supportEngine.js#postMessage) rather than postMessage() itself --
// `node:sqlite`'s DatabaseSync has no nested-transaction/savepoint
// support, and this function already opens its OWN db.exec("BEGIN") per
// row (below) so the claim UPDATE and the message INSERT commit
// atomically together; calling postMessage() here would attempt a
// second, nested db.exec("BEGIN") inside that already-open transaction
// and throw "cannot start a transaction within a transaction".
export function deliverDueMessages(db, accountId) {
  const now = new Date().toISOString();
  const dueRows = db
    .prepare(
      `SELECT id, body FROM scheduled_support_messages
       WHERE account_id = ? AND delivered_at IS NULL AND deliver_at <= ?
       ORDER BY deliver_at ASC`
    )
    .all(accountId, now);

  if (dueRows.length === 0) return { delivered: 0 };

  let deliveredCount = 0;
  const conversation = getOrCreateConversation(db, accountId);

  for (const row of dueRows) {
    db.exec("BEGIN");
    try {
      const claim = db
        .prepare(
          `UPDATE scheduled_support_messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL`
        )
        .run(now, row.id);
      if (claim.changes === 0) {
        // Another concurrent request already claimed/delivered this row.
        db.exec("ROLLBACK");
        continue;
      }
      postMessageInner(db, {
        conversationId: conversation.id,
        senderRole: "admin",
        senderAccountId: null, // resolves to the shared support-team display identity
        body: row.body,
      });
      db.exec("COMMIT");
      deliveredCount += 1;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  return { delivered: deliveredCount };
}

// ---- Message templates ----------------------------------------------

export const FIRST_LOGIN_WELCOME_MESSAGE =
  "Welcome to the Smart Income System! To start earning immediately, I would start by watching the first 3 modules and setting up your ISP right away. If you have any trouble with anything, feel free to reach out anytime.";

export const ISP_APPROVED_MESSAGE =
  "Congratulations! Your ISP setup is complete. Please go to the ISP SETUP tab to activate your earnings. Once activated, you may check your earnings in the \u201cDashboard\u201d section.";

// 8-12 professionally written, pre-approved check-in variations, rotated
// per spec ("Do NOT use AI to generate a new message on every login. Use
// a controlled server-side pool of approved variations."). This exact
// array is the pool -- selectLoginCheckinMessage() below is the ONLY
// function that should read from it.
export const LOGIN_CHECKIN_MESSAGES = [
  "Let me know if there's anything you need help with.",
  "I'll be right here if you need anything.",
  "Hope you're having a nice day. Let me know if you need help with anything.",
  "Just checking in -- happy to help if you run into any questions.",
  "Welcome back! Reach out anytime if something comes up.",
  "Glad to see you back. Let me know if there's anything I can help with.",
  "If anything's unclear as you go, don't hesitate to ask.",
  "Here if you need a hand with anything today.",
  "Hope everything's going smoothly. I'm just a message away.",
  "Quick check-in -- let me know if you need support with anything.",
];

// Deterministic-but-varied selection: avoids repeating the SAME account's
// immediately-previous check-in message back-to-back "when practical"
// (per spec), using the account's own login_count as the rotation index
// so the sequence is stable and reproducible rather than re-rolled with
// Math.random() on every call. `previousBody` (the account's last
// delivered/scheduled check-in body, if known) is used only to skip
// picking the exact same string twice in a row -- if the natural
// rotation would repeat, this advances by one more slot.
export function selectLoginCheckinMessage(loginCount, previousBody = null) {
  const pool = LOGIN_CHECKIN_MESSAGES;
  let index = ((loginCount % pool.length) + pool.length) % pool.length;
  if (previousBody && pool[index] === previousBody) {
    index = (index + 1) % pool.length;
  }
  return pool[index];
}
