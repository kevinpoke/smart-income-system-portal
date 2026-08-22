import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import {
  getMessages,
  markConversationRead,
  postMessage,
  getConversationTags,
} from "@/lib/supportEngine";

// Single conversation detail for the admin inbox. GET marks incoming
// customer messages as read (per spec: "Opening a conversation marks
// incoming customer messages as read"). POST sends an admin reply.
// Role-protected server-side via requireAdmin() -- proxy.js also blocks
// non-admins from /api/admin/* at the edge, but this route independently
// re-verifies per the defense-in-depth rule used throughout the app.
export async function GET(request, { params }) {
  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const { id: conversationId } = await params;
  const db = getDb();

  const conversation = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(conversationId);
  if (!conversation) {
    return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  }

  // Part 5 (unread logic): this GET is the ONE and ONLY place an
  // admin-facing conversation is marked read -- it only runs when the
  // admin actually loads a specific conversation's detail (manually
  // "opens/taps into" it from the inbox UI). No other route in this app
  // calls markConversationRead(): automated messages (postMessageInner's
  // admin branch, lib/supportAutomation.js deliverDueMessages) and the
  // admin broadcast route (app/api/admin/support/broadcast, which sends
  // without opening any single chat) only ever touch conversations'
  // CUSTOMER-facing customer_unread flag, never this ADMIN-facing
  // unread_override/unread_customer_count state -- confirmed by
  // grepping every write site of unread_override in the codebase.
  markConversationRead(db, conversationId);

  const messages = getMessages(db, conversationId, conversation.account_id);
  const tags = getConversationTags(db, conversationId);
  const account = db
    .prepare(`SELECT id, email, name, first_name, last_name, profile_photo_url FROM accounts WHERE id = ?`)
    .get(conversation.account_id);

  return NextResponse.json({
    conversation: {
      id: conversation.id,
      accountId: conversation.account_id,
      accountEmail: account?.email,
      accountName: account?.name,
      accountFirstName: account?.first_name,
      accountLastName: account?.last_name,
      accountPhotoUrl: account?.profile_photo_url,
      tags,
    },
    messages: messages.map((m) => ({
      id: m.id,
      senderRole: m.sender_role,
      body: m.body,
      createdAt: m.created_at,
      readAt: m.read_at,
      senderFirstName: m.senderFirstName,
      senderPhotoUrl: m.senderPhotoUrl,
    })),
  });
}

export async function POST(request, { params }) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const { id: conversationId } = await params;
  const db = getDb();

  const conversation = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(conversationId);
  if (!conversation) {
    return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "Message cannot be empty." }, { status: 400 });
  }
  if (text.length > 4000) {
    return NextResponse.json({ error: "Message is too long." }, { status: 400 });
  }

  const result = postMessage(db, {
    conversationId,
    senderRole: "admin",
    senderAccountId: guard.account.id,
    body: text,
  });

  if (result.duplicate) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  return NextResponse.json({ ok: true, id: result.id, createdAt: result.createdAt });
}
