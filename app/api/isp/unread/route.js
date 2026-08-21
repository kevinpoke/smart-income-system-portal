import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentAccountRaw } from "@/lib/session";
import { checkAndAutoApproveIsp } from "@/lib/ispEngine";

// Production feature/fix batch: lightweight, read-only "does this
// customer have an unread ISP status change" check for the ISP Setup
// nav-tab indicator (Sidebar/MobileNav). Mirrors GET /api/support/unread
// exactly -- deliberately does NOT clear isp_unread (only POST
// /api/isp/mark-seen, called when the customer actually loads the ISP
// Setup page, does that), and is polled independently of whatever page
// is currently mounted so the dot appears automatically without the
// customer needing to do anything beyond normal navigation/polling.
//
// Also runs the server-authoritative 3-day auto-approval check on every
// poll (same as GET /api/auth/me) -- this is what makes the auto-approve
// -> isp_unread=1 transition visible on the Sidebar/MobileNav dot within
// one poll interval even if the customer never visits the ISP Setup page
// or the Dashboard, satisfying "the ISP dot becomes visible without
// requiring extra manual action beyond normal polling."
export async function GET() {
  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const db = getDb();
  const fresh = checkAndAutoApproveIsp(db, account);

  return NextResponse.json({ unread: Boolean(fresh.isp_unread) });
}
