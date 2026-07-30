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
