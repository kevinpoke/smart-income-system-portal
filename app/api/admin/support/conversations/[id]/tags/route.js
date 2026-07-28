import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { setConversationTag } from "@/lib/supportEngine";

// Assign or unassign a tag to a conversation.
export async function POST(request, { params }) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const { id: conversationId } = await params;
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { tagId, assign } = body;
  if (!tagId || typeof assign !== "boolean") {
    return NextResponse.json({ error: '"tagId" and "assign" (boolean) are required.' }, { status: 400 });
  }

  const db = getDb();
  const conversation = db.prepare(`SELECT id FROM conversations WHERE id = ?`).get(conversationId);
  if (!conversation) {
    return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  }
  const tag = db.prepare(`SELECT id FROM support_tags WHERE id = ?`).get(tagId);
  if (!tag) {
    return NextResponse.json({ error: "Tag not found." }, { status: 404 });
  }

  setConversationTag(db, conversationId, tagId, assign);
  return NextResponse.json({ ok: true });
}
