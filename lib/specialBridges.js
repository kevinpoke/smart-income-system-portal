// ISP support controls + special bridges batch: the four EXACT,
// admin-assignable special Bridges (spec section 13/14). These are
// fixed, individually-identified inventory items -- never randomly
// generated, never merged into the generic Standard/Super/Nova
// auto-roll inventory (lib/nodeTiers.js pickRateForTier()). This file is
// the single authoritative catalog; every consumer (admin assignment
// route, owned-Node display, earnings engine) imports from here.
//
// Internal tier key mapping (spec section 14): the Golden Bridge reuses
// the EXISTING "super" tier key (which already displays as "Golden
// Bridge" via lib/nodeTiers.js tierKeyToBridgeDisplayName()) -- no new
// tier concept needed. The three IX Bridges reuse the existing "nova"
// tier key for internal/DB purposes (nova is already persisted as
// "Nova Node" in owned_nodes.tier). Historically the nova tier's
// generic customer-facing label was "XI Bridge" while these four
// special rows needed to read "IX Bridge" specifically, which required
// this catalog to carry its OWN `displayName` override rather than use
// the generic tierKeyToBridgeDisplayName() lookup. As of the Standard
// Bridge label update, the generic nova-tier label is ALSO "IX Bridge"
// (see lib/nodeTiers.js BRIDGE_DISPLAY_NAMES), so the two now agree for
// these four rows -- this catalog's own `displayName` field is kept
// regardless (still the single authoritative override every
// special-bridge-aware renderer must prefer -- see
// specialBridgeDisplayName() below, and lib/ownedNodes.js
// listOwnedNodes()), since a special Bridge's identity/label must never
// silently depend on whatever the generic tier label happens to be at
// any given time.
// Waitlist redesign + Bridge ordering batch (spec section J): the
// Admin Portal's Special Bridge selection list must show
// Golden Bridge #617294 FIRST, with the remaining five special Bridges
// preserved in their existing relative order after it. This is a pure
// DISPLAY/SELECTION ORDER change -- ids, tierKey, displayName, and
// baseEstMonthlyCents (including #617294's own 480000) are completely
// unchanged; every consumer (assignment route GET, ownedNodes.js,
// earnings engine) reads this same array, so reordering it here is the
// single source of truth with no other file to touch.
export const SPECIAL_BRIDGE_CATALOG = [
  {
    id: "617294",
    tierKey: "super",
    displayName: "Golden Bridge",
    baseEstMonthlyCents: 480000, // $4,800
  },
  {
    id: "284373",
    tierKey: "super",
    displayName: "Golden Bridge",
    baseEstMonthlyCents: 490000, // $4,900
  },
  {
    id: "841837",
    tierKey: "nova",
    displayName: "IX Bridge",
    baseEstMonthlyCents: 170000, // $1,700
  },
  {
    id: "952341",
    tierKey: "nova",
    displayName: "IX Bridge",
    baseEstMonthlyCents: 190000, // $1,900
  },
  {
    id: "934211",
    tierKey: "nova",
    displayName: "IX Bridge",
    baseEstMonthlyCents: 130000, // $1,300
  },
  {
    id: "735122",
    tierKey: "nova",
    displayName: "IX Bridge",
    baseEstMonthlyCents: 55000, // $550
  },
];

const SPECIAL_BRIDGE_BY_ID = new Map(SPECIAL_BRIDGE_CATALOG.map((b) => [b.id, b]));

export function getSpecialBridgeById(bridgeId) {
  return SPECIAL_BRIDGE_BY_ID.get(String(bridgeId)) || null;
}

export function isSpecialBridgeId(bridgeId) {
  return SPECIAL_BRIDGE_BY_ID.has(String(bridgeId));
}

// Customer/admin-facing display name for a special Bridge row -- ALWAYS
// this catalog's own `displayName` ("Golden Bridge" / "IX Bridge"),
// never the generic tierKeyToBridgeDisplayName() lookup, per the header
// comment above.
export function specialBridgeDisplayName(bridgeId) {
  const bridge = getSpecialBridgeById(bridgeId);
  return bridge?.displayName || null;
}

// ---- Stable, deterministic +/-2% to +/-5% MONTHLY fluctuation ----------
//
// Spec sections 18-21: each special Bridge's effective monthly earning
// for a given CALENDAR MONTH is its base estimate multiplied by a single
// variance chosen once for that (bridge, month) pair -- between 2% and
// 5%, either direction -- and that exact effective rate must stay
// stable for the entire month (refresh-proof, restart-proof, Docker-
// recreate-proof, and reproducible for historical months). This is
// achieved the SAME way lib/earningsEngine.js's own
// dailyFluctuationMultiplier() already achieves an identical guarantee
// for the existing daily account-level wobble: a seeded, deterministic
// PRNG (lib/mockData.js rngFromKey -- never Math.random()) keyed by a
// stable string that is entirely reproducible from (bridgeId, monthKey)
// alone, so NOTHING needs to be persisted anywhere to get "refresh does
// not change the number; app restart does not change the number; Docker
// recreate does not change the number; multiple API calls agree;
// historical months remain reproducible" all at once, for free.
import { rngFromKey } from "./mockData";

const MIN_VARIANCE = 0.02;
const MAX_VARIANCE = 0.05;

// Calendar-month key ("YYYY-MM") for a given UTC epoch ms, in UTC. A
// plain UTC calendar month (not the Pacific-midnight DAILY cycle
// lib/earningsEngine.js uses for its finer-grained accrual boundary --
// see that file's CYCLE_TZ comment) is the right granularity here since
// this is a coarser, whole-calendar-month concept ("Golden Bridge's
// October rate"), not a specific daily accrual boundary.
export function monthKeyFor(nowMs) {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// Deterministic variance fraction in [-0.05,-0.02] U [0.02,0.05] for one
// specific (bridgeId, monthKey) pair. Reproducible forever from these
// two inputs alone -- never persisted, never re-rolled.
export function specialBridgeVarianceFraction(bridgeId, monthKey) {
  const rand = rngFromKey(`specialbridge:variance:${bridgeId}:${monthKey}`);
  const direction = rand() < 0.5 ? -1 : 1;
  const magnitude = MIN_VARIANCE + rand() * (MAX_VARIANCE - MIN_VARIANCE);
  return direction * magnitude;
}

// The effective monthly earning (in cents) for a special Bridge during
// the calendar month identified by `monthKey` -- base estimate x
// (1 + variance), rounded to the nearest cent. Callers needing "this
// month" should pass monthKeyFor(Date.now()); callers computing a
// specific historical/future cycle should pass that cycle's own month
// key (see lib/earningsEngine.js computeNodeCycleCents(), which does
// exactly this per accrual cycle so a Bridge spanning two calendar
// months correctly uses each month's own effective rate for the time
// actually earned in that month -- spec section 21).
export function effectiveMonthlyCentsForBridgeMonth(bridge, monthKey) {
  const fraction = specialBridgeVarianceFraction(bridge.id, monthKey);
  return Math.round(bridge.baseEstMonthlyCents * (1 + fraction));
}

// Convenience: effective monthly cents for a bridge id at a given
// instant (defaults to "right now"). Returns null for an unrecognized
// bridge id.
export function currentEffectiveMonthlyCentsForBridgeId(bridgeId, nowMs = Date.now()) {
  const bridge = getSpecialBridgeById(bridgeId);
  if (!bridge) return null;
  return effectiveMonthlyCentsForBridgeMonth(bridge, monthKeyFor(nowMs));
}
