import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentAccountRaw, toPublicAccount } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { completeWifiReconnect } from "@/lib/wifiEngine";

// Completes the OFF -> ON reconnection flow. The client calls this once
// its 20-second visual progress bar reaches 100%, but the SERVER
// independently re-validates that at least 20 real seconds have elapsed
// since the persisted wifi_reconnect_started_at (lib/wifiEngine.js
// completeWifiReconnect) before actually marking the account connected --
// a client that raced ahead or manipulated its own timer cannot shorten
// the real waiting period, since the check is against a server-persisted
// timestamp, not anything the client sends.
//
// Only on success does this: (1) set wifi_enabled = 1, (2) set
// wifi_state_since to the completion instant (so Header uptime and
// earnings accrual both start fresh from exactly this moment, never
// retroactively crediting the OFF/reconnecting period), (3) clear
// wifi_reconnect_started_at. The CLIENT (not this route) is responsible
// for calling notifyAccountChanged() (lib/accountEvents.js) after a
// successful response so every mounted useAccount()/useEarningsSummary()
// consumer refetches immediately without a hard refresh.
export async function POST(request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const db = getDb();
  const result = completeWifiReconnect(db, account.id);

  if (!result.ok) {
    if (result.reason === "too_early") {
      return NextResponse.json(
        { error: "Reconnection still in progress.", remainingMs: result.remainingMs },
        { status: 409 }
      );
    }
    const messages = {
      not_reconnecting: "No reconnection is currently in progress.",
      not_found: "Account not found.",
    };
    return NextResponse.json(
      { error: messages[result.reason] || "Unable to complete reconnection." },
      { status: 409 }
    );
  }

  return NextResponse.json({ ok: true, account: toPublicAccount(result.account) });
}
