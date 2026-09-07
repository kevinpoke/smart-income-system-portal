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
import { saveSupportImageUpload } from "@/lib/supportUploads";
import { WITHDRAWALS_MODULE_10_GATE_ID } from "@/lib/mockData";

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
  // Admin-portal batch (Support header tags, spec sections C-E): reuse
  // the EXACT SAME authoritative columns/subquery shapes
  // lib/supportEngine.js#listConversationsForAdmin() already reads for
  // the left conversation-list row badges (accounts.upsell_purchased,
  // accounts.waitlist_joined_at, and the account_module_progress
  // completed_at subquery for WITHDRAWALS_MODULE_10_GATE_ID) -- NOT a
  // second/duplicate tag computation. Fetched in this SAME single query
  // (no extra round-trip, no N+1) so the header can render immediately
  // alongside the rest of the conversation detail response.
  const account = db
    .prepare(
      `SELECT id, email, name, first_name, last_name, profile_photo_url,
              upsell_purchased, waitlist_joined_at,
              (SELECT completed_at FROM account_module_progress
                 WHERE account_module_progress.account_id = accounts.id
                   AND account_module_progress.module_key = ${WITHDRAWALS_MODULE_10_GATE_ID}) as module10_completed_at
       FROM accounts WHERE id = ?`
    )
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
      // Same three automatic-tag booleans the left conversation list
      // already exposes as accountUpsellPurchased/accountWaitlistJoined/
      // accountModule10Watched -- identical field names/semantics so the
      // header and the list row can never disagree.
      accountUpsellPurchased: Boolean(account?.upsell_purchased),
      accountWaitlistJoined: Boolean(account?.waitlist_joined_at),
      accountModule10Watched: Boolean(account?.module10_completed_at),
    },
    messages: messages.map((m) => ({
      id: m.id,
      senderRole: m.sender_role,
      body: m.body,
      createdAt: m.created_at,
      editedAt: m.edited_at,
      readAt: m.read_at,
      // Read-receipts batch: has the CUSTOMER actually viewed this
      // admin-authored message (see lib/db.js support_messages.
      // customer_read_at, and lib/supportEngine.js
      // markAdminMessagesReadByCustomer(), which is the ONLY writer of
      // this column -- fired exclusively from the customer's own
      // Support-page GET, never from anything admin-side). Only ever
      // non-null on sender_role = 'admin' rows.
      customerReadAt: m.customer_read_at,
      senderFirstName: m.senderFirstName,
      senderPhotoUrl: m.senderPhotoUrl,
      attachment: m.attachment,
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

  // Image messages (Support Chat image composer batch): the client sends
  // multipart/form-data when attaching an image (fields "text" + "image"),
  // and plain JSON ({ text }) for text-only sends -- both remain
  // supported so this route is fully backward compatible with any
  // existing caller that only ever sent JSON.
  const contentType = request.headers.get("content-type") || "";
  let text = "";
  let imageFile = null;

  if (contentType.includes("multipart/form-data")) {
    let formData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
    }
    const rawText = formData.get("text");
    text = typeof rawText === "string" ? rawText.trim() : "";
    const file = formData.get("image");
    if (file && typeof file === "object" && typeof file.arrayBuffer === "function" && file.size > 0) {
      imageFile = file;
    }
  } else {
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
    }
    text = typeof body.text === "string" ? body.text.trim() : "";
  }

  // Per spec Part 15: an image-only message is allowed, but a message
  // with neither text nor an image is never sent.
  if (!text && !imageFile) {
    return NextResponse.json({ error: "Message cannot be empty." }, { status: 400 });
  }
  if (text.length > 4000) {
    return NextResponse.json({ error: "Message is too long." }, { status: 400 });
  }

  let attachment = null;
  if (imageFile) {
    try {
      const saved = await saveSupportImageUpload(imageFile);
      attachment = {
        storageKey: saved.storageKey,
        mimeType: saved.mimeType,
        sizeBytes: saved.sizeBytes,
        originalFilename: typeof imageFile.name === "string" ? imageFile.name.slice(0, 255) : null,
      };
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Unable to upload image." },
        { status: 400 }
      );
    }
  }

  const result = postMessage(db, {
    conversationId,
    senderRole: "admin",
    senderAccountId: guard.account.id,
    body: text,
    attachment,
  });

  if (result.duplicate) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  return NextResponse.json({ ok: true, id: result.id, createdAt: result.createdAt });
}
