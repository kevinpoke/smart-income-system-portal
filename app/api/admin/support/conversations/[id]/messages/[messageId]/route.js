import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { editMessage, deleteMessage } from "@/lib/supportEngine";
import { deleteSupportImage } from "@/lib/supportUploads";

// Admin-only edit/delete for an individual Support message (ISP support
// controls + special bridges batch, spec sections 6-9). ADMIN-ONLY at
// this route layer via requireAdmin() -- there is no customer-facing
// route that reaches lib/supportEngine.js#editMessage/deleteMessage at
// all, so a customer attempting either action gets rejected before any
// message lookup even happens (spec section 8: "Customer must receive
// rejection for attempts to edit/delete own or admin messages").
//
// Both routes are scoped to `conversationId` (the [id] param) AND
// `messageId` -- the message is looked up by id and its
// conversation_id is cross-checked against the URL's conversationId, so
// a request can never edit/delete a message that does not actually
// belong to the conversation named in the URL (defense-in-depth; the
// message id alone is already a strong, unguessable identifier, but
// this keeps the URL's own scoping meaningful and auditable).
function loadScopedMessage(db, conversationId, messageId) {
  return db
    .prepare(
      `SELECT * FROM support_messages WHERE id = ? AND conversation_id = ? AND deleted_at IS NULL`
    )
    .get(messageId, conversationId);
}

export async function PATCH(request, { params }) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const { id: conversationId, messageId } = await params;
  const db = getDb();

  const existing = loadScopedMessage(db, conversationId, messageId);
  if (!existing) {
    return NextResponse.json({ error: "Message not found." }, { status: 404 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  // Preserves multiline/newline formatting exactly as typed -- this is
  // plain string passthrough (never trimmed/collapsed), matching how the
  // ORIGINAL send routes already store `text` (see
  // app/api/support/messages/route.js and the admin conversation POST
  // route, both of which only .trim() the OUTER whitespace, never
  // interior newlines).
  const newBody = typeof body.text === "string" ? body.text : "";

  const result = editMessage(db, messageId, newBody);
  if (!result.ok) {
    if (result.reason === "not_found") {
      return NextResponse.json({ error: "Message not found." }, { status: 404 });
    }
    if (result.reason === "empty_message") {
      return NextResponse.json({ error: "Message cannot be empty." }, { status: 400 });
    }
    if (result.reason === "too_long") {
      return NextResponse.json({ error: "Message is too long." }, { status: 400 });
    }
    return NextResponse.json({ error: "Unable to edit message." }, { status: 400 });
  }

  return NextResponse.json({ ok: true, id: result.id, body: result.body, editedAt: result.editedAt });
}

export async function DELETE(request, { params }) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const { id: conversationId, messageId } = await params;
  const db = getDb();

  const existing = loadScopedMessage(db, conversationId, messageId);
  if (!existing) {
    return NextResponse.json({ error: "Message not found." }, { status: 404 });
  }

  const result = deleteMessage(db, messageId);
  if (!result.ok) {
    return NextResponse.json({ error: "Unable to delete message." }, { status: 400 });
  }

  // Attachment cleanup (spec section 7): if this message had an image,
  // and NO OTHER non-deleted message references the same storage_key
  // (storage keys are always unique-per-upload -- see
  // lib/supportUploads.js#saveSupportImageUpload's crypto.randomBytes
  // naming -- so in practice this check is always true, but it is kept
  // explicit and defensive rather than assumed), remove the file from
  // disk. The attachment METADATA row itself is left in place (see
  // lib/supportEngine.js#deleteMessage's comment for why).
  if (result.attachmentStorageKey) {
    const stillReferenced = db
      .prepare(
        `SELECT att.id FROM support_message_attachments att
         JOIN support_messages m ON m.id = att.message_id
         WHERE att.storage_key = ? AND m.deleted_at IS NULL`
      )
      .get(result.attachmentStorageKey);
    if (!stillReferenced) {
      deleteSupportImage(result.attachmentStorageKey);
    }
  }

  return NextResponse.json({ ok: true, id: result.id });
}
