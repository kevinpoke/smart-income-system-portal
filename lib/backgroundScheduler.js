import { getDb } from "./db";
import { transitionIspToApproved, AUTO_APPROVE_AFTER_MS } from "./ispEngine";
import { runGoldenBridgeFollowup72hScan } from "./supportAutomation";
import { runNeverLoggedIn3DayScan } from "./neverLoggedIn";
import { runJvzooUpsellReconciliationScan } from "./jvzooBridgeUpsells";
import { runAweberThreeDayNoLoginScan } from "./aweberSync";
import { runGenericAutomationEvaluator } from "./automationEvaluator";
import { reportEvaluatorResult, startAutomationWake } from "./automationWake";

// ISP-AUTO-APPROVAL + 4-DAY-FOLLOWUP batch: the ONE in-process background
// scheduler for this whole app. Per spec section A, the previous
// "auto-approve" mechanism (lib/ispEngine.js#checkAndAutoApproveIsp) was
// LAZY ONLY -- it was "Deliberately NOT a setTimeout/cron -- called
// inline from every customer-facing read of account/ISP status (GET
// /api/auth/me at minimum)", meaning an account sitting in
// 'pending_review' past its 1-hour deadline stayed there until SOME
// request happened to read it. That is no longer true automation (a
// customer who never refreshes, and no admin action, can leave it
// pending indefinitely) -- this file adds a genuine, server-process-level
// timer that promotes overdue accounts with zero client involvement.
//
// Architecture (per spec): a single module-level `setInterval` at the
// Node SERVER PROCESS level (started once via instrumentation.js's
// `register()` hook -- see that file's comment for why this is the
// idiomatic Next.js 16 App Router mechanism for "run code once when the
// server boots", not a page/client timer, not a second Docker service).
// The DATABASE remains the sole source of truth for what's due and for
// idempotency: every actual state transition below is performed by a
// function that itself does a guarded `UPDATE ... WHERE <still-eligible>`
// or a `UNIQUE(event_key)`-protected INSERT, so this interval is safe to
// run concurrently with itself (a slow tick overlapping the next one), to
// double-run after a container restart, and to coexist with the existing
// lazy checkAndAutoApproveIsp() call (still left in place as defense in
// depth per spec: "existing lazy check can stay as defense-in-depth") --
// whichever of the lazy path or this scheduler gets there first simply
// wins the guarded UPDATE/INSERT; the other is a safe no-op.
//
// This same tick also performs the GOLDEN-BRIDGE-FOLLOWUP campaign's
// Trigger B due-scan (spec section K: "Use the EXISTING recurring
// background scheduler ... Do NOT create ... a new cron"). This
// REPLACES the old 4-day non-waitlist Support follow-up scan that
// previously ran here (lib/supportAutomation.js#runNonWaitlist4DayScan,
// now permanently unused -- see that function's own header comment);
// the old scan is deliberately no longer called from this tick so it
// can never fire again for any account, while its historical sends
// remain untouched in scheduled_support_messages for Analytics. Both
// scans are independent, narrowly-named functions called from this one
// tick -- neither depends on the other's result.

// Every few minutes is explicitly "fine" per spec ("does not need
// second-level precision"). 2 minutes keeps the ISP 1-hour SLA and the
// 4-day SLA both comfortably tight while being cheap to run.
const TICK_INTERVAL_MS = 2 * 60 * 1000;

// Finds every account still sitting in 'pending_review' whose
// isp_submitted_at is already past the auto-approve deadline, and
// promotes each one via the SAME shared transitionIspToApproved()
// helper the admin manual-approval route uses (see lib/ispEngine.js) --
// no duplicated transition logic. transitionIspToApproved's own
// `UPDATE ... WHERE isp_status = 'pending_review'` guard is what makes
// this scan safe to run against a backlog of many overdue accounts in
// one pass, safe to re-run every tick, and safe against a concurrent
// manual admin approval that already won the race for a given account
// (that account is no longer 'pending_review' by the time this UPDATE
// runs, so it safely no-ops for that one row and never double-approves
// or errors).
export function runIspAutoApproveScan(db) {
  const cutoffIso = new Date(Date.now() - AUTO_APPROVE_AFTER_MS).toISOString();
  const dueRows = db
    .prepare(
      `SELECT id FROM accounts
       WHERE isp_status = 'pending_review'
         AND isp_submitted_at IS NOT NULL
         AND isp_submitted_at <= ?`
    )
    .all(cutoffIso);

  let approvedCount = 0;
  for (const row of dueRows) {
    const result = transitionIspToApproved(db, row.id, { approvedBy: "system" });
    if (result.transitioned) approvedCount += 1;
  }
  return { scanned: dueRows.length, approved: approvedCount };
}

async function runTick() {
  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error("[backgroundScheduler] failed to open db:", err);
    return;
  }

  try {
    runIspAutoApproveScan(db);
  } catch (err) {
    // Never let one scan's failure prevent the other from running, and
    // never let an uncaught exception here kill the server process --
    // this is a background maintenance task, not a request handler.
    console.error("[backgroundScheduler] ISP auto-approve scan failed:", err);
  }

  try {
    runGoldenBridgeFollowup72hScan(db);
  } catch (err) {
    console.error("[backgroundScheduler] Golden Bridge follow-up 72h scan failed:", err);
  }

  // ANALYTICS/SUPPORT/BRIDGE batch: Never-Logged-In-By-Day-3 durable-list
  // scan. Own try/catch (per spec) so a failure here can never prevent
  // the ISP auto-approve or 4-day-followup scans above from running --
  // and vice versa, a failure in either of those never skips this one,
  // since each scan is independently wrapped. Also doubles as the
  // deploy-time BACKFILL for any account that already qualified before
  // this feature existed, since this exact same call runs immediately
  // on startBackgroundScheduler()'s initial runTick() as well as every
  // subsequent tick.
  try {
    runNeverLoggedIn3DayScan(db);
  } catch (err) {
    console.error("[backgroundScheduler] Never-logged-in-3-day scan failed:", err);
  }

  // JVZOO-BRIDGE-UPSELL batch: recovery/reconciliation safety net for
  // pending upsell Bridge entitlements -- covers a temporary DB error,
  // process interruption, webhook race, or a restart between
  // entitlement creation and Bridge grant (Case D). Own try/catch so it
  // can never prevent, or be prevented by, any other scan on this tick.
  // Fully idempotent (see lib/jvzooBridgeUpsells.js).
  try {
    runJvzooUpsellReconciliationScan(db);
  } catch (err) {
    console.error("[backgroundScheduler] JVZoo upsell reconciliation scan failed:", err);
  }

  // AWEBER-3DAY-NO-LOGIN-SYNC batch: reuses the EXISTING recurring
  // scheduler per spec section 18 ("Do NOT create a new cron/container
  // if the existing scheduler is suitable... this does not need
  // millisecond real-time"). Selects strictly from the already-scanned
  // admin_never_logged_in_3day cohort (see lib/aweberSync.js), so this
  // MUST run AFTER runNeverLoggedIn3DayScan() above on the same tick --
  // a brand-new candidate that just qualified on THIS tick is
  // immediately eligible for the AWeber move on the SAME tick, rather
  // than waiting an extra full interval. Network calls to AWeber are
  // async, so this whole tick function awaits it; every other scan
  // above is synchronous SQLite work and completes first regardless.
  // Own try/catch, same isolation guarantee as every other scan here --
  // an AWeber outage can never block ISP auto-approval or any other
  // scan, and vice versa. Idempotent + bounded-batch by construction
  // (see lib/aweberSync.js runAweberThreeDayNoLoginScan), so double-
  // running on a slow-tick-overlap or container restart is always safe.
  try {
    await runAweberThreeDayNoLoginScan(db);
  } catch (err) {
    console.error("[backgroundScheduler] AWeber 3-day-no-login sync scan failed:", err);
  }

  // AI-SALES batch: generic evaluator for admin-created automations
  // (see lib/automationEvaluator.js). Skips the 4 legacy-migrated
  // automations, which keep firing from their own existing call sites
  // above/elsewhere -- this guarantees exactly ONE authoritative sender
  // per automation. Own try/catch, same isolation guarantee as every
  // other scan on this tick.
  //
  // SECOND-LEVEL-TIMING batch: this recurring tick is the durable
  // recovery/reconciliation path (nothing is ever lost even if the
  // nearest-due wake timer in lib/automationWake.js never fires, e.g.
  // after a crash) -- so it still runs the evaluator itself, every tick,
  // unconditionally. reportEvaluatorResult() afterward reschedules (or
  // leaves alone) that module's single wake timer from the SAME result,
  // so the fast path and the durable path never diverge or fight.
  try {
    const result = runGenericAutomationEvaluator(db);
    reportEvaluatorResult(result);
  } catch (err) {
    console.error("[backgroundScheduler] Generic automation evaluator failed:", err);
  }
}

// Idempotent singleton start, guarded by a global flag so Next.js
// dev-mode HMR / module re-evaluation (or an accidental second import)
// can never create a second overlapping interval. instrumentation.js's
// register() is documented to run once per server instance already, but
// this guard is cheap defense-in-depth per spec ("a module-level
// singleton guarded by a global flag").
//
// SCHEDULER-OVERLAP SAFETY (post-review addition): runTick() is now
// async because the AWeber scan makes real network calls (see the
// comment on that scan above) -- a slow/degraded AWeber API, or a full
// batch of 25 accounts each needing a network round-trip, could in
// principle make one tick take longer than the 2-minute interval. Since
// setInterval fires unconditionally on its own schedule regardless of
// whether the previous callback finished, an unguarded async runTick()
// could start a SECOND overlapping tick while the first is still
// running -- e.g. two concurrent runAweberThreeDayNoLoginScan() calls
// selecting overlapping candidate batches. tickInProgress below is a
// minimal, process-local guard: if a tick is still running when the
// next interval fires, that fire is skipped entirely (not queued, not
// retried early) -- the tick AFTER that resumes the normal cadence.
// This never blocks/delays a tick (still fires immediately on the exact
// same 2-minute cadence), it only ever SKIPS a redundant overlapping
// one, so the batch/idempotency guarantees inside each individual scan
// remain the only durability guarantee that matters -- this guard is
// purely a courtesy to avoid wasted duplicate work within one process,
// not a correctness requirement (every scan is already safe to run
// concurrently with itself, per each scan's own idempotency design).
let tickInProgress = false;

async function runTickGuarded() {
  if (tickInProgress) {
    // A previous tick is still running (e.g. a slow AWeber round-trip)
    // -- skip this overlapping fire entirely; the next normal-cadence
    // tick will pick up wherever this one left off (every scan here is
    // independently idempotent, so nothing is lost by skipping).
    return;
  }
  tickInProgress = true;
  try {
    await runTick();
  } finally {
    tickInProgress = false;
  }
}

export function startBackgroundScheduler() {
  if (globalThis.__sisBackgroundSchedulerStarted) {
    return;
  }
  globalThis.__sisBackgroundSchedulerStarted = true;

  // Run once immediately on boot (per spec: "the first scan tick ...
  // should fire immediately on startup, then every interval thereafter"
  // so a container restart catches up any backlog right away instead of
  // waiting a full interval), then on the fixed interval thereafter.
  // runTickGuarded() wraps runTick() with the overlap guard above; every
  // individual scan inside runTick() is already wrapped in its own
  // try/catch, so runTick() itself should never reject -- the .catch()
  // here is pure defense-in-depth so an unforeseen error can never
  // become an unhandled promise rejection that crashes the process.
  runTickGuarded().catch((err) => {
    console.error("[backgroundScheduler] unexpected error in initial tick:", err);
  });
  // SECOND-LEVEL-TIMING batch: establishes the nearest-due wake timer
  // from current DB state right after the initial recurring-tick
  // reconciliation above has had a chance to run -- covers the case
  // where the process was down long enough that something became due
  // but this module's own fast-path timer hasn't been scheduled yet.
  // See lib/automationWake.js header comment for the full design.
  startAutomationWake();
  const intervalId = setInterval(() => {
    runTickGuarded().catch((err) => {
      console.error("[backgroundScheduler] unexpected error in scheduled tick:", err);
    });
  }, TICK_INTERVAL_MS);
  // Never let this interval keep the process alive past a graceful
  // shutdown signal on its own.
  if (typeof intervalId.unref === "function") {
    intervalId.unref();
  }
}
