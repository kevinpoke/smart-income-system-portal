import { generateId } from "./auth-crypto";
import { rngFromKey } from "./mockData";
import { TIER_KEYS, isValidTierKey, tierKeyToDisplayName, displayNameToTierKey, pickRateForTier } from "./nodeTiers";

// Server-only, persisted customer-owned Node records (Dashboard "Your
// Nodes"). Unlike lib/nodesEngine.js (the browsable marketplace demo
// inventory), rows here represent Nodes the customer actually owns and
// are the source of truth for the Dashboard earnings baseline. Location
// is intentionally NOT stored per row -- every read joins live against
// the account's own isp_city/isp_state so it can never drift from the
// customer's actual ISP Setup address.
//
// PRIMARY NODE RULE: this schema has no explicit "is this the primary
// Node" column. The primary Node for an account is defined as the
// earliest-created Node, i.e. the row with the LOWEST node_number for
// that account_id (node_number is assigned strictly in creation order,
// starting at 1, and is never reassigned -- see addOwnedNode() below).
// Every consumer that needs "the account's primary Node" (User
// Management's Node column, the admin Node-edit popup's default
// selection, etc.) should query
// `... WHERE account_id = ? ORDER BY node_number ASC LIMIT 1`. This
// codebase has no per-Node active/inactive flag (Node "activity" is
// governed at the ACCOUNT level via accounts.wifi_enabled -- when WiFi
// is off, ALL of that account's Nodes stop accruing together, not
// individually), so "earliest-created" and "earliest-created active"
// are equivalent here; if a genuine per-Node active/inactive flag is
// ever introduced, this rule should be updated to filter on it first.
//
// Multi-tier Nodes refinement pass: `tier` is now one of THREE display
// strings ('Standard Node' | 'Super Node' | 'Nova Node'), all defined
// in lib/nodeTiers.js (the single source of truth for tier keys, display
// names, and cent ranges -- never hardcode a tier range here or
// anywhere else). `earning_rate_cents` is the new persisted, STABLE
// per-Node rate (added via a lib/db.js migration, backfilled from the
// pre-existing `est_monthly_cents` value so no historical Node's rate
// silently changed when the column was introduced). `est_monthly_cents`
// remains the column every pre-existing reader already queries and is
// kept in exact sync with `earning_rate_cents` on every write in this
// file -- there is only ever one logical rate per Node, mirrored into
// two column names for backward compatibility with existing SELECTs.

export const MAX_NODES_PER_ACCOUNT = 5;

// Retained for the AUTOMATIC first-Node-on-ISP-activation path only
// (see deterministicNodeSpec/addOwnedNode below) -- this ~20% Standard/
// Super random split is PRE-EXISTING behavior that this refinement pass
// does not change; only the CENT RANGE each tier maps to is now sourced
// from lib/nodeTiers.js instead of a locally-hardcoded range. Nova is
// deliberately NEVER auto-assigned by this random roll -- Nova is only
// ever granted through the explicit admin-driven Add Node / tier-change
// flows (addOwnedNodeWithTier / updateNodeTier below), matching the
// spec's framing of Nova as an admin-curated premium tier rather than a
// randomly-granted one.
const SUPER_NODE_CHANCE = 0.2; // ~1 in 5 newly granted nodes is a Super Node

// Deterministic (seeded, never Math.random()) tier-key + rate selection
// for the AUTOMATIC first-Node grant. Returns { tierKey, tier
// (display name), estMonthlyCents }. `forceSuper` preserves the
// existing package_tier signal wiring (see addOwnedNode below).
function deterministicAutoTierSpec(accountId, nodeNumber, forceSuper = false) {
  const tierRand = rngFromKey(`ownednode:tier:${accountId}:${nodeNumber}`);
  const isSuper = forceSuper || tierRand() < SUPER_NODE_CHANCE;
  const tierKey = isSuper ? "super" : "standard";
  const amountRand = rngFromKey(`ownednode:amount:${accountId}:${nodeNumber}`);
  const estMonthlyCents = pickRateForTier(amountRand, tierKey);
  return {
    tierKey,
    tier: tierKeyToDisplayName(tierKey),
    estMonthlyCents,
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
//
// This is the AUTOMATIC grant path only (unchanged behavior from before
// this refinement pass, aside from now sourcing its cent range from
// lib/nodeTiers.js) -- see addOwnedNodeWithTier() below for the
// admin-driven Add Node flow, which always uses an explicitly chosen
// tier instead of this random roll.
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
  const spec = deterministicAutoTierSpec(accountId, nodeNumber, forceSuper);
  const now = new Date().toISOString();
  const displayNodeId = generateDisplayNodeId(accountId, nodeNumber);

  db.prepare(
    `INSERT OR IGNORE INTO owned_nodes (id, account_id, node_number, tier, est_monthly_cents, earning_rate_cents, created_at, display_node_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    generateId("ownednode"),
    accountId,
    nodeNumber,
    spec.tier,
    spec.estMonthlyCents,
    spec.estMonthlyCents,
    now,
    displayNodeId
  );

  return { added: true, nodeNumber, tier: spec.tier, estMonthlyCents: spec.estMonthlyCents };
}

// Admin-driven Add Node: creates exactly one new Node for the account
// with an EXPLICITLY chosen tier (never the random auto-roll above).
// Used by POST /api/admin/accounts/[id]/nodes. Returns the same shape
// as addOwnedNode() plus the resolved tierKey, or a `reason` on
// rejection (limit_reached). Idempotency (never creating a duplicate
// Node for the same logical request) is the CALLER's responsibility via
// the node_add_requests table -- this function itself is not
// idempotent by request-key, only by the pre-existing
// UNIQUE(account_id, node_number) constraint (which prevents a raw
// double-call from ever producing two rows with the same node_number,
// though a legitimate second call would still correctly create a
// DIFFERENT, valid Node at the next node_number -- the request-key
// idempotency table is what stops that from happening on a retry of the
// SAME logical request).
export function addOwnedNodeWithTier(db, accountId, tierKey) {
  if (!isValidTierKey(tierKey)) {
    return { added: false, reason: "invalid_tier" };
  }
  const countRow = db
    .prepare(`SELECT COUNT(*) as c FROM owned_nodes WHERE account_id = ?`)
    .get(accountId);
  if (countRow.c >= MAX_NODES_PER_ACCOUNT) {
    return { added: false, reason: "limit_reached" };
  }

  const nodeNumber = countRow.c + 1;
  const rand = rngFromKey(`ownednode:amount:${accountId}:${nodeNumber}:${tierKey}`);
  const estMonthlyCents = pickRateForTier(rand, tierKey);
  const displayName = tierKeyToDisplayName(tierKey);
  const now = new Date().toISOString();
  const displayNodeId = generateDisplayNodeId(accountId, nodeNumber);
  const id = generateId("ownednode");

  db.prepare(
    `INSERT OR IGNORE INTO owned_nodes (id, account_id, node_number, tier, est_monthly_cents, earning_rate_cents, created_at, display_node_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, accountId, nodeNumber, displayName, estMonthlyCents, estMonthlyCents, now, displayNodeId);

  return {
    added: true,
    id,
    nodeNumber,
    tierKey,
    tier: displayName,
    estMonthlyCents,
    createdAt: now,
    displayNodeId,
  };
}

// Updates ONE specific owned Node's tier (and its stable earning rate,
// recomputed deterministically within the NEW tier's range). Used by
// PATCH /api/admin/accounts/[id]/nodes/[nodeId]. Never touches any
// other Node belonging to the account, and never touches `id`,
// `node_number`, `created_at`, or `display_node_id` on the target row
// itself -- only `tier` and (kept in sync) `est_monthly_cents`/
// `earning_rate_cents` change. The new rate is deterministically seeded
// by `accountId:nodeNumber:newTierKey`, so repeatedly setting the SAME
// tier always reproduces the SAME rate (a duplicate/retried submission
// of the same tier is a safe no-op change, never a re-roll), while
// switching tiers picks a fresh, stable rate within the new tier's
// range. Historical ledger rows already written for this Node are
// NEVER modified by this function -- only future calls to
// runEarningsCatchup() (which reads the LIVE est_monthly_cents value at
// call time) are affected, so a tier change only ever changes FUTURE
// accrual.
export function updateOwnedNodeTier(db, accountId, ownedNodeId, newTierKey) {
  if (!isValidTierKey(newTierKey)) {
    return { ok: false, reason: "invalid_tier" };
  }
  const node = db
    .prepare(`SELECT * FROM owned_nodes WHERE id = ? AND account_id = ?`)
    .get(ownedNodeId, accountId);
  if (!node) {
    return { ok: false, reason: "not_found" };
  }

  const previousTierKey = displayNameToTierKey(node.tier);
  const rand = rngFromKey(`ownednode:amount:${accountId}:${node.node_number}:${newTierKey}`);
  const newEstMonthlyCents = pickRateForTier(rand, newTierKey);
  const newDisplayName = tierKeyToDisplayName(newTierKey);

  db.prepare(
    `UPDATE owned_nodes SET tier = ?, est_monthly_cents = ?, earning_rate_cents = ? WHERE id = ? AND account_id = ?`
  ).run(newDisplayName, newEstMonthlyCents, newEstMonthlyCents, ownedNodeId, accountId);

  return {
    ok: true,
    nodeId: ownedNodeId,
    nodeNumber: node.node_number,
    previousTierKey,
    previousTier: node.tier,
    previousEstMonthlyCents: node.est_monthly_cents,
    newTierKey,
    newTier: newDisplayName,
    newEstMonthlyCents,
  };
}

// Deterministic 7-digit customer-facing display Node ID, distinct from
// the internal PK (`id`) and `node_number` (the internal per-account
// ordinal). Per spec, the account's current default (first) owned Node
// must display as exactly "#8632563"; any additional Node gets its own
// deterministic 7-digit display ID (same generator style as the
// marketplace's demo IDs in lib/nodesEngine.js) so every Node -- whether
// auto-granted or admin-added -- keeps its own unique, stable display ID
// without ever colliding with "8632563" or with each other.
function generateDisplayNodeId(accountId, nodeNumber) {
  if (nodeNumber === 1) return "8632563";
  const rand = rngFromKey(`ownednode:displayid:${accountId}:${nodeNumber}`);
  return String(randomIntLocal(rand, 1000000, 9999999));
}

// Local copy of lib/mockData.js randomInt to avoid importing it twice
// under two different names in this file (rngFromKey is already
// imported above); behaviorally identical.
function randomIntLocal(rand, min, max) {
  return Math.floor(rand() * (max - min + 1)) + min;
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
// ISP-setup location (never a stored/stale value) and their canonical
// tier key. `isPrimary` marks the earliest-created Node (see the
// PRIMARY NODE RULE comment at the top of this file) -- rows are
// already ordered by node_number ASC, so the first row in the array is
// always the primary one.
export function listOwnedNodes(db, account) {
  const rows = db
    .prepare(
      `SELECT id, node_number, tier, est_monthly_cents, earning_rate_cents, created_at, display_node_id FROM owned_nodes
       WHERE account_id = ? ORDER BY node_number ASC`
    )
    .all(account.id);

  const location =
    account.isp_city && account.isp_state ? `${account.isp_city}, ${account.isp_state}` : null;

  return rows.map((r, index) => ({
    id: r.id, // internal PK -- NOT for display, only for joining against ledger_entries.node_id
    nodeId: r.node_number, // legacy field name, kept for back-compat with any existing consumer
    displayNodeId: r.display_node_id || String(r.node_number),
    tier: r.tier,
    tierKey: displayNameToTierKey(r.tier),
    location,
    estMonthlyCents: r.est_monthly_cents,
    earningRateCents: r.earning_rate_cents ?? r.est_monthly_cents,
    createdAt: r.created_at,
    isPrimary: index === 0,
  }));
}

export function sumOwnedNodesMonthlyCents(db, accountId) {
  const row = db
    .prepare(`SELECT COALESCE(SUM(est_monthly_cents), 0) as total FROM owned_nodes WHERE account_id = ?`)
    .get(accountId);
  return row.total;
}

// Returns the account's primary Node row (earliest-created, i.e. lowest
// node_number) or null if the account owns no Nodes. See the PRIMARY
// NODE RULE comment at the top of this file.
export function getPrimaryOwnedNode(db, accountId) {
  return (
    db
      .prepare(
        `SELECT id, node_number, tier, est_monthly_cents, earning_rate_cents, created_at, display_node_id
         FROM owned_nodes WHERE account_id = ? ORDER BY node_number ASC LIMIT 1`
      )
      .get(accountId) || null
  );
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

export { TIER_KEYS, isValidTierKey };
