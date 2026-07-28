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
    // not change the customer-unread state.
    if (senderRole === "customer") {
      db.prepare(
        `UPDATE conversations SET last_message_at = ?, unread_override = NULL WHERE id = ?`
      ).run(now, conversationId);
    } else {
      db.prepare(`UPDATE conversations SET last_message_at = ? WHERE id = ?`).run(now, conversationId);
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return { duplicate: false, id, createdAt: now };
}

export function getMessages(db, conversationId) {
  return db
    .prepare(
      `SELECT id, sender_role, sender_account_id, body, created_at, read_at
       FROM support_messages WHERE conversation_id = ? ORDER BY created_at ASC`
    )
    .all(conversationId);
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
