import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentAccountRaw, toPublicAccount } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";

// Customer clicks "I Approve" while isp_status = approved_awaiting_user.
// This is the ONLY action that may start the Node/earnings lifecycle --
// admin approval alone (isp/admin/approve) must never reach isp_status =
// 'active'. Per Phase 2 scope, this route sets the node-activation
// timestamps and flips isp_status to 'active'; it does NOT create ledger
// entries or start earnings math -- that is Phase 3 territory and is
// intentionally left untouched here so earnings still show as inactive
// until Phase 3 wires the dashboard to the ledger.
export async function POST(request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const db = getDb();
  const fresh = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(account.id);

  if (fresh.isp_status !== "approved_awaiting_user") {
    // Duplicate authorization or out-of-order call: reject explicitly
    // rather than silently no-op, so the client can surface a clear error.
    return NextResponse.json(
      { error: "Your ISP setup is not currently awaiting authorization." },
      { status: 409 }
    );
  }

  const now = new Date().toISOString();

  db.prepare(
    `UPDATE accounts
     SET user_authorized_at = COALESCE(user_authorized_at, ?),
         node_connected_at = COALESCE(node_connected_at, ?),
         isp_status = 'active'
     WHERE id = ?`
  ).run(now, now, account.id);

  const updated = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(account.id);

  return NextResponse.json({ ok: true, account: toPublicAccount(updated) });
}
