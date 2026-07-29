import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentAccountRaw, toPublicAccount } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { startIspAuthorization, getIspAuthorizeStatus } from "@/lib/ispEngine";

// Customer clicks "I Approve" while isp_status = approved_awaiting_user.
// This begins (or resumes) the 20-second "Establishing a Secure
// Connection..." authorization window -- it does NOT itself activate the
// account. Only POST /api/isp/authorize/complete may flip isp_status to
// 'active', and only once the server independently confirms the full 20
// seconds has genuinely elapsed since the persisted
// isp_authorize_started_at (see lib/ispEngine.js). Admin approval alone
// (app/api/admin/isp/[id]/approve) must never reach isp_status =
// 'active' -- only the customer's own "I Approve" -> completed
// authorization window may do that.
//
// Idempotent/concurrency-safe: calling this while authorization is
// already in progress returns the EXISTING start timestamp rather than
// resetting the 20-second clock, so a double-click or a page refresh
// that re-fires this call can never extend or restart the window.
export async function POST(request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const db = getDb();
  const result = startIspAuthorization(db, account.id);

  if (!result.ok) {
    const messages = {
      not_awaiting_authorization: "Your ISP setup is not currently awaiting authorization.",
      not_found: "Account not found.",
    };
    return NextResponse.json(
      { error: messages[result.reason] || "Unable to start authorization." },
      { status: 409 }
    );
  }

  const fresh = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(account.id);

  return NextResponse.json({
    ok: true,
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    readyAt: result.readyAt,
    status: getIspAuthorizeStatus(fresh),
    account: toPublicAccount(fresh),
  });
}
