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

function deterministicNodeSpec(accountId, nodeNumber, forceSuper = false) {
  const tierRand = rngFromKey(`ownednode:tier:${accountId}:${nodeNumber}`);
  const isSuper = forceSuper || tierRand() < SUPER_NODE_CHANCE;
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
// authorization, or by ensureOwnedNode()'s lazy backfill below). Enforces
// the "purchases are limited to five Nodes per member" cap server-side.
// Idempotent per (account, nodeNumber) via the UNIQUE constraint, but
// callers should only invoke this when a new Node is actually being
// granted.
//
// Super Node signal: if the account's `package_tier` column contains
// "super" (case-insensitive), the account's FIRST Node is forced to
// "Super Node" tier instead of the existing ~20% random chance -- this is
// the only existing schema field that could plausibly carry a
// purchase-tier signal. As of this Phase 5 correction, no admin UI or
// purchase webhook route actually sets package_tier anywhere in this
// codebase, so in practice every account still gets the random ~20%
// assignment; this wiring is forward-compatible for whenever a real
// purchase-tier signal is introduced, without inventing a new field.
export function addOwnedNode(db, accountId) {
  const countRow = db
    .prepare(`SELECT COUNT(*) as c FROM owned_nodes WHERE account_id = ?`)
    .get(accountId);
  if (countRow.c >= MAX_NODES_PER_ACCOUNT) {
    return { added: false, reason: "limit_reached" };
  }

  const nodeNumber = countRow.c + 1;
  const account = db.prepare(`SELECT package_tier FROM accounts WHERE id = ?`).get(accountId);
  const forceSuper =
    nodeNumber === 1 && typeof account?.package_tier === "string" && /super/i.test(account.package_tier);
  const spec = deterministicNodeSpec(accountId, nodeNumber, forceSuper);
  const now = new Date().toISOString();

  db.prepare(
    `INSERT OR IGNORE INTO owned_nodes (id, account_id, node_number, tier, est_monthly_cents, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(generateId("ownednode"), accountId, nodeNumber, spec.tier, spec.estMonthlyCents, now);

  return { added: true, nodeNumber, ...spec };
}

// Phase 5 correction: idempotent lazy repair for accounts that reached
// isp_status === 'active' (a Node genuinely connected) but somehow have
// ZERO owned_nodes rows -- e.g. accounts activated before this mechanism
// existed. Gated strictly on a zero-count check, so it can never create a
// SECOND Node for an account that already owns at least one; safe to call
// on every dashboard load/poll (see lib/earningsEngine.js
// computeEarningsSummary()).
export function ensureOwnedNode(db, account) {
  if (!account || account.isp_status !== "active" || !account.node_connected_at) {
    return { added: false, reason: "not_active" };
  }
  const countRow = db
    .prepare(`SELECT COUNT(*) as c FROM owned_nodes WHERE account_id = ?`)
    .get(account.id);
  if (countRow.c > 0) {
    return { added: false, reason: "already_owns_node" };
  }
  return addOwnedNode(db, account.id);
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
