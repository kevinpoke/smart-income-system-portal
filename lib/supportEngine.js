import { generateId } from "./auth-crypto";

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

function isDuplicateSubmit(db, conversationId, senderRole, senderAccountId, body) {
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

export function postMessage(db, { conversationId, senderRole, senderAccountId = null, body }) {
  if (isDuplicateSubmit(db, conversationId, senderRole, senderAccountId, body)) {
    return { duplicate: true };
  }

  const now = new Date().toISOString();
  const id = generateId("msg");

  db.exec("BEGIN");
  try {
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

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return { duplicate: false, id, createdAt: now };
}

export function getMessages(db, conversationId, customerAccountId = null) {
  const rows = db
    .prepare(
      `SELECT id, sender_role, sender_account_id, body, created_at, read_at
       FROM support_messages WHERE conversation_id = ? ORDER BY created_at ASC`
    )
    .all(conversationId);

  return enrichMessagesWithIdentity(db, rows, customerAccountId);
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
      senderFirstName: admin?.first_name || "Ashley",
      senderPhotoUrl: admin?.profile_photo_url || null,
    };
  });
}

function isUnread(row) {
  if (row.unread_override === 1) return true;
  if (row.unread_override === 0) return false;
  return row.unread_customer_count > 0;
}

// Admin-facing conversation list: customer name/email, last-message
// preview + timestamp, unread indicator, tags, sorted newest-activity
// first. Supports filter = 'all' | 'read' | 'unread' and an optional set
// of tagIds to filter by (conversation must have ALL listed tags).
export function listConversationsForAdmin(db, { filter = "all", tagIds = [] } = {}) {
  const rows = db
    .prepare(
      `SELECT
         c.id, c.account_id, c.created_at, c.last_message_at, c.unread_override,
         a.email as account_email, a.name as account_name,
         a.first_name as account_first_name, a.profile_photo_url as account_photo_url,
         (SELECT COUNT(*) FROM support_messages m
            WHERE m.conversation_id = c.id AND m.sender_role = 'customer' AND m.read_at IS NULL) as unread_customer_count,
         (SELECT body FROM support_messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_body,
         (SELECT sender_role FROM support_messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_sender_role
       FROM conversations c
       JOIN accounts a ON a.id = c.account_id
       ORDER BY c.last_message_at DESC`
    )
    .all();

  let list = rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    accountEmail: r.account_email,
    accountName: r.account_name,
    accountFirstName: r.account_first_name,
    accountPhotoUrl: r.account_photo_url,
    createdAt: r.created_at,
    lastMessageAt: r.last_message_at,
    lastMessagePreview: r.last_body || "",
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
