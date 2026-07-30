// Single shared source of truth for Node tier definitions -- canonical
// key, display name, and estimated-monthly-earnings cent range. Every
// place in the app that needs tier metadata (owned-Node rate assignment,
// the marketplace demo inventory, Dashboard "Your Nodes", User
// Management, the Add Node / Edit Node admin popups, and any future
// consumer) must import from here rather than hardcoding its own range,
// per spec ("Do not hardcode tier ranges independently in many files").
//
// Cent ranges (per spec section 6):
//   Standard Node: $1,000-$2,500/mo  -> 100000-250000 cents
//   Super Node:    $2,500-$4,000/mo  -> 250000-400000 cents
//   Nova Node:     $4,000-$6,000/mo  -> 400000-600000 cents
//
// Display names are kept EXACTLY as the existing `owned_nodes.tier`
// column already stores them ("Standard Node" / "Super Node") so no
// backfill/rewrite of existing rows is required -- "Nova Node" simply
// joins as a third valid value using the same naming convention.

import { randomFloat } from "./mockData";

export const NODE_TIERS = {
  standard: {
    key: "standard",
    label: "Standard",
    displayName: "Standard Node",
    minCents: 100000, // $1,000
    maxCents: 250000, // $2,500
    glow: null,
  },
  super: {
    key: "super",
    label: "Super",
    displayName: "Super Node",
    minCents: 250000, // $2,500
    maxCents: 400000, // $4,000
    glow: null,
  },
  nova: {
    key: "nova",
    label: "Nova",
    displayName: "Nova Node",
    minCents: 400000, // $4,000
    maxCents: 600000, // $6,000
    glow: "purple",
  },
};

export const TIER_KEYS = ["standard", "super", "nova"];

export function isValidTierKey(key) {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(NODE_TIERS, key);
}

// Maps a canonical tier key to the exact display string persisted in
// `owned_nodes.tier` (and shown throughout the UI). Falls back to the
// Standard display name for an unrecognized key rather than throwing --
// callers that need strict validation should call isValidTierKey()
// first and reject invalid input themselves (this function is a pure
// lookup, not a validator).
export function tierKeyToDisplayName(key) {
  return NODE_TIERS[key]?.displayName || NODE_TIERS.standard.displayName;
}

// Reverse mapping: given a persisted display string (as already stored
// on existing owned_nodes rows, e.g. "Super Node"), returns the
// canonical tier key ("super"). Falls back to "standard" for any
// unrecognized/legacy value so old rows always resolve to SOME valid
// tier rather than producing an undefined tier key downstream.
export function displayNameToTierKey(displayName) {
  const match = Object.values(NODE_TIERS).find((t) => t.displayName === displayName);
  return match?.key || "standard";
}

// Deterministic (seeded) cents-in-range picker for a given tier. `rand`
// must be a rand()-style function from lib/mockData.js rngFromKey/
// rngFromSeed -- callers are responsible for seeding it appropriately
// (e.g. `accountId:nodeNumber` for a brand-new Node, or
// `accountId:nodeNumber:newTier` when an admin changes a Node's tier,
// so the SAME tier always reproduces the SAME rate for that Node
// deterministically, without ever needing to store the seed itself).
export function pickRateForTier(rand, tierKey) {
  const tier = NODE_TIERS[tierKey] || NODE_TIERS.standard;
  const dollars = randomFloat(rand, tier.minCents / 100, tier.maxCents / 100, 2);
  return Math.round(dollars * 100);
}
