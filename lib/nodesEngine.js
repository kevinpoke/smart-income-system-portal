import { rngFromKey, randomInt, randomFloat } from "./mockData";

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

const NODE_COUNT = 24;
const SUPER_NODE_COUNT = 3;

const STANDARD_COST_MIN_CENTS = 25000; // $250
const STANDARD_COST_MAX_CENTS = 55000; // $550
const SUPER_COST_MIN_CENTS = 60000; // $600
const SUPER_COST_MAX_CENTS = 98000; // $980

const EARNINGS_MULTIPLIER_MIN = 3.5;
const EARNINGS_MULTIPLIER_MAX = 5.0;

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

// Determines which row indices are Super Nodes, deterministic per account.
function superNodeIndices(accountId) {
  const rand = rngFromKey(`node:super:${accountId}`);
  const indices = new Set();
  // Bounded loop: NODE_COUNT is a small fixed constant, so this always
  // terminates quickly; no risk of an unbounded loop from user input.
  while (indices.size < SUPER_NODE_COUNT) {
    indices.add(randomInt(rand, 0, NODE_COUNT - 1));
  }
  return indices;
}

function nodeCostCents(accountId, rowIndex, isSuper) {
  const rand = rngFromKey(`node:cost:${accountId}:${rowIndex}`);
  const [minCents, maxCents] = isSuper
    ? [SUPER_COST_MIN_CENTS, SUPER_COST_MAX_CENTS]
    : [STANDARD_COST_MIN_CENTS, STANDARD_COST_MAX_CENTS];
  const dollars = randomFloat(rand, minCents / 100, maxCents / 100, 2);
  return Math.round(dollars * 100);
}

// Est. Monthly Earnings is mathematically DERIVED from cost (3.5x-5x),
// never generated independently, so the ratio invariant holds by
// construction -- no separate verification step could ever disagree with
// the generator itself. computeNodes() below still asserts the invariant
// defensively (throws in dev if violated) to catch any future edit that
// breaks this relationship.
function nodeEstMonthlyCents(accountId, rowIndex, costCents) {
  const rand = rngFromKey(`node:earn:${accountId}:${rowIndex}`);
  const multiplier = randomFloat(rand, EARNINGS_MULTIPLIER_MIN, EARNINGS_MULTIPLIER_MAX, 4);
  return Math.round(costCents * multiplier);
}

// customerLocation: required "City, ST" string for the authenticated
// customer's own ISP location. Returns an empty list if it's not set yet
// -- every Node shown must be in the customer's own area, so there is
// nothing valid to show before ISP Setup is complete.
export function computeNodes(accountId, customerLocation) {
  if (!customerLocation) return [];

  const supers = superNodeIndices(accountId);
  const nodes = [];

  for (let i = 0; i < NODE_COUNT; i++) {
    const isSuper = supers.has(i);
    const costCents = nodeCostCents(accountId, i, isSuper);
    const estMonthlyCents = nodeEstMonthlyCents(accountId, i, costCents);

    const ratio = estMonthlyCents / costCents;
    if (ratio < EARNINGS_MULTIPLIER_MIN - 1e-9 || ratio > EARNINGS_MULTIPLIER_MAX + 1e-9) {
      // Should be unreachable given nodeEstMonthlyCents() derives directly
      // from costCents within the allowed range -- guards against future
      // regressions rather than a real runtime condition.
      throw new Error(`Node earnings ratio out of bounds for row ${i}: ${ratio}`);
    }

    nodes.push({
      nodeId: nodeId(accountId, i),
      location: customerLocation,
      tier: isSuper ? "Super Node" : "Standard Node",
      ip: nodeIp(accountId, i),
      estMonthlyCents,
      costCents,
      status: "SOLD",
    });
  }

  return nodes;
}
