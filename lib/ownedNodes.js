import { generateId } from "./auth-crypto";
import { rngFromKey, randomFloat } from "./mockData";

// Server-only, persisted customer-owned Node records (Dashboard "Your
// Nodes"). Unlike lib/nodesEngine.js (the browsable marketplace demo
// inventory), rows here represent Nodes the customer actually owns and
// are the source of truth for the Dashboard earnings baseline. Location
// is intentionally NOT stored per row -- every read joins live against
// the account's own isp_city/isp_state so it can never drift from the
// customer's actual ISP Setup address.

export const MAX_NODES_PER_ACCOUNT = 5;

const STANDARD_MONTHLY_MIN_CENTS = 150000; // $1,500
const STANDARD_MONTHLY_MAX_CENTS = 280000; // $2,800
const SUPER_MONTHLY_MIN_CENTS = 240000; // $2,400
const SUPER_MONTHLY_MAX_CENTS = 400000; // $4,000
const SUPER_NODE_CHANCE = 0.2; // ~1 in 5 newly granted nodes is a Super Node

function deterministicNodeSpec(accountId, nodeNumber) {
  const tierRand = rngFromKey(`ownednode:tier:${accountId}:${nodeNumber}`);
  const isSuper = tierRand() < SUPER_NODE_CHANCE;
  const amountRand = rngFromKey(`ownednode:amount:${accountId}:${nodeNumber}`);
  const [minCents, maxCents] = isSuper
    ? [SUPER_MONTHLY_MIN_CENTS, SUPER_MONTHLY_MAX_CENTS]
    : [STANDARD_MONTHLY_MIN_CENTS, STANDARD_MONTHLY_MAX_CENTS];
  const dollars = randomFloat(amountRand, minCents / 100, maxCents / 100, 2);
  return {
    tier: isSuper ? "Super Node" : "Standard Node",
    estMonthlyCents: Math.round(dollars * 100),
  };
}

// Grants the account's next Node (used when a Node is activated via ISP
// authorization). Enforces the "purchases are limited to five Nodes per
// member" cap server-side. Idempotent per (account, nodeNumber) via the
// UNIQUE constraint, but callers should only invoke this when a new Node
// is actually being granted (see app/api/isp/authorize).
export function addOwnedNode(db, accountId) {
  const countRow = db
    .prepare(`SELECT COUNT(*) as c FROM owned_nodes WHERE account_id = ?`)
    .get(accountId);
  if (countRow.c >= MAX_NODES_PER_ACCOUNT) {
    return { added: false, reason: "limit_reached" };
  }

  const nodeNumber = countRow.c + 1;
  const spec = deterministicNodeSpec(accountId, nodeNumber);
  const now = new Date().toISOString();

  db.prepare(
    `INSERT OR IGNORE INTO owned_nodes (id, account_id, node_number, tier, est_monthly_cents, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(generateId("ownednode"), accountId, nodeNumber, spec.tier, spec.estMonthlyCents, now);

  return { added: true, nodeNumber, ...spec };
}

// Returns the customer's owned Node rows enriched with their live
// ISP-setup location (never a stored/stale value).
export function listOwnedNodes(db, account) {
  const rows = db
    .prepare(
      `SELECT id, node_number, tier, est_monthly_cents, created_at FROM owned_nodes
       WHERE account_id = ? ORDER BY node_number ASC`
    )
    .all(account.id);

  const location =
    account.isp_city && account.isp_state ? `${account.isp_city}, ${account.isp_state}` : null;

  return rows.map((r) => ({
    nodeId: r.node_number,
    tier: r.tier,
    location,
    estMonthlyCents: r.est_monthly_cents,
    createdAt: r.created_at,
  }));
}

export function sumOwnedNodesMonthlyCents(db, accountId) {
  const row = db
    .prepare(`SELECT COALESCE(SUM(est_monthly_cents), 0) as total FROM owned_nodes WHERE account_id = ?`)
    .get(accountId);
  return row.total;
}
