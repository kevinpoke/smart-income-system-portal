import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { generateId } from "@/lib/auth-crypto";
import { assignSpecialBridge, listSpecialBridgeAssignments } from "@/lib/ownedNodes";
import { SPECIAL_BRIDGE_CATALOG, getSpecialBridgeById } from "@/lib/specialBridges";

// Admin-only: lists the four EXACT special Bridges (spec section 13/14)
// with their base estimate and current assignment status, for the admin
// Add Bridge popup. Never exposes anything a customer route could reuse
// to self-assign (requireAdmin() below).
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const db = getDb();
  const assignments = listSpecialBridgeAssignments(db);
  const accountIds = Object.values(assignments);
  let accountsById = {};
  if (accountIds.length > 0) {
    const placeholders = accountIds.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT id, email FROM accounts WHERE id IN (${placeholders})`)
      .all(...accountIds);
    accountsById = Object.fromEntries(rows.map((r) => [r.id, r.email]));
  }

  return NextResponse.json({
    ok: true,
    bridges: SPECIAL_BRIDGE_CATALOG.map((b) => ({
      id: b.id,
      displayName: b.displayName,
      baseEstMonthlyCents: b.baseEstMonthlyCents,
      assignedToAccountId: assignments[b.id] || null,
      assignedToAccountEmail: assignments[b.id] ? accountsById[assignments[b.id]] || null : null,
    })),
  });
}

// Admin-only: assigns ONE of the four EXACT special Bridges to a
// customer account. SERVER-AUTHORIZED (requireAdmin()) -- there is no
// customer-facing route that can reach this. Rejects if the bridge id
// is unrecognized, or if it is already actively assigned to any account
// (spec section 16 -- each of the four ids is unique, one active owner
// at a time).
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

  const bridgeId = typeof body.bridgeId === "string" ? body.bridgeId.trim() : "";
  const bridge = getSpecialBridgeById(bridgeId);
  if (!bridge) {
    return NextResponse.json(
      { error: "Unrecognized special Bridge id." },
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
      { error: "Special Bridges can only be assigned to customer accounts." },
      { status: 400 }
    );
  }

  let result;
  db.exec("BEGIN");
  try {
    result = assignSpecialBridge(db, targetId, bridgeId);
    if (!result.added) {
      db.exec("ROLLBACK");
      if (result.reason === "already_assigned") {
        return NextResponse.json(
          { error: `${bridge.displayName} #${bridge.id} is already assigned to another account.` },
          { status: 409 }
        );
      }
      return NextResponse.json({ error: "Unable to assign special Bridge." }, { status: 400 });
    }

    db.prepare(
      `INSERT INTO audit_log (id, admin_account_id, target_account_id, action, before_json, after_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      generateId("audit"),
      guard.account.id,
      targetId,
      "special_bridge_assign",
      JSON.stringify({}),
      JSON.stringify({
        nodeId: result.id,
        bridgeId: result.bridgeId,
        displayName: result.displayName,
        baseEstMonthlyCents: result.baseEstMonthlyCents,
        createdAt: result.createdAt,
      }),
      result.createdAt
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    // A concurrent request winning the DB's own partial UNIQUE index
    // (idx_owned_nodes_special_bridge_active) surfaces here as a thrown
    // constraint-violation error rather than assignSpecialBridge()'s own
    // pre-check catching it -- treat it identically to "already_assigned"
    // rather than a generic 500, since that's exactly what happened.
    if (String(err?.message || "").toLowerCase().includes("unique")) {
      return NextResponse.json(
        { error: `${bridge.displayName} #${bridge.id} is already assigned to another account.` },
        { status: 409 }
      );
    }
    throw err;
  }

  return NextResponse.json({
    ok: true,
    node: {
      id: result.id,
      nodeNumber: result.nodeNumber,
      bridgeId: result.bridgeId,
      displayName: result.displayName,
      baseEstMonthlyCents: result.baseEstMonthlyCents,
      createdAt: result.createdAt,
    },
  });
}
