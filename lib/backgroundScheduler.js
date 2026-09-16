import { getDb } from "./db";
import { transitionIspToApproved, AUTO_APPROVE_AFTER_MS } from "./ispEngine";
import { runGoldenBridgeFollowup72hScan } from "./supportAutomation";
import { runNeverLoggedIn3DayScan } from "./neverLoggedIn";

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

function runTick() {
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
}

// Idempotent singleton start, guarded by a global flag so Next.js
// dev-mode HMR / module re-evaluation (or an accidental second import)
// can never create a second overlapping interval. instrumentation.js's
// register() is documented to run once per server instance already, but
// this guard is cheap defense-in-depth per spec ("a module-level
// singleton guarded by a global flag").
export function startBackgroundScheduler() {
  if (globalThis.__sisBackgroundSchedulerStarted) {
    return;
  }
  globalThis.__sisBackgroundSchedulerStarted = true;

  // Run once immediately on boot (per spec: "the first scan tick ...
  // should fire immediately on startup, then every interval thereafter"
  // so a container restart catches up any backlog right away instead of
  // waiting a full interval), then on the fixed interval thereafter.
  runTick();
  const intervalId = setInterval(runTick, TICK_INTERVAL_MS);
  // Never let this interval keep the process alive past a graceful
  // shutdown signal on its own.
  if (typeof intervalId.unref === "function") {
    intervalId.unref();
  }
}
