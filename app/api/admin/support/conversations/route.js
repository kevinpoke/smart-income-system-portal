import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { listConversationsForAdmin, getSupportFilterCounts } from "@/lib/supportEngine";

// Admin conversation list: customer name/email, last-message preview,
// exact timestamp of the most recent message, unread indicator, tags.
// Sorted newest activity first by default (see listConversationsForAdmin).
// Supports ?filter=all|read|unread|upsell, ?tags=id1,id2 (conversation
// must have ALL listed tags), and ?search=<text> (Part 3: case-
// insensitive partial match against first/last/full name/email,
// server-side, combined with whichever filter/tag is also active).
//
// Also returns `counts` (Part 4: Unread / Upsell badge counts) computed
// via one small aggregate query each -- unaffected by the current
// filter/search so the badges always reflect the TRUE total counts, not
// a filtered subset.
export async function GET(request) {
  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const { searchParams } = new URL(request.url);
  const filter = searchParams.get("filter") || "all";
  const tagIds = (searchParams.get("tags") || "").split(",").filter(Boolean);
  const search = searchParams.get("search") || "";

  const db = getDb();
  const conversations = listConversationsForAdmin(db, { filter, tagIds, search });
  const counts = getSupportFilterCounts(db);

  return NextResponse.json({ conversations, counts });
}
