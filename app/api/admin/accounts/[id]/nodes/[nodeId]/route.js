import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { generateId } from "@/lib/auth-crypto";
import { updateOwnedNodeTier } from "@/lib/ownedNodes";
import { isValidTierKey } from "@/lib/nodeTiers";

// Admin-only: changes ONE specific owned Node's tier. Never touches any
// other Node belonging to the account (lib/ownedNodes.js
// updateOwnedNodeTier() scopes its UPDATE to
// `WHERE id = ? AND account_id = ?`), and never touches that Node's own
// `id`/`node_number`/`created_at`/`display_node_id` -- only `tier` and
// (kept in sync) `est_monthly_cents`/`earning_rate_cents` change.
//
// Historical ledger rows already written for this Node are structurally
// immutable here -- this route only ever UPDATEs owned_nodes, never
// ledger_entries, so "already accrued earnings" can never be rewritten
// by a tier change. Future accrual automatically uses the new rate the
// next time runEarningsCatchup() reads the live est_monthly_cents column
// (lib/earningsEngine.js) -- no separate "apply going forward" flag is
// needed since the accrual engine always reads the CURRENT row value at
// call time, never a cached/snapshotted one.
//
// Idempotent by construction: submitting the SAME tier twice (e.g. a
// duplicate/retried request) re-derives the SAME deterministic rate
// (seeded by accountId:nodeNumber:tierKey, not by wall-clock time or a
// random roll), so it is always a safe no-op change, never a re-roll.
export async function PATCH(request, { params }) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const { id: targetId, nodeId } = await params;
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const tierKey = typeof body.tier === "string" ? body.tier.trim().toLowerCase() : "";
  if (!isValidTierKey(tierKey)) {
    return NextResponse.json(
      { error: "Tier must be one of: standard, super, nova." },
      { status: 400 }
    );
  }

  const db = getDb();
  const target = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(targetId);
  if (!target) {
    return NextResponse.json({ error: "Account not found." }, { status: 404 });
  }
  if (target.role !== "customer") {
    return NextResponse.json(
      { error: "Node tier editing only applies to customer accounts." },
      { status: 400 }
    );
  }

  let result;
  db.exec("BEGIN");
  try {
    result = updateOwnedNodeTier(db, targetId, nodeId, tierKey);
    if (!result.ok) {
      db.exec("ROLLBACK");
      if (result.reason === "not_found") {
        return NextResponse.json(
          { error: "Node not found for this account." },
          { status: 404 }
        );
      }
      return NextResponse.json({ error: "Unable to update Node tier." }, { status: 400 });
    }

    db.prepare(
      `INSERT INTO audit_log (id, admin_account_id, target_account_id, action, before_json, after_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      generateId("audit"),
      guard.account.id,
      targetId,
      "node_tier_change",
      JSON.stringify({
        nodeId,
        tierKey: result.previousTierKey,
        tier: result.previousTier,
        estMonthlyCents: result.previousEstMonthlyCents,
      }),
      JSON.stringify({
        nodeId,
        tierKey: result.newTierKey,
        tier: result.newTier,
        estMonthlyCents: result.newEstMonthlyCents,
      }),
      new Date().toISOString()
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return NextResponse.json({
    ok: true,
    node: {
      id: nodeId,
      nodeNumber: result.nodeNumber,
      tierKey: result.newTierKey,
      tier: result.newTier,
      estMonthlyCents: result.newEstMonthlyCents,
    },
  });
}
