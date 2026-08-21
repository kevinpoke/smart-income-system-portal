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
// extremes.
//
// Production feature/fix batch: "Cost" is now explicitly modeled per
// spec as a PERCENTAGE of the row's own estMonthlyCents, within a
// tier-specific percent range (Standard 12-17%, Golden/super 12-15%,
// XI/nova 15-22%) -- rather than an independent dollar range with no
// stated relationship to earnings. This replaces the earlier purely
// cosmetic dollar-range cost model (which had no defined relationship
// to a listing's earnings at all) with the economics the spec actually
// calls for, while keeping cost fully deterministic/seeded like every
// other value in this file and keeping the existing per-row table
// layout unchanged (see app/(portal)/nodes/page.js -- Cost column stays
// a single dollar figure, now with a "% of earnings" caption underneath
// matching the existing "estimated" caption style under Est. Monthly
// Earnings).

const NODE_COUNT = 100;
const SUPER_NODE_COUNT = 4;
const NOVA_NODE_COUNT = 70;

// Percent-of-monthly-earnings ranges used to derive each row's "Cost"
// figure from its own estMonthlyCents. Deterministically seeded per
// account+row (see nodeCostCents below), never Math.random().
const COST_PERCENT_RANGES = {
  standard: [0.12, 0.17],
  super: [0.12, 0.15], // Golden Bridge
  nova: [0.15, 0.22], // XI Bridge
};

// Deterministic 7-digit Node ID, stable per account+row forever.
function nodeId(accountId, rowIndex) {
  const rand = rngFromKey(`node:id:${accountId}:${rowIndex}`);
  return String(randomInt(rand, 1000000, 9999999));
}

// Fictional demo IP made to look like a valid public USA-based address for
// display purposes only (Data Bridges UI polish pass). Deterministically
// derived from `${accountId}:${rowIndex}` -- the same Bridge always shows
// the same IP across renders/refreshes/restarts, never re-rolled via
// Math.random(). The first octet is drawn from a small curated list of
// real-world US ISP/allocation blocks (Comcast/AT&T/Verizon/Charter-style
// ranges) purely so the number LOOKS like a plausible public US address;
// this is fictional/demo data, never a real allocated IP, never the
// customer's real IP, and never a server/network infrastructure address.
// Deliberately avoids private/reserved ranges (10.x, 127.x, 169.254.x,
// 172.16-31.x, 192.168.x) by construction, since none of these first
// octets fall in those blocks.
const USA_IP_FIRST_OCTETS = [
  24, 32, 50, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 96, 97,
  98, 99, 173, 174, 184, 199, 204, 206, 207, 208, 209, 216,
];

function nodeIp(accountId, rowIndex) {
  const rand = rngFromKey(`bridge:ip:${accountId}:${rowIndex}`);
  const first = USA_IP_FIRST_OCTETS[randomInt(rand, 0, USA_IP_FIRST_OCTETS.length - 1)];
  const second = randomInt(rand, 0, 255);
  const third = randomInt(rand, 0, 255);
  const fourth = randomInt(rand, 1, 254);
  return `${first}.${second}.${third}.${fourth}`;
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

function nodeCostCents(accountId, rowIndex, tierKey, estMonthlyCents) {
  const rand = rngFromKey(`node:cost:${accountId}:${rowIndex}`);
  const [minPercent, maxPercent] = COST_PERCENT_RANGES[tierKey] || COST_PERCENT_RANGES.standard;
  const percent = randomFloat(rand, minPercent, maxPercent, 4);
  const costCents = Math.round(estMonthlyCents * percent);
  return { costCents, percent };
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
    // Est. Monthly Earnings picked directly from the canonical
    // lib/nodeTiers.js range for this row's tier -- deterministically
    // seeded so it never changes across renders/refreshes/restarts for
    // the same account+row, exactly like every other value here.
    const earningsRand = rngFromKey(`node:earn:${accountId}:${i}`);
    const estMonthlyCents = pickRateForTier(earningsRand, tierKey);
    const { costCents, percent: costPercent } = nodeCostCents(
      accountId,
      i,
      tierKey,
      estMonthlyCents
    );

    nodes.push({
      nodeId: nodeId(accountId, i),
      location: customerLocation,
      tier: tierKeyToDisplayName(tierKey),
      tierKey,
      ip: nodeIp(accountId, i),
      estMonthlyCents,
      costCents,
      costPercent,
      status: "SOLD",
    });
  }

  return nodes;
}
