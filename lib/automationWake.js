import { getDb } from "./db";
import { runGenericAutomationEvaluator } from "./automationEvaluator";
import { GENERIC_AI_SALES_RUNTIME_ENABLED } from "./automationRuntimeFlag";

// SECOND-LEVEL-TIMING batch: a single, process-wide "nearest due" wake
// timer for generic (non-legacy) AI Sales automations, layered ON TOP OF
// -- never replacing -- the existing recurring background-scheduler tick
// (lib/backgroundScheduler.js, 2-minute interval). That tick remains the
// durable recovery/reconciliation mechanism (guarantees nothing is ever
// lost across a restart, a missed wake, or a crashed process); this
// module is a pure latency OPTIMIZATION so a 15-second delay doesn't
// have to wait out a 2-minute tick.
//
// Design (deliberately simple, per spec's safety constraints):
//   - ONE setTimeout at a time for the whole process (never one per
//     customer, never one per automation send, never an unbounded
//     collection of timers).
//   - The DB (automation_definitions + automation_sends +
//     the various occurrence source tables) remains the ONLY source of
//     truth. This timer never itself decides what's due -- it just calls
//     runGenericAutomationEvaluator(db, now), which independently
//     recomputes everything from scratch every time, exactly as the
//     recurring scheduler tick already does. The timer firing a few ms
//     early/late, firing twice, or never firing at all (e.g. process
//     killed) can never cause a duplicate OR a lost send -- that
//     guarantee lives entirely in automation_sends' UNIQUE constraint +
//     the recurring tick's eventual re-scan, same as before this batch.
//   - After every evaluator run (whether triggered by this timer, the
//     recurring tick, or a "poke" from a user event -- see
//     requestAutomationWake() below), the evaluator's own returned
//     `nextDueAtMs` is used to reschedule (or clear) this ONE timer.
//   - Capped to a sane max single-timeout duration (setTimeout silently
//     misbehaves on degenerate huge delays on some platforms) --
//     anything further out than MAX_SINGLE_TIMEOUT_MS is just left to
//     the recurring 2-minute tick, which will re-poke this module well
//     before that distant due time is ever reached in practice.
//   - .unref()'d so it can never keep the Node process alive on its own,
//     matching the existing recurring-scheduler's own convention.

const MAX_SINGLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes -- far enough out that the 2-minute recurring tick will re-poke well before this is ever actually relied on for a real wake
const MIN_TIMEOUT_MS = 0; // a due time already in the past fires on the next tick of the event loop, not synchronously re-entrant

let currentTimer = null;
let currentTimerDueAtMs = null;
let runningInline = false; // reentrancy guard: evaluator run -> reschedule -> never a nested synchronous re-run

function clearCurrentTimer() {
  if (currentTimer) {
    clearTimeout(currentTimer);
    currentTimer = null;
    currentTimerDueAtMs = null;
  }
}

function runEvaluatorAndReschedule() {
  // EMERGENCY ISOLATION PATCH: see lib/automationRuntimeFlag.js. When
  // the generic runtime is paused, this must be a hard no-op -- never
  // open the DB, never call the evaluator, never touch the timer.
  if (!GENERIC_AI_SALES_RUNTIME_ENABLED) return;
  if (runningInline) return; // already inside a run (e.g. the recurring scheduler called us re-entrantly); let that run's own reschedule happen instead
  runningInline = true;
  try {
    const db = getDb();
    const result = runGenericAutomationEvaluator(db, Date.now());
    scheduleWakeAt(result.nextDueAtMs);
  } catch (err) {
    console.error("[automationWake] evaluator run failed:", err);
  } finally {
    runningInline = false;
  }
}

// Schedules (or clears) the single wake timer for `nextDueAtMs` (ms epoch,
// or null/undefined for "nothing currently known to be due"). A request
// for a due time LATER than the currently-scheduled timer is ignored
// (the earlier timer already covers it -- when it fires it will discover
// and reschedule for the later one anyway). A request EARLIER than the
// current timer (or when none is scheduled) replaces it.
export function scheduleWakeAt(nextDueAtMs) {
  // EMERGENCY ISOLATION PATCH: see lib/automationRuntimeFlag.js. Never
  // arm a timer while paused, even if called directly.
  if (!GENERIC_AI_SALES_RUNTIME_ENABLED) return;
  if (nextDueAtMs == null || !Number.isFinite(nextDueAtMs)) {
    return; // nothing currently due/known -- leave any existing timer alone (it covers a nearer event) or stay idle
  }
  if (currentTimerDueAtMs !== null && nextDueAtMs >= currentTimerDueAtMs) {
    return; // an existing timer already fires at or before this requested time
  }
  clearCurrentTimer();
  const delayMs = Math.min(Math.max(nextDueAtMs - Date.now(), MIN_TIMEOUT_MS), MAX_SINGLE_TIMEOUT_MS);
  currentTimerDueAtMs = nextDueAtMs;
  currentTimer = setTimeout(() => {
    currentTimer = null;
    currentTimerDueAtMs = null;
    runEvaluatorAndReschedule();
  }, delayMs);
  if (typeof currentTimer.unref === "function") {
    currentTimer.unref();
  }
}

// Called by the recurring background-scheduler tick (durable
// reconciliation) AFTER it runs the generic evaluator itself, so this
// module's timer always reflects the latest known state even if no user
// event happened to poke it in between.
export function reportEvaluatorResult(result) {
  scheduleWakeAt(result?.nextDueAtMs);
}

// Lightweight "poke" for event routes (login, waitlist join, module
// complete, support tag add, message-read marking) to call right after
// writing the event that might make a near-term generic automation due
// sooner than the currently-scheduled wake. Deliberately synchronous,
// cheap to call from any route, and fully optional -- if a given call
// site doesn't wire this in, the recurring 2-minute tick still catches
// the event on its own next pass, so this is a pure latency optimization
// an event route is never required to call to remain correct.
export function requestAutomationWake() {
  // Running the evaluator synchronously inline here (rather than just
  // guessing a near-future wake time) is deliberate: it is cheap (same
  // query pattern as every scheduler tick), gives EXACT second-level
  // delivery for a zero-delay or already-overdue automation triggered by
  // this very event, and naturally also reschedules the single timer for
  // whatever is now the nearest future due time.
  runEvaluatorAndReschedule();
}

// Called once at server boot (see instrumentation.js), AFTER the
// existing recurring scheduler's own immediate startup tick has already
// run once (so any overdue backlog from before a restart is reconciled
// first). Performs one more evaluator pass + schedules the first wake
// timer from current DB state -- covers the case where the process was
// down long enough that something became due but the recurring
// scheduler's first tick hasn't run yet, and establishes the initial
// nearest-due timer for the fast path going forward.
export function startAutomationWake() {
  runEvaluatorAndReschedule();
}

// Test-only reset hook (disposable-DB test harnesses import this to
// avoid one test's leftover timer leaking into the next).
export function _resetAutomationWakeForTests() {
  clearCurrentTimer();
  runningInline = false;
}
