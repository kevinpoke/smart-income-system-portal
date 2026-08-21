import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { generateId } from "@/lib/auth-crypto";
import { listOwnedNodes, addOwnedNodeWithTier } from "@/lib/ownedNodes";
import { hasPayoutsNodesAccess } from "@/lib/moduleAccess";
import { isValidTierKey } from "@/lib/nodeTiers";

// Admin-only: lists every owned Node belonging to a specific customer
// account, for the Edit Node popup in User Management. Returns the same
// enriched shape listOwnedNodes() already produces for the customer's
// own /api/nodes/owned route (Node ID/displayNodeId, start date, tier,
// tierKey, canonical location derived live from the account's current
// isp_city/isp_state, and isPrimary -- see lib/ownedNodes.js for the
// PRIMARY NODE RULE definition: the earliest-created Node, i.e. lowest
// node_number).
//
// This app has no per-Node active/inactive flag (Node "activity" is
// governed at the ACCOUNT level via accounts.wifi_enabled -- see the
// PRIMARY NODE RULE comment in lib/ownedNodes.js for why), so the
// "status" surfaced here is the account-level WiFi/ISP connection state
// shared across every Node, not a per-row flag.
export async function GET(request, { params }) {
  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const { id: targetId } = await params;
  const db = getDb();
  const target = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(targetId);
  if (!target) {
    return NextResponse.json({ error: "Account not found." }, { status: 404 });
  }

  const nodes = listOwnedNodes(db, target);

  return NextResponse.json({
    ok: true,
    accountStatus: {
      wifiEnabled: Boolean(target.wifi_enabled),
      ispStatus: target.isp_status,
    },
    nodes,
  });
}

// Admin-only: adds exactly ONE new Node to a customer's account with an
// explicitly chosen tier (standard/super/nova). Never uses the
// automatic random Standard/Super roll that ISP activation uses --
// see lib/ownedNodes.js addOwnedNodeWithTier().
//
// ACCESS RULE: requires the account to already be FULLY unlocked for
// Payouts/Nodes -- ISP status active AND both city and state on file --
// reusing hasPayoutsNodesAccess() (lib/moduleAccess.js), the exact same
// canonical predicate every other Payouts/Nodes gate in this app already
// uses. Rejects with 400 if not met, listing which piece is missing.
//
// IDEMPOTENCY: the client supplies a `requestKey`, generated fresh only
// when a NEW Add Node popup is opened (never regenerated on a retry of
// the SAME popup submission). A row is inserted into node_add_requests
// with a UNIQUE(request_key) constraint IN THE SAME TRANSACTION as the
// owned_nodes insert -- so a double-click or network retry of the exact
// same request either (a) succeeds once and creates exactly one Node,
// with node_add_requests recording which Node it created, or (b) if the
// UNIQUE constraint fires (this exact request_key was already handled),
// the existing node_add_requests row's linked owned_node_id is looked up
// and that SAME Node's data is returned again -- never a second Node.
export async function POST(request, { params }) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const { id: targetId } = await params;
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const tierKey = typeof body.tier === "string" ? body.tier.trim().toLowerCase() : "";
  const requestKey = typeof body.requestKey === "string" ? body.requestKey.trim() : "";

  if (!requestKey) {
    return NextResponse.json({ error: "A requestKey is required." }, { status: 400 });
  }
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
      { error: "Nodes can only be added to customer accounts." },
      { status: 400 }
    );
  }

  // Idempotency check FIRST (before any validation that could differ
  // between the original request and a retry) -- a genuine duplicate
  // submission of the exact same request_key always returns the
  // original outcome, even if e.g. the account's location was changed
  // in between (which shouldn't happen for a same-key retry in
  // practice, but this ordering keeps the guarantee airtight).
  const existingRequest = db
    .prepare(`SELECT * FROM node_add_requests WHERE request_key = ?`)
    .get(requestKey);
  if (existingRequest) {
    const existingNode = existingRequest.owned_node_id
      ? db.prepare(`SELECT * FROM owned_nodes WHERE id = ?`).get(existingRequest.owned_node_id)
      : null;
    return NextResponse.json({
      ok: true,
      duplicate: true,
      node: existingNode
        ? {
            id: existingNode.id,
            nodeNumber: existingNode.node_number,
            tier: existingNode.tier,
            displayNodeId: existingNode.display_node_id,
            estMonthlyCents: existingNode.est_monthly_cents,
            createdAt: existingNode.created_at,
          }
        : null,
    });
  }

  if (!hasPayoutsNodesAccess(target)) {
    const missing = [];
    if (target.isp_status !== "active") missing.push("active ISP setup");
    if (!target.isp_city) missing.push("city");
    if (!target.isp_state) missing.push("state");
    return NextResponse.json(
      {
        error: `Cannot add a Node: this account is missing ${missing.join(", ")}.`,
      },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();
  let result;
  db.exec("BEGIN");
  try {
    result = addOwnedNodeWithTier(db, targetId, tierKey);
    if (!result.added) {
      db.exec("ROLLBACK");
      return NextResponse.json({ error: "Unable to add Node." }, { status: 400 });
    }

    db.prepare(
      `INSERT INTO node_add_requests (id, request_key, account_id, owned_node_id, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(generateId("nodeaddreq"), requestKey, targetId, result.id, now);

    db.prepare(
      `INSERT INTO audit_log (id, admin_account_id, target_account_id, action, before_json, after_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      generateId("audit"),
      guard.account.id,
      targetId,
      "node_add",
      JSON.stringify({}),
      JSON.stringify({
        nodeId: result.id,
        nodeNumber: result.nodeNumber,
        tierKey: result.tierKey,
        tier: result.tier,
        estMonthlyCents: result.estMonthlyCents,
        createdAt: result.createdAt,
      }),
      now
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return NextResponse.json({
    ok: true,
    duplicate: false,
    node: {
      id: result.id,
      nodeNumber: result.nodeNumber,
      tier: result.tier,
      tierKey: result.tierKey,
      displayNodeId: result.displayNodeId,
      estMonthlyCents: result.estMonthlyCents,
      createdAt: result.createdAt,
    },
  });
}
