import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { listConversationsForAdmin } from "@/lib/supportEngine";

// Admin conversation list: customer name/email, last-message preview,
// exact timestamp of the most recent message, unread indicator, tags.
// Sorted newest activity first by default (see listConversationsForAdmin).
// Supports ?filter=all|read|unread and ?tags=id1,id2 (conversation must
// have ALL listed tags).
export async function GET(request) {
  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const { searchParams } = new URL(request.url);
  const filter = searchParams.get("filter") || "all";
  const tagIds = (searchParams.get("tags") || "").split(",").filter(Boolean);

  const db = getDb();
  const conversations = listConversationsForAdmin(db, { filter, tagIds });

  return NextResponse.json({ conversations });
}
