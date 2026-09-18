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
// "Bridge" / "Golden Bridge" / "IX Bridge".
//
// STANDARD BRIDGE LABEL + FUTURE-ONLY EARNINGS RANGE UPDATE batch: the
// nova tier's customer/admin-facing label changed from "XI Bridge" to
// "IX Bridge" (display-only -- the canonical key `nova` and the
// persisted `owned_nodes.tier` display string "Nova Node" are
// unchanged, see BRIDGE_DISPLAY_NAMES below). Per the same batch, the
// super ("Golden Bridge") and nova ("IX Bridge") cent ranges were
// raised for FUTURE assignments only:
//   super: $2,800-$4,000  -> $4,500-$5,000 (280000-400000 -> 450000-500000 cents)
//   nova:  $1,200-$1,700  -> $1,500-$2,000 (120000-170000 -> 150000-200000 cents)
// This ONLY changes what NEW pickRateForTier() calls generate going
// forward (new owned-Node assignments, and the admin Edit-Bridge tier
// change flow, which explicitly re-rolls a rate for the NEWLY chosen
// tier -- both are "new assignment" events). It does NOT touch any
// EXISTING owned_nodes row's stored est_monthly_cents/earning_rate_cents
// -- those columns are written ONCE at assignment time (see
// lib/ownedNodes.js) and never rewritten by a later range change. The
// only thing that reads a tier's range against an EXISTING stored rate
// is clampCentsToTierMax() below, which only ever LOWERS a rate to the
// tier's current maxCents -- since both new maxCents values here are
// HIGHER than the previous maxCents, that clamp remains a complete
// no-op for every pre-existing Standard Golden/IX Bridge (grandfathered
// exactly as before, no migration/backfill needed for this change).
//
// Cent ranges (current):
//   standard ("Bridge"):        $1,500-$2,500/mo -> 150000-250000 cents
//   super    ("Golden Bridge"): $4,500-$5,000/mo -> 450000-500000 cents
//   nova     ("IX Bridge"):     $1,500-$2,000/mo -> 150000-200000 cents
//
// Prior range history: super was $2,800-$4,000 (before that $2,500-
// $4,000); nova/XI was $1,200-$1,700 (before that $1,000-$2,000).
//
// IMPORTANT ranking note: prior to the original Node -> Bridge rebrand,
// "nova" was the highest-earning/premium tier ($4,000-$6,000/mo). It
// became the LOWEST-earning tier ("XI Bridge", later relabeled "IX
// Bridge"). As of this batch nova ($1,500-$2,000) is again the lowest
// tier and "super" ("Golden Bridge", $4,500-$5,000) is the highest,
// with "standard" ("Bridge", $1,500-$2,500) in the middle. Do not
// assume nova/IX Bridge is "premium" anywhere in the code or copy.
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
    minCents: 450000, // $4,500 -- Standard-Bridge-earnings-range batch: was 280000 ($2,800)
    maxCents: 500000, // $5,000 -- Standard-Bridge-earnings-range batch: was 400000 ($4,000)
    glow: null,
  },
  nova: {
    key: "nova",
    label: "Nova",
    displayName: "Nova Node",
    minCents: 150000, // $1,500 -- Standard-Bridge-earnings-range batch: was 120000 ($1,200)
    maxCents: 200000, // $2,000 -- Standard-Bridge-earnings-range batch: was 170000 ($1,700); LOWEST tier, see ranking note above
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
  nova: "IX Bridge", // Standard-Bridge-earnings-range batch: was "XI Bridge" (display-only rename; canonical key `nova` unchanged)
};

// "Data Bridges" section/nav label helper -- single place any
// customer-facing heading/nav-item text for the former "Nodes" section
// should pull from, so it can never drift out of sync across the
// Sidebar/MobileNav/marketplace page.
export const DATA_BRIDGES_SECTION_LABEL = "Data Bridges";

// Maps a canonical tier key to the new customer/admin-facing display
// string ("Bridge" / "Golden Bridge" / "IX Bridge"). Falls back to the
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

// Runtime safety net (production feature/fix batch, XI-Bridge-cap
// follow-up): clamps a STORED est_monthly_cents/earning_rate_cents
// value to its tier's current maxCents at the moment it's actually used
// to compute earnings. `pickRateForTier()` above only enforces a tier's
// range at the instant a NEW rate is assigned (Node creation, or an
// admin explicitly changing a Node's tier) -- it does nothing for a
// Node whose rate was already persisted under a PRIOR, wider range
// before a tier's range was tightened (e.g. nova/XI's max dropping from
// $2,000 to $1,700). A one-time DB backfill (scripts/normalize-xi-cap.mjs)
// corrects existing rows going forward, but this clamp is the durable
// belt-and-suspenders guard: even if a future range change is shipped
// without a matching backfill, or a row is somehow reintroduced above
// its tier's cap by any other path, actual earnings computation can
// never exceed the tier's current maxCents. Accepts either the
// persisted display-name string ("Nova Node") or a canonical key
// ("nova"); unrecognized values fall back to Standard's cap via the
// existing displayNameToTierKey()/NODE_TIERS fallback chain, matching
// this file's other lookup helpers.
export function clampCentsToTierMax(tierDisplayNameOrKey, cents) {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return cents;
  const tierKey = isValidTierKey(tierDisplayNameOrKey)
    ? tierDisplayNameOrKey
    : displayNameToTierKey(tierDisplayNameOrKey);
  const tier = NODE_TIERS[tierKey] || NODE_TIERS.standard;
  return Math.min(cents, tier.maxCents);
}
