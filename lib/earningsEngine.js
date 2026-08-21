import { generateId } from "./auth-crypto";
import { rngFromSeed, randomFloat } from "./mockData";
import {
  sumOwnedNodesMonthlyCents,
  ensureOwnedNode,
  computeNodeEarningsTotals,
} from "./ownedNodes";
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

// Refinement pass (multi-tier Nodes / Pacific-midnight phase): the daily
// earnings cycle boundary is 12:00 AM (midnight) America/Los_Angeles,
// DST-aware, never a hardcoded UTC offset. This SUPERSEDES an earlier
// Phase 5 correction that had moved the boundary from UTC midnight to
// 5:00 PM Pacific -- that 5PM boundary is no longer used anywhere. See
// cycleStartMsFor/cycleEndMsFor/cycleKeyFor below -- these are the ONLY
// place cycle boundaries are computed anywhere in the app; every
// consumer (catch-up, summary, client interpolation) must go through
// these, never inline UTC-day math again.
//
// Changing CYCLE_HOUR alone is sufficient to move the boundary: every
// ledger row already written under the OLD 5PM boundary carries its own
// fixed `source_reference` (e.g. "earning-cycle:2026-07-29:node:...")
// computed from the cycle key AT THE TIME it was written, and is never
// re-derived or rewritten later -- only NEW cycles closed after this
// change use the new midnight boundary. This is what satisfies "do not
// rewrite historical ledger entries."
const CYCLE_TZ = "America/Los_Angeles";
const CYCLE_HOUR = 0; // 12:00 AM (midnight) Pacific

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

// Converts a LA-local "YYYY-MM-DD HH:00:00" wall-clock moment into the
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

// Returns the UTC epoch ms of the most recent 12:00 AM (midnight) Pacific
// boundary at or before `nowMs` -- i.e. the START of the calendar day
// (Pacific-local) containing `nowMs`. A timestamp exactly AT midnight
// Pacific is treated as the start of the NEW day (not the end of the
// previous one). With CYCLE_HOUR = 0, `secondsOfDay >= cycleHourSeconds`
// is always true (secondsOfDay can never be negative), so this always
// resolves to "today's LA date at midnight" -- the "yesterday" branch
// below is dead code for CYCLE_HOUR = 0 specifically, but is kept
// general (not hardcoded to always take the first branch) so this
// function continues to work correctly for any CYCLE_HOUR value, not
// just midnight, should the boundary ever need to change again.
export function cycleStartMsFor(nowMs) {
  const parts = laPartsFor(nowMs);
  const secondsOfDay = parts.hour * 3600 + parts.minute * 60 + parts.second;
  const cycleHourSeconds = CYCLE_HOUR * 3600;

  if (secondsOfDay >= cycleHourSeconds) {
    // Today's LA date at the cycle boundary hour (midnight).
    return laWallClockToUtcMs(parts.year, parts.month, parts.day, CYCLE_HOUR, 0, 0);
  }

  // Yesterday's LA date at the cycle boundary hour. Compute "yesterday"
  // via a real Date arithmetic step on the LA calendar date (not UTC) to
  // correctly handle month/year rollovers.
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

// The cycle's exclusive end / the next midnight Pacific boundary.
//
// Deliberately NOT `cycleStartMsFor(nowMs) + DAY_MS` (a naive +24h-in-UTC
// guess) -- on a DST transition day that would land up to an hour away
// from the ACTUAL next local midnight (23h later on the spring-forward
// day, 25h later on the fall-back day), which the spec explicitly rules
// out: "the next reset must always represent the next local midnight...
// do not calculate the next reset merely by adding 24 hours." Instead,
// this advances the LA calendar date by one real day (via the same
// noon-UTC-guess technique cycleStartMsFor already uses for its
// "yesterday" step, which is immune to DST distortion because noon is
// never within a couple hours of either transition), then re-derives
// THAT date's own midnight via laWallClockToUtcMs -- so the result is
// always the genuine next local midnight, whether that's 23, 24, or 25
// UTC-hours away.
export function cycleEndMsFor(nowMs) {
  const cycleStartMs = cycleStartMsFor(nowMs);
  const parts = laPartsFor(cycleStartMs);
  const noonUtcGuess = Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0);
  const nextDay = new Date(noonUtcGuess + DAY_MS);
  return laWallClockToUtcMs(
    nextDay.getUTCFullYear(),
    nextDay.getUTCMonth() + 1,
    nextDay.getUTCDate(),
    CYCLE_HOUR,
    0,
    0
  );
}

// Stable string key identifying a cycle: the LA calendar date (YYYY-MM-DD)
// on which the cycle STARTS. Used for ledger source_reference and
// fluctuation seeding so "the cycle starting July 27, 12:00 AM Pacific" has a
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
//
// NOTE: this ACCOUNT-LEVEL helper remains used ONLY for the Dashboard's
// purely-informational "Today's expected earnings ~$X" display estimate
// (see computeEarningsSummary's todaysExpectedCents below) -- it is
// intentionally a rough, non-eligibility-aware approximation (per its
// existing docstring: "before any WiFi on/off pro-rating"). It is NEVER
// used for actual ledger writes or the real "Today (1d)"/lifetime
// totals -- see computeNodeCycleCents() below, which is the sole
// source of truth for every dollar actually written to ledger_entries
// or summed into todayAccruedCents, and which correctly restricts each
// Node's contribution to its own eligible created_at/removed_at window.
export function dailyBaseAmountCents(accountId, cycleKey, totalMonthlyCents) {
  if (!totalMonthlyCents) return 0;
  const baseline = totalMonthlyCents / 30;
  const fluctuation = dailyFluctuationMultiplier(accountId, cycleKey);
  return Math.round(baseline * fluctuation);
}

// Computes ONE Node's own earnings contribution for a specific cycle,
// restricted to that Node's own ELIGIBLE INTERVAL within the cycle:
//
//   eligibleStart = max(cycleStartMs, node.created_at, connectedAtMs)
//   eligibleEnd   = min(cycleEndMs, rangeEndMs, node.removed_at ?? +Inf)
//
// where `rangeEndMs` is `cycleEndMs` itself for a fully-completed
// historical cycle, or `now` (capped at cycleEndMs) for the current
// in-progress cycle. `hasWindow` is true whenever eligibleEnd >
// eligibleStart -- i.e. the Node existed (and hadn't yet been removed)
// for SOME non-zero slice of this specific cycle, REGARDLESS of
// whether WiFi was on or off during that slice. This is the ONLY
// eligibility gate for whether a Node participates in a cycle at all:
// a Node created after this cycle already ended, or removed before
// this cycle started, has `hasWindow: false` and earns nothing for
// that cycle. This is what guarantees:
//   - a brand-new Node NEVER receives retroactive earnings for any
//     cycle (or any portion of a cycle) before its own created_at
//   - a removed Node NEVER receives earnings for any cycle (or
//     portion of a cycle) at/after its own removed_at
//   - a Node added or removed MID-cycle still correctly earns for
//     exactly the fraction of that cycle it was genuinely eligible for
//     (never zero, never the full cycle) -- satisfying "starts
//     accruing immediately from its own created_at timestamp" without
//     ever crediting time before it existed.
//
// Within that eligible interval, WiFi on/off time is applied exactly
// as it always has been (via computeOnMsInRange) -- a Node that
// existed for the whole cycle but had WiFi off for all of it still has
// `hasWindow: true` (it existed) but `finalCents: 0` (nothing accrued
// while off), which preserves the pre-existing "every existing Node
// gets an idempotent ledger row every cycle, possibly for $0" contract
// that callers rely on for catch-up idempotency.
//
// This function is the SOLE place any dollar amount is computed FOR A
// NODE, for either a completed historical cycle (via
// runEarningsCatchup) or the live in-progress cycle (via
// computeEarningsSummary) -- there is no other per-Node money
// calculation anywhere else in this file, and it never divides one
// account-level total proportionally across the current Node list
// (the bug this replaces): each Node's cents are derived directly from
// its OWN stable est_monthly_cents rate and its OWN eligible time,
// entirely independent of how many other Nodes the account has, had,
// or will have.
export function computeNodeCycleCents({
  db,
  accountId,
  connectedAtMs,
  node,
  cycleStartMs,
  cycleEndMs,
  rangeEndMs,
  fluctuationMultiplier,
  earningsMultiplier,
}) {
  const cycleDurationMs = cycleEndMs - cycleStartMs;
  if (cycleDurationMs <= 0) {
    return { hasWindow: false, baseCents: 0, finalCents: 0, eligibleFraction: 0 };
  }

  const nodeCreatedMs = new Date(node.created_at).getTime();
  const nodeRemovedMs = node.removed_at ? new Date(node.removed_at).getTime() : null;

  const eligibleStart = Math.max(cycleStartMs, nodeCreatedMs, connectedAtMs ?? cycleStartMs);
  let eligibleEnd = Math.min(cycleEndMs, rangeEndMs);
  if (nodeRemovedMs !== null) eligibleEnd = Math.min(eligibleEnd, nodeRemovedMs);

  const hasWindow = eligibleEnd > eligibleStart;
  if (!hasWindow) {
    return { hasWindow: false, baseCents: 0, finalCents: 0, eligibleFraction: 0 };
  }

  // WiFi-gated on-time strictly WITHIN this Node's own eligible
  // interval -- never outside it, so a Node's own eligibility window
  // is always respected regardless of the account's broader WiFi
  // history before/after that window.
  const onMs = computeOnMsInRange(db, accountId, connectedAtMs, eligibleStart, eligibleEnd);
  const eligibleFraction = onMs / cycleDurationMs;

  // This Node's OWN daily rate (its stable monthly rate / 30), with the
  // same account+cycle fluctuation multiplier every Node in this cycle
  // shares (dailyFluctuationMultiplier is deliberately account-level,
  // not per-Node -- the demo model's "the whole account has a good/bad
  // day" variance is unchanged by this fix, only the PER-NODE
  // eligibility gating is new).
  const nodeDailyCents = Math.round((node.est_monthly_cents / 30) * fluctuationMultiplier);
  const baseCents = Math.round(nodeDailyCents * eligibleFraction);
  const finalCents = Math.round(baseCents * earningsMultiplier);

  return { hasWindow: true, baseCents, finalCents, eligibleFraction };
}

// ---- Per-Node "Avg Daily Earnings" (Dashboard "Your Nodes" column) ------
//
// Returns the total number of milliseconds a specific owned Node has
// actually been ON/earning, from the LATER of (a) the account's overall
// node_connected_at and (b) this Node's own created_at, through now (or
// through the Node's removed_at if it has already been removed -- this
// is only ever called with a still-owned Node today, but the removed_at
// guard is kept for correctness if a caller ever passes one). This is
// the exact same eligible-window definition computeNodeCycleCents()
// above uses per-cycle, just accumulated over the Node's ENTIRE
// lifetime instead of one cycle at a time, and it reuses the SAME
// canonical WiFi on/off replay (lib/wifiEngine.js computeOnMsInRange)
// rather than a second, independently-computed duration -- so a period
// where WiFi was off (or before the Node existed, or after it was
// removed) is excluded exactly the same way it's excluded from the
// Node's actual earnings.
export function computeNodeOnDurationMs(db, account, node) {
  const connectedAtMs = account?.node_connected_at
    ? new Date(account.node_connected_at).getTime()
    : null;
  if (!connectedAtMs) return 0;

  const nodeCreatedMs = new Date(node.createdAt ?? node.created_at).getTime();
  if (Number.isNaN(nodeCreatedMs)) return 0;

  const eligibleStart = Math.max(connectedAtMs, nodeCreatedMs);
  const removedAtRaw = node.removedAt ?? node.removed_at ?? null;
  const removedAtMs = removedAtRaw ? new Date(removedAtRaw).getTime() : null;
  const eligibleEnd = removedAtMs !== null ? Math.min(Date.now(), removedAtMs) : Date.now();

  if (eligibleEnd <= eligibleStart) return 0;

  return computeOnMsInRange(db, account.id, connectedAtMs, eligibleStart, eligibleEnd);
}

// Given a Node's canonical total earnings (cents) and its canonical
// on-duration (ms, from computeNodeOnDurationMs above), returns the
// average daily earnings in CENTS, rounded to the nearest cent. Never
// divides by account age or calendar days -- only by the Node's own
// actual eligible ON/earning duration. Returns 0 when the Node has been
// on for 0ms (including a brand-new Node with no on-time yet), matching
// the "$0.00 if ON duration is 0" requirement, and never divides by
// zero.
export function computeAvgDailyEarningsCents(totalEarningsCents, onDurationMs) {
  if (!onDurationMs || onDurationMs <= 0) return 0;
  const onDays = onDurationMs / DAY_MS;
  if (onDays <= 0) return 0;
  return Math.round((totalEarningsCents || 0) / onDays);
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

  // Production feature/fix batch (admin balance / lifetime earnings,
  // Option 2): lifetime_earnings_cents is no longer "sum of 'earning'
  // rows only" -- admin adjustments now affect it too, per approved
  // decision:
  //   - earning:       lifetime += total; balance += total (unchanged)
  //   - admin_credit:  lifetime += total; balance += total (NEW: used to
  //                    only move balance, not lifetime)
  //   - admin_debit:   lifetime -= total; balance -= total (NEW: used to
  //                    only move balance, not lifetime)
  //   - correction:    lifetime += total; balance += total -- moves
  //                    lifetime the SAME direction balance already moves
  //                    (grep of every 'correction' writer in this
  //                    codebase -- app/api/webhooks/jvzoo/route.js, the
  //                    only current writer -- confirms final_amount_cents
  //                    is a plain signed value with no separate
  //                    direction flag elsewhere, always written as 0 for
  //                    its own zero-amount audit-trail rows today; a
  //                    future signed correction amount is handled
  //                    correctly by this same "+=" since a negative
  //                    total naturally subtracts from both balance and
  //                    lifetime together).
  //   - payout:        balance -= total; lifetime UNCHANGED -- a payout
  //                    is a withdrawal of money the customer already
  //                    earned, so it must never reduce (double-count
  //                    against) lifetime earnings.
  // Historical ledger_entries rows are never rewritten by this change --
  // this function only reads existing rows and recomputes the two
  // derived account columns from them.
  let lifetime = 0;
  let balance = 0;
  for (const row of rows) {
    switch (row.event_type) {
      case "earning":
        lifetime += row.total;
        balance += row.total;
        break;
      case "admin_credit":
        lifetime += row.total;
        balance += row.total;
        break;
      case "admin_debit":
        lifetime -= row.total;
        balance -= row.total;
        break;
      case "correction":
        lifetime += row.total;
        balance += row.total;
        break;
      case "payout":
        balance -= row.total;
        // lifetime intentionally untouched -- see comment above.
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

// Writes one immutable 'earning' ledger row PER OWNED NODE for every
// fully completed midnight-Pacific-to-midnight-Pacific CYCLE between the account's
// node_connected_at moment and the current (in-progress) cycle, for any
// cycle that doesn't already have rows. Idempotent: INSERT OR IGNORE +
// the UNIQUE(account_id, source_reference) constraint means calling this
// 1 time or 100 times in a row (login, refresh, periodic poll, server
// restart) produces the exact same ledger state -- this is the "offline
// catch-up without double counting" rule.
//
// Node earnings behavior refinement pass: each cycle's per-Node amount
// is now computed INDEPENDENTLY per Node via computeNodeCycleCents()
// (see its docstring above) -- restricted to that Node's own eligible
// created_at/removed_at window WITHIN this cycle, and WiFi-gated within
// that window. This REPLACES the prior "split one account-level total
// proportionally across the current Node list" approach, which could
// retroactively credit a brand-new Node for cycles before it existed
// (or silently redistribute a removed Node's un-written share onto the
// remaining Nodes) whenever catch-up ran with unwritten historical
// cycles still pending. One ledger row is still written per (cycle,
// Node) pair with that Node's own node_id and a per-Node-unique
// source_reference (so the existing UNIQUE(account_id,
// source_reference) idempotency guarantee still holds row-by-row) --
// this is what lets the Dashboard "Your Nodes" table show each Node's
// own exact cumulative contribution. A row is written for every Node
// with `hasWindow: true` for this cycle, even if its computed amount is
// $0 (e.g. WiFi was off the entire eligible slice) -- this preserves
// the pre-existing "idempotent per-cycle row per existing Node" catch-up
// contract every consumer already relies on.
//
// Phase 5 correction: source_reference uses the `earning-cycle:` prefix
// (was `earning:`) so new cycle-keyed rows can never collide with
// pre-existing `earning:YYYY-MM-DD` (UTC calendar date) rows written
// before that change -- those old rows are left untouched, never
// migrated/rewritten (per the "do not retroactively rewrite prior ledger
// events" rule). Dashboard adjustment pass adds a `:node:<nodeId>` suffix
// to the source_reference so multiple per-Node rows for the same cycle
// don't collide with each other under the same UNIQUE constraint either
// -- and because that suffix is keyed by the Node's own STABLE internal
// id (never its ordinal position in an array), adding or removing a
// DIFFERENT Node can never change an already-written Node's own
// source_reference, so tier changes / other Nodes' add/remove events
// never cause a previously-completed row to be rewritten or duplicated.
//
// The current (in-progress) cycle is deliberately never written here --
// it only becomes real ledger rows once it is no longer the current
// cycle on a later call. Until then it's shown to the customer only as a
// live, ticking, clearly-labeled estimate (see the dashboard's
// useLiveEarningsCents/AnimatedNumber usage, and computeEarningsSummary
// below which independently computes the SAME per-Node eligible-window
// logic for the live in-progress cycle via computeNodeCycleCents).
export function runEarningsCatchup(db, account) {
  if (account.isp_status !== "active" || !account.node_connected_at) {
    return;
  }

  // Node earnings behavior refinement pass: fetch EVERY Node the account
  // has ever had (including already-removed ones, via no removed_at
  // filter here) with its FULL lifecycle window (created_at/removed_at)
  // and its own STABLE monthly rate (est_monthly_cents) -- each cycle's
  // per-Node contribution below is computed directly from this Node's
  // own rate and its own eligible interval within that cycle, never
  // derived from any other Node's data or from a shared account-level
  // total.
  const allNodes = db
    .prepare(
      `SELECT id, est_monthly_cents, created_at, removed_at FROM owned_nodes
       WHERE account_id = ? ORDER BY node_number ASC`
    )
    .all(account.id);
  if (allNodes.length === 0) {
    // No owned Node yet (shouldn't normally happen once ensureOwnedNode
    // has run, but guard defensively) -- nothing to attribute earnings
    // to, so skip catch-up entirely rather than writing an unattributed
    // NULL-node_id row for a brand-new cycle going forward.
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
       (id, account_id, event_type, base_amount_cents, multiplier, final_amount_cents, effective_date, created_at, source_reference, metadata_json, node_id)
     VALUES (?, ?, 'earning', ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const multiplier = account.earnings_multiplier ?? 1.0;
  const nowIso = new Date().toISOString();
  let wroteAny = false;

  while (cursorMs < currentCycleStartMs && iterations < maxIterations) {
    const cycleKey = cycleKeyFor(cursorMs);
    // cycleEndMs (and therefore this cycle's real duration) is
    // recomputed via cycleEndMsFor -- the genuine next local Pacific
    // midnight -- rather than a naive `cursorMs + DAY_MS`. On the two
    // DST transition days per year that naive approach would overshoot
    // by an hour (spring-forward, a 23h cycle) or undershoot by an hour
    // (fall-back, a 25h cycle), landing the NEXT cycle's start at the
    // wrong Pacific wall-clock time and never fully correcting itself
    // since every subsequent cursor position would inherit the same
    // drift. This cycle's REAL duration (23h/24h/25h) flows straight
    // into computeNodeCycleCents() below via cycleStartMs/cycleEndMs,
    // so a Node's eligible-fraction pacing on a DST transition day
    // stays exactly proportional to elapsed real time.
    const cycleEndMs = cycleEndMsFor(cursorMs);
    const fluctuationMultiplier = dailyFluctuationMultiplier(account.id, cycleKey);
    // effective_date remains a UTC calendar-date label (used only by the
    // week/month rollup queries and the dashboard's 14-day chart, never
    // for pacing) -- the cycle's start instant is a fine, stable choice.
    const effectiveDate = dateStrUTC(new Date(cursorMs));

    for (const node of allNodes) {
      const { hasWindow, baseCents, finalCents, eligibleFraction } = computeNodeCycleCents({
        db,
        accountId: account.id,
        connectedAtMs,
        node,
        cycleStartMs: cursorMs,
        cycleEndMs,
        rangeEndMs: cycleEndMs, // this cycle is fully completed -- the full cycle is in range
        fluctuationMultiplier,
        earningsMultiplier: multiplier,
      });

      // A Node with no eligible window at all for this cycle (created
      // after it ended, or removed before it started) gets NO ledger
      // row for this cycle whatsoever -- not even a $0 row -- so it
      // never becomes part of this cycle's history whatsoever. A Node
      // that DID have an eligible window (even a $0 one, e.g. WiFi was
      // off throughout) still gets its row, preserving the existing
      // per-cycle idempotency contract.
      if (!hasWindow) continue;

      const sourceRef = `earning-cycle:${cycleKey}:node:${node.id}`;
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
          onFraction: Number(eligibleFraction.toFixed(4)),
          cycleKey,
          label: "Demo estimate — not an externally funded payout.",
        }),
        node.id
      );
      if (result.changes > 0) wroteAny = true;
    }

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
    runEarningsCatchup(db, account);
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
  // dashboard's +/-5% visual-only fluctuation ticker is centered on. This
  // remains a rough ACCOUNT-LEVEL estimate (per its pre-existing
  // semantics) rather than a per-Node-eligibility-aware figure -- it is
  // purely informational display copy ("~$X"), never written to the
  // ledger and never summed into any actual accrued total below.
  let todaysExpectedCents = 0;
  if (active) {
    todaysExpectedCents = dailyBaseAmountCents(fresh.id, cycleKey, totalMonthlyCents) * multiplier;
    todaysExpectedCents = Math.round(todaysExpectedCents);
  }

  // Node earnings behavior refinement pass: the REAL "Today (1d)"
  // accrued total and the per-Node live breakdown are now both derived
  // from the SAME per-Node computeNodeCycleCents() calculation used by
  // runEarningsCatchup() for completed cycles -- each currently-active
  // Node's own eligible interval within the LIVE (in-progress) cycle
  // is [max(cycleStart, node.created_at, connectedAtMs), min(now,
  // cycleEnd)], so a Node created moments ago correctly starts at
  // exactly 0 cents and only begins accruing from its own created_at
  // forward, rather than receiving a proportional slice of an
  // account-level total that includes time before it existed. This
  // fixes a previously-shipped bug where a brand-new Node's live
  // display briefly showed a nonzero amount immediately after
  // creation (a slice of the CURRENT cycle's already-elapsed time,
  // incorrectly attributed to it via proportional splitting).
  const liveEligibleNodeRows = db
    .prepare(
      `SELECT id, est_monthly_cents, created_at, removed_at FROM owned_nodes
       WHERE account_id = ? AND removed_at IS NULL ORDER BY node_number ASC`
    )
    .all(accountId);

  let todayAccruedCents = 0;
  const liveNodeCents = {};
  if (active && connectedAtMs) {
    const fluctuationMultiplier = dailyFluctuationMultiplier(fresh.id, cycleKey);
    for (const node of liveEligibleNodeRows) {
      const { hasWindow, finalCents } = computeNodeCycleCents({
        db,
        accountId,
        connectedAtMs,
        node,
        cycleStartMs,
        cycleEndMs,
        rangeEndMs: nowMs, // the live cycle is only "in range" up through now
        fluctuationMultiplier,
        earningsMultiplier: multiplier,
      });
      if (hasWindow) {
        liveNodeCents[node.id] = finalCents;
        todayAccruedCents += finalCents;
      }
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

  // Dashboard adjustment pass: per-Node "Total Earnings" (completed
  // cycles only, from ledger_entries.node_id -- see
  // lib/ownedNodes.js computeNodeEarningsTotals) PLUS this Node's OWN
  // independently-computed share of the CURRENT in-progress cycle
  // (liveNodeCents, computed above via computeNodeCycleCents -- never
  // a proportional split of the account-level todayAccruedCents), so
  // the live number shown per-Node updates in lockstep with the
  // account-level Live Earnings ticker while WiFi is on and freezes
  // with it while WiFi is off/reconnecting, while never crediting a
  // Node for time before its own created_at. The live portion is never
  // written to the ledger -- it's derived fresh on every call, exactly
  // like the account-level todayAccruedCents it's summed into.
  const completedNodeTotals = computeNodeEarningsTotals(db, accountId);
  const nodeEarnings = {};
  for (const node of liveEligibleNodeRows) {
    nodeEarnings[node.id] = (completedNodeTotals[node.id] || 0) + (liveNodeCents[node.id] || 0);
  }

  return {
    mode: "demo",
    active,
    ispStatus: fresh.isp_status,
    nodeConnectedAt: fresh.node_connected_at,
    wifiEnabled: Boolean(fresh.wifi_enabled),
    wifiStateSince: fresh.wifi_state_since,
    // Bugfix (refinement pass): the Dashboard's WifiToggleCard derives its
    // `reconnecting` flag from `summary?.wifiReconnectStartedAt` (see
    // app/(portal)/page.js) so a mid-flow refresh can resume the visual
    // progress bar instead of losing it entirely. This field was
    // previously omitted from this summary object, so `wifiEnabled` was
    // the only field it carried during a reconnect -- an OFF->ON refresh
    // mid-flow made the modal silently vanish (confirmed live) even
    // though the server had a real countdown in progress. Exposing the
    // already-fetched `fresh.wifi_reconnect_started_at` column here is a
    // read-only fix -- no new query, no schema change.
    wifiReconnectStartedAt: fresh.wifi_reconnect_started_at,
    // Field name kept as `todayStartAt` for client backward-compatibility;
    // it now means "current midnight-Pacific cycle's start instant".
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
    // { [ownedNodeId]: totalEarningsCents } -- consumed by the Dashboard
    // "Your Nodes" table's live "Total Earnings" column (see
    // app/api/nodes/owned/route.js, which joins this against
    // listOwnedNodes()).
    nodeEarnings,
  };
}
