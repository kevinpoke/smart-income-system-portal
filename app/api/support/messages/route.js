import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentAccountRaw } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { getOrCreateConversation, getMessages, postMessage, markCustomerRead } from "@/lib/supportEngine";
import { deliverDueMessages } from "@/lib/supportAutomation";
import { saveSupportImageUpload } from "@/lib/supportUploads";

// Customer's own support conversation. Always scoped to the authenticated
// session's account id -- there is no conversation/account id parameter
// anywhere in this route, so a customer can never read or post into
// another customer's conversation.

// Small in-memory rate limiter, same pattern as app/api/auth/login/route.js.
const sendAttempts = new Map(); // accountId -> { count, firstAttemptAt }
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 30; // generous for legitimate back-and-forth chat

function isRateLimited(accountId) {
  const now = Date.now();
  const entry = sendAttempts.get(accountId);
  if (!entry) return false;
  if (now - entry.firstAttemptAt > WINDOW_MS) {
    sendAttempts.delete(accountId);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordAttempt(accountId) {
  const now = Date.now();
  const entry = sendAttempts.get(accountId);
  if (!entry || now - entry.firstAttemptAt > WINDOW_MS) {
    sendAttempts.set(accountId, { count: 1, firstAttemptAt: now });
  } else {
    entry.count += 1;
  }
}

// Portal reliability pass: GET now also clears the persistent
// customer-facing unread indicator (see lib/supportEngine.js
// getCustomerUnread/markCustomerRead) -- per spec, the badge on the
// Support nav tab "must be cleared only when the customer opens or taps
// the Support tab/page," and loading this route IS that action (the
// Support page's own useEffect calls this on mount). This route is also
// polled every few seconds while the Support page stays open (see
// app/(portal)/support/page.js) so an admin reply appears automatically
// without a hard refresh.
export async function GET() {
  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const db = getDb();
  // Production feature/fix batch: deliver any due scheduled automated
  // messages (welcome / check-in / ISP-approved) before reading the
  // conversation, so a customer who opens Support after the delivery
  // window has elapsed sees them immediately rather than on some later
  // request. See lib/supportAutomation.js.
  deliverDueMessages(db, account.id);
  const conversation = getOrCreateConversation(db, account.id);
  const messages = getMessages(db, conversation.id, account.id);
  markCustomerRead(db, account.id);

  return NextResponse.json({
    conversationId: conversation.id,
    messages: messages.map((m) => ({
      id: m.id,
      senderRole: m.sender_role,
      body: m.body,
      createdAt: m.created_at,
      editedAt: m.edited_at,
      senderFirstName: m.senderFirstName,
      senderPhotoUrl: m.senderPhotoUrl,
      attachment: m.attachment,
    })),
  });
}

export async function POST(request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  if (isRateLimited(account.id)) {
    return NextResponse.json(
      { error: "You're sending messages too quickly. Please wait a moment and try again." },
      { status: 429 }
    );
  }

  // Image messages (Support Chat image composer batch): multipart/
  // form-data when attaching an image (fields "text" + "image"), plain
  // JSON ({ text }) for text-only sends -- both remain supported. The
  // customer can ONLY ever upload into their own conversation (there is
  // no conversation/account id anywhere in this request -- see the file
  // header comment), so this cannot be abused to attach an image to
  // another customer's thread.
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

  recordAttempt(account.id);

  const db = getDb();
  const conversation = getOrCreateConversation(db, account.id);
  const result = postMessage(db, {
    conversationId: conversation.id,
    senderRole: "customer",
    body: text,
    attachment,
  });

  if (result.duplicate) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  return NextResponse.json({ ok: true, id: result.id, createdAt: result.createdAt });
}
