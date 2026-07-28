import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentAccountRaw, toPublicAccount } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { setWifiEnabled } from "@/lib/wifiEngine";

// Customer-controlled WiFi on/off toggle. Only the authenticated customer
// may change their OWN state (account id is always taken from the
// session, never from the request body). The toggle is only meaningful
// once a Node is actually connected (isp_status === 'active' and the
// initial 20-second connection process is complete) -- attempting to
// toggle before that is rejected rather than silently allowed.
//
// The client is responsible for calling notifyAccountChanged() (see
// lib/accountEvents.js) after a successful response so every mounted
// useAccount()/useEarningsSummary() consumer refetches immediately
// without a hard refresh -- that broadcast is a browser-only concern and
// deliberately lives outside this server route.
export async function POST(request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: '"enabled" (boolean) is required.' }, { status: 400 });
  }

  const db = getDb();
  const fresh = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(account.id);

  if (fresh.isp_status !== "active" || !fresh.node_connected_at) {
    return NextResponse.json(
      { error: "WiFi control is only available after your ISP Setup connection is complete." },
      { status: 409 }
    );
  }

  const result = setWifiEnabled(db, account.id, body.enabled);
  const updated = result.account || fresh;

  return NextResponse.json({ ok: true, account: toPublicAccount(updated) });
}

