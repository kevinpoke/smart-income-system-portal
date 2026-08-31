// ADMIN-PORTAL-TIME-FORMATTING batch: single canonical source for every
// Admin-Portal-visible date/time/duration display. Two hard rules,
// enforced ONLY here so every admin-facing call site automatically
// inherits both without re-deriving them:
//   1. Canonical timezone is ALWAYS America/Los_Angeles (handles
//      PST/PDT automatically via the IANA tz database) -- never
//      browser-local, never server-local, never a manual UTC-8/UTC-7
//      offset subtraction (spec Part 21).
//   2. NEVER display seconds, anywhere (spec Part 20/22/23) -- this is
//      a DISPLAY-only trim. It never touches what is stored in SQLite
//      (still full ISO-8601 with seconds), never changes scheduler/
//      countdown precision (ISP auto-approval, 48h waitlist, etc. all
//      keep computing real millisecond-accurate deadlines -- only the
//      rendered string is coarsened).
//
// Deliberately NOT used by anything customer-facing (Dashboard,
// customer Support Chat, ISP Setup, Withdrawals, Nodes, Modules pages)
// -- those keep using their existing toLocaleString()/formatCountdown
// calls from lib/mockData.js completely unchanged, per spec ("Admin
// Portal" scope only).
const ADMIN_TIME_ZONE = "America/Los_Angeles";

function toDate(value) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// "Aug 30, 2026, 5:42 PM" -- full admin date+time, no seconds, always
// Pacific regardless of the viewing admin's own device/browser
// timezone (Intl.DateTimeFormat's `timeZone` option forces the
// conversion server- or client-side identically; it is NOT the same
// thing as the browser's local Date formatting, which is exactly the
// bug this batch fixes).
export function formatAdminDateTime(value) {
  const d = toDate(value);
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ADMIN_TIME_ZONE,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

// "Aug 30, 2026" -- admin date-only (e.g. Joined / account creation
// date columns that previously only ever showed a date, never a time).
export function formatAdminDate(value) {
  const d = toDate(value);
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ADMIN_TIME_ZONE,
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(d);
}

// "5:42 PM" -- admin time-only (e.g. a compact inline timestamp next
// to a Support Chat message bubble where the date is already implied
// by a day-separator above it).
export function formatAdminTime(value) {
  const d = toDate(value);
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ADMIN_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

// "Never" for a null/missing timestamp, else formatAdminDateTime(). The
// direct Pacific/no-seconds replacement for the old
// app/(portal)/admin/page.js#formatLastLogin() and
// app/(portal)/admin/chats/page.js#formatTime(), both of which
// previously called the browser/server-local `new Date(iso).
// toLocaleString()`.
export function formatAdminLastLogin(value) {
  if (!value) return "Never";
  return formatAdminDateTime(value);
}

// Admin countdown display: hours + minutes only (or days + hours +
// minutes for a multi-day countdown), NEVER seconds -- the internal
// `ms` value passed in must still be computed to full millisecond
// accuracy by the caller (see lib/mockData.js#formatCountdown /
// lib/earningsEngine.js's real deadline math, both UNCHANGED by this
// batch); this function only decides how coarsely to RENDER it. e.g.
// "0d 00h 58m 15s" (old) -> "0d 00h 58m" (new); "01h 24m 37s" (old)
// -> "01h 24m" (new). Mirrors lib/mockData.js#formatCountdown's exact
// zero-padded shape, just with the trailing seconds segment dropped.
export function formatAdminCountdown(ms) {
  const clamped = Math.max(0, ms);
  const totalMinutes = Math.floor(clamped / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return `${days}d ${pad(hours)}h ${pad(minutes)}m`;
}

export { ADMIN_TIME_ZONE };
