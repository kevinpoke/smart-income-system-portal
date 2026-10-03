// EMERGENCY ISOLATION PATCH (outage response): single, central kill
// switch for the ENTIRE generic (non-legacy) AI Sales automation
// runtime -- the nearest-due wake timer (lib/automationWake.js) AND the
// recurring scheduler's own call to runGenericAutomationEvaluator()
// (lib/backgroundScheduler.js). Does NOT affect the 4 legacy dedicated
// automations (waitlist_selection, isp_confirmation_reminder,
// golden_bridge_followup, non_waitlist_4day), which have their own
// independent call sites in lib/supportAutomation.js and are untouched
// by this flag.
//
// Purpose: production is down with the SIS Node process pinned near
// 100% CPU and the HTTP server unresponsive even on localhost. The
// generic automation runtime is the prime suspect (requestAutomationWake()
// runs runGenericAutomationEvaluator() SYNCHRONOUSLY INLINE on the
// request path of 4 event routes, one of which -- GET
// /api/support/messages -- is polled by every open customer/admin tab
// every 4 seconds). Flipping this to false removes every call path that
// can invoke the generic evaluator, as a reversible, single-line,
// no-data-touched isolation step to test that theory on production
// without deleting any code, automation definition, or DB row.
//
// Flip back to true (or, once the real hardened scheduler lands, delete
// this flag and its guards entirely) once root-caused.
export const GENERIC_AI_SALES_RUNTIME_ENABLED = false;
