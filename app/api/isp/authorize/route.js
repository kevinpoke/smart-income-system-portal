import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentAccountRaw, toPublicAccount } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { addOwnedNode } from "@/lib/ownedNodes";
import { generateId } from "@/lib/auth-crypto";

// Customer clicks "I Approve" while isp_status = approved_awaiting_user.
// This is the ONLY action that may start the Node/earnings lifecycle --
// admin approval alone (isp/admin/approve) must never reach isp_status =
// 'active'. Per Phase 2 scope, this route sets the node-activation
// timestamps and flips isp_status to 'active'.
//
// Phase 5 additions: this is also the moment a customer's first owned
// Node record is created (lib/ownedNodes.js -- Dashboard "Your Nodes")
// and their WiFi toggle is initialized to ON with wifi_state_since set to
// the same activation timestamp, so live earnings accrual and the
// WiFi-connected UI state both start from exactly this instant.
export async function POST(request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const db = getDb();

  let updated;
  db.exec("BEGIN");
  try {
    const fresh = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(account.id);

    if (fresh.isp_status !== "approved_awaiting_user") {
      db.exec("ROLLBACK");
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
           wifi_enabled = 1,
           wifi_state_since = COALESCE(wifi_state_since, ?),
           isp_status = 'active'
       WHERE id = ?`
    ).run(now, now, now, account.id);

    db.prepare(
      `INSERT INTO wifi_events (id, account_id, action, created_at) VALUES (?, ?, 'on', ?)`
    ).run(generateId("wifiev"), account.id, now);

    addOwnedNode(db, account.id);

    db.exec("COMMIT");
    updated = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(account.id);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return NextResponse.json({ ok: true, account: toPublicAccount(updated) });
}
