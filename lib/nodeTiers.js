// Single shared source of truth for Node/Bridge tier definitions --
// canonical key, INTERNAL display name (still persisted to the
// `owned_nodes.tier` column, unchanged), and estimated-monthly-earnings
// cent range. Every place in the app that needs tier metadata
// (owned-Node rate assignment, the marketplace demo inventory,
// Dashboard "Your Bridges", User Management, the Add Bridge / Edit
// Bridge admin popups, and any future consumer) must import from here
// rather than hardcoding its own range, per spec ("Do not hardcode tier
// ranges independently in many files").
//
// Node -> Bridge rebrand (customer/admin-facing terminology only): the
// canonical keys (`standard`/`super`/`nova`) and the internal
// `displayName` strings ("Standard Node"/"Super Node"/"Nova Node") are
// UNCHANGED and keep being written to/read from `owned_nodes.tier` --
// no DB migration, no rewrite of existing rows. Anything a CUSTOMER OR
// ADMIN actually reads on screen should instead use
// `tierKeyToBridgeDisplayName()` / `BRIDGE_DISPLAY_NAMES` below, which
// map the same canonical keys to the new customer-facing strings
// "Bridge" / "Golden Bridge" / "XI Bridge".
//
// Cent ranges (post-rebrand, per spec section 5; nova/XI range updated
// again in the production feature/fix batch, see below):
//   standard ("Bridge"):        $1,500-$2,500/mo -> 150000-250000 cents
//   super    ("Golden Bridge"): $2,800-$4,000/mo -> 280000-400000 cents
//   nova     ("XI Bridge"):     $1,200-$1,700/mo -> 120000-170000 cents
//
// Production feature/fix batch: nova/XI Bridge's actual earning range is
// $1,200-$1,700/month (max must be exactly $1,700, not $2,000) --
// updated minCents 100000->120000 and maxCents 200000->170000. Golden
// Bridge (super)'s minimum was also raised from $2,500 to $2,800
// (minCents 250000->280000); its $4,000 maximum is unchanged.
//
// IMPORTANT ranking note: prior to this rebrand, "nova" was the
// highest-earning/premium tier ($4,000-$6,000/mo). It is now the
// LOWEST-earning tier ("XI Bridge", $1,200-$1,700/mo) -- "super"
// ("Golden Bridge") is now the highest tier, and "standard" ("Bridge")
// sits in the middle. Do not assume nova/XI Bridge is still "premium"
// anywhere in the code or copy.
//
// Display names are kept EXACTLY as the existing `owned_nodes.tier`
// column already stores them ("Standard Node" / "Super Node" / "Nova
// Node") so no backfill/rewrite of existing rows is required.

import { randomFloat } from "./mockData";

export const NODE_TIERS = {
  standard: {
    key: "standard",
    label: "Standard",
    displayName: "Standard Node",
    minCents: 150000, // $1,500
    maxCents: 250000, // $2,500
    glow: null,
  },
  super: {
    key: "super",
    label: "Super",
    displayName: "Super Node",
    minCents: 280000, // $2,800 -- production feature/fix batch: was 250000 ($2,500)
    maxCents: 400000, // $4,000
    glow: null,
  },
  nova: {
    key: "nova",
    label: "Nova",
    displayName: "Nova Node",
    minCents: 120000, // $1,200 -- production feature/fix batch: was 100000 ($1,000)
    maxCents: 170000, // $1,700 -- production feature/fix batch: was 200000 ($2,000); LOWEST tier, see ranking note above
    glow: "purple",
  },
};

// Customer/admin-FACING display names post-rebrand. Canonical keys are
// unchanged; only what a human reads on screen changes. Use
// tierKeyToBridgeDisplayName() (below) rather than reading this map
// directly, so an unrecognized key still falls back safely.
export const BRIDGE_DISPLAY_NAMES = {
  standard: "Bridge",
  super: "Golden Bridge",
  nova: "XI Bridge",
};

// "Data Bridges" section/nav label helper -- single place any
// customer-facing heading/nav-item text for the former "Nodes" section
// should pull from, so it can never drift out of sync across the
// Sidebar/MobileNav/marketplace page.
export const DATA_BRIDGES_SECTION_LABEL = "Data Bridges";

// Maps a canonical tier key to the new customer/admin-facing display
// string ("Bridge" / "Golden Bridge" / "XI Bridge"). Falls back to the
// Bridge (standard) label for an unrecognized key, mirroring
// tierKeyToDisplayName()'s fallback behavior below.
export function tierKeyToBridgeDisplayName(key) {
  return BRIDGE_DISPLAY_NAMES[key] || BRIDGE_DISPLAY_NAMES.standard;
}

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
