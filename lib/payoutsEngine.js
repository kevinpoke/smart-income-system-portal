import { rngFromKey, randomFloat } from "./mockData";

// Server-only, purely-deterministic payout ESTIMATE generator. These are
// explicitly demo/marketing figures ("previous payouts in your area") --
// they are NEVER written to ledger_entries and NEVER affect
// current_balance_cents / lifetime_earnings_cents. The dashboard's real
// ledger-backed earnings (lib/earningsEngine.js) is a completely separate
// code path; this file must never import from or write through it.
//
// Determinism: each row's amount is seeded by `${accountId}:${year}-${month}`
// so it is stable forever for that exact account+month combination,
// independent of when the account visits the page, across refresh, login
// cycles, and server restarts. Changing the account's ISP location does
// NOT change these amounts (they aren't seeded by location) -- only the
// account id and the calendar month are.

const MIN_CENTS = 230000; // $2,300.00
const MAX_CENTS = 410000; // $4,100.00

function estimateCentsForMonth(accountId, year, month) {
  // month is 1-12 here for a human-readable seed key.
  const rand = rngFromKey(`payout:${accountId}:${year}-${String(month).padStart(2, "0")}`);
  const dollars = randomFloat(rand, MIN_CENTS / 100, MAX_CENTS / 100, 2);
  return Math.round(dollars * 100);
}

// Returns the last `count` full calendar months strictly BEFORE the
// current month (the current, still-in-progress month never appears --
// only completed months have a "previous payout"), newest first, using
// real Date objects for both the seed and the sort key so ordering can
// never degrade into alphabetical month-name sorting.
export function computePayoutEstimates(accountId, count = 12) {
  const now = new Date();
  const rows = [];
  for (let i = 1; i <= count; i++) {
    // First day of (current month - i), evaluated via UTC to avoid
    // timezone-dependent month drift.
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1; // 1-12
    const amountCents = estimateCentsForMonth(accountId, year, month);
    rows.push({
      id: `${year}-${String(month).padStart(2, "0")}`,
      // Real Date used for both display formatting and sort key -- never
      // sorted by the formatted string.
      sortKeyMs: d.getTime(),
      monthLabel: d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
      amountCents,
    });
  }
  // Already generated newest-first (i=1 is last month, i=count is the
  // oldest), but sort explicitly by the real date value to make the
  // "newest first, using actual date values" requirement airtight even if
  // the generation order above ever changes.
  rows.sort((a, b) => b.sortKeyMs - a.sortKeyMs);
  return rows;
}
