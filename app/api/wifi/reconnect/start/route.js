import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentAccountRaw, toPublicAccount } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { startWifiReconnect } from "@/lib/wifiEngine";

// Begins the OFF -> ON reconnection flow. Only the authenticated customer
// may start their OWN reconnection (account id always taken from the
// session). Idempotent/concurrency-safe: calling this while a
// reconnection is already in progress returns the EXISTING start
// timestamp rather than resetting the 20-second clock, so a double-click
// or a page refresh that re-fires this call can never extend or restart
// the window (see lib/wifiEngine.js startWifiReconnect for the guard).
//
// This does NOT mark wifi_enabled = 1 -- the account remains OFF (no
// earnings accrue) until POST /api/wifi/reconnect/complete is called AND
// the server independently confirms the full 20 seconds has elapsed.
export async function POST(request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const db = getDb();
  const result = startWifiReconnect(db, account.id);

  if (!result.ok) {
    const messages = {
      not_eligible:
        "WiFi control is only available after your ISP Setup connection is complete.",
      already_on: "WiFi is already connected.",
      not_found: "Account not found.",
    };
    return NextResponse.json(
      { error: messages[result.reason] || "Unable to start reconnection." },
      { status: 409 }
    );
  }

  const fresh = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(account.id);

  return NextResponse.json({
    ok: true,
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    readyAt: result.readyAt,
    account: toPublicAccount(fresh),
  });
}
