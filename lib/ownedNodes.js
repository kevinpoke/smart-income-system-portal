import { generateId } from "./auth-crypto";
import { rngFromKey, randomFloat, randomInt } from "./mockData";

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

  // Dashboard adjustment pass: customer-facing display Node ID, separate
  // from the internal PK (`id`, generated below) and from `node_number`
  // (the internal per-account ordinal). Per spec, the account's current
  // default (first) owned Node must display as exactly "#8632563"; any
  // additional Nodes get their own deterministic 7-digit display ID
  // (same generator style as the marketplace's demo IDs in
  // lib/nodesEngine.js) so multi-Node support keeps every Node uniquely
  // identifiable without ever touching the internal identifier scheme.
  const displayNodeId =
    nodeNumber === 1
      ? "8632563"
      : String(
          randomInt(
            rngFromKey(`ownednode:displayid:${accountId}:${nodeNumber}`),
            1000000,
            9999999
          )
        );

  db.prepare(
    `INSERT OR IGNORE INTO owned_nodes (id, account_id, node_number, tier, est_monthly_cents, created_at, display_node_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    generateId("ownednode"),
    accountId,
    nodeNumber,
    spec.tier,
    spec.estMonthlyCents,
    now,
    displayNodeId
  );

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

// Splits `totalCents` proportionally across `nodes` ([{id, est_monthly_cents}])
// by each node's share of the combined est_monthly_cents, returning
// { [nodeId]: cents } that ALWAYS sums to EXACTLY totalCents (every node
// but the last gets its rounded proportional share; the last node
// absorbs the remainder, so no cent is ever lost or invented to rounding
// drift). Shared by both the write-time per-cycle split (see
// lib/earningsEngine.js runEarningsCatchup, which stores a distinct
// ledger row per Node with its own node_id) and the read-time historical
// backfill split (computeNodeEarningsTotals below, for pre-existing
// NULL-node_id ledger rows) -- one implementation, one reconciliation
// guarantee, used everywhere per-Node money needs to be divided.
export function splitProportionally(totalCents, nodes) {
  const result = {};
  if (!nodes.length) return result;
  if (nodes.length === 1) {
    result[nodes[0].id] = totalCents;
    return result;
  }

  const totalMonthly = nodes.reduce((sum, n) => sum + n.est_monthly_cents, 0);
  if (totalMonthly <= 0) {
    // No node has a positive monthly baseline to split by -- attribute
    // everything to the first node rather than silently dropping it.
    for (const n of nodes) result[n.id] = 0;
    result[nodes[0].id] = totalCents;
    return result;
  }

  let allocated = 0;
  nodes.forEach((n, idx) => {
    const isLast = idx === nodes.length - 1;
    const share = isLast
      ? totalCents - allocated
      : Math.round((totalCents * n.est_monthly_cents) / totalMonthly);
    allocated += share;
    result[n.id] = share;
  });
  return result;
}

// Returns the customer's owned Node rows enriched with their live
// ISP-setup location (never a stored/stale value).
export function listOwnedNodes(db, account) {
  const rows = db
    .prepare(
      `SELECT id, node_number, tier, est_monthly_cents, created_at, display_node_id FROM owned_nodes
       WHERE account_id = ? ORDER BY node_number ASC`
    )
    .all(account.id);

  const location =
    account.isp_city && account.isp_state ? `${account.isp_city}, ${account.isp_state}` : null;

  return rows.map((r) => ({
    id: r.id, // internal PK -- NOT for display, only for joining against ledger_entries.node_id
    nodeId: r.node_number, // legacy field name, kept for back-compat with any existing consumer
    displayNodeId: r.display_node_id || String(r.node_number),
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

// ---- Per-Node earnings attribution (Dashboard adjustment pass) ----------
//
// Returns { [ownedNodeId]: totalEarningsCents } for every owned Node on
// this account, reconciling exactly with the account's Node-generated
// lifetime earnings (i.e. summing every value in the returned map equals
// the sum of every 'earning' ledger_entries row's final_amount_cents for
// this account -- non-'earning' rows like admin_credit/admin_debit/
// payout/correction are never included here, matching the spec's "must
// not be falsely attributed to a Node" rule).
//
// Two categories of 'earning' rows are combined:
//   1. Rows with a non-NULL node_id (written after this feature existed,
//      see lib/earningsEngine.js runEarningsCatchup) -- summed directly,
//      per Node, exactly as recorded.
//   2. Historical rows with NULL node_id (written before this feature
//      existed) -- their SUM is split proportionally, at READ TIME ONLY
//      (nothing is written back to these rows, via splitProportionally
//      above), across the account's CURRENTLY-owned Nodes by each Node's
//      share of total estimated monthly earnings. This is a
//      deterministic, reproducible allocation (same inputs -> same
//      output every time): if the account currently owns only one Node,
//      100% of the historical NULL-node_id total is attributed to it
//      (matches the common case exactly, since almost every account only
//      ever had one Node during the period before per-Node attribution
//      existed). If it owns multiple Nodes, the historical total is split
//      by monthly-earnings share since there is no way to know
//      retroactively which Node "actually" produced which cycle's money
//      in this demo model.
export function computeNodeEarningsTotals(db, accountId) {
  const nodes = db
    .prepare(`SELECT id, est_monthly_cents FROM owned_nodes WHERE account_id = ? ORDER BY node_number ASC`)
    .all(accountId);

  const totals = {};
  for (const n of nodes) totals[n.id] = 0;
  if (nodes.length === 0) return totals;

  const attributedRows = db
    .prepare(
      `SELECT node_id, COALESCE(SUM(final_amount_cents), 0) as total
       FROM ledger_entries
       WHERE account_id = ? AND event_type = 'earning' AND node_id IS NOT NULL
       GROUP BY node_id`
    )
    .all(accountId);
  for (const row of attributedRows) {
    if (Object.prototype.hasOwnProperty.call(totals, row.node_id)) {
      totals[row.node_id] += row.total;
    }
  }

  const unattributedRow = db
    .prepare(
      `SELECT COALESCE(SUM(final_amount_cents), 0) as total
       FROM ledger_entries
       WHERE account_id = ? AND event_type = 'earning' AND node_id IS NULL`
    )
    .get(accountId);
  const unattributedTotal = unattributedRow.total || 0;

  if (unattributedTotal > 0) {
    const splits = splitProportionally(unattributedTotal, nodes);
    for (const [nodeId, cents] of Object.entries(splits)) {
      totals[nodeId] += cents;
    }
  }

  return totals;
}
