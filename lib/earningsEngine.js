import { generateId } from "./auth-crypto";
import { rngFromSeed, randomFloat } from "./mockData";
import { sumOwnedNodesMonthlyCents } from "./ownedNodes";
import { computeOnMsInRange } from "./wifiEngine";

// Server-only earnings engine. This is the ONLY place that computes or
// writes earnings data; every number shown to a customer flows through
// here from SQLite (ledger_entries + accounts.current_balance_cents /
// lifetime_earnings_cents), never from Zustand/localStorage.
//
// DEMO MODE (Phase 5 revision): daily earnings are now derived from the
// customer's actual owned Node inventory (lib/ownedNodes.js) rather than a
// flat $80-150/day guess -- "Live earnings must be based on the sum of all
// owned Nodes' estimated monthly earnings" per spec. A deterministic
// per-account/per-day fluctuation of up to +/-10% is applied around the
// (totalMonthlyCents / 30) baseline; the fluctuation is stable for that
// account+day (never re-rolled on refresh) but never affects the ledger
// once a day's row is written (per the "do not retroactively rewrite
// prior ledger events" rule). Every ledger row created here is tagged
// metadata_json.mode = "demo" so it is unambiguous these are not
// externally funded/verified payouts.
//
// WiFi gating (Phase 5): every day's (and today's in-progress) earnings
// are additionally pro-rated by the fraction of that time range the
// account's WiFi toggle was ON (lib/wifiEngine.js computeOnMsInRange),
// so turning WiFi off immediately freezes accrual and turning it back on
// never retroactively credits the off period.

const DAY_MS = 24 * 60 * 60 * 1000;
const CATCHUP_WINDOW_DAYS = 400; // sanity cap so a corrupted timestamp can't loop forever
const DAILY_FLUCTUATION_RANGE = 0.1; // +/-10%

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

// Deterministic per-account/per-day fluctuation multiplier in
// [1 - DAILY_FLUCTUATION_RANGE, 1 + DAILY_FLUCTUATION_RANGE]. Stable for
// the entire calendar day and reproducible forever from the same two
// inputs -- this is what makes idempotent catch-up possible without
// storing anything extra, and what keeps the "must not randomly change
// after every refresh" rule true.
export function dailyFluctuationMultiplier(accountId, dateStr) {
  const seed = hashStringToSeed(`dailyfluct:${accountId}:${dateStr}`);
  const rand = rngFromSeed(seed);
  return 1 + randomFloat(rand, -DAILY_FLUCTUATION_RANGE, DAILY_FLUCTUATION_RANGE, 4);
}

// Deterministic daily BASE amount (before multiplier) in integer cents,
// derived from the account's current total owned-Node monthly earnings
// (baseline = totalMonthlyCents / 30) with the stable daily fluctuation
// applied. Falls back to $0 if the account owns no Nodes yet.
export function dailyBaseAmountCents(accountId, dateStr, totalMonthlyCents) {
  if (!totalMonthlyCents) return 0;
  const baseline = totalMonthlyCents / 30;
  const fluctuation = dailyFluctuationMultiplier(accountId, dateStr);
  return Math.round(baseline * fluctuation);
}

function daysInUTCMonth(year, monthIndex) {
  // Day 0 of the FOLLOWING month is the last day of `monthIndex`. Works
  // correctly across year boundaries and leap years because Date.UTC
  // normalizes an out-of-range month index itself.
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

// Exactly N calendar months from `startMs`, preserving the time-of-day and
// using correct end-of-month clamping (no fixed-day-count approximation,
// no minimum-day floor). If the source day-of-month doesn't exist in the
// target month (e.g. Jan 31 -> April has only 30 days), clamp DOWN to the
// target month's last day per standard calendar semantics:
//   Jan 15 + 4mo -> May 15
//   Jul 31 + 4mo -> Nov 30 (November has no 31st)
//   Feb 29, 2024 (leap) + 4mo -> Jun 29
// Implemented by explicitly computing the target year/month/day instead of
// relying on JS Date's own month-overflow rollover (new Date(...).setUTCMonth
// alone would silently roll Jan 31 + 1 month into Mar 3, which is wrong).
export function addCalendarMonths(startMs, months) {
  const start = new Date(startMs);
  const startYear = start.getUTCFullYear();
  const startMonthIndex = start.getUTCMonth();
  const startDay = start.getUTCDate();

  const totalMonthIndex = startMonthIndex + months;
  const targetYear = startYear + Math.floor(totalMonthIndex / 12);
  const targetMonthIndex = ((totalMonthIndex % 12) + 12) % 12;

  const targetDay = Math.min(startDay, daysInUTCMonth(targetYear, targetMonthIndex));

  const result = new Date(start);
  result.setUTCFullYear(targetYear, targetMonthIndex, targetDay);
  return result.getTime();
}

// THE single shared source for the payout target timestamp. Both the
// Dashboard and the Payouts page must read this exact value (never
// recompute a second, independently-calculated target) -- per spec.
export function getPayoutTargetAt(account) {
  if (!account?.node_connected_at) return { payoutTargetAt: null, payoutAvailable: false };
  const targetMs = addCalendarMonths(new Date(account.node_connected_at).getTime(), 4);
  return {
    payoutTargetAt: new Date(targetMs).toISOString(),
    payoutAvailable: Date.now() >= targetMs,
  };
}

// Recomputes accounts.current_balance_cents / lifetime_earnings_cents
// directly from ledger_entries so they can never drift from the ledger --
// this IS the reconciliation, not a cache that might disagree with it.
// - lifetime_earnings_cents = sum of 'earning' entries only (gross total
//   ever earned; matches the "Total Earnings" requirement).
// - current_balance_cents = earnings + admin_credit + correction
//   - admin_debit - payout (net spendable balance).
//
// Re-exported (see lib/adminLedger.js) for admin balance-adjustment routes
// so there is exactly one reconciliation implementation shared by the
// earnings catch-up path and admin credit/debit writes.
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

export { recomputeBalances };

// Writes exactly one immutable 'earning' ledger row for every fully
// completed UTC calendar day between the account's node_connected_at date
// and yesterday (inclusive), for any day that doesn't already have one.
// Idempotent: INSERT OR IGNORE + the UNIQUE(account_id, source_reference)
// constraint means calling this 1 time or 100 times in a row (login,
// refresh, periodic poll, server restart) produces the exact same ledger
// state -- this is the "offline catch-up without double counting" rule.
// Each day's amount is pro-rated by the fraction of that day the account's
// WiFi toggle was actually ON (lib/wifiEngine.js), so days (or partial
// days) spent OFF never accrue -- and a day is only ever written once, so
// this pro-rating can never be revisited/rewritten later either.
//
// Today itself is deliberately never written here -- it only becomes a
// real ledger row once it is no longer "today" on a later call. Until
// then it's shown to the customer only as a live, ticking, clearly-labeled
// estimate (see the dashboard's useEarnings/AnimatedNumber usage).
export function runEarningsCatchup(db, account, totalMonthlyCents) {
  if (account.isp_status !== "active" || !account.node_connected_at) {
    return;
  }

  const connectedAtMs = new Date(account.node_connected_at).getTime();
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
    const dayEndMs = cursorMs + DAY_MS;
    const onMs = computeOnMsInRange(db, account.id, connectedAtMs, cursorMs, dayEndMs);
    const onFraction = onMs / DAY_MS;
    const baseCents = dailyBaseAmountCents(account.id, dateStr, totalMonthlyCents);
    const finalCents = Math.round(baseCents * multiplier * onFraction);

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
        onFraction: Number(onFraction.toFixed(4)),
        label: "Demo estimate — not an externally funded payout.",
      })
    );
    if (result.changes > 0) wroteAny = true;

    cursorMs = dayEndMs;
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
  const totalMonthlyCents = sumOwnedNodesMonthlyCents(db, accountId);

  if (active) {
    runEarningsCatchup(db, account, totalMonthlyCents);
  }

  const fresh = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);

  const todayDateStr = dateStrUTC(new Date());
  const todayStartMs = startOfUTCDateMs(todayDateStr);
  const multiplier = fresh.earnings_multiplier ?? 1.0;
  const connectedAtMs = fresh.node_connected_at ? new Date(fresh.node_connected_at).getTime() : null;

  // "Today's expected earnings" (the day's ASSIGNED amount per spec,
  // before any WiFi on/off pro-rating) -- this is the number the
  // dashboard's +/-5% visual-only fluctuation ticker is centered on.
  let todaysExpectedCents = 0;
  if (active) {
    todaysExpectedCents = dailyBaseAmountCents(fresh.id, todayDateStr, totalMonthlyCents) * multiplier;
    todaysExpectedCents = Math.round(todaysExpectedCents);
  }

  // "Today (1d)" ACCRUED so far -- the actual live/ticking number, scaled
  // by how much of elapsed "today" the WiFi was really ON. Freezes the
  // instant WiFi goes off (onMs simply stops growing) and never credits
  // time before the account's Node was connected.
  let todayAccruedCents = 0;
  if (active && connectedAtMs) {
    const accrualStart = Math.max(todayStartMs, connectedAtMs);
    const nowMs = Date.now();
    if (nowMs > accrualStart) {
      const onMsToday = computeOnMsInRange(db, fresh.id, connectedAtMs, accrualStart, nowMs);
      todayAccruedCents = Math.round(todaysExpectedCents * (onMsToday / DAY_MS));
    }
  }

  const completedDaysRow = db
    .prepare(
      `SELECT COUNT(*) as c FROM ledger_entries WHERE account_id = ? AND event_type = 'earning'`
    )
    .get(accountId);
  const completedDays = completedDaysRow.c;

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
  // deterministic expected value for today only.
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
      cents = todayAccruedCents;
    }
    series.push({
      label: d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
      value: Number((cents / 100).toFixed(2)),
    });
  }

  const { payoutTargetAt, payoutAvailable } = getPayoutTargetAt(fresh);

  return {
    mode: "demo",
    active,
    ispStatus: fresh.isp_status,
    nodeConnectedAt: fresh.node_connected_at,
    wifiEnabled: Boolean(fresh.wifi_enabled),
    wifiStateSince: fresh.wifi_state_since,
    todayStartAt: new Date(todayStartMs).toISOString(),
    todaysExpectedCents,
    todayAccruedCents,
    totalMonthlyCents,
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
