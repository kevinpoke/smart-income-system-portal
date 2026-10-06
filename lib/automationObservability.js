// HARDENED SCHEDULER observability (post-outage redesign, spec Part 13):
// lightweight, rate-limited diagnostics for the generic AI Sales
// automation runtime. Deliberately NEVER logs customer data, message
// bodies, account ids, or per-candidate detail -- only aggregate counts
// and timings. A healthy, idle system should produce very little output;
// this module exists so an on-call engineer can see "the evaluator ran
// N times, found M candidates, sent K" without re-enabling verbose
// per-request logging (which is itself part of what caused the outage).
//
// Rate limiting: identical consecutive "nothing happened" events
// (0 candidates, 0 sent, 0 suppressed) are summarized rather than
// logged individually, so a quiet system doesn't produce a quiet FLOOD
// of "ran, did nothing" lines either.

const QUIET_RUN_LOG_INTERVAL_MS = 5 * 60 * 1000; // at most one "still quiet" line per 5 minutes
let lastQuietLogAtMs = 0;
let quietRunsSinceLastLog = 0;

export function recordEvaluatorRun({
  startedAt,
  durationMs,
  definitionsChecked,
  accountsChecked,
  candidatesFound,
  sent,
  suppressed,
  nextDueAtMs,
  error,
  backoffMs,
  source,
}) {
  const nowMs = Date.now();
  const isQuiet = !error && !sent && !suppressed && !candidatesFound;

  if (isQuiet) {
    quietRunsSinceLastLog += 1;
    if (nowMs - lastQuietLogAtMs < QUIET_RUN_LOG_INTERVAL_MS) {
      return; // suppressed -- nothing interesting happened, don't flood logs
    }
    lastQuietLogAtMs = nowMs;
    console.log(
      `[automationEvaluator] ${quietRunsSinceLastLog} quiet run(s) in the last ~5min (no sends/suppressions/candidates). durationMs=${durationMs}`
    );
    quietRunsSinceLastLog = 0;
    return;
  }

  // Non-quiet run (something actually happened, or it errored) -- always
  // log, but still only ONE line, aggregate counts only, no PII.
  const nextDueInMs = Number.isFinite(nextDueAtMs) ? nextDueAtMs - nowMs : null;
  if (error) {
    console.error(
      `[automationEvaluator] run FAILED source=${source || "?"} durationMs=${durationMs} backoffMs=${backoffMs}`
    );
  } else {
    console.log(
      `[automationEvaluator] source=${source || "?"} durationMs=${durationMs} ` +
        `definitionsChecked=${definitionsChecked ?? "?"} accountsChecked=${accountsChecked ?? "?"} ` +
        `candidatesFound=${candidatesFound ?? "?"} sent=${sent ?? 0} suppressed=${suppressed ?? 0} ` +
        `nextDueInMs=${nextDueInMs ?? "null"}`
    );
  }
}

// Wake-scheduling events are even higher-volume (one per requestAutomationWake
// call) -- only log at most once per interval, and only the LAST event's
// shape, never a line per HTTP request.
const WAKE_EVENT_LOG_INTERVAL_MS = 5 * 60 * 1000;
let lastWakeLogAtMs = 0;
let wakeEventsSinceLastLog = 0;
let lastWakeEventShape = null;

export function recordWakeEvent(event) {
  wakeEventsSinceLastLog += 1;
  lastWakeEventShape = event;
  const nowMs = Date.now();
  if (nowMs - lastWakeLogAtMs < WAKE_EVENT_LOG_INTERVAL_MS) return;
  lastWakeLogAtMs = nowMs;
  console.log(
    `[automationWake] ${wakeEventsSinceLastLog} wake event(s) in the last ~5min; most recent: ` +
      `reason=${lastWakeEventShape.reason} scheduledInMs=${lastWakeEventShape.scheduledInMs ?? "null"} ` +
      `evaluatorAlreadyRunning=${Boolean(lastWakeEventShape.evaluatorAlreadyRunning)} ` +
      `timerAlreadyExists=${Boolean(lastWakeEventShape.timerAlreadyExists)} ` +
      `circuitBreakerState=${lastWakeEventShape.circuitBreakerState ?? "closed"}`
  );
  wakeEventsSinceLastLog = 0;
}

// Test-only reset so one test's accumulated rate-limit state can't
// suppress another test's expected log line.
export function _resetAutomationObservabilityForTests() {
  lastQuietLogAtMs = 0;
  quietRunsSinceLastLog = 0;
  lastWakeLogAtMs = 0;
  wakeEventsSinceLastLog = 0;
  lastWakeEventShape = null;
}
