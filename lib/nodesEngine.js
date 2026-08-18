import { rngFromKey, randomInt, randomFloat } from "./mockData";
import { pickRateForTier, tierKeyToDisplayName } from "./nodeTiers";

// Server-only, purely-deterministic demo Node inventory generator. Every
// value here is derived from `${accountId}:${rowIndex}` (or a fixed row
// key for shared fields), so it never uses Math.random() and never changes
// across renders, refreshes, logins, or server restarts for a given
// account. None of these numbers are earnings -- they are marketing/demo
// inventory data and must never be written to ledger_entries.
//
// Phase 5 location rule: "Every Node shown to a customer must use the
// customer's ISP Setup city and state. Do not generate or display
// different Node locations." -- every row's location is therefore now
// forced to the customer's own ISP location (never a random demo city),
// and computeNodes() returns an empty list when that location isn't set
// yet (the page/route layer is responsible for the "Location Required"
// locked state before ISP Setup is complete/approved).
//
// Multi-tier Nodes refinement pass: the marketplace now offers all THREE
// tiers (Standard/Super/Nova), and every row's "Est. Monthly Earnings"
// figure is picked DIRECTLY from lib/nodeTiers.js's canonical per-tier
// cent range via pickRateForTier() -- the single shared source of truth
// used everywhere else in the app (owned Nodes, User Management, the
// Add Node / Edit Node admin popups). This replaces the PRIOR design
// where earnings were mathematically derived from cost via a
// cost-to-earnings multiplier: that derivation produced Standard-Node
// earnings as low as $875 and as high as $2,750, which no longer fits
// inside the new canonical Standard range ($1,000-$2,500) at its
// extremes. Cost remains its own independent, purely cosmetic
// marketplace figure (never a real transaction, never tied to any
// tier's canonical earnings range) -- there is no invariant to assert
// between cost and earnings anymore, since earnings are no longer
// derived from cost.

const NODE_COUNT = 24;
const SUPER_NODE_COUNT = 3;
const NOVA_NODE_COUNT = 1;

const STANDARD_COST_MIN_CENTS = 25000; // $250
const STANDARD_COST_MAX_CENTS = 55000; // $550
const SUPER_COST_MIN_CENTS = 60000; // $600
const SUPER_COST_MAX_CENTS = 98000; // $980
// Nova's cosmetic marketplace "cost" range sits above Super's. NOTE:
// post-rebrand, Nova ("XI Bridge") is the LOWEST canonical earnings
// tier in lib/nodeTiers.js, not the premium one -- this cost range is a
// purely cosmetic marketplace figure independent of earnings (no
// multiplier ties them together), so it is left as-is rather than
// reordered to "match" earnings rank.
const NOVA_COST_MIN_CENTS = 100000; // $1,000
const NOVA_COST_MAX_CENTS = 160000; // $1,600

// Deterministic 7-digit Node ID, stable per account+row forever.
function nodeId(accountId, rowIndex) {
  const rand = rngFromKey(`node:id:${accountId}:${rowIndex}`);
  return String(randomInt(rand, 1000000, 9999999));
}

// Fictional/private demo IP with the SECOND octet fixed at 168 (per spec),
// first octet always 192 (private range), third/fourth octets vary
// deterministically per row. This never reflects any real customer IP.
function nodeIp(accountId, rowIndex) {
  const rand = rngFromKey(`node:ip:${accountId}:${rowIndex}`);
  const third = randomInt(rand, 0, 255);
  const fourth = randomInt(rand, 1, 254);
  return `192.168.${third}.${fourth}`;
}

// Determines which row indices are Super/Nova Nodes, deterministic per
// account. Nova indices are chosen from the remaining rows after Super
// indices are picked, so a row can never be assigned to more than one
// tier.
function tierIndices(accountId) {
  const superRand = rngFromKey(`node:super:${accountId}`);
  const superIndices = new Set();
  // Bounded loop: NODE_COUNT is a small fixed constant, so this always
  // terminates quickly; no risk of an unbounded loop from user input.
  while (superIndices.size < SUPER_NODE_COUNT) {
    superIndices.add(randomInt(superRand, 0, NODE_COUNT - 1));
  }

  const novaRand = rngFromKey(`node:nova:${accountId}`);
  const novaIndices = new Set();
  while (novaIndices.size < NOVA_NODE_COUNT) {
    const candidate = randomInt(novaRand, 0, NODE_COUNT - 1);
    if (!superIndices.has(candidate)) novaIndices.add(candidate);
  }

  return { superIndices, novaIndices };
}

function tierKeyForIndex(i, superIndices, novaIndices) {
  if (novaIndices.has(i)) return "nova";
  if (superIndices.has(i)) return "super";
  return "standard";
}

function nodeCostCents(accountId, rowIndex, tierKey) {
  const rand = rngFromKey(`node:cost:${accountId}:${rowIndex}`);
  const ranges = {
    standard: [STANDARD_COST_MIN_CENTS, STANDARD_COST_MAX_CENTS],
    super: [SUPER_COST_MIN_CENTS, SUPER_COST_MAX_CENTS],
    nova: [NOVA_COST_MIN_CENTS, NOVA_COST_MAX_CENTS],
  };
  const [minCents, maxCents] = ranges[tierKey] || ranges.standard;
  const dollars = randomFloat(rand, minCents / 100, maxCents / 100, 2);
  return Math.round(dollars * 100);
}

// customerLocation: required "City, ST" string for the authenticated
// customer's own ISP location. Returns an empty list if it's not set yet
// -- every Node shown must be in the customer's own area, so there is
// nothing valid to show before ISP Setup is complete.
export function computeNodes(accountId, customerLocation) {
  if (!customerLocation) return [];

  const { superIndices, novaIndices } = tierIndices(accountId);
  const nodes = [];

  for (let i = 0; i < NODE_COUNT; i++) {
    const tierKey = tierKeyForIndex(i, superIndices, novaIndices);
    const costCents = nodeCostCents(accountId, i, tierKey);
    // Est. Monthly Earnings picked directly from the canonical
    // lib/nodeTiers.js range for this row's tier -- deterministically
    // seeded so it never changes across renders/refreshes/restarts for
    // the same account+row, exactly like every other value here.
    const earningsRand = rngFromKey(`node:earn:${accountId}:${i}`);
    const estMonthlyCents = pickRateForTier(earningsRand, tierKey);

    nodes.push({
      nodeId: nodeId(accountId, i),
      location: customerLocation,
      tier: tierKeyToDisplayName(tierKey),
      tierKey,
      ip: nodeIp(accountId, i),
      estMonthlyCents,
      costCents,
      status: "SOLD",
    });
  }

  return nodes;
}
