import { getDb } from "./db";
import { runGenericAutomationEvaluator } from "./automationEvaluator";
import { GENERIC_AI_SALES_RUNTIME_ENABLED } from "./automationRuntimeFlag";
import { recordEvaluatorRun, recordWakeEvent } from "./automationObservability";

// HARDENED SCHEDULER (post-outage redesign): single, process-wide
// "nearest due" wake mechanism for generic (non-legacy) AI Sales
// automations, layered ON TOP OF -- never replacing -- the existing
// recurring background-scheduler tick (lib/backgroundScheduler.js,
// 2-minute interval). That tick remains the durable recovery/
// reconciliation mechanism; this module is a pure latency OPTIMIZATION.
//
// OUTAGE ROOT CAUSE (see git history around commit 8c6ea71): the
// PREVIOUS version of this module ran runGenericAutomationEvaluator()
// SYNCHRONOUSLY, INLINE, on the calling stack of requestAutomationWake()
// -- which itself was called directly from 4 HTTP request handlers,
// including GET /api/support/messages, which is polled by every open
// customer/admin tab every 4 seconds. With ~3,300+ accounts, that made
// every single poll run a full table-scan evaluation pass on Node's one
// event-loop thread, competing directly with HTTP request handling.
// Under concurrent load this pinned CPU at ~100-115% and made the
// server stop answering requests entirely (verified via isolation test:
// pausing the generic runtime alone restored the site).
//
// HARDENED INVARIANTS enforced by this rewrite (every one of these is
// covered by a unit test in __tests__/automationWake.test.mjs):
//
//   A. NEVER ZERO-DELAY SPIN -- MIN_WAKE_DELAY_MS floor on every
//      scheduled timer, even for an already-overdue nextDueAtMs.
//   B. SINGLE-FLIGHT EVALUATOR -- evaluatorRunning flag; a wake request
//      that arrives while a run is in progress sets wakeRequested and
//      returns, it does NOT queue a nested/recursive call.
//   C. ONE TIMER MAXIMUM -- a single module-level timer handle; a new
//      request only replaces it when the new time is meaningfully
//      sooner, never accumulates.
//   D. requestAutomationWake() NEVER RUNS WORK INLINE -- it only ever
//      arms/coalesces the one timer and returns synchronously in O(1),
//      regardless of DB size. The evaluator always runs later, off the
//      calling request's stack, via setTimeout.
//   E. OVERDUE-CANDIDATE PROTECTION + F. nextDueAt CONTRACT -- enforced
//      in lib/automationEvaluator.js's runGenericAutomationEvaluator():
//      it must only ever return a nextDueAtMs that is STRICTLY in the
//      future (now passed in), never an already-processed timestamp.
//      This module trusts that contract but ALSO defensively clamps any
//      non-conforming value (see scheduleWakeAt) so a future regression
//      in the evaluator can never again produce a busy-spin here.
//   G. FAILURE BACKOFF -- exponential backoff (5s/15s/30s/60s cap) on
//      repeated evaluator exceptions, reset after any successful run.
//   H. EXECUTION BUDGET -- delegated to the evaluator itself (batched +
//      yielded, see automationEvaluator.js); this module does not add
//      its own budget since it never runs work inline.
//   I. CIRCUIT BREAKER -- if the evaluator is asked to start more than
//      CIRCUIT_BREAKER_MAX_STARTS times within CIRCUIT_BREAKER_WINDOW_MS,
//      the nearest-due wake path stops scheduling for
//      CIRCUIT_BREAKER_COOLDOWN_MS. The periodic 2-minute scheduler tick
//      is deliberately NOT gated by this breaker (see
//      lib/backgroundScheduler.js) -- it is the durable fallback that
//      must keep working even if this fast path trips.
//
// Still fully gated by GENERIC_AI_SALES_RUNTIME_ENABLED (see
// lib/automationRuntimeFlag.js) while this redesign is validated.

const MIN_WAKE_DELAY_MS = 1000; // never schedule faster than this, even for an overdue/zero/negative nextDueAtMs
const MAX_SINGLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes -- the 2-minute recurring tick re-pokes well before this is ever relied on
const REPLACE_TIMER_SLACK_MS = 250; // only replace an existing timer if the new target is at least this much sooner (avoids timer churn from near-simultaneous requests)

const BACKOFF_STEPS_MS = [5000, 15000, 30000, 60000]; // 5s, 15s, 30s, 60s cap

const CIRCUIT_BREAKER_MAX_STARTS = 10;
const CIRCUIT_BREAKER_WINDOW_MS = 10 * 1000;
const CIRCUIT_BREAKER_COOLDOWN_MS = 60 * 1000;

// Rate-limit the circuit-breaker-open log line so a persistently
// misbehaving evaluator can never flood logs (spec Part 13 /
// Part 9 "do not spam logs").
const CIRCUIT_BREAKER_LOG_INTERVAL_MS = 60 * 1000;

let wakeTimer = null;
let wakeAtMs = null;

let evaluatorRunning = false;
let wakeRequestedWhileRunning = false;

let consecutiveFailures = 0;

let evaluatorStartTimestamps = []; // sliding window for circuit breaker
let circuitBreakerOpenUntilMs = null;
let lastCircuitBreakerLogAtMs = 0;

function clearWakeTimer() {
  if (wakeTimer) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
    wakeAtMs = null;
  }
}

function circuitBreakerIsOpen(nowMs) {
  return circuitBreakerOpenUntilMs !== null && nowMs < circuitBreakerOpenUntilMs;
}

// Records one evaluator *start attempt* in the sliding window and opens
// the breaker if the threshold is exceeded. Returns true if the start is
// ALLOWED to proceed, false if the breaker is (now, or already) open.
function checkAndRecordCircuitBreaker(nowMs) {
  if (circuitBreakerIsOpen(nowMs)) return false;

  evaluatorStartTimestamps = evaluatorStartTimestamps.filter(
    (t) => nowMs - t < CIRCUIT_BREAKER_WINDOW_MS
  );
  evaluatorStartTimestamps.push(nowMs);

  if (evaluatorStartTimestamps.length > CIRCUIT_BREAKER_MAX_STARTS) {
    circuitBreakerOpenUntilMs = nowMs + CIRCUIT_BREAKER_COOLDOWN_MS;
    evaluatorStartTimestamps = [];
    if (nowMs - lastCircuitBreakerLogAtMs > CIRCUIT_BREAKER_LOG_INTERVAL_MS) {
      lastCircuitBreakerLogAtMs = nowMs;
      console.error(
        `[automationWake] circuit breaker OPEN: >${CIRCUIT_BREAKER_MAX_STARTS} evaluator starts within ${CIRCUIT_BREAKER_WINDOW_MS}ms. Pausing nearest-due wake for ${CIRCUIT_BREAKER_COOLDOWN_MS}ms; periodic reconciliation scheduler is unaffected.`
      );
    }
    return false;
  }
  return true;
}

// The ONLY place that actually invokes the evaluator. Always runs
// asynchronously relative to whatever called scheduleWakeAt/requestWake
// -- by construction, it is only ever reached via a setTimeout callback
// or an explicit await from the periodic scheduler tick (see
// runGenericEvaluatorSingleFlight below), never synchronously from an
// HTTP request's own stack.
async function runEvaluatorNow() {
  if (!GENERIC_AI_SALES_RUNTIME_ENABLED) return;

  const nowMs = Date.now();

  if (evaluatorRunning) {
    // Single-flight: a run is already in progress (e.g. the periodic
    // tick and this timer raced). Do NOT start a second overlapping
    // run -- just remember that another pass is wanted once the
    // current one finishes.
    wakeRequestedWhileRunning = true;
    return;
  }

  if (!checkAndRecordCircuitBreaker(nowMs)) {
    recordWakeEvent({ reason: "circuit_breaker_open", circuitBreakerState: "open" });
    return; // breaker open -- periodic 2-minute scheduler remains the fallback
  }

  evaluatorRunning = true;
  const startedAt = Date.now();
  try {
    const db = getDb();
    const result = await runGenericAutomationEvaluator(db, startedAt);
    consecutiveFailures = 0; // reset backoff on any successful run
    recordEvaluatorRun({ startedAt, durationMs: Date.now() - startedAt, ...result, source: "wake" });
    scheduleWakeAt(result.nextDueAtMs, "post-run reschedule");
  } catch (err) {
    console.error("[automationWake] evaluator run failed:", err);
    consecutiveFailures += 1;
    const backoffMs = BACKOFF_STEPS_MS[Math.min(consecutiveFailures - 1, BACKOFF_STEPS_MS.length - 1)];
    recordEvaluatorRun({ startedAt, durationMs: Date.now() - startedAt, error: true, backoffMs });
    scheduleWakeAt(Date.now() + backoffMs, "failure backoff");
  } finally {
    evaluatorRunning = false;
  }

  if (wakeRequestedWhileRunning) {
    wakeRequestedWhileRunning = false;
    // Exactly ONE future wake, never a recursive/immediate re-run --
    // schedule it through the normal min-delay path.
    scheduleWakeAt(Date.now() + MIN_WAKE_DELAY_MS, "coalesced request during run");
  }
}

// Shared single-flight entry point used by BOTH the nearest-due wake
// timer (via runEvaluatorNow's own setTimeout callback above) AND the
// periodic 2-minute background-scheduler tick (lib/backgroundScheduler.js).
// Routing the periodic tick through this SAME function -- rather than
// having it call runGenericAutomationEvaluator() directly -- means there
// is exactly ONE single-flight guard shared by every caller, so the
// periodic tick and the nearest-due timer can never run the evaluator
// concurrently with each other either. If a periodic tick arrives while
// the wake timer's own run is in flight (or vice versa), it coalesces
// into the same "wakeRequestedWhileRunning" follow-up, never a second
// overlapping execution.
export async function runGenericEvaluatorSingleFlight(reason = "periodic tick") {
  if (!GENERIC_AI_SALES_RUNTIME_ENABLED) return;
  if (evaluatorRunning) {
    wakeRequestedWhileRunning = true;
    recordWakeEvent({ reason, evaluatorAlreadyRunning: true });
    return;
  }
  await runEvaluatorNow();
}

// Schedules (or tightens) the single wake timer for `targetMs` (ms
// epoch, or null/undefined for "nothing currently known to be due").
// Defensively clamps to MIN_WAKE_DELAY_MS..MAX_SINGLE_TIMEOUT_MS no
// matter what the caller passes in -- this is the one place that
// guarantees invariant A (never zero-delay) even if a caller (or a
// future bug in the evaluator's nextDueAt contract) passes a past or
// near-now timestamp.
export function scheduleWakeAt(targetMs, reason = "unspecified") {
  if (!GENERIC_AI_SALES_RUNTIME_ENABLED) return;
  if (targetMs == null || !Number.isFinite(targetMs)) {
    recordWakeEvent({
      reason,
      scheduledInMs: null,
      evaluatorAlreadyRunning: evaluatorRunning,
      circuitBreakerState: circuitBreakerIsOpen(Date.now()) ? "open" : "closed",
    });
    return; // nothing currently due/known -- leave any existing timer alone, or stay idle
  }

  const now = Date.now();
  const clampedDelayMs = Math.min(
    Math.max(targetMs - now, MIN_WAKE_DELAY_MS),
    MAX_SINGLE_TIMEOUT_MS
  );
  const clampedTargetMs = now + clampedDelayMs;

  if (wakeAtMs !== null && clampedTargetMs >= wakeAtMs - REPLACE_TIMER_SLACK_MS) {
    // An existing timer already fires at (or effectively at) this time
    // or sooner -- never accumulate a second timer.
    recordWakeEvent({
      reason,
      scheduledInMs: wakeAtMs - now,
      evaluatorAlreadyRunning: evaluatorRunning,
      timerAlreadyExists: true,
      circuitBreakerState: circuitBreakerIsOpen(now) ? "open" : "closed",
    });
    return;
  }

  clearWakeTimer();
  wakeAtMs = clampedTargetMs;
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    wakeAtMs = null;
    runEvaluatorNow();
  }, clampedDelayMs);
  if (typeof wakeTimer.unref === "function") {
    wakeTimer.unref(); // never keeps the process alive on its own
  }
  recordWakeEvent({
    reason,
    scheduledInMs: clampedDelayMs,
    evaluatorAlreadyRunning: evaluatorRunning,
    timerAlreadyExists: false,
    circuitBreakerState: circuitBreakerIsOpen(now) ? "open" : "closed",
  });
}

// Lightweight "poke" for event routes (login, waitlist join, module
// complete, message read). HARD REQUIREMENT (post-outage redesign):
// this function does ZERO database work and ZERO evaluator work on the
// calling request's stack -- it only arms/coalesces the single wake
// timer at "as soon as reasonably possible" (MIN_WAKE_DELAY_MS out) and
// returns immediately. The actual evaluation always happens later, off
// a setTimeout callback, never synchronously inline with the HTTP
// response. An event route calling this is a pure, O(1), fire-and-
// forget latency hint -- never required for correctness (the 2-minute
// periodic tick independently reconciles everything regardless).
export function requestAutomationWake(reason = "event") {
  if (!GENERIC_AI_SALES_RUNTIME_ENABLED) return;
  scheduleWakeAt(Date.now() + MIN_WAKE_DELAY_MS, reason);
}

// Called once at server boot (see instrumentation.js). Per spec Part
// 12 ("startup must not run a large generic evaluator synchronously
// before web traffic can be served"), this ONLY arms a near-term timer
// -- it never calls the evaluator on the boot/register() call stack.
// The first real evaluator pass happens MIN_WAKE_DELAY_MS after the
// timer is armed, well after the server is already accepting requests.
export function startAutomationWake() {
  if (!GENERIC_AI_SALES_RUNTIME_ENABLED) return;
  scheduleWakeAt(Date.now() + MIN_WAKE_DELAY_MS, "startup");
}

// Test-only reset hook (disposable-DB test harnesses import this to
// avoid one test's leftover timer/state leaking into the next).
export function _resetAutomationWakeForTests() {
  clearWakeTimer();
  evaluatorRunning = false;
  wakeRequestedWhileRunning = false;
  consecutiveFailures = 0;
  evaluatorStartTimestamps = [];
  circuitBreakerOpenUntilMs = null;
  lastCircuitBreakerLogAtMs = 0;
}

// Test-only introspection (no production call sites).
export function _getAutomationWakeStateForTests() {
  return {
    wakeAtMs,
    hasTimer: wakeTimer !== null,
    evaluatorRunning,
    wakeRequestedWhileRunning,
    consecutiveFailures,
    circuitBreakerOpen: circuitBreakerIsOpen(Date.now()),
    circuitBreakerOpenUntilMs,
  };
}

// Test-only direct trigger (bypasses the timer, but goes through the
// exact same single-flight/circuit-breaker/backoff path as the real
// timer callback -- used by tests that need to deterministically force
// one evaluator pass without waiting out a real setTimeout).
export async function _runEvaluatorNowForTests() {
  await runEvaluatorNow();
}
