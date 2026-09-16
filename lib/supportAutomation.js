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

// STOP-AUTOMATED-SUPPORT-MESSAGES batch: the LOGIN/first-login/ISP-
// approved automated Support message EXECUTION PATH remains permanently
// disabled -- scheduleMessage() is still never called anywhere for any
// of those historical event kinds (see the removed call sites in
// app/api/auth/login/route.js and lib/ispEngine.js -- confirmed via a
// full-tree search before this change).
//
// WAITLIST-48H-MESSAGE batch: deliverDueMessages() is no longer an
// unconditional no-op -- it now ALSO delivers the ONE new automation
// this batch introduces (the 48-hours-after-waitlist-join message,
// event_key = `${WAITLIST_SELECTION_EVENT_PREFIX}${accountId}`,
// scheduled exclusively by scheduleWaitlistSelectionMessage() in this
// same file, called only from the NEW waitlist-join success path in
// app/api/waitlist/join/route.js). This is a narrow, explicit allowlist
// by event_key PREFIX, not a blanket re-enable: any row whose event_key
// does not start with WAITLIST_SELECTION_EVENT_PREFIX (i.e. every
// historical login/first-login/ISP-approved row) is still never
// delivered here, and the lib/db.js migration that already stamped
// `cancelled_at` on every pre-existing pending row at deploy time means
// even a stale old row can never resurrect. A row that has since been
// cancelled (see cancelWaitlistSelectionMessage() below -- fired when a
// customer is removed from the waitlist before their 48h message went
// out) is also skipped (`cancelled_at IS NULL`). Historical rows already
// copied into support_messages (delivered_at IS NOT NULL, before this
// change) are NEVER touched or deleted by any of this -- they remain
// visible in the customer's and admin's Support inbox exactly as
// before. Manual customer/admin messages are posted through an entirely
// separate code path (lib/supportEngine.js#postMessage(), called only
// from the customer/admin Support POST routes) and are completely
// unaffected.
export function deliverDueMessages(db, accountId) {
  const now = new Date().toISOString();
  const dueRows = db
    .prepare(
      `SELECT id, body FROM scheduled_support_messages
       WHERE account_id = ? AND delivered_at IS NULL AND cancelled_at IS NULL
         AND deliver_at <= ? AND (event_key LIKE ? OR event_key LIKE ?)
       ORDER BY deliver_at ASC`
    )
    .all(
      accountId,
      now,
      `${WAITLIST_SELECTION_EVENT_PREFIX}%`,
      `${ISP_CONFIRMATION_REMINDER_EVENT_PREFIX}%`
    );

  if (dueRows.length === 0) return { delivered: 0 };

  let deliveredCount = 0;
  const conversation = getOrCreateConversation(db, accountId);

  for (const row of dueRows) {
    db.exec("BEGIN");
    try {
      // Re-check cancelled_at/delivered_at atomically inside the claim
      // UPDATE itself -- guards against a concurrent removal-from-
      // waitlist cancellation (or another concurrent delivery attempt,
      // e.g. two open tabs polling at once) racing this exact row
      // between the SELECT above and this UPDATE.
      const claim = db
        .prepare(
          `UPDATE scheduled_support_messages SET delivered_at = ?
           WHERE id = ? AND delivered_at IS NULL AND cancelled_at IS NULL`
        )
        .run(now, row.id);
      if (claim.changes === 0) {
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

// Idempotently schedules ONE message for delivery at `deliverAt` (a Date
// or ISO string). `eventKey` is the sole idempotency guard -- if a row
// with this exact key already exists (this account already has this
// event scheduled, whether already delivered or not), this is a
// completely safe no-op: returns { scheduled: false, reason: "already_scheduled" }
// rather than throwing or creating a duplicate. Every OTHER historical
// event kind (first-login welcome, ISP-approved, login check-in) still
// has zero call sites anywhere in the app -- only the NEW waitlist-join
// automation below (scheduleWaitlistSelectionMessage) calls this.
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

// ---- WAITLIST-48H-MESSAGE batch --------------------------------------
//
// NEW customers who join/apply for the waitlist AFTER this feature is
// deployed get exactly ONE automated Support message, scheduled for
// exactly 48 hours after their waitlist join timestamp. This deliberately
// reuses the EXISTING scheduled_support_messages engine above (same
// table, same UNIQUE(event_key) idempotency guard, same lazy
// deliverDueMessages() delivery path) rather than inventing a second
// scheduler -- see the deliverDueMessages() comment above for exactly
// how this new event_key prefix is the only one re-enabled for delivery.
//
// CRITICAL (spec section E): this must NEVER be called for a waitlist
// join that already happened before this feature was deployed -- it is
// wired into exactly one call site, the NEW-join success branch of
// POST /api/waitlist/join (the same transaction that first sets
// waitlist_joined_at from NULL -> a timestamp). It must never be called
// from a backfill/scan of existing accounts.waitlist_joined_at values.
export const WAITLIST_SELECTION_EVENT_PREFIX = "waitlist_selection:";

export const WAITLIST_SELECTION_MESSAGE_DELAY_MS = 48 * 60 * 60 * 1000; // exactly 48 hours

// Exact required copy, including paragraph breaks -- preserved verbatim
// (do not collapse/re-wrap the blank lines between paragraphs; the
// customer Support view renders newlines as-is, see
// components/support/LinkifiedText.js).
export const WAITLIST_SELECTION_MESSAGE =
  "You\u2019ve been selected from our waitlist and can purchase a maximum of 3 available Bridges per user. \n\nEach Bridge is a one-time purchase and cannot be resold. \n\nPlease let me know if you want to claim your spot for additional IX Bridges.";

// Idempotency key is tied 1:1 to (account, "this account's waitlist
// selection message") -- NOT to a specific join event/timestamp -- so
// double-clicking Join Waitlist, a retried POST, or a repeated scheduler
// evaluation can never create a second row for the same account even
// across multiple requests/app restarts (UNIQUE(event_key) in
// lib/db.js is the real, unbypassable guard; this is just the
// deterministic key derivation both the scheduling and cancellation
// call sites share).
export function waitlistSelectionEventKey(accountId) {
  return `${WAITLIST_SELECTION_EVENT_PREFIX}${accountId}`;
}

// Called ONLY from the new-join success branch of POST /api/waitlist/join,
// inside that route's own existing BEGIN/COMMIT transaction (this
// function issues no BEGIN/COMMIT of its own, matching scheduleMessage()
// above, so it composes safely inside a caller-owned transaction).
// `joinedAtIso` is the account's own waitlist_joined_at timestamp (the
// SAME value just written), so deliver_at is always exactly
// joinedAt + 48h, never "now + 48h" (relevant if this were ever called
// slightly after the actual join instant).
export function scheduleWaitlistSelectionMessage(db, { accountId, joinedAtIso }) {
  const deliverAt = new Date(new Date(joinedAtIso).getTime() + WAITLIST_SELECTION_MESSAGE_DELAY_MS);
  return scheduleMessage(db, {
    accountId,
    eventKey: waitlistSelectionEventKey(accountId),
    body: WAITLIST_SELECTION_MESSAGE,
    deliverAt,
  });
}

// Spec section G ("preferred behavior"): if the customer is removed from
// the waitlist before the 48-hour message goes out, cancel it rather
// than deliver a "you've been selected from our waitlist" message to
// someone no longer on the waitlist. Uses the SAME atomic-claim pattern
// as deliverDueMessages()'s own UPDATE ... WHERE delivered_at IS NULL --
// only ever cancels a row that has not already been delivered, so this
// can never race a delivery into "wait, it both sent AND got cancelled."
// If delivery already won the race (delivered_at IS NOT NULL by the time
// this runs), this is a safe no-op -- the already-sent message is never
// retracted/deleted (there is no message-recall feature in this app).
export function cancelWaitlistSelectionMessage(db, accountId) {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE scheduled_support_messages
       SET cancelled_at = ?
       WHERE account_id = ? AND event_key = ? AND delivered_at IS NULL AND cancelled_at IS NULL`
    )
    .run(now, accountId, waitlistSelectionEventKey(accountId));
  return { cancelled: result.changes > 0 };
}

// ---- ISP-CONFIRMATION-15M-MESSAGE batch -------------------------------
//
// NEW customers who complete their OWN final ISP Confirmation ("I
// Approve" -> completeIspAuthorization() reaching isp_status = 'active'
// with source: "customer") get exactly ONE automated Support message,
// scheduled for exactly 15 minutes after that confirmation instant.
// Reuses the exact same scheduled_support_messages engine/table/
// UNIQUE(event_key) idempotency guard and lazy deliverDueMessages() path
// as the 48h waitlist-selection message above -- no second scheduler.
//
// CRITICAL trigger scope (spec section: "message customer 15 minutes
// after ISP confirmation"): this must be called ONLY from the customer's
// own POST /api/isp/authorize/complete route, and ONLY on a genuinely
// NEW transition into isp_status = 'active' with
// isp_activation_source === 'customer' (never on an already-active
// idempotent no-op). It must NEVER be called from:
//   - ISP application submission (POST /api/isp/submit)
//   - ISP auto-approval to approved_awaiting_user (checkAndAutoApproveIsp)
//   - Admin manual approval to approved_awaiting_user
//     (app/api/admin/isp/[id]/approve)
//   - The admin "Setup ISP + $71.28" one-click action or the admin ISP
//     Confirmation route (app/api/admin/isp/[id]/confirm), both of which
//     call completeIspAuthorization() with source: "admin" -- explicitly
//     excluded by checking isp_activation_source === "customer" at the
//     one call site (app/api/isp/authorize/complete/route.js), never by
//     duplicating activation logic here.
// No historical backfill: only wired into the NEW-confirmation success
// branch, never a scan/backfill of existing already-active accounts.
export const ISP_CONFIRMATION_REMINDER_EVENT_PREFIX = "isp_confirmation_reminder:";

export const ISP_CONFIRMATION_REMINDER_DELAY_MS = 15 * 60 * 1000; // exactly 15 minutes

// Exact required copy, including the paragraph break -- preserved
// verbatim (do not collapse/re-wrap the blank line between paragraphs;
// see WAITLIST_SELECTION_MESSAGE above for the same rendering note).
export const ISP_CONFIRMATION_REMINDER_MESSAGE =
  "If you haven\u2019t already, I recommend you to join the \u201cWaitlist\u201d in the \u201cBridges\u201d section as soon as you can. Spots are starting to fill up.\n\nWe currently do not have any more bridges available for sale, but I will be reaching out to waitlisted members when they become available.";

// Idempotency key tied 1:1 to (account, "this account's ISP confirmation
// reminder") -- NOT to a specific confirmation timestamp/request -- so a
// double-click on "I Approve", a retried/duplicate POST
// /api/isp/authorize/complete, a browser refresh mid-flow, a repeated
// scheduler/delivery evaluation, or a server restart between scheduling
// and delivery can never create (or deliver) a second row for the same
// account. UNIQUE(event_key) in lib/db.js is the real, unbypassable
// guard; this is just the deterministic key derivation the scheduling
// call site uses (mirrors waitlistSelectionEventKey() above).
export function ispConfirmationReminderEventKey(accountId) {
  return `${ISP_CONFIRMATION_REMINDER_EVENT_PREFIX}${accountId}`;
}

// Called ONLY from the NEW-customer-confirmation success branch of
// POST /api/isp/authorize/complete, immediately after
// completeIspAuthorization() returns { ok: true } for a genuinely fresh
// transition (never on alreadyActive: true, and never for source:
// "admin"). `confirmedAtIso` is the account's own freshly-stamped
// user_authorized_at timestamp (the SAME value completeIspAuthorization
// just wrote), so deliver_at is always exactly confirmedAt + 15m, never
// "now + 15m". Already-waitlisted customers are NOT excluded -- this is
// a general reminder regardless of current waitlist_joined_at status.
export function scheduleIspConfirmationReminderMessage(db, { accountId, confirmedAtIso }) {
  const deliverAt = new Date(
    new Date(confirmedAtIso).getTime() + ISP_CONFIRMATION_REMINDER_DELAY_MS
  );
  return scheduleMessage(db, {
    accountId,
    eventKey: ispConfirmationReminderEventKey(accountId),
    body: ISP_CONFIRMATION_REMINDER_MESSAGE,
    deliverAt,
  });
}

// ---- 4-DAY-NON-WAITLIST-MESSAGE batch ---------------------------------
//
// Third, INDEPENDENT automated Support message (spec section F): once an
// account is >= 4 days old (accounts.created_at is the canonical
// signup/creation timestamp -- verified authoritative in lib/db.js; this
// is deliberately NOT first_login_at/isp_submitted_at/isp_approved_at/
// user_authorized_at/waitlist_joined_at/module-completion, none of which
// are "signup") AND that account has NEVER joined the Bridge Waitlist
// (waitlist_joined_at IS NULL), send this message exactly ONCE, ever.
//
// Reuses the EXACT SAME durable scheduled_support_messages engine/table/
// UNIQUE(event_key) idempotency guard as the two existing automations
// above -- per spec ("follow the SAME existing pattern/table for
// consistency rather than inventing a new one"). Both the DUE-SCAN
// (runNonWaitlist4DaySupportScan, called from the shared background
// scheduler tick -- see lib/backgroundScheduler.js) and the actual send
// happen here; the SEND-TIME recheck of the waitlist/active condition
// (spec: "re-verify ... immediately before actually inserting the
// message, not just at initial due-scan time") happens inside the SAME
// atomic claim transaction below, so a customer who joins the waitlist
// between being marked "due" and the message actually being written can
// never receive it.
export const NON_WAITLIST_4DAY_EVENT_PREFIX = "non_waitlist_4day_followup:";

export const NON_WAITLIST_4DAY_AGE_MS = 4 * 24 * 60 * 60 * 1000; // exactly 4 days

// Exact required copy, including the blank line between paragraphs --
// preserved verbatim (same rendering note as WAITLIST_SELECTION_MESSAGE/
// ISP_CONFIRMATION_REMINDER_MESSAGE above: the customer Support view
// renders newlines as-is).
export const NON_WAITLIST_4DAY_MESSAGE =
  "I just checked your account and it seems like your ISP qualifies for additional bridge add-ons!\n\nHowever, due to a shortage of bridges, we're limiting users to be able to purchase 2 bridges max. \n\nPlease let me know if you want to claim your spot for additional IX Bridges.";

export function nonWaitlist4DayEventKey(accountId) {
  return `${NON_WAITLIST_4DAY_EVENT_PREFIX}${accountId}`;
}

// deliverDueMessages() above only ever delivers rows whose event_key
// matches one of two explicit prefixes it allowlists. Rather than
// widening that allowlist (and thereby making deliverDueMessages()
// respect a `deliver_at` in the future that this function's send-time
// recheck below would then need to happen BEFORE, not at, the actual
// insert), this automation inserts its row ALREADY delivered -- i.e. it
// performs the due-check, the send-time recheck, and the actual
// support_messages insert all in one atomic step, exactly once, rather
// than a separate schedule-now/deliver-later split. This is safe and
// consistent with the existing table's semantics (a
// scheduled_support_messages row with delivered_at already set is
// simply a durable historical record of when/what was sent -- the same
// shape deliverDueMessages() itself produces when it delivers a row).
//
// `conversation` must be the account's own getOrCreateConversation()
// result (callers already have it or can cheaply obtain it) -- kept as a
// parameter rather than re-deriving it here so a caller processing many
// accounts in one scan doesn't pay a redundant lookup.
function sendNonWaitlist4DayMessage(db, accountId) {
  const eventKey = nonWaitlist4DayEventKey(accountId);
  const now = new Date().toISOString();

  db.exec("BEGIN");
  try {
    // Send-time recheck (spec: "re-verify the waitlist condition (and
    // active/enabled condition) immediately before actually inserting
    // the message"). Re-reads the account FRESH, inside this
    // transaction, rather than trusting whatever snapshot the caller's
    // due-scan used to decide this account was a candidate.
    const fresh = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
    if (!fresh || fresh.role !== "customer") {
      db.exec("ROLLBACK");
      return { sent: false, reason: "not_found" };
    }
    if (fresh.account_status !== "active") {
      db.exec("ROLLBACK");
      return { sent: false, reason: "not_active" };
    }
    if (fresh.waitlist_joined_at) {
      db.exec("ROLLBACK");
      return { sent: false, reason: "waitlisted" };
    }
    const createdMs = fresh.created_at ? new Date(fresh.created_at).getTime() : null;
    if (createdMs == null || Date.now() - createdMs < NON_WAITLIST_4DAY_AGE_MS) {
      db.exec("ROLLBACK");
      return { sent: false, reason: "too_young" };
    }

    // Idempotency: the INSERT's UNIQUE(event_key) constraint (same
    // column/constraint scheduleMessage() above relies on) is the real,
    // unbypassable guard against ever sending this twice for the same
    // account -- concurrent worker runs, retries, and restarts can only
    // ever have ONE winner here. A conflict means this account already
    // has this event recorded (whether from a previous run of this exact
    // function, ever) -- treated as a safe no-op, never an error.
    let insertResult;
    try {
      insertResult = db
        .prepare(
          `INSERT INTO scheduled_support_messages (id, account_id, event_key, body, deliver_at, delivered_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(generateId("schedmsg"), accountId, eventKey, NON_WAITLIST_4DAY_MESSAGE, now, now, now);
    } catch (err) {
      if (String(err?.message || "").includes("UNIQUE")) {
        db.exec("ROLLBACK");
        return { sent: false, reason: "already_sent" };
      }
      throw err;
    }
    if (insertResult.changes === 0) {
      db.exec("ROLLBACK");
      return { sent: false, reason: "already_sent" };
    }

    const conversation = getOrCreateConversation(db, accountId);
    postMessageInner(db, {
      conversationId: conversation.id,
      senderRole: "admin",
      senderAccountId: null, // resolves to the shared support-team display identity
      body: NON_WAITLIST_4DAY_MESSAGE,
    });

    db.exec("COMMIT");
    return { sent: true };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// Due-scan entry point for the OLD 4-day non-waitlist automation.
//
// GOLDEN-BRIDGE-FOLLOWUP batch: per spec section B ("PAUSE/REMOVE this
// trigger for all future sends... It must NOT continue firing after
// this batch"), this function is kept (its logic is unchanged, and
// every historical scheduled_support_messages row it already wrote
// stays exactly as-is for Analytics) but is NO LONGER CALLED from
// lib/backgroundScheduler.js's runTick() -- see that file's comment.
// Leaving the function itself intact (rather than deleting it) means:
//   - historical event_key prefix (NON_WAITLIST_4DAY_EVENT_PREFIX) and
//     message constant remain available for lib/supportAnalytics.js to
//     keep attributing/displaying the old campaign's historical
//     Sent/Replied stats
//   - the old automation can be audited/reasoned about later without
//     needing to dig through git history
// There is no remaining call site for this function anywhere in the
// app; it is intentionally dead code from this batch forward.
export function runNonWaitlist4DayScan(db) {
  const cutoffIso = new Date(Date.now() - NON_WAITLIST_4DAY_AGE_MS).toISOString();
  const candidates = db
    .prepare(
      `SELECT id FROM accounts
       WHERE role = 'customer'
         AND account_status = 'active'
         AND waitlist_joined_at IS NULL
         AND created_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM scheduled_support_messages
           WHERE scheduled_support_messages.account_id = accounts.id
             AND scheduled_support_messages.event_key = ? || accounts.id
         )`
    )
    .all(cutoffIso, NON_WAITLIST_4DAY_EVENT_PREFIX);

  let sentCount = 0;
  for (const row of candidates) {
    const result = sendNonWaitlist4DayMessage(db, row.id);
    if (result.sent) sentCount += 1;
  }
  return { scanned: candidates.length, sent: sentCount };
}

// ---- GOLDEN-BRIDGE-FOLLOWUP batch --------------------------------------
//
// Replaces the old 4-day non-waitlist automation above (which is now
// permanently disabled, see runNonWaitlist4DayScan's header comment)
// with a new automated Support message sent when EITHER of two
// independent triggers fires FIRST for a given customer, per spec
// sections C/D/E:
//
//   A. Trigger A -- genuine Module 7 completion (the SAME authoritative
//      account_module_progress.completed_at signal every other
//      completion-gated feature in this codebase reads via
//      lib/moduleEngine.js#isModuleCompleted() -- never the admin
//      "Unlock All Modules" override, never merely "unlocked", never a
//      partial-watch/visit signal) while waitlist_joined_at IS NULL.
//      Wired into the ONE existing call site that ever writes a fresh
//      Module 7 completion: POST /api/modules/[key]/complete (see that
//      route -- it calls triggerGoldenBridgeFollowupFromModuleCompletion()
//      immediately after lib/moduleEngine.js#completeModule() reports a
//      genuinely NEW completion, never on the idempotent
//      alreadyCompleted:true branch).
//
//   B. Trigger B -- the account reaches EXACTLY accounts.created_at + 72
//      hours (the canonical account creation/join timestamp; see this
//      file's existing 4-day automation and lib/moduleEngine.js, both of
//      which already treat accounts.created_at as the authoritative
//      "account age" anchor) while waitlist_joined_at IS NULL. Wired
//      into the SAME shared background scheduler tick used by every
//      other due-scan in this app (lib/backgroundScheduler.js) -- no new
//      standalone timer/cron/worker.
//
// BOTH triggers call the exact same shared send function
// (sendGoldenBridgeFollowupMessage below), which uses ONE campaign
// event_key per account (GOLDEN_BRIDGE_FOLLOWUP_EVENT_PREFIX + accountId)
// -- never two separate keys for the two triggers -- so whichever
// trigger reaches the database's UNIQUE(event_key) constraint FIRST
// wins, and the other is always a safe, silent no-op. This is the exact
// same "insert already-delivered atomically, with a fresh send-time
// recheck of active/waitlist state inside the same transaction" pattern
// sendNonWaitlist4DayMessage() above already uses, reused verbatim (see
// that function's own header comment for the full rationale) so this
// batch introduces zero new architecture, only a new prefix/message/
// trigger wiring.
export const GOLDEN_BRIDGE_FOLLOWUP_EVENT_PREFIX = "golden_bridge_followup:";

export const GOLDEN_BRIDGE_FOLLOWUP_AGE_MS = 72 * 60 * 60 * 1000; // exactly 72 hours

// Exact required copy -- single line, no paragraph breaks, preserved
// verbatim. Message-only: no video/media reference of any kind.
export const GOLDEN_BRIDGE_FOLLOWUP_MESSAGE =
  "I\u2019m not sure if you had a chance to review the modules yet, but we actually have 2 Golden Bridges available right now. Are you against adding more bridges to your account?";

export function goldenBridgeFollowupEventKey(accountId) {
  return `${GOLDEN_BRIDGE_FOLLOWUP_EVENT_PREFIX}${accountId}`;
}

// Shared send function for BOTH triggers. Re-reads the account FRESH,
// inside its own transaction, immediately before inserting -- per spec
// section F ("Recheck Waitlist status immediately at SEND TIME... Do
// not rely only on earlier eligibility query"), a customer who became
// eligible (Module 7 completed, or 72h reached) and THEN joined the
// Waitlist before this actually runs is correctly excluded here, even
// if whatever caller invoked this believed the customer was still
// eligible a moment ago. The INSERT's UNIQUE(event_key) constraint is
// the final, unbypassable one-time guarantee (see header comment above)
// -- a concurrent duplicate call (Module 7 completing at almost the
// same instant the 72h scan independently picks up the same account)
// can only ever have exactly one winner.
export function sendGoldenBridgeFollowupMessage(db, accountId) {
  const eventKey = goldenBridgeFollowupEventKey(accountId);
  const now = new Date().toISOString();

  db.exec("BEGIN");
  try {
    const fresh = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
    if (!fresh || fresh.role !== "customer") {
      db.exec("ROLLBACK");
      return { sent: false, reason: "not_found" };
    }
    if (fresh.account_status !== "active") {
      db.exec("ROLLBACK");
      return { sent: false, reason: "not_active" };
    }
    if (fresh.waitlist_joined_at) {
      db.exec("ROLLBACK");
      return { sent: false, reason: "waitlisted" };
    }

    let insertResult;
    try {
      insertResult = db
        .prepare(
          `INSERT INTO scheduled_support_messages (id, account_id, event_key, body, deliver_at, delivered_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          generateId("schedmsg"),
          accountId,
          eventKey,
          GOLDEN_BRIDGE_FOLLOWUP_MESSAGE,
          now,
          now,
          now
        );
    } catch (err) {
      if (String(err?.message || "").includes("UNIQUE")) {
        db.exec("ROLLBACK");
        return { sent: false, reason: "already_sent" };
      }
      throw err;
    }
    if (insertResult.changes === 0) {
      db.exec("ROLLBACK");
      return { sent: false, reason: "already_sent" };
    }

    const conversation = getOrCreateConversation(db, accountId);
    postMessageInner(db, {
      conversationId: conversation.id,
      senderRole: "admin",
      senderAccountId: null, // resolves to the shared support-team display identity
      body: GOLDEN_BRIDGE_FOLLOWUP_MESSAGE,
    });

    db.exec("COMMIT");
    return { sent: true };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// Trigger A entry point. Called ONLY from the customer's own POST
// /api/modules/[key]/complete route, and ONLY when
// lib/moduleEngine.js#completeModule() reports a genuinely FRESH
// completion (result.completedAt present, never on the idempotent
// alreadyCompleted:true branch) for moduleKey === 7 -- so an admin's
// "Unlock All Modules" override, a mere unlock/visit, or a
// duplicate/retried completion POST can never fire this. The
// active/waitlist/idempotency safety net is entirely inside
// sendGoldenBridgeFollowupMessage() above, so this function is a thin,
// auditable wrapper whose only job is proving the caller genuinely just
// witnessed a real Module 7 completion.
export function triggerGoldenBridgeFollowupFromModuleCompletion(db, accountId) {
  return sendGoldenBridgeFollowupMessage(db, accountId);
}

// Trigger B due-scan, called from the shared background scheduler tick
// (lib/backgroundScheduler.js) -- covers BOTH existing customers already
// >= 72h old at the moment this feature is deployed AND future customers
// who cross the 72h threshold later, since this scan re-runs on every
// tick. The candidate query is a cheap performance filter only (role /
// account_status / waitlist / created_at, plus a NOT EXISTS against this
// SAME shared campaign event_key so an account already sent the message
// via EITHER trigger is never re-considered here) -- the real send-time
// recheck + idempotent insert happens inside
// sendGoldenBridgeFollowupMessage() for every candidate.
export function runGoldenBridgeFollowup72hScan(db) {
  const cutoffIso = new Date(Date.now() - GOLDEN_BRIDGE_FOLLOWUP_AGE_MS).toISOString();
  const candidates = db
    .prepare(
      `SELECT id FROM accounts
       WHERE role = 'customer'
         AND account_status = 'active'
         AND waitlist_joined_at IS NULL
         AND created_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM scheduled_support_messages
           WHERE scheduled_support_messages.account_id = accounts.id
             AND scheduled_support_messages.event_key = ? || accounts.id
         )`
    )
    .all(cutoffIso, GOLDEN_BRIDGE_FOLLOWUP_EVENT_PREFIX);

  let sentCount = 0;
  for (const row of candidates) {
    const result = sendGoldenBridgeFollowupMessage(db, row.id);
    if (result.sent) sentCount += 1;
  }
  return { scanned: candidates.length, sent: sentCount };
}
