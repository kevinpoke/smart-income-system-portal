import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentAccountRaw, toPublicAccount } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";

// Production feature/fix batch: clears the customer-facing ISP Setup
// nav-tab unread indicator (accounts.isp_unread). Mirrors the existing
// Support pattern exactly (see app/api/support/messages/route.js GET,
// which clears conversations.customer_unread the moment the customer
// loads the Support page) -- "opened the page" is the one and only
// clearing signal here too. This is a dedicated POST rather than being
// folded into GET /api/auth/me, because /api/auth/me is read by every
// page/component in the portal (Header, Sidebar, Dashboard, etc.), not
// just the ISP Setup page -- clearing the flag there would clear it the
// instant ANY page loads, not only when the customer actually visits ISP
// Setup, which would break "cleared ONLY when the customer visits the
// ISP Setup page" from spec. The ISP Setup page's own mount effect calls
// this once, then calls useAccount()'s refetch() (same pattern as the
// Support page) so the sidebar dot disappears without a hard refresh.
export async function POST(request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const db = getDb();
  db.prepare(`UPDATE accounts SET isp_unread = 0 WHERE id = ?`).run(account.id);

  const updated = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(account.id);
  return NextResponse.json({ ok: true, account: toPublicAccount(updated) });
}
