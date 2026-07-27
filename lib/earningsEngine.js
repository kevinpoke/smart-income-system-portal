import { generateId } from "./auth-crypto";
import { rngFromSeed, randomFloat } from "./mockData";

// Server-only earnings engine. This is the ONLY place that computes or
// writes earnings data; every number shown to a customer flows through
// here from SQLite (ledger_entries + accounts.current_balance_cents /
// lifetime_earnings_cents), never from Zustand/localStorage.
//
// DEMO MODE: this app has no live production earnings source yet, so daily
// earnings are a deterministic "expected" estimate seeded by account ID +
// calendar date (UTC). The same seed always produces the same amount for
// that day, and once a day is written to the ledger it is NEVER rewritten
// -- only the multiplier in effect at write time is baked into that row
// (per the "do not retroactively rewrite prior ledger events" rule).
// Every ledger row created here is tagged metadata_json.mode = "demo" so
// it is unambiguous these are not externally funded/verified payouts.

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_PAYOUT_DAYS = 120; // safety floor if 4 calendar months is short
const CATCHUP_WINDOW_DAYS = 400; // sanity cap so a corrupted timestamp can't loop forever

function hashStringToSeed(str) {
  // FNV-1a 32-bit -- fast, deterministic, good-enough distribution for a
  // display-only PRNG seed (not used for anything security-sensitive).
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function dateStrUTC(date) {
  return date.toISOString().slice(0, 10); // "YYYY-MM-DD" in UTC
}

function startOfUTCDateMs(dateStr) {
  return Date.parse(`${dateStr}T00:00:00.000Z`);
}

// Deterministic daily BASE amount (before multiplier) in integer cents,
// seeded by account id + calendar date. Stable for the entire calendar day
// and reproducible forever from the same two inputs -- this is what makes
// idempotent catch-up possible without storing anything extra.
export function dailyBaseAmountCents(accountId, dateStr) {
  const seed = hashStringToSeed(`${accountId}:${dateStr}`);
  const rand = rngFromSeed(seed);
  const dollars = randomFloat(rand, 80, 150, 2);
  return Math.round(dollars * 100);
}

// Four CALENDAR months from `startMs` (using actual month-length
// arithmetic, not a flat day count), clamped to a minimum of
// MIN_PAYOUT_DAYS calendar days in case a run of short months would
// otherwise land earlier than that floor.
export function addCalendarMonthsClamped(startMs, months, minDays = MIN_PAYOUT_DAYS) {
  const start = new Date(startMs);
  const target = new Date(start);
  target.setUTCMonth(target.getUTCMonth() + months);
  const minMs = startMs + minDays * DAY_MS;
  return Math.max(target.getTime(), minMs);
}

// Recomputes accounts.current_balance_cents / lifetime_earnings_cents
// directly from ledger_entries so they can never drift from the ledger --
// this IS the reconciliation, not a cache that might disagree with it.
// - lifetime_earnings_cents = sum of 'earning' entries only (gross total
//   ever earned; matches the "Total Earnings" requirement).
// - current_balance_cents = earnings + admin_credit + correction
//   - admin_debit - payout (net spendable balance).
function recomputeBalances(db, accountId) {
  const rows = db
    .prepare(
      `SELECT event_type, COALESCE(SUM(final_amount_cents), 0) as total
       FROM ledger_entries WHERE account_id = ? GROUP BY event_type`
    )
    .all(accountId);

  let lifetime = 0;
  let balance = 0;
  for (const row of rows) {
    switch (row.event_type) {
      case "earning":
        lifetime += row.total;
        balance += row.total;
        break;
      case "admin_credit":
      case "correction":
        balance += row.total;
        break;
      case "admin_debit":
      case "payout":
        balance -= row.total;
        break;
      default:
        break;
    }
  }

  db.prepare(
    `UPDATE accounts SET current_balance_cents = ?, lifetime_earnings_cents = ? WHERE id = ?`
  ).run(balance, lifetime, accountId);
}

// Writes exactly one immutable 'earning' ledger row for every fully
// completed UTC calendar day between the account's node_connected_at date
// and yesterday (inclusive), for any day that doesn't already have one.
// Idempotent: INSERT OR IGNORE + the UNIQUE(account_id, source_reference)
// constraint means calling this 1 time or 100 times in a row (login,
// refresh, periodic poll, server restart) produces the exact same ledger
// state -- this is the "offline catch-up without double counting" rule.
//
// Today itself is deliberately never written here -- it only becomes a
// real ledger row once it is no longer "today" on a later call. Until
// then it's shown to the customer only as a live, ticking, clearly-labeled
// estimate (see the dashboard's useEarnings/AnimatedNumber usage).
export function runEarningsCatchup(db, account) {
  if (account.isp_status !== "active" || !account.node_connected_at) {
    return;
  }

  const startDateStr = dateStrUTC(new Date(account.node_connected_at));
  const todayDateStr = dateStrUTC(new Date());
  const todayStartMs = startOfUTCDateMs(todayDateStr);
  let cursorMs = startOfUTCDateMs(startDateStr);

  // Guard against a corrupted/absurd node_connected_at value turning this
  // into an unbounded loop.
  const maxIterations = CATCHUP_WINDOW_DAYS;
  let iterations = 0;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO ledger_entries
       (id, account_id, event_type, base_amount_cents, multiplier, final_amount_cents, effective_date, created_at, source_reference, metadata_json)
     VALUES (?, ?, 'earning', ?, ?, ?, ?, ?, ?, ?)`
  );

  const multiplier = account.earnings_multiplier ?? 1.0;
  const nowIso = new Date().toISOString();
  let wroteAny = false;

  while (cursorMs < todayStartMs && iterations < maxIterations) {
    const dateStr = dateStrUTC(new Date(cursorMs));
    const sourceRef = `earning:${dateStr}`;
    const baseCents = dailyBaseAmountCents(account.id, dateStr);
    const finalCents = Math.round(baseCents * multiplier);

    const result = insert.run(
      generateId("ledger"),
      account.id,
      baseCents,
      multiplier,
      finalCents,
      dateStr,
      nowIso,
      sourceRef,
      JSON.stringify({
        mode: "demo",
        label: "Demo estimate — not an externally funded payout.",
      })
    );
    if (result.changes > 0) wroteAny = true;

    cursorMs += DAY_MS;
    iterations += 1;
  }

  if (wroteAny) {
    recomputeBalances(db, account.id);
  }
}

// Full dashboard summary: runs catch-up (if active), then reads back
// everything the dashboard needs, all sourced from SQLite.
export function computeEarningsSummary(db, accountId) {
  const account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
  if (!account) return null;

  const active = account.isp_status === "active" && !!account.node_connected_at;

  if (active) {
    runEarningsCatchup(db, account);
  }

  const fresh = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);

  const todayDateStr = dateStrUTC(new Date());
  const todayStartMs = startOfUTCDateMs(todayDateStr);
  const multiplier = fresh.earnings_multiplier ?? 1.0;

  let todaysExpectedCents = 0;
  if (active) {
    const todaysBaseCents = dailyBaseAmountCents(fresh.id, todayDateStr);
    todaysExpectedCents = Math.round(todaysBaseCents * multiplier);
  }

  const completedDaysRow = db
    .prepare(
      `SELECT COUNT(*) as c FROM ledger_entries WHERE account_id = ? AND event_type = 'earning'`
    )
    .get(accountId);
  const completedDays = completedDaysRow.c;

  const averageDailyCents = active
    ? completedDays > 0
      ? Math.round(fresh.lifetime_earnings_cents / completedDays)
      : todaysExpectedCents
    : 0;

  const weekThresholdDateStr = dateStrUTC(new Date(Date.now() - 7 * DAY_MS));
  const monthThresholdDateStr = dateStrUTC(new Date(Date.now() - 30 * DAY_MS));

  const weekRow = db
    .prepare(
      `SELECT COALESCE(SUM(final_amount_cents), 0) as total FROM ledger_entries
       WHERE account_id = ? AND event_type = 'earning' AND effective_date >= ?`
    )
    .get(accountId, weekThresholdDateStr);
  const monthRow = db
    .prepare(
      `SELECT COALESCE(SUM(final_amount_cents), 0) as total FROM ledger_entries
       WHERE account_id = ? AND event_type = 'earning' AND effective_date >= ?`
    )
    .get(accountId, monthThresholdDateStr);

  // Small ledger-backed series for the dashboard chart: last 14 UTC days,
  // using the real ledger row where one exists, or the (not-yet-written)
  // deterministic expected value for today only. This replaced the old
  // Zustand-seeded generateEarningsSeries(), which had no connection to
  // real account data.
  const seriesDays = 14;
  const series = [];
  for (let i = seriesDays - 1; i >= 0; i--) {
    const d = new Date(todayStartMs - i * DAY_MS);
    const ds = dateStrUTC(d);
    const row = db
      .prepare(
        `SELECT final_amount_cents FROM ledger_entries WHERE account_id = ? AND event_type = 'earning' AND effective_date = ?`
      )
      .get(accountId, ds);
    let cents = 0;
    if (row) {
      cents = row.final_amount_cents;
    } else if (active && ds === todayDateStr) {
      cents = todaysExpectedCents;
    }
    series.push({
      label: d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
      value: Number((cents / 100).toFixed(2)),
    });
  }

  let payoutTargetAt = null;
  let payoutAvailable = false;
  if (fresh.node_connected_at) {
    const targetMs = addCalendarMonthsClamped(new Date(fresh.node_connected_at).getTime(), 4);
    payoutTargetAt = new Date(targetMs).toISOString();
    payoutAvailable = Date.now() >= targetMs;
  }

  return {
    mode: "demo",
    active,
    ispStatus: fresh.isp_status,
    nodeConnectedAt: fresh.node_connected_at,
    todayStartAt: new Date(todayStartMs).toISOString(),
    todaysExpectedCents,
    averageDailyCents,
    lifetimeEarningsCents: fresh.lifetime_earnings_cents,
    currentBalanceCents: fresh.current_balance_cents,
    weekEarningsCents: weekRow.total,
    monthEarningsCents: monthRow.total,
    completedDays,
    payoutTargetAt,
    payoutAvailable,
    series,
  };
}
