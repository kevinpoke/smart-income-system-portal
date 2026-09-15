import { generateId } from "./auth-crypto";
import { WITHDRAWALS_MODULE_10_GATE_ID } from "./mockData";

// Server-only Support inbox engine. One conversation per customer account
// (see lib/db.js for the schema rationale) -- this keeps "a customer may
// only access their own conversation" trivial (WHERE account_id = ?) and
// gives the admin inbox a simple one-row-per-customer list model.
//
// Unread semantics: a conversation is "unread" (green indicator) when
// EITHER (a) it has at least one customer message with read_at IS NULL,
// OR (b) an admin has explicitly forced it unread via "Mark Unread"
// (unread_override = 1). unread_override = 0 forces read regardless of
// per-message state (used right after an admin opens/reads it, so a
// stray old row doesn't keep it flagged). Any new customer message clears
// the override back to NULL so real unread state takes over again.

export function getOrCreateConversation(db, accountId) {
  const existing = db.prepare(`SELECT * FROM conversations WHERE account_id = ?`).get(accountId);
  if (existing) return existing;

  const now = new Date().toISOString();
  const id = generateId("conv");
  db.prepare(
    `INSERT INTO conversations (id, account_id, created_at, last_message_at, unread_override)
     VALUES (?, ?, ?, ?, NULL)`
  ).run(id, accountId, now, now);
  return db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id);
}

// De-dupes accidental rapid double-submits of the exact same body from the
// same sender within a short window (covers double-click / double-tap
// network races the client-side submitting-lock might miss).
const DUPLICATE_WINDOW_MS = 4000;

// Image-only messages (empty body) are deliberately EXCLUDED from
// duplicate-submit detection here -- two genuinely different photos sent
// back-to-back would both have body === "" and must not be silently
// collapsed into one. Text (or text+image) duplicate detection is
// unaffected.
function isDuplicateSubmit(db, conversationId, senderRole, senderAccountId, body) {
  if (!body) return false;
  const recent = db
    .prepare(
      `SELECT body, created_at FROM support_messages
       WHERE conversation_id = ? AND sender_role = ? AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(conversationId, senderRole);
  if (!recent || recent.body !== body) return false;
  return Date.now() - new Date(recent.created_at).getTime() < DUPLICATE_WINDOW_MS;
}

// Core message-insert logic, with NO transaction of its own -- callers
// are responsible for wrapping this in BEGIN/COMMIT (or reusing an
// already-open transaction). Factored out of postMessage() below so
// lib/supportAutomation.js's deliverDueMessages() (which already runs
// its own BEGIN/COMMIT per delivered row, atomically alongside its
// `delivered_at` claim UPDATE) can post the automated message INSIDE
// that same transaction instead of nesting a second, independent
// BEGIN -- `node:sqlite`'s DatabaseSync has no support for nested/
// savepoint transactions, and calling db.exec("BEGIN") while a
// transaction is already open throws "cannot start a transaction
// within a transaction". postMessage() itself is unchanged for every
// OTHER caller (the customer/admin Support POST routes), which still
// get their own single, self-contained transaction exactly as before.
function postMessageInner(db, { conversationId, senderRole, senderAccountId = null, body, attachment = null }) {
  const now = new Date().toISOString();
  const id = generateId("msg");

  db.prepare(
    `INSERT INTO support_messages (id, conversation_id, sender_role, sender_account_id, body, created_at, read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    conversationId,
    senderRole,
    senderAccountId,
    body,
    now,
    senderRole === "admin" ? now : null // admin messages need no "unread by admin" tracking
  );

  // Image messages (Support Chat image composer batch): the attachment
  // row is inserted in the SAME transaction as the message row (see
  // postMessage()'s BEGIN/COMMIT below), so a message can never end up
  // persisted without its attachment metadata (or vice versa) even on a
  // mid-write crash. `attachment` is only ever a value this module
  // itself trusts -- callers (the Support POST routes) build it from
  // lib/supportUploads.js#saveSupportImageUpload()'s return value, never
  // from raw client input.
  if (attachment) {
    db.prepare(
      `INSERT INTO support_message_attachments (id, message_id, storage_key, original_filename, mime_type, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      generateId("att"),
      id,
      attachment.storageKey,
      attachment.originalFilename || null,
      attachment.mimeType,
      attachment.sizeBytes,
      now
    );
  }

  // A fresh customer message always clears any stale override so the
  // conversation shows as genuinely unread again; an admin reply does
  // not change the ADMIN-facing customer-unread state (unread_override)
  // but DOES set the CUSTOMER-facing customer_unread flag -- these are
  // two independent, differently-directioned indicators (see lib/db.js
  // for why they're separate columns). Portal reliability pass: every
  // admin reply persistently marks customer_unread = 1 so the
  // customer's Support nav-tab badge appears and survives page
  // navigation/polling; it is cleared only when the customer actually
  // opens/loads their own Support page (see app/api/support/messages
  // GET), never by an unrelated re-render.
  if (senderRole === "customer") {
    db.prepare(
      `UPDATE conversations SET last_message_at = ?, unread_override = NULL WHERE id = ?`
    ).run(now, conversationId);
  } else {
    db.prepare(
      `UPDATE conversations SET last_message_at = ?, customer_unread = 1 WHERE id = ?`
    ).run(now, conversationId);
  }

  return { duplicate: false, id, createdAt: now };
}

export function postMessage(db, { conversationId, senderRole, senderAccountId = null, body, attachment = null }) {
  if (isDuplicateSubmit(db, conversationId, senderRole, senderAccountId, body)) {
    return { duplicate: true };
  }

  db.exec("BEGIN");
  try {
    const result = postMessageInner(db, { conversationId, senderRole, senderAccountId, body, attachment });
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export { postMessageInner };

export function getMessages(db, conversationId, customerAccountId = null) {
  const rows = db
    .prepare(
      `SELECT id, sender_role, sender_account_id, body, created_at, read_at, customer_read_at, edited_at
       FROM support_messages WHERE conversation_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`
    )
    .all(conversationId);

  const withIdentity = enrichMessagesWithIdentity(db, rows, customerAccountId);
  return attachAttachments(db, withIdentity);
}

// Attaches { id, mimeType, sizeBytes } for any message that has an image
// (never the storageKey/filesystem path itself -- the client only ever
// gets an opaque attachment id, which it uses to GET
// /api/support/attachments/[id], the sole authenticated route that
// resolves an id to actual bytes). One extra query for the whole batch
// of messages (never N+1 per message).
function attachAttachments(db, messages) {
  if (messages.length === 0) return messages;
  const placeholders = messages.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, message_id, mime_type, size_bytes FROM support_message_attachments
       WHERE message_id IN (${placeholders})`
    )
    .all(...messages.map((m) => m.id));
  const byMessage = new Map(rows.map((r) => [r.message_id, r]));
  return messages.map((m) => {
    const att = byMessage.get(m.id);
    return {
      ...m,
      attachment: att ? { id: att.id, mimeType: att.mime_type, sizeBytes: att.size_bytes } : null,
    };
  });
}

// Refinement pass: attaches display identity (first name + photo URL) to
// each message via a live account lookup -- NEVER a value copied/frozen
// onto the message row at send time, per spec ("existing historical
// messages should display the sender's CURRENT profile name/photo
// through account lookup... do not duplicate name/photo values into
// every message unless needed for historical integrity"). This means a
// customer or admin who updates their name/photo later sees every past
// message immediately reflect the new identity, with zero migration.
//
// Customer-sent messages are attributed to the conversation's OWN
// customer account (customerAccountId, passed by the caller who already
// knows it). Admin-sent messages are attributed to whichever admin
// account sent them (support_messages.sender_account_id) -- in this
// app's current single-admin model that is always the same admin
// account (seeded with first_name = "Ashley" per spec), but the lookup is
// written generically so it stays correct if more admin accounts are
// ever added. A missing/orphaned sender_account_id (defensive fallback,
// should not normally occur) still displays as "Ashley" rather than
// leaving the sender blank.
// Fallback display name used ONLY when an admin-sent message's
// sender_account_id fails to resolve to a real admin account row (an
// orphaned/legacy row -- should not normally occur; see the comment
// above). This is the ONE place in the entire codebase that hardcodes
// "Ashley" -- every other consumer (both the customer Support page and
// the admin Support Chats inbox) must read the per-message
// `senderFirstName`/`senderPhotoUrl` fields this function attaches
// below, never re-derive or hardcode a name/photo of their own. This is
// what makes this function the single canonical server-side
// sender-display shape for both customer- and admin-authored messages.
const ADMIN_FALLBACK_DISPLAY_NAME = "Ashley";

// THE canonical sender-display resolver, used by every Support
// route/page (customer GET, admin conversation GET) via getMessages()
// below. Given a raw support_messages row, resolves the display name +
// photo the SAME way every time:
// - customer-authored row -> the conversation's OWN customer account
//   (passed in by the caller, which already knows it from the
//   conversation record / authenticated session -- never from the
//   message row or any client-supplied value)
// - admin-authored row -> whichever admin account actually sent it
//   (support_messages.sender_account_id, set server-side at send time
//   from the authenticated admin session -- never client-supplied)
// Both customer and admin UIs must render every message using ONLY
// these two attached fields (never falling back to conversation-level
// metadata, a client cache, or a hardcoded name) so there is exactly
// one source of truth for "who sent this message" and it can never
// silently drift or be spoofed.
function enrichMessagesWithIdentity(db, rows, customerAccountId) {
  const customer = customerAccountId
    ? db
        .prepare(`SELECT first_name, name, email, profile_photo_url FROM accounts WHERE id = ?`)
        .get(customerAccountId)
    : null;

  const adminCache = new Map();
  function lookupAdmin(accountId) {
    if (!accountId) return null;
    if (!adminCache.has(accountId)) {
      adminCache.set(
        accountId,
        db.prepare(`SELECT first_name, profile_photo_url FROM accounts WHERE id = ?`).get(accountId)
      );
    }
    return adminCache.get(accountId);
  }

  return rows.map((m) => {
    if (m.sender_role === "customer") {
      return {
        ...m,
        senderFirstName: customer?.first_name || customer?.name || null,
        senderPhotoUrl: customer?.profile_photo_url || null,
      };
    }
    const admin = lookupAdmin(m.sender_account_id);
    return {
      ...m,
      senderFirstName: admin?.first_name || ADMIN_FALLBACK_DISPLAY_NAME,
      senderPhotoUrl: admin?.profile_photo_url || null,
    };
  });
}

function isUnread(row) {
  if (row.unread_override === 1) return true;
  if (row.unread_override === 0) return false;
  return row.unread_customer_count > 0;
}

// Spec Part 18 (preview/last-message text): collapses newlines/whitespace
// for the compact inbox-row preview ONLY -- the full conversation view
// (getMessages() above) always preserves the real stored body untouched.
// An image-only message (empty body, has an attachment) previews as
// "Photo" rather than blank or a raw storage path/filename.
function buildPreviewText(rawBody, hasAttachment) {
  const collapsed = (rawBody || "").replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return hasAttachment ? "Photo" : "";
  }
  if (hasAttachment) {
    return `Photo · ${collapsed}`;
  }
  return collapsed;
}

// Admin-facing conversation list: customer name/email, last-message
// preview + timestamp, unread indicator, tags, sorted newest-activity
// first. Supports filter = 'all' | 'read' | 'unread' | 'upsell', an
// optional set of tagIds to filter by (conversation must have ALL listed
// tags), and an optional `search` string matched case-insensitively
// against first name, last name, "first last" full name, and email
// (server-side, per Part 3 of the support-inbox spec -- never loads
// every conversation to the client for filtering).
//
// Part 4 (filter counts): the 'upsell' filter uses the SAME authoritative
// field the existing admin User Management "Upsell" column already reads
// and writes (accounts.upsell_purchased -- see lib/db.js ACCOUNT_COLUMNS
// and app/api/admin/accounts/[id]/upsell) rather than inventing a new
// signal or a same-named support_tags row, since that column IS already
// the app's one canonical "belongs to Upsell" fact for a customer.
//
// SUPPORT-TAGS-UPSELL-IMAGES-MULTILINE batch: this same query now ALSO
// returns, per conversation, the account's Waitlist state
// (accounts.waitlist_joined_at IS NOT NULL -- the exact same column the
// Users/User Management table already reads, see lib/waitlistEngine.js
// computeWaitlistStatus()'s `joined = Boolean(account.waitlist_joined_at)`)
// and Module 10 WATCHED state (account_module_progress.completed_at for
// module_key = WITHDRAWALS_MODULE_10_GATE_ID -- the exact same subquery
// shape app/api/admin/accounts/route.js's MODULE10_COMPLETED_AT_SUBQUERY
// already uses for the User Management "Mod 10" column, and the exact
// same underlying fact lib/moduleEngine.js#isModuleCompleted() reads).
// Per spec Part 5/6, "Mod10" must reflect WATCHED only -- NOT merely
// unlocked, and NOT the admin "Unlock All Modules" override
// (accounts.modules_unlocked) by itself -- so this deliberately reads
// ONLY completed_at, never modules_unlocked. All three tags are derived
// live from this one join/subquery per conversation-list request (no
// separate per-conversation API calls, no duplicated Support-only flags
// anywhere in the schema), so a customer becoming Upsell/Waitlist/Mod10
// on the Users side is reflected here automatically on next fetch.
// PAGINATION batch: server-side LIMIT/OFFSET pagination for the admin
// Support inbox list. `page` is 1-indexed, `pageSize` must be one of the
// 5 allowed values (route layer validates/clamps before calling this --
// this function trusts its caller, matching this module's existing
// pattern of NOT re-validating what routes already validate). Returns
// { conversations, totalCount } -- totalCount is a real SQL COUNT(*) run
// against the EXACT SAME WHERE clause (search/filter/tags) as the main
// SELECT, so search/filter/tag results are always counted against the
// FULL matching dataset, never just the current page. Both `read`/
// `unread` (previously derived in JS via isUnread() AFTER fetching every
// row) and the `tagIds` "must have ALL listed tags" filter are now
// pushed into the SQL WHERE clause itself (see UNREAD_SQL and the
// conversation_tags COUNT-matching subquery below) specifically so a
// real `LIMIT ? OFFSET ?` can be applied directly by SQLite against the
// true filtered set for every filter value, with zero JS-side
// post-filtering or slicing anywhere in this function.
export function listConversationsForAdmin(
  db,
  { filter = "all", tagIds = [], search = "", page = 1, pageSize = 30 } = {}
) {
  const safePage = Number.isInteger(page) && page >= 1 ? page : 1;
  const ALLOWED_PAGE_SIZES = [30, 50, 100, 200, 500];
  const safePageSize = ALLOWED_PAGE_SIZES.includes(pageSize) ? pageSize : 30;

  const whereClauses = [];
  const params = [];
  const trimmedSearch = search.trim().toLowerCase();
  if (trimmedSearch) {
    // Server-side, SQL-level search (Part 3): matches partial, case-
    // insensitive first name, last name, "first last" full name, plain
    // `name`, or email -- executed as a single indexed-column LIKE scan
    // in SQLite rather than pulling every conversation into Node memory
    // first, so this stays efficient as the inbox grows.
    whereClauses.push(
      `(LOWER(a.first_name) LIKE ? OR LOWER(a.last_name) LIKE ? OR
        LOWER(a.first_name || ' ' || a.last_name) LIKE ? OR
        LOWER(a.name) LIKE ? OR LOWER(a.email) LIKE ?)`
    );
    const like = `%${trimmedSearch}%`;
    params.push(like, like, like, like, like);
  }
  if (filter === "upsell") {
    whereClauses.push(`a.upsell_purchased = 1`);
  }
  // SUPPORT-FILTER-WAITLIST-MOD10 batch: two new selectable filter values
  // added to this SAME single-filter `filter` param architecture (see
  // app/(portal)/admin/chats/page.js -- the existing filter tabs are
  // mutually-exclusive radio-style buttons, all|read|unread|upsell, one
  // active at a time), rather than inventing a parallel/second filter
  // system. Both reuse the EXACT SAME authoritative columns already
  // selected/returned below as accountWaitlistJoined/
  // accountModule10Watched (accounts.waitlist_joined_at IS NOT NULL, and
  // account_module_progress.completed_at for Module 10 -- NEVER
  // accounts.modules_unlocked/"Unlock All", per spec: Unlock All must
  // NOT count as Mod10 here). No new table/column, no duplicate customer
  // state.
  if (filter === "waitlist") {
    whereClauses.push(`a.waitlist_joined_at IS NOT NULL`);
  }
  if (filter === "mod10") {
    whereClauses.push(
      `EXISTS (SELECT 1 FROM account_module_progress amp
         WHERE amp.account_id = a.id AND amp.module_key = ${WITHDRAWALS_MODULE_10_GATE_ID}
           AND amp.completed_at IS NOT NULL)`
    );
  }
  // PAGINATION batch: the unread/read derivation (isUnread()) is now
  // pushed into SQL as well (it was previously computed in JS AFTER
  // fetching every row, which made LIMIT/OFFSET impossible to apply
  // correctly for these two filter values). The condition below is the
  // exact same boolean logic isUnread() implements: unread_override = 1
  // forces unread; unread_override = 0 forces read; otherwise fall back
  // to "has at least one unread customer message" via the same
  // unread_customer_count subquery already selected elsewhere in this
  // query.
  const UNREAD_SQL = `(
    c.unread_override = 1
    OR (
      (c.unread_override IS NULL)
      AND (SELECT COUNT(*) FROM support_messages m
             WHERE m.conversation_id = c.id AND m.sender_role = 'customer'
               AND m.read_at IS NULL AND m.deleted_at IS NULL) > 0
    )
  )`;
  if (filter === "unread") {
    whereClauses.push(UNREAD_SQL);
  }
  if (filter === "read") {
    whereClauses.push(`NOT ${UNREAD_SQL}`);
  }
  // Tag filter (conversation must have ALL listed tags): pushed into SQL
  // via a COUNT of matching conversation_tags rows equal to the number
  // of requested tag ids -- this is what lets tag-filtered pagination
  // use a real SQL LIMIT/OFFSET too, rather than the previous JS-side
  // post-filter.
  if (tagIds.length > 0) {
    const tagPlaceholders = tagIds.map(() => "?").join(",");
    whereClauses.push(
      `(SELECT COUNT(DISTINCT tag_id) FROM conversation_tags ct
          WHERE ct.conversation_id = c.id AND ct.tag_id IN (${tagPlaceholders})) = ?`
    );
    params.push(...tagIds, tagIds.length);
  }
  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  // PAGINATION batch: real SQL COUNT(*) against the EXACT SAME WHERE
  // clause/params as the main SELECT below -- this is the true total
  // count of the full matching dataset (search/filter/tags all already
  // applied), independent of page/pageSize.
  const totalCount = db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM conversations c
       JOIN accounts a ON a.id = c.account_id
       ${whereSql}`
    )
    .get(...params).c;

  const offset = (safePage - 1) * safePageSize;

  const rows = db
    .prepare(
      `SELECT
         c.id, c.account_id, c.created_at, c.last_message_at, c.unread_override,
         a.email as account_email, a.name as account_name,
         a.first_name as account_first_name, a.last_name as account_last_name,
         a.profile_photo_url as account_photo_url, a.upsell_purchased as account_upsell_purchased,
         a.waitlist_joined_at as account_waitlist_joined_at,
         (SELECT completed_at FROM account_module_progress
            WHERE account_module_progress.account_id = a.id
              AND account_module_progress.module_key = ${WITHDRAWALS_MODULE_10_GATE_ID}) as account_module10_completed_at,
         (SELECT COUNT(*) FROM support_messages m
            WHERE m.conversation_id = c.id AND m.sender_role = 'customer' AND m.read_at IS NULL AND m.deleted_at IS NULL) as unread_customer_count,
         (SELECT body FROM support_messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 1) as last_body,
         (SELECT sender_role FROM support_messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 1) as last_sender_role,
         (SELECT id FROM support_messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 1) as last_message_id,
         (SELECT att.id FROM support_message_attachments att
            WHERE att.message_id = (
              SELECT m3.id FROM support_messages m3 WHERE m3.conversation_id = c.id AND m3.deleted_at IS NULL
              ORDER BY m3.created_at DESC LIMIT 1
            )) as last_message_attachment_id
       FROM conversations c
       JOIN accounts a ON a.id = c.account_id
       ${whereSql}
       ORDER BY c.last_message_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, safePageSize, offset);

  const list = rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    accountEmail: r.account_email,
    accountName: r.account_name,
    accountFirstName: r.account_first_name,
    accountLastName: r.account_last_name,
    accountPhotoUrl: r.account_photo_url,
    accountUpsellPurchased: Boolean(r.account_upsell_purchased),
    accountWaitlistJoined: Boolean(r.account_waitlist_joined_at),
    accountModule10Watched: Boolean(r.account_module10_completed_at),
    createdAt: r.created_at,
    lastMessageAt: r.last_message_at,
    lastMessagePreview: buildPreviewText(r.last_body, Boolean(r.last_message_attachment_id)),
    lastSenderRole: r.last_sender_role || null,
    lastMessageId: r.last_message_id || null,
    unread: isUnread(r),
  }));

  // Attach tags for every conversation ON THIS PAGE in one query (never
  // N+1, and never needs to touch conversations outside the current
  // page since tags are purely a display concern here now that
  // filtering by tag happens in SQL above).
  if (list.length > 0) {
    const placeholders = list.map(() => "?").join(",");
    const tagRows = db
      .prepare(
        `SELECT ct.conversation_id, t.id as tag_id, t.name
         FROM conversation_tags ct JOIN support_tags t ON t.id = ct.tag_id
         WHERE ct.conversation_id IN (${placeholders})`
      )
      .all(...list.map((c) => c.id));
    const byConv = new Map();
    for (const row of tagRows) {
      if (!byConv.has(row.conversation_id)) byConv.set(row.conversation_id, []);
      byConv.get(row.conversation_id).push({ id: row.tag_id, name: row.name });
    }
    for (const c of list) {
      c.tags = byConv.get(c.id) || [];
    }
  }

  return { conversations: list, totalCount };
}

export function markConversationRead(db, conversationId) {
  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    db.prepare(
      `UPDATE support_messages SET read_at = ? WHERE conversation_id = ? AND sender_role = 'customer' AND read_at IS NULL AND deleted_at IS NULL`
    ).run(now, conversationId);
    db.prepare(`UPDATE conversations SET unread_override = 0 WHERE id = ?`).run(conversationId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function markConversationUnread(db, conversationId) {
  db.prepare(`UPDATE conversations SET unread_override = 1 WHERE id = ?`).run(conversationId);
}

// ---- Read receipts (Support read-receipts batch) -----------------------
//
// Two independent, symmetric "has the OTHER side actually viewed this
// message" facts, each stamped only by the ACTUAL recipient opening the
// relevant conversation (never by background polling, a conversation
// LIST fetch, or an unread-count calculation -- see the call sites of
// each function below, which are the sole places either is invoked):
//   - support_messages.read_at        -- has an ADMIN viewed this
//     CUSTOMER-authored message. Already existed (markConversationRead(),
//     called only from the admin single-conversation GET route -- see
//     that route's own comment for why opening the LIST never touches
//     this).
//   - support_messages.customer_read_at -- has the CUSTOMER viewed this
//     ADMIN-authored message. New in this batch. Set only here, only
//     from the customer's own Support-page GET (app/api/support/messages
//     route.js), which is the one authenticated, account-scoped place a
//     customer "opens" their Support conversation.
//
// Both are bulk, single-statement operations (spec: "mark all
// currently-visible/unread incoming messages in THAT conversation as
// read in one operation" -- never one request per message) and both are
// naturally idempotent: the WHERE ... IS NULL guard means calling either
// function again when there is nothing new to mark is a harmless no-op
// that touches zero rows and never overwrites an already-set timestamp
// (repeated polling can never keep bumping the read time forward).
//
// Authorization for customer-side marking is enforced entirely by the
// caller (GET /api/support/messages) always operating on
// getOrCreateConversation(db, account.id) for the AUTHENTICATED
// session's own account -- there is no conversationId parameter here at
// all, so this function can never be pointed at another customer's
// conversation, and an unauthenticated request never reaches this call
// (the route returns 401 first). Authorization for admin-side marking
// (markConversationRead, above) is enforced the same way one layer up,
// by requireAdmin() in the admin conversation GET route.
export function markAdminMessagesReadByCustomer(db, conversationId) {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE support_messages
     SET customer_read_at = ?
     WHERE conversation_id = ? AND sender_role = 'admin' AND customer_read_at IS NULL AND deleted_at IS NULL`
  ).run(now, conversationId);
}

// Part 4 (filter badge counts): total UNREAD conversation count using the
// exact same isUnread() derivation as the list above (unread_override
// override, else "has an unread customer message"), and total UPSELL
// conversation count (accounts.upsell_purchased = 1, joined through the
// SAME conversations table so this exactly matches what the Upsell
// filter itself returns). Both are single aggregate queries -- never a
// full-list fetch-then-count on the client.
//
// SUPPORT-TAGS-UPSELL-IMAGES-MULTILINE batch (spec Part 3, "Upsell count
// next to the Upsell icon"): upsellCount deliberately joins through
// `conversations` (one row per CUSTOMER account -- see getOrCreateConversation
// above, and lib/db.js `conversations.account_id ... UNIQUE(account_id)`)
// rather than counting `accounts` directly, which gives three
// requirements for free with zero extra logic:
//   - "do not count admins": admin accounts never have a conversations
//     row (only customer Support activity creates one), so an admin with
//     upsell_purchased somehow set could never be counted here.
//   - "avoid double-counting the same customer because of multiple
//     messages": this counts CONVERSATIONS (one per customer), never
//     support_messages rows, so a customer with 50 messages still counts
//     exactly once.
//   - "server-side count" / "no N+1 requests": one aggregate COUNT(*)
//     query, computed alongside the conversation list fetch (see
//     app/api/admin/support/conversations/route.js), never a per-row
//     client-side tally.
export function getSupportFilterCounts(db) {
  const rows = db
    .prepare(
      `SELECT c.unread_override,
         (SELECT COUNT(*) FROM support_messages m
            WHERE m.conversation_id = c.id AND m.sender_role = 'customer' AND m.read_at IS NULL AND m.deleted_at IS NULL) as unread_customer_count
       FROM conversations c`
    )
    .all();
  const unreadCount = rows.filter((r) => isUnread(r)).length;

  const upsellCount = db
    .prepare(
      `SELECT COUNT(*) as c FROM conversations conv
       JOIN accounts a ON a.id = conv.account_id
       WHERE a.upsell_purchased = 1`
    )
    .get().c;

  return { unreadCount, upsellCount };
}

// ---- Customer-facing "unread admin reply" indicator (Support nav tab) ---
//
// Deliberately independent of the admin-facing unread_override/
// unread_customer_count machinery above -- see lib/db.js's
// conversations.customer_unread column comment for why these must not
// be conflated. Persisted server-side (not a client-only/toast state) so
// it survives page navigation and reloads, and is only ever cleared by
// the customer actually opening/loading their own Support page.
export function getCustomerUnread(db, accountId) {
  const row = db
    .prepare(`SELECT customer_unread FROM conversations WHERE account_id = ?`)
    .get(accountId);
  return Boolean(row?.customer_unread);
}

export function markCustomerRead(db, accountId) {
  db.prepare(`UPDATE conversations SET customer_unread = 0 WHERE account_id = ?`).run(accountId);
}

export function listTags(db) {
  return db.prepare(`SELECT id, name FROM support_tags ORDER BY name ASC`).all();
}

export function createTag(db, name) {
  const trimmed = name.trim();
  if (!trimmed) return { error: "Tag name is required." };
  const existing = db.prepare(`SELECT id, name FROM support_tags WHERE name = ?`).get(trimmed);
  if (existing) return { tag: existing };
  const id = generateId("tag");
  db.prepare(`INSERT INTO support_tags (id, name, created_at) VALUES (?, ?, ?)`).run(
    id,
    trimmed,
    new Date().toISOString()
  );
  return { tag: { id, name: trimmed } };
}

export function setConversationTag(db, conversationId, tagId, assign) {
  if (assign) {
    db.prepare(
      `INSERT OR IGNORE INTO conversation_tags (conversation_id, tag_id, created_at) VALUES (?, ?, ?)`
    ).run(conversationId, tagId, new Date().toISOString());
  } else {
    db.prepare(`DELETE FROM conversation_tags WHERE conversation_id = ? AND tag_id = ?`).run(
      conversationId,
      tagId
    );
  }
}

export function getConversationTags(db, conversationId) {
  return db
    .prepare(
      `SELECT t.id, t.name FROM conversation_tags ct JOIN support_tags t ON t.id = ct.tag_id
       WHERE ct.conversation_id = ? ORDER BY t.name ASC`
    )
    .all(conversationId);
}

// Refinement pass: permanent tag deletion. Removes the tag itself AND
// every conversation_tags mapping referencing it, in a single
// transaction -- conversations and their messages are never touched.
// Idempotent: deleting a tag id that no longer exists is a safe no-op
// (returns deleted: false) rather than throwing, so a duplicate/retried
// delete request (e.g. a double-click) can't error.
export function deleteTag(db, tagId) {
  const existing = db.prepare(`SELECT id, name FROM support_tags WHERE id = ?`).get(tagId);
  if (!existing) {
    return { deleted: false, reason: "not_found" };
  }

  db.exec("BEGIN");
  try {
    db.prepare(`DELETE FROM conversation_tags WHERE tag_id = ?`).run(tagId);
    db.prepare(`DELETE FROM support_tags WHERE id = ?`).run(tagId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return { deleted: true, tag: existing };
}

// ---- Admin edit/delete for Support messages (ISP support controls +
// special bridges batch) ------------------------------------------------
//
// Both operations are ADMIN-ONLY at the ROUTE layer (see
// app/api/admin/support/conversations/[id]/messages/[messageId]/route.js
// -- requireAdmin() there, never trusted from this shared engine layer
// alone) -- these functions themselves do not re-check role, matching
// this codebase's existing pattern (e.g. postMessage() also does not
// re-check auth; that is the calling route's job).

// Edits an EXISTING message's body in place, preserving: sender_role,
// sender_account_id, created_at (original send time -- NEVER reset by an
// edit, per spec section 12), read_at, and any attachment row (editing
// text never touches support_message_attachments). Sets edited_at to
// now on every successful edit (additive metadata only -- see the
// lib/db.js column comment). Returns { ok: false, reason: "not_found" }
// for an unknown/already-deleted message id (deleted_at IS NOT NULL is
// treated as "not found" here so an edit can never resurrect or mutate a
// soft-deleted message's body).
export function editMessage(db, messageId, newBody) {
  const existing = db
    .prepare(`SELECT * FROM support_messages WHERE id = ? AND deleted_at IS NULL`)
    .get(messageId);
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }

  // Per spec section 6: an image-only message (no body, has an
  // attachment) may still be edited to ADD a text body cleanly -- this
  // is allowed here (the route layer decides whether to expose that UI
  // affordance); an edit is only rejected for having an entirely empty
  // result when the message would ALSO have no attachment (mirrors the
  // existing "message cannot be empty" rule the send routes already
  // enforce).
  const hasAttachment = Boolean(
    db.prepare(`SELECT id FROM support_message_attachments WHERE message_id = ?`).get(messageId)
  );
  const trimmed = typeof newBody === "string" ? newBody : "";
  if (!trimmed && !hasAttachment) {
    return { ok: false, reason: "empty_message" };
  }
  if (trimmed.length > 4000) {
    return { ok: false, reason: "too_long" };
  }

  const now = new Date().toISOString();
  db.prepare(`UPDATE support_messages SET body = ?, edited_at = ? WHERE id = ?`).run(
    trimmed,
    now,
    messageId
  );

  return { ok: true, id: messageId, body: trimmed, editedAt: now };
}

// Soft-deletes a message (sets deleted_at) -- the row and any attachment
// metadata/file remain in the database/filesystem (never a hard DELETE,
// per spec section 7: "Prefer the safest architecture supported by the
// existing schema... the deleted message must be completely hidden from
// normal customer/admin chat rendering and APIs"). getMessages() and
// every conversation-list/preview/unread query above already filter on
// `deleted_at IS NULL`, so a soft-deleted message is immediately and
// completely invisible through every normal read path the instant this
// commits.
//
// Also recomputes the conversation's last_message_at / customer_unread
// state so the admin inbox's preview text updates correctly when the
// LATEST message in a conversation is deleted (spec section 7: "the
// conversation preview should update correctly") -- reusing the exact
// same "most recent non-deleted message" derivation
// listConversationsForAdmin() already performs at read time, so no
// separate/duplicate logic is introduced; last_message_at itself is left
// as the true historical last-activity timestamp on this table (this
// column is also used for admin inbox sort order, which should reflect
// genuine conversation activity, not just non-deleted activity) --
// deleting a message never reduces or rewrites last_message_at, since
// the ORDER BY last_message_at DESC sort should still reflect when the
// conversation was last touched even if that specific message was later
// removed.
export function deleteMessage(db, messageId) {
  const existing = db
    .prepare(`SELECT * FROM support_messages WHERE id = ? AND deleted_at IS NULL`)
    .get(messageId);
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }

  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    db.prepare(`UPDATE support_messages SET deleted_at = ? WHERE id = ?`).run(now, messageId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  // Attachment cleanup (spec section 7): if this message had an image
  // and it is now unreferenced by any NON-deleted message, the caller
  // (the DELETE route) is responsible for calling
  // lib/supportUploads.js#readSupportImage/unlink via the attachment's
  // own storage_key -- kept OUT of this function so this engine module
  // never touches the filesystem directly (matching its existing
  // separation of concerns: postMessageInner() above also never calls
  // saveSupportImageUpload() itself, the callers do). The attachment
  // METADATA row is intentionally left in place (never deleted) since
  // support_message_attachments.message_id still legitimately points at
  // a real (soft-deleted) support_messages row, and no code path can
  // ever resolve a hidden message's attachment id back to bytes anyway
  // (the attachments GET route below is scoped to the message's
  // conversation via a join that already excludes deleted messages).
  const attachment = db
    .prepare(`SELECT storage_key FROM support_message_attachments WHERE message_id = ?`)
    .get(messageId);

  return { ok: true, id: messageId, conversationId: existing.conversation_id, attachmentStorageKey: attachment?.storage_key || null };
}
