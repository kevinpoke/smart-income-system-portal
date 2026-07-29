import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentAccountRaw, toPublicAccount } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { completeIspAuthorization } from "@/lib/ispEngine";

// Completes the ISP "I Approve" authorization flow. The client calls
// this once its 20-second visual progress bar reaches 100%, but the
// SERVER independently re-validates that at least 20 real seconds have
// elapsed since the persisted isp_authorize_started_at (see
// lib/ispEngine.js completeIspAuthorization) before actually flipping
// isp_status to 'active' -- a client that raced ahead or manipulated its
// own timer cannot shorten the real waiting period, since the check is
// against a server-persisted timestamp, not anything the client sends.
//
// Only on success does this activate the account: isp_status = 'active',
// node_connected_at/user_authorized_at set, WiFi initialized ON (so
// Header/uptime/earnings all start fresh from exactly this instant), and
// the customer's first owned Node granted. The CLIENT (not this route)
// is responsible for calling notifyAccountChanged() after a successful
// response so every mounted useAccount()/useEarningsSummary() consumer
// refetches immediately without a hard refresh.
export async function POST(request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const db = getDb();
  const result = completeIspAuthorization(db, account.id);

  if (!result.ok) {
    if (result.reason === "too_early") {
      return NextResponse.json(
        { error: "Authorization still in progress.", remainingMs: result.remainingMs },
        { status: 409 }
      );
    }
    const messages = {
      not_authorizing: "No authorization is currently in progress.",
      not_found: "Account not found.",
    };
    return NextResponse.json(
      { error: messages[result.reason] || "Unable to complete authorization." },
      { status: 409 }
    );
  }

  return NextResponse.json({ ok: true, account: toPublicAccount(result.account) });
}
