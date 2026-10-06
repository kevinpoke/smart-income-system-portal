// EMERGENCY ISOLATION PATCH (outage response), now RE-ENABLED after the
// hardened scheduler redesign + Docker runtime-user cache fix were
// verified: single, central kill switch for the ENTIRE generic
// (non-legacy) AI Sales automation runtime -- the nearest-due wake timer
// (lib/automationWake.js) AND the recurring scheduler's own call to
// runGenericAutomationEvaluator() (lib/backgroundScheduler.js). Does NOT
// affect the 4 legacy dedicated automations (waitlist_selection,
// isp_confirmation_reminder, golden_bridge_followup, non_waitlist_4day),
// which have their own independent call sites in
// lib/supportAutomation.js and are untouched by this flag.
//
// History: production went down with the SIS Node process pinned near
// 100% CPU and the HTTP server unresponsive even on localhost. The
// generic automation runtime was the prime suspect (requestAutomationWake()
// ran runGenericAutomationEvaluator() SYNCHRONOUSLY INLINE on the
// request path of 4 event routes, one of which -- GET
// /api/support/messages -- is polled by every open customer/admin tab
// every 4 seconds). Flipping this to false removed every call path that
// could invoke the generic evaluator, as a reversible, single-line,
// no-data-touched isolation step, without deleting any code, automation
// definition, or DB row. That diagnosis was confirmed, and the runtime
// was hardened (single-flight evaluator, O(1) request-path scheduling,
// min wake delay, failure backoff, circuit breaker, time-based
// event-loop yielding -- see lib/automationWake.js /
// lib/automationEvaluator.js) before being turned back on here.
//
// Keep this flag mechanism in place: flip back to false for an
// immediate, single-line emergency rollback if the hardened runtime ever
// needs to be isolated again. Only remove the flag and its guards
// entirely once it's no longer needed as a rollback lever.
//
// HARDENED SCHEDULER test harness note: this is `let`, not `const`, so
// that _testSetGenericAiSalesRuntimeEnabled() below can flip it via a
// live ES-module binding -- every existing call site that does
// `import { GENERIC_AI_SALES_RUNTIME_ENABLED } from "./automationRuntimeFlag"`
// and reads the value (e.g. `if (GENERIC_AI_SALES_RUNTIME_ENABLED)`)
// automatically observes the current value with NO changes to those
// call sites, because ES module named imports are live bindings, not a
// snapshot copy, as long as the exporting module itself reassigns this
// variable (never shadows it with a local const in another module).
export let GENERIC_AI_SALES_RUNTIME_ENABLED = true;

// TEST-ONLY override. Deliberately impossible to use in a real
// production process: throws immediately unless NODE_ENV === "test".
// Production's docker-compose.prod.yml / Dockerfile never set
// NODE_ENV=test (production sets NODE_ENV=production, see Dockerfile),
// so this function is a guaranteed no-op/throw outside an actual test
// run -- there is no environment variable an operator could set in
// production that would silently enable this (NODE_ENV=production is
// required for `next start`'s own production optimizations, so
// accidentally running production with NODE_ENV=test would break far
// more than just this flag, making an accidental flip here extremely
// unlikely in addition to being explicitly guarded).
export function _testSetGenericAiSalesRuntimeEnabled(enabled) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "_testSetGenericAiSalesRuntimeEnabled() may only be called when NODE_ENV === 'test'. " +
        `Current NODE_ENV: ${process.env.NODE_ENV ?? "(unset)"}. ` +
        "This guard exists so the generic AI Sales runtime can never be accidentally " +
        "re-enabled outside an explicit test process."
    );
  }
  GENERIC_AI_SALES_RUNTIME_ENABLED = Boolean(enabled);
}

// Test-only reset back to the hardened-but-isolated baseline (false),
// i.e. NOT the current production default (true) -- tests that need the
// runtime OFF (e.g. exercising legacy-only call sites in isolation)
// the disposable-DB-script style used by this repo's test harnesses) a
// later require of this same module within the same process.
export function _testResetGenericAiSalesRuntimeEnabled() {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "_testResetGenericAiSalesRuntimeEnabled() may only be called when NODE_ENV === 'test'."
    );
  }
  GENERIC_AI_SALES_RUNTIME_ENABLED = false;
}
