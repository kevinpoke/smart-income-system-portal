import { generateId } from "./auth-crypto";
import { rngFromSeed, randomFloat } from "./mockData";
import { sumOwnedNodesMonthlyCents, ensureOwnedNode } from "./ownedNodes";
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

// Phase 5 correction: the daily earnings cycle boundary moves from UTC
// midnight to 5:00 PM America/Los_Angeles (DST-aware, never a hardcoded
// UTC offset). See cycleStartMsFor/cycleEndMsFor/cycleKeyFor below -- these
// are the ONLY place cycle boundaries are computed anywhere in the app;
// every consumer (catch-up, summary, client interpolation) must go through
// these, never inline UTC-day math again.
const CYCLE_TZ = "America/Los_Angeles";
const CYCLE_HOUR = 17; // 5:00 PM

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

// Retained for any legacy/back-compat reference (e.g. reading OLD
// `earning:YYYY-MM-DD` ledger rows' effective_date, which remains a UTC
// calendar date label). No longer used for computing DAILY pacing
// boundaries -- see cycleStartMsFor() for that.
export function dateStrUTC(date) {
  return date.toISOString().slice(0, 10); // "YYYY-MM-DD" in UTC
}

// Reads the LA-local wall-clock parts (year/month/day/hour/minute/second)
// that a given UTC instant corresponds to.
function laPartsFor(utcMs) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: CYCLE_TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = {};
  for (const { type, value } of formatter.formatToParts(new Date(utcMs))) {
    if (type !== "literal") parts[type] = Number(value);
  }
  // Intl represents midnight hour as "24" in some environments/hour12:false
  // configurations -- normalize defensively.
  if (parts.hour === 24) parts.hour = 0;
  return parts;
}

// Converts a LA-local "YYYY-MM-DD 17:00:00" wall-clock moment into the
// correct UTC epoch ms, without assuming a fixed UTC offset (handles both
// PDT/UTC-7 and PST/UTC-8, and the DST transition dates themselves).
// Technique: guess the UTC instant assuming UTC==LA (i.e.
// Date.UTC(y,m-1,d,hour,0,0)), then read what LA wall-clock time that
// guess ACTUALLY represents, compute the difference in minutes between
// the guessed LA hour/minute and the intended target, and shift the guess
// by that many minutes. Because the LA-UTC offset is always a whole
// number of hours (never fractional, even across DST transitions), a
// single correction pass converges exactly; we loop up to 2 passes
// defensively and assert convergence in a dev-only check.
function laWallClockToUtcMs(year, month, day, hour, minute = 0, second = 0) {
  let guessUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);

  for (let pass = 0; pass < 2; pass++) {
    const actual = laPartsFor(guessUtcMs);
    const actualMinutesOfEpochDay =
      Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second) / 60000;
    const targetMinutesOfEpochDay = Date.UTC(year, month - 1, day, hour, minute, second) / 60000;
    const diffMinutes = actualMinutesOfEpochDay - targetMinutesOfEpochDay;
    if (diffMinutes === 0) break;
    guessUtcMs -= diffMinutes * 60000;
  }

  if (process.env.NODE_ENV !== "production") {
    const check = laPartsFor(guessUtcMs);
    const converged =
      check.year === year &&
      check.month === month &&
      check.day === day &&
      check.hour === hour &&
      check.minute === minute &&
      check.second === second;
    if (!converged) {
      throw new Error(
        `laWallClockToUtcMs failed to converge for ${year}-${month}-${day} ${hour}:${minute}:${second} (got ${JSON.stringify(check)})`
      );
    }
  }

  return guessUtcMs;
}

// Returns the UTC epoch ms of the most recent 5:00 PM Pacific boundary at
// or before `nowMs` -- i.e. the START of the cycle containing `nowMs`. A
// timestamp exactly AT 5:00:00 PM Pacific is treated as the start of the
// NEW cycle (not the end of the previous one).
export function cycleStartMsFor(nowMs) {
  const parts = laPartsFor(nowMs);
  const secondsOfDay = parts.hour * 3600 + parts.minute * 60 + parts.second;
  const cycleHourSeconds = CYCLE_HOUR * 3600;

  if (secondsOfDay >= cycleHourSeconds) {
    // Today's LA date at 5:00 PM.
    return laWallClockToUtcMs(parts.year, parts.month, parts.day, CYCLE_HOUR, 0, 0);
  }

  // Yesterday's LA date at 5:00 PM. Compute "yesterday" via a real Date
  // arithmetic step on the LA calendar date (not UTC) to correctly handle
  // month/year rollovers.
  const todayAtNoonUtcGuess = Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0);
  const yesterday = new Date(todayAtNoonUtcGuess - DAY_MS);
  return laWallClockToUtcMs(
    yesterday.getUTCFullYear(),
    yesterday.getUTCMonth() + 1,
    yesterday.getUTCDate(),
    CYCLE_HOUR,
    0,
    0
  );
}

// The cycle's exclusive end / the next 5PM Pacific boundary.
export function cycleEndMsFor(nowMs) {
  return cycleStartMsFor(nowMs) + DAY_MS;
}

// Stable string key identifying a cycle: the LA calendar date (YYYY-MM-DD)
// on which the cycle STARTS. Used for ledger source_reference and
// fluctuation seeding so "the cycle starting July 27, 5PM Pacific" has a
// stable, human-meaningful key independent of DST math details.
export function cycleKeyFor(nowMs) {
  const startMs = cycleStartMsFor(nowMs);
  const parts = laPartsFor(startMs);
  const pad = (n) => String(n).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

// Deterministic per-account/per-cycle fluctuation multiplier in
// [1 - DAILY_FLUCTUATION_RANGE, 1 + DAILY_FLUCTUATION_RANGE]. Stable for
// the entire cycle and reproducible forever from the same two inputs --
// this is what makes idempotent catch-up possible without storing
// anything extra, and what keeps the "must not randomly change after
// every refresh" rule true.
export function dailyFluctuationMultiplier(accountId, cycleKey) {
  const seed = hashStringToSeed(`dailyfluct:${accountId}:${cycleKey}`);
  const rand = rngFromSeed(seed);
  return 1 + randomFloat(rand, -DAILY_FLUCTUATION_RANGE, DAILY_FLUCTUATION_RANGE, 4);
}

// Deterministic cycle BASE amount (before multiplier) in integer cents,
// derived from the account's current total owned-Node monthly earnings
// (baseline = totalMonthlyCents / 30) with the stable per-cycle
// fluctuation applied. Falls back to $0 if the account owns no Nodes yet.
export function dailyBaseAmountCents(accountId, cycleKey, totalMonthlyCents) {
  if (!totalMonthlyCents) return 0;
  const baseline = totalMonthlyCents / 30;
  const fluctuation = dailyFluctuationMultiplier(accountId, cycleKey);
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
// completed 5PM-Pacific-to-5PM-Pacific CYCLE between the account's
// node_connected_at moment and the current (in-progress) cycle, for any
// cycle that doesn't already have one. Idempotent: INSERT OR IGNORE + the
// UNIQUE(account_id, source_reference) constraint means calling this 1
// time or 100 times in a row (login, refresh, periodic poll, server
// restart) produces the exact same ledger state -- this is the "offline
// catch-up without double counting" rule. Each cycle's amount is
// pro-rated by the fraction of that cycle the account's WiFi toggle was
// actually ON (lib/wifiEngine.js), so cycles (or partial cycles) spent OFF
// never accrue -- and a cycle is only ever written once, so this
// pro-rating can never be revisited/rewritten later either.
//
// Phase 5 correction: source_reference now uses the `earning-cycle:`
// prefix (was `earning:`) so new cycle-keyed rows can never collide with
// pre-existing `earning:YYYY-MM-DD` (UTC calendar date) rows written
// before this change -- those old rows are left untouched, never
// migrated/rewritten (per the "do not retroactively rewrite prior ledger
// events" rule).
//
// The current (in-progress) cycle is deliberately never written here --
// it only becomes a real ledger row once it is no longer the current
// cycle on a later call. Until then it's shown to the customer only as a
// live, ticking, clearly-labeled estimate (see the dashboard's
// useLiveEarningsCents/AnimatedNumber usage).
export function runEarningsCatchup(db, account, totalMonthlyCents) {
  if (account.isp_status !== "active" || !account.node_connected_at) {
    return;
  }

  const connectedAtMs = new Date(account.node_connected_at).getTime();
  const currentCycleStartMs = cycleStartMsFor(Date.now());
  let cursorMs = cycleStartMsFor(connectedAtMs);

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

  while (cursorMs < currentCycleStartMs && iterations < maxIterations) {
    const cycleKey = cycleKeyFor(cursorMs);
    const sourceRef = `earning-cycle:${cycleKey}`;
    const cycleEndMs = cursorMs + DAY_MS;
    const onMs = computeOnMsInRange(db, account.id, connectedAtMs, cursorMs, cycleEndMs);
    const onFraction = onMs / DAY_MS;
    const baseCents = dailyBaseAmountCents(account.id, cycleKey, totalMonthlyCents);
    const finalCents = Math.round(baseCents * multiplier * onFraction);
    // effective_date remains a UTC calendar-date label (used only by the
    // week/month rollup queries and the dashboard's 14-day chart, never
    // for pacing) -- the cycle's start instant is a fine, stable choice.
    const effectiveDate = dateStrUTC(new Date(cursorMs));

    const result = insert.run(
      generateId("ledger"),
      account.id,
      baseCents,
      multiplier,
      finalCents,
      effectiveDate,
      nowIso,
      sourceRef,
      JSON.stringify({
        mode: "demo",
        onFraction: Number(onFraction.toFixed(4)),
        cycleKey,
        label: "Demo estimate — not an externally funded payout.",
      })
    );
    if (result.changes > 0) wroteAny = true;

    cursorMs = cycleEndMs;
    iterations += 1;
  }

  if (wroteAny) {
    recomputeBalances(db, account.id);
  }
}

// Full dashboard summary: runs catch-up (if active), ensures the Owned
// Node backfill guarantee, then reads back everything the dashboard needs,
// all sourced from SQLite.
export function computeEarningsSummary(db, accountId) {
  const account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
  if (!account) return null;

  const active = account.isp_status === "active" && !!account.node_connected_at;

  // Phase 5 correction: every customer with a completed/active ISP setup
  // must always own at least one Node. This is a lazy, idempotent repair
  // for accounts that reached isp_status === 'active' before the owned
  // Node mechanism existed (or otherwise ended up with zero owned Nodes)
  // -- see lib/ownedNodes.js ensureOwnedNode() for the zero-count guard
  // that makes this safe to call on every dashboard load/poll without
  // ever creating a second Node for an account that already has one.
  if (active) {
    ensureOwnedNode(db, account);
  }

  const totalMonthlyCents = sumOwnedNodesMonthlyCents(db, accountId);

  if (active) {
    runEarningsCatchup(db, account, totalMonthlyCents);
  }

  const fresh = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);

  const nowMs = Date.now();
  const cycleStartMs = cycleStartMsFor(nowMs);
  const cycleEndMs = cycleEndMsFor(nowMs);
  const cycleKey = cycleKeyFor(nowMs);
  const multiplier = fresh.earnings_multiplier ?? 1.0;
  const connectedAtMs = fresh.node_connected_at ? new Date(fresh.node_connected_at).getTime() : null;

  // "Today's expected earnings" (the current cycle's ASSIGNED amount per
  // spec, before any WiFi on/off pro-rating) -- this is the number the
  // dashboard's +/-5% visual-only fluctuation ticker is centered on.
  let todaysExpectedCents = 0;
  if (active) {
    todaysExpectedCents = dailyBaseAmountCents(fresh.id, cycleKey, totalMonthlyCents) * multiplier;
    todaysExpectedCents = Math.round(todaysExpectedCents);
  }

  // "Today (1d)" ACCRUED so far -- the actual live/ticking number, scaled
  // by how much of the elapsed current cycle the WiFi was really ON,
  // paced evenly across the full cycle via computeOnMsInRange from
  // cycleStartMs to now (capped at cycleEndMs). Freezes the instant WiFi
  // goes off (onMs simply stops growing) and never credits time before
  // the account's Node was connected or before the cycle started.
  let todayAccruedCents = 0;
  if (active && connectedAtMs) {
    const accrualStart = Math.max(cycleStartMs, connectedAtMs);
    const accrualEnd = Math.min(nowMs, cycleEndMs);
    if (accrualEnd > accrualStart) {
      const onMsToday = computeOnMsInRange(db, fresh.id, connectedAtMs, accrualStart, accrualEnd);
      todayAccruedCents = Math.round(todaysExpectedCents * (onMsToday / DAY_MS));
    }
  }

  const completedDaysRow = db
    .prepare(
      `SELECT COUNT(*) as c FROM ledger_entries WHERE account_id = ? AND event_type = 'earning'`
    )
    .get(accountId);
  const completedDays = completedDaysRow.c;

  // Week/Month/lifetime rollups remain keyed off effective_date (a UTC
  // calendar-date label on each ledger row) -- this is unaffected by the
  // cycle-boundary change since it's a coarse 7/30-day lookback window,
  // not the pacing math itself.
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

  // Small ledger-backed series for the dashboard chart: last 14 UTC
  // calendar days (effective_date-based, a display label only), using the
  // real ledger row where one exists, or the (not-yet-written)
  // deterministic accrued value for today's calendar date only.
  const seriesDays = 14;
  const todayDateStr = dateStrUTC(new Date(nowMs));
  const todayStartMs = Date.parse(`${todayDateStr}T00:00:00.000Z`);
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
    // Field name kept as `todayStartAt` for client backward-compatibility;
    // it now means "current 5PM-Pacific cycle's start instant".
    todayStartAt: new Date(cycleStartMs).toISOString(),
    cycleEndAt: new Date(cycleEndMs).toISOString(),
    cycleKey,
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
