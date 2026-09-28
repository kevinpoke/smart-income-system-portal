// Shared server+client-safe location normalization utilities. Used by
// BOTH the customer-facing ISP Setup submission route
// (app/api/isp/submit) and the admin User Management location editor
// (app/api/admin/accounts/[id]/location) -- there must be exactly ONE
// place this formatting logic lives, per spec ("do not maintain
// separate formatting logic in multiple routes").
//
// These are pure functions (no DB/request access) so they can also be
// imported client-side for an instant "preview" of the normalized value
// before the save round-trip completes, while the SERVER'S own call to
// the exact same function remains the authoritative value actually
// persisted (never trust a client-normalized value directly).

import { US_STATES } from "./mockData";

const US_STATE_SET = new Set(US_STATES);

// OTHER-STATE-ISP batch: fixed sentinel written to accounts.isp_state /
// isp_setups.state when the customer selects "Other" in the State
// dropdown. Never a real two-letter code (isValidStateCode below
// deliberately excludes it), so this can always be distinguished from a
// genuine US_STATES value at a glance -- but the AUTHORITATIVE signal
// for cohort/Analytics purposes remains isp_state_is_other (see
// lib/db.js), never this string alone.
export const OTHER_STATE_CODE = "OTHER";

// Title-cases a city name: uppercases the first letter of each "word",
// where a word boundary is whitespace, a hyphen, or an apostrophe (so
// "coeur d'alene" -> "Coeur D'Alene" and "winston-salem" ->
// "Winston-Salem" both capitalize correctly on every side of the
// punctuation, not just at the very start of the string). Everything
// else is lowercased first so mixed/garbled input ("LOS ANGELES", "sAn
// frANcisco") normalizes the same as clean input. Leading/trailing
// whitespace is trimmed and repeated internal whitespace is collapsed
// to a single space, per spec.
//
// Deliberately does NOT validate the result against any external
// geocoding/location database -- per spec ("do not silently invent or
// validate a city against an external location database"), this is a
// pure text-formatting transform only. An empty/whitespace-only input
// normalizes to an empty string; callers decide whether that's
// acceptable (e.g. the ISP Setup route still requires a non-empty city
// via its own REQUIRED_FIELDS check before this function ever runs).
export function normalizeCity(raw) {
  if (typeof raw !== "string") return "";
  const collapsed = raw.trim().replace(/\s+/g, " ");
  if (!collapsed) return "";

  const lower = collapsed.toLowerCase();
  // Capitalize the first letter of the whole string, and the first
  // letter immediately following any run of whitespace, hyphen, or
  // apostrophe -- covers "st. louis" -> "St. Louis" (space boundary),
  // "coeur d'alene" -> "Coeur D'Alene" (apostrophe boundary), and
  // "winston-salem" -> "Winston-Salem" (hyphen boundary) in one pass.
  return lower.replace(/(^|[\s\-'])([a-z])/g, (match, boundary, letter) => boundary + letter.toUpperCase());
}

// Normalizes a US state value to its canonical two-letter uppercase
// code. Trims whitespace and uppercases -- does NOT attempt to expand a
// full state name ("California" -> "CA") since every existing input
// surface in this app (the ISP Setup <select>, the US_STATES constant)
// already only ever supplies a two-letter code; this keeps the function
// a pure, predictable trim+uppercase rather than guessing at a mapping
// that has no existing caller.
export function normalizeState(raw) {
  if (typeof raw !== "string") return "";
  return raw.trim().toUpperCase();
}

// True only for one of the 50 canonical two-letter US state codes
// (matches the existing lib/mockData.js US_STATES list -- the SAME list
// already used by the ISP Setup <select>, so "valid" here means
// "one of the values the UI itself could ever produce", not an
// independently-invented validation rule).
export function isValidStateCode(code) {
  return typeof code === "string" && US_STATE_SET.has(code);
}

// Trims a customer-typed "State / Region" free-text value for the Other
// path. Whitespace-only input normalizes to an empty string (the caller
// -- both the client form and the server route -- rejects an empty
// result rather than storing it). Deliberately no case-changing/
// title-casing here, unlike normalizeCity: the customer's exact typed
// value (only trimmed) must be preserved verbatim per spec ("do not
// overwrite the user's typed value"); any normalization for display/
// grouping purposes happens read-only, at Analytics query time.
export function normalizeOtherStateText(raw) {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/\s+/g, " ");
}

// ---- ADMIN-CUSTOM-LOCATION-EDITING batch ---------------------------------
//
// Applies the SAME title-case word-boundary normalization normalizeCity()
// already uses (capitalize first letter of each word, lowercase the
// rest, collapse whitespace) to an Admin-entered custom State / Region
// name (e.g. "BRITISH COLUMBIA" -> "British Columbia", "new south
// wales" -> "New South Wales"). Reused verbatim rather than a second
// parallel implementation, per spec ("do not maintain separate
// capitalization implementations in multiple routes") -- this is
// intentionally just an alias so both City and custom-State go through
// literally the same code path with zero drift risk.
export function normalizeCustomLocationText(raw) {
  return normalizeCity(raw);
}

// Resolves what an Admin typed into the State field (spec section 8/10):
// Admin must be able to enter ANY reasonable custom location text, not
// just a two-letter US code. This function decides which storage shape
// applies:
//   - Blank/whitespace-only input -> invalid (caller rejects).
//   - A two-letter value that matches a canonical US_STATES code
//     (case-insensitive, e.g. admin types "ca" or "CA") -> treated as a
//     genuine canonical State selection: isOther=false, the canonical
//     UPPERCASE two-letter code is returned as `value`.
//   - Anything else (a full name, a Canadian province, "Panama", a
//     stray two-letter string that ISN'T one of the 50 codes) -> Other:
//     isOther=true, `value` is the title-cased normalized text (per the
//     spec's capitalization rule), to be stored as
//     isp_state_other_text with isp_state set to OTHER_STATE_CODE.
// This is the SINGLE place that decides "is this Admin-typed State text
// a canonical code or a custom Other region" -- both the location PATCH
// route and any future caller must route through this rather than
// re-deriving the same two-letter-length heuristic independently.
export function resolveAdminStateInput(raw) {
  if (typeof raw !== "string") return { valid: false };
  const trimmed = raw.trim();
  if (!trimmed) return { valid: false };

  const upper = trimmed.toUpperCase();
  if (upper.length === 2 && US_STATE_SET.has(upper)) {
    return { valid: true, isOther: false, value: upper };
  }

  const normalized = normalizeCustomLocationText(trimmed);
  if (!normalized) return { valid: false };
  return { valid: true, isOther: true, value: normalized };
}

// ---- CUSTOM-LOCATION-DISPLAY batch ---------------------------------------
//
// CENTRAL LOCATION DISPLAY HELPER (spec section 5): the ONE shared
// function every customer/admin-facing UI must call to render a
// stored State value. Per spec, once a customer selects "Other" and
// types a region (e.g. "Panama"), EVERY display surface except
// Analytics must show that typed text -- "Panama" -- never the raw
// sentinel "OTHER" and never a hybrid "Other — Panama" label. Analytics
// remains the only place that continues to classify the account under
// an "Other" cohort, via the separate, unchanged isp_state_is_other
// flag (see lib/supportAnalytics.js#computeOtherStateAnalytics) -- this
// helper has no effect on that cohort logic at all; it only changes
// what a human being SEES.
//
// Accepts either a full account-shaped object (as returned by
// lib/authz.js#toPublicAccount, camelCase: ispState/ispStateIsOther/
// ispStateOtherText) or the raw snake_case DB row shape -- both shapes
// coexist across this codebase's various read paths, so this helper
// normalizes across both rather than forcing every call site to
// pre-shape its input first.
//
// For a normal (non-Other) State, this returns the value already
// stored in isp_state completely unchanged -- if any existing/future
// "full state name" display helper is introduced for normal States,
// this function's normal-state branch is the single place to route
// through it, per spec ("continue using the proper normal-state
// display behavior already established in the app... preserve it").
// Today this app stores/displays normal States as their canonical
// two-letter code with no separate full-name expansion, so the normal
// branch is a direct passthrough.
export function displayLocationState(accountLike) {
  if (!accountLike) return "";
  const isOther = Boolean(
    accountLike.ispStateIsOther ?? accountLike.isp_state_is_other
  );
  if (isOther) {
    const otherText = accountLike.ispStateOtherText ?? accountLike.isp_state_other_text;
    // Per spec, never show the raw sentinel even if a legacy/edge-case
    // row somehow has the Other flag set with no typed text -- fall
    // back to an empty string (callers render their own "—"/placeholder
    // for a falsy value, matching the existing LocationCell convention)
    // rather than ever leaking "OTHER" to a human.
    return otherText || "";
  }
  const state = accountLike.ispState ?? accountLike.isp_state;
  return state || "";
}
