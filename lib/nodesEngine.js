import { rngFromKey, randomInt, randomFloat } from "./mockData";

// Server-only, purely-deterministic demo Node inventory generator. Every
// value here is derived from `${accountId}:${rowIndex}` (or a fixed row
// key for shared fields), so it never uses Math.random() and never changes
// across renders, refreshes, logins, or server restarts for a given
// account. None of these numbers are earnings -- they are marketing/demo
// inventory data and must never be written to ledger_entries.

const NODE_COUNT = 24;
const SUPER_NODE_COUNT = 3;

const STANDARD_COST_MIN_CENTS = 25000; // $250
const STANDARD_COST_MAX_CENTS = 55000; // $550
const SUPER_COST_MIN_CENTS = 60000; // $600
const SUPER_COST_MAX_CENTS = 98000; // $980

const EARNINGS_MULTIPLIER_MIN = 3.5;
const EARNINGS_MULTIPLIER_MAX = 5.0;

const DEMO_LOCATIONS = [
  "Austin, TX", "Denver, CO", "Phoenix, AZ", "Columbus, OH", "Raleigh, NC",
  "Tampa, FL", "Portland, OR", "Nashville, TN", "Boise, ID", "Salt Lake City, UT",
  "Charlotte, NC", "Kansas City, MO", "Indianapolis, IN", "Sacramento, CA",
];

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

function nodeLocation(accountId, rowIndex, customerLocation) {
  // Prioritize the authenticated customer's own ISP location on the first
  // row so their table visibly reflects "a node near you", while every
  // other row shows a realistic-but-generic demo location (never another
  // customer's real ISP location -- this generator only ever receives the
  // CALLING customer's own location as an argument).
  if (rowIndex === 0 && customerLocation) {
    return customerLocation;
  }
  const rand = rngFromKey(`node:loc:${accountId}:${rowIndex}`);
  return DEMO_LOCATIONS[randomInt(rand, 0, DEMO_LOCATIONS.length - 1)];
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

// customerLocation: optional "City, ST" string for the authenticated
// customer's own ISP location (or null if not yet set) -- used only to
// personalize row 0's Location field for THIS customer.
export function computeNodes(accountId, customerLocation) {
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
      location: nodeLocation(accountId, i, customerLocation),
      tier: isSuper ? "Super Node" : "Standard Node",
      ip: nodeIp(accountId, i),
      estMonthlyCents,
      costCents,
      status: "SOLD",
    });
  }

  return nodes;
}
