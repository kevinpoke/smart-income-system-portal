import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { markConversationUnread } from "@/lib/supportEngine";

// Admin action: "Mark Unread" -- restores the green unread indicator for
// a conversation regardless of per-message read state. Available both via
// a right-click context menu and a regular button in the UI (this route
// serves both call sites identically).
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
  const conversation = db.prepare(`SELECT id FROM conversations WHERE id = ?`).get(conversationId);
  if (!conversation) {
    return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  }

  markConversationUnread(db, conversationId);
  return NextResponse.json({ ok: true });
}
