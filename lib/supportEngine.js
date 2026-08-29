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
       WHERE conversation_id = ? AND sender_role = ?
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
      `SELECT id, sender_role, sender_account_id, body, created_at, read_at
       FROM support_messages WHERE conversation_id = ? ORDER BY created_at ASC`
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
export function listConversationsForAdmin(db, { filter = "all", tagIds = [], search = "" } = {}) {
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
  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

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
            WHERE m.conversation_id = c.id AND m.sender_role = 'customer' AND m.read_at IS NULL) as unread_customer_count,
         (SELECT body FROM support_messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_body,
         (SELECT sender_role FROM support_messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_sender_role,
         (SELECT att.id FROM support_message_attachments att
            WHERE att.message_id = (
              SELECT m3.id FROM support_messages m3 WHERE m3.conversation_id = c.id
              ORDER BY m3.created_at DESC LIMIT 1
            )) as last_message_attachment_id
       FROM conversations c
       JOIN accounts a ON a.id = c.account_id
       ${whereSql}
       ORDER BY c.last_message_at DESC`
    )
    .all(...params);

  let list = rows.map((r) => ({
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
    unread: isUnread(r),
  }));

  if (filter === "read") list = list.filter((c) => !c.unread);
  if (filter === "unread") list = list.filter((c) => c.unread);

  if (tagIds.length > 0) {
    const tagRows = db
      .prepare(
        `SELECT conversation_id, tag_id FROM conversation_tags WHERE conversation_id IN (${list
          .map(() => "?")
          .join(",") || "''"})`
      )
      .all(...list.map((c) => c.id));
    const tagsByConv = new Map();
    for (const row of tagRows) {
      if (!tagsByConv.has(row.conversation_id)) tagsByConv.set(row.conversation_id, new Set());
      tagsByConv.get(row.conversation_id).add(row.tag_id);
    }
    list = list.filter((c) => {
      const convTags = tagsByConv.get(c.id) || new Set();
      return tagIds.every((t) => convTags.has(t));
    });
  }

  // Attach tags for every remaining conversation in one query.
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

  return list;
}

export function markConversationRead(db, conversationId) {
  const now = new Date().toISOString();
  db.exec("BEGIN");
  try {
    db.prepare(
      `UPDATE support_messages SET read_at = ? WHERE conversation_id = ? AND sender_role = 'customer' AND read_at IS NULL`
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
            WHERE m.conversation_id = c.id AND m.sender_role = 'customer' AND m.read_at IS NULL) as unread_customer_count
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
