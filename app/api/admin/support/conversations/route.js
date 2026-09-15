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
// PAGINATION batch: also supports ?page= (1-indexed, default 1) and
// ?pageSize= (one of 30/50/100/200/500, default 30) -- both validated
// here (invalid/out-of-range values fall back to the default rather
// than being rejected outright, matching this route's existing
// permissive-default style for filter/search params) and passed through
// to listConversationsForAdmin(), which performs REAL SQL LIMIT/OFFSET
// pagination (never fetch-everything-then-slice-in-JS). The response
// now also echoes back `totalCount`, `page`, and `pageSize` so the
// (future) UI layer can render page controls without re-deriving them.
//
// Also returns `counts` (Part 4: Unread / Upsell badge counts) computed
// via one small aggregate query each -- unaffected by the current
// filter/search/page/pageSize so the badges always reflect the TRUE
// total counts, not a filtered/paged subset.
const ALLOWED_PAGE_SIZES = [30, 50, 100, 200, 500];

export async function GET(request) {
  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const { searchParams } = new URL(request.url);
  const filter = searchParams.get("filter") || "all";
  const tagIds = (searchParams.get("tags") || "").split(",").filter(Boolean);
  const search = searchParams.get("search") || "";

  const rawPage = Number.parseInt(searchParams.get("page"), 10);
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;

  const rawPageSize = Number.parseInt(searchParams.get("pageSize"), 10);
  const pageSize = ALLOWED_PAGE_SIZES.includes(rawPageSize) ? rawPageSize : 30;

  const db = getDb();
  const { conversations, totalCount } = listConversationsForAdmin(db, {
    filter,
    tagIds,
    search,
    page,
    pageSize,
  });
  const counts = getSupportFilterCounts(db);

  return NextResponse.json({ conversations, counts, totalCount, page, pageSize });
}
