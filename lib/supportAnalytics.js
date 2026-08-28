// Server-only Support Analytics engine (admin Analytics tab, Part 1F).
//
// AUDIT FINDING: no new persisted signal is needed to distinguish a
// MANUAL admin support reply from an AUTOMATED one. lib/supportAutomation.js
// delivers every automated message (welcome, ISP-approved, login check-in)
// via postMessageInner() with senderAccountId = null (see
// deliverDueMessages -> postMessageInner({ senderAccountId: null, ... })).
// Every manual admin reply, by contrast, is sent through
// POST /api/admin/support/conversations/[id], which always passes the
// authenticated admin's real account id as senderAccountId (see that
// route: `senderAccountId: guard.account.id`). So
// support_messages.sender_account_id IS NOT NULL is already the
// authoritative, persisted "this was a real manual admin reply" signal --
// this file relies on that existing column, adding no new schema.
//
// CALCULATION (support-ticket style, documented per spec):
// Walk each conversation's messages in chronological order. Track the
// timestamp of the FIRST customer message in the current "unanswered
// sequence" (a run of customer messages with no manual admin reply yet).
// - A customer message: if there is no open unanswered sequence, this
//   message's timestamp becomes the sequence start. If a sequence is
//   already open (customer sent again before being answered), the start
//   timestamp is NOT moved -- this is what "customer 10:00, customer
//   10:04, admin manual 10:15" example dictates: exactly one sample of
//   15 minutes (10:00 -> 10:15), not two.
// - An automated admin message (sender_account_id IS NULL): completely
//   ignored for this calculation. It does not close the sequence, does
//   not reset the timer, and is never treated as a response.
// - A manual admin message (sender_account_id IS NOT NULL): if a
//   sequence is open, this closes it -- one sample is recorded
//   (thisMessage.created_at - sequence.start), and the sequence resets
//   (no open sequence) until the next customer message starts a new one.
//   If no sequence is open (admin replying with nothing pending), no
//   sample is recorded.
// A conversation with an unanswered sequence still open at the end (no
// manual reply yet) contributes NO sample for that open sequence, per
// spec ("Do NOT include conversations that have not yet received a
// manual admin response").
//
// PERIOD FILTERING: a sample belongs to the selected period based on the
// timestamp of the INITIAL inbound customer message that started its
// sequence (per spec), not the admin reply time.
export function computeResponseTimeSamples(db) {
  const rows = db
    .prepare(
      `SELECT conversation_id, sender_role, sender_account_id, created_at
       FROM support_messages
       ORDER BY conversation_id ASC, created_at ASC, id ASC`
    )
    .all();

  const samples = []; // { conversationId, startAt (ms), respondedAt (ms), deltaMs }
  let currentConversationId = null;
  let sequenceStartMs = null;

  for (const row of rows) {
    if (row.conversation_id !== currentConversationId) {
      currentConversationId = row.conversation_id;
      sequenceStartMs = null;
    }

    const createdMs = new Date(row.created_at).getTime();

    if (row.sender_role === "customer") {
      if (sequenceStartMs === null) {
        sequenceStartMs = createdMs;
      }
      continue;
    }

    // sender_role === 'admin'
    const isManual = row.sender_account_id !== null && row.sender_account_id !== undefined;
    if (!isManual) {
      // Automated system message -- never counts as a response, never
      // resets/closes the open sequence.
      continue;
    }

    if (sequenceStartMs !== null) {
      samples.push({
        conversationId: row.conversation_id,
        startAtMs: sequenceStartMs,
        respondedAtMs: createdMs,
        deltaMs: createdMs - sequenceStartMs,
      });
      sequenceStartMs = null; // sequence answered; next customer message starts a fresh one
    }
    // If no sequence was open, a manual admin message with nothing
    // pending is not a "response" to anything and contributes no sample.
  }

  return samples;
}

// Filters already-computed samples to those whose INITIAL inbound
// customer message timestamp falls within [startMs, endMs) (endMs
// exclusive), then reduces to { avgMs, count }.
export function summarizeResponseTimes(samples, startMs, endMs) {
  const inRange = samples.filter((s) => s.startAtMs >= startMs && s.startAtMs < endMs);
  if (inRange.length === 0) {
    return { avgMs: null, count: 0 };
  }
  const totalMs = inRange.reduce((sum, s) => sum + s.deltaMs, 0);
  return { avgMs: Math.round(totalMs / inRange.length), count: inRange.length };
}

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// ---- Admin-facing day-boundary computation -----------------------------
//
// Uses the SAME "America/Los_Angeles" timezone the rest of this app's
// existing production time-based logic already standardizes on (see
// lib/earningsEngine.js CYCLE_TZ) so the admin-facing "day" used by these
// filters is consistent with the one users of this app already see
// elsewhere (earnings cycle boundaries), rather than silently mixing UTC
// calendar days with a different admin-facing convention. This is a
// SELF-CONTAINED reimplementation (not an import from lib/earningsEngine.js)
// so this Support Analytics feature has zero coupling to -- and makes zero
// changes to -- the earnings/payout engine, which is explicitly off-limits
// for this batch.
const ANALYTICS_TZ = "America/Los_Angeles";

function tzPartsFor(utcMs, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
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
  if (parts.hour === 24) parts.hour = 0;
  return parts;
}

// Converts a timeZone-local "YYYY-MM-DD 00:00:00" wall-clock moment into
// the correct UTC epoch ms, without assuming a fixed UTC offset (handles
// both standard and daylight-saving offsets, and the transition dates
// themselves). Same convergence technique used elsewhere in this app for
// this exact class of problem.
function localMidnightToUtcMs(year, month, day, timeZone) {
  let guessUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0);
  for (let pass = 0; pass < 2; pass++) {
    const actual = tzPartsFor(guessUtcMs, timeZone);
    const actualMinutes =
      Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second) / 60000;
    const targetMinutes = Date.UTC(year, month - 1, day, 0, 0, 0) / 60000;
    const diff = actualMinutes - targetMinutes;
    if (diff === 0) break;
    guessUtcMs -= diff * 60000;
  }
  return guessUtcMs;
}

// Returns [startMs, endMs) for the given admin-facing period, evaluated
// "now" in ANALYTICS_TZ. `period` one of:
// today | yesterday | last3 | lastweek | lastmonth | custom
// For custom, `customStart`/`customEnd` are "YYYY-MM-DD" strings
// (inclusive start day, inclusive end day) interpreted in ANALYTICS_TZ.
export function resolvePeriodRange(period, { customStart, customEnd, now = Date.now() } = {}) {
  const todayParts = tzPartsFor(now, ANALYTICS_TZ);
  const todayMidnightMs = localMidnightToUtcMs(todayParts.year, todayParts.month, todayParts.day, ANALYTICS_TZ);
  const DAY_MS = 24 * 60 * 60 * 1000;

  switch (period) {
    case "today":
      return { startMs: todayMidnightMs, endMs: todayMidnightMs + DAY_MS };
    case "yesterday":
      return { startMs: todayMidnightMs - DAY_MS, endMs: todayMidnightMs };
    case "last3":
      return { startMs: todayMidnightMs - 3 * DAY_MS, endMs: todayMidnightMs + DAY_MS };
    case "lastweek":
      return { startMs: todayMidnightMs - 7 * DAY_MS, endMs: todayMidnightMs + DAY_MS };
    case "lastmonth":
      return { startMs: todayMidnightMs - 30 * DAY_MS, endMs: todayMidnightMs + DAY_MS };
    case "custom": {
      const start = parseYmd(customStart);
      const end = parseYmd(customEnd);
      if (!start || !end) return null;
      const startMs = localMidnightToUtcMs(start.y, start.m, start.d, ANALYTICS_TZ);
      // end is inclusive of the whole end day -> exclusive boundary is midnight of the day AFTER end.
      const endMs = localMidnightToUtcMs(end.y, end.m, end.d, ANALYTICS_TZ) + DAY_MS;
      return { startMs, endMs };
    }
    default:
      return null;
  }
}

function parseYmd(str) {
  if (typeof str !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str.trim());
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

export { ANALYTICS_TZ };

// ---- DISABLED-FUNNEL-ANALYTICS batch: Disabled User Funnel --------------
//
// Uses the canonical, per-account `disable_stage_snapshot` written once
// at disable time by lib/accountDisable.js#disableAccount() -- NEVER
// re-derived from the account's CURRENT funnel fields, since those can
// keep changing after a disable (see that file's header comment for the
// full rationale). Historical accounts disabled BEFORE this column
// existed have disable_stage_snapshot = NULL and are bucketed into
// "unknown" rather than guessed -- per spec, "if some historical
// disabled users cannot be classified reliably, create an Unknown
// bucket instead of guessing."
//
// All four MAIN buckets (before_login / before_isp_setup /
// during_isp_verification / after_isp_approval) plus unknown are
// mutually exclusive by construction: disable_stage_snapshot holds
// exactly one of five possible string values per row (see
// computeFunnelStageAtDisable in lib/accountDisable.js), and this query
// aggregates by that single column with a single pass -- never double-
// counts, never requires client-side reconciliation.
export function computeDisabledFunnel(db) {
  const rows = db
    .prepare(
      `SELECT disable_stage_snapshot AS stage, COUNT(*) AS c
       FROM accounts
       WHERE role = 'customer' AND account_status = 'disabled'
       GROUP BY disable_stage_snapshot`
    )
    .all();

  const counts = {
    before_login: 0,
    before_isp_setup: 0,
    during_isp_verification: 0,
    after_isp_approval_never_live: 0,
    after_isp_approval_went_live: 0,
    unknown: 0,
  };
  for (const row of rows) {
    const key = row.stage && counts.hasOwnProperty(row.stage) ? row.stage : "unknown";
    counts[key] += row.c;
  }

  const totalDisabled = Object.values(counts).reduce((a, b) => a + b, 0);
  const afterApprovalTotal = counts.after_isp_approval_never_live + counts.after_isp_approval_went_live;

  function pct(n) {
    if (!totalDisabled) return 0;
    return Math.round((n / totalDisabled) * 1000) / 10;
  }

  // ---- Disabled By Reason breakdown (Part 6, secondary) ----
  const reasonRows = db
    .prepare(
      `SELECT disable_reason AS reason, COUNT(*) AS c
       FROM accounts
       WHERE role = 'customer' AND account_status = 'disabled'
       GROUP BY disable_reason`
    )
    .all();
  const reasonCounts = { manual_admin: 0, jvzoo_refund: 0, unknown: 0 };
  for (const row of reasonRows) {
    const key = row.reason && reasonCounts.hasOwnProperty(row.reason) ? row.reason : "unknown";
    reasonCounts[key] += row.c;
  }

  return {
    totalDisabled,
    stages: {
      beforeLogin: { count: counts.before_login, pct: pct(counts.before_login) },
      beforeIspSetup: { count: counts.before_isp_setup, pct: pct(counts.before_isp_setup) },
      duringIspVerification: {
        count: counts.during_isp_verification,
        pct: pct(counts.during_isp_verification),
      },
      afterIspApproval: {
        count: afterApprovalTotal,
        pct: pct(afterApprovalTotal),
        neverWentLive: {
          count: counts.after_isp_approval_never_live,
          pct: pct(counts.after_isp_approval_never_live),
        },
        wentLiveBeforeDisabled: {
          count: counts.after_isp_approval_went_live,
          pct: pct(counts.after_isp_approval_went_live),
        },
      },
      unknown: { count: counts.unknown, pct: pct(counts.unknown) },
    },
    byReason: {
      manualAdmin: { count: reasonCounts.manual_admin, pct: pct(reasonCounts.manual_admin) },
      jvzooRefund: { count: reasonCounts.jvzoo_refund, pct: pct(reasonCounts.jvzoo_refund) },
      unknown: { count: reasonCounts.unknown, pct: pct(reasonCounts.unknown) },
    },
  };
}

// ---- ISP-APPROVAL-CONVERSION batch: ISP Approval -> Go-Live funnel ------
//
// Denominator (Total ISP Approved): every customer whose isp_approved_at
// is set -- includes BOTH manually-approved and automatically-approved
// accounts, per spec, regardless of their CURRENT isp_status (an
// approved-then-disabled account is still counted as "approved").
//
// "Went live" / activation source uses the SAME authoritative signal
// completeIspAuthorization() persists: isp_activation_source
// ("customer" | "admin"). A row with isp_status = 'active' (or
// user_authorized_at/node_connected_at set) but isp_activation_source
// NULL is a historical activation from before this column existed --
// counted in "Still Not Live" is WRONG for those rows (they clearly ARE
// live), so a THIRD bucket is used instead: "live, but activation
// source unknown" -- surfaced separately and never silently folded into
// either the customer-return or admin-completed buckets, per spec's
// "Do NOT count an admin-completed ISP Confirmation as the customer
// coming back" + "do not guess" rules taken together.
function isLive(row) {
  return Boolean(row.isp_status === "active" || row.user_authorized_at || row.node_connected_at);
}

function classifyApprovalRow(row) {
  const approvalSource = row.isp_approval_source === "manual" || row.isp_approval_source === "automatic"
    ? row.isp_approval_source
    : "unknown";
  let activationBucket;
  if (!isLive(row)) {
    activationBucket = "not_live";
  } else if (row.isp_activation_source === "customer") {
    activationBucket = "customer_returned";
  } else if (row.isp_activation_source === "admin") {
    activationBucket = "admin_completed";
  } else {
    activationBucket = "live_unknown_source";
  }
  return { approvalSource, activationBucket };
}

function emptyConversionBucket() {
  return { approved: 0, customerReturned: 0, adminCompleted: 0, liveUnknownSource: 0, notLive: 0 };
}

function finalizeConversionBucket(b) {
  const totalLive = b.customerReturned + b.adminCompleted + b.liveUnknownSource;
  function pct(n) {
    if (!b.approved) return 0;
    return Math.round((n / b.approved) * 1000) / 10;
  }
  return {
    approved: b.approved,
    customerReturnedWentLive: { count: b.customerReturned, pct: pct(b.customerReturned) },
    adminCompletedWentLive: { count: b.adminCompleted, pct: pct(b.adminCompleted) },
    liveActivationSourceUnknown: { count: b.liveUnknownSource, pct: pct(b.liveUnknownSource) },
    stillNotLive: { count: b.notLive, pct: pct(b.notLive) },
    totalLive,
    customerReturnConversionPct: pct(b.customerReturned),
    totalGoLiveConversionPct: pct(totalLive),
  };
}

// ---- MODULE-10-REFUND-ANALYTICS batch: Module 10 Refunds -----------------
//
// AUTHORITATIVE DEFINITIONS (audited against the current codebase at
// HEAD -- see lib/moduleEngine.js and lib/accountDisable.js):
//
//   REFUND SOURCE: only rows with disable_reason = 'jvzoo_refund' AND
//   disabled_at IS NOT NULL count as a qualifying JVZoo refund -- this is
//   the SAME canonical disable-event tracking introduced by
//   lib/accountDisable.js#disableAccount(), written by BOTH the manual
//   admin disable route (reason: 'manual_admin', excluded here) and the
//   JVZoo original-SALE refund auto-disable path
//   (app/api/webhooks/jvzoo/route.js disableForOriginalSaleRefund, reason:
//   'jvzoo_refund'). A BILL/rebill refund never reaches
//   disableForOriginalSaleRefund (see recordNonDisablingRefund in that
//   file) and therefore never sets disable_reason='jvzoo_refund' -- it is
//   correctly excluded by construction, not by any extra filter here.
//
//   MODULE 10 UNLOCK: uses the EXACT SAME schedule constant
//   (MODULE_UNLOCK_HOURS[10], currently 112h) and the exact same formula
//   lib/moduleEngine.js#computeModuleUnlockAtMs uses --
//   first_login_at + MODULE_UNLOCK_HOURS[10]*HOUR_MS. This is
//   deliberately NOT a second hardcoded copy of "112" -- it imports
//   MODULE_UNLOCK_HOURS from lib/mockData.js, the single canonical
//   schedule source, so a future change to the schedule automatically
//   flows through to this analytics query with zero additional edits.
//   Per spec Part 4: admin "Unlock All Modules" (accounts.modules_unlocked)
//   is DELIBERATELY NOT consulted here -- a CURRENT override can never
//   retroactively prove a PAST refund happened after unlock; only the
//   account's own first_login_at-derived schedule timestamp (which is
//   fixed and known at any point in time, unlike the override which has
//   no persisted "since when" timestamp) is used. first_login_at IS NULL
//   means the unlock timestamp can never be computed -- such refunded
//   accounts are correctly excluded from BOTH the unlocked-before-refund
//   numerator and (transitively) the watched-before-refund check.
//
//   MODULE 10 WATCHED: uses ONLY the real, persisted completion signal
//   account_module_progress.completed_at for module_key = 10 -- the exact
//   same column lib/moduleEngine.js#isModuleCompleted() reads, which is
//   the same one lib/moduleAccess.js#hasWithdrawalsModule10Access() gates
//   the Withdrawals page on. This is never satisfied by
//   accounts.modules_unlocked (the timing override) or by the module
//   merely becoming available -- only an actual "Mark as Watched" write
//   (POST /api/modules/10/complete) sets completed_at.
//
//   TIMESTAMP ORDERING: <= semantics throughout (an event at the exact
//   refund timestamp counts as having happened before/at the refund),
//   per spec Part 17.
//
//   OVERLAP: unlocked-before-refund and watched-before-refund are
//   deliberately NOT mutually exclusive -- a customer who watched Module
//   10 (which per the module engine can only happen after it unlocked)
//   and later refunded is counted in BOTH numerators. This function never
//   subtracts one from the other.
//
// Denominators (Part 6): "ever unlocked" / "ever watched" are evaluated
// against ALL customers (not just refunded ones) using nowMs -- i.e.
// "has Module 10's schedule timestamp already passed as of right now"
// and "does a completed_at row exist for module_key=10 at all,"
// respectively. These are DIFFERENT questions from the refund-timing
// numerators above (which ask "was it unlocked/watched by the moment of
// THIS refund," a per-account historical timestamp comparison) -- the
// two must never be confused, per spec Part 6 ("keep these
// denominator-based rates separate from '% of refunds'").
import { MODULE_UNLOCK_HOURS } from "./mockData";

const MODULE_10_KEY = 10;
const HOUR_MS_M10 = 60 * 60 * 1000;

export function computeModule10RefundAnalytics(db, nowMs = Date.now()) {
  const module10Hours = MODULE_UNLOCK_HOURS[MODULE_10_KEY];

  const refunds = db
    .prepare(
      `SELECT id, first_login_at, disabled_at
       FROM accounts
       WHERE role = 'customer' AND disable_reason = 'jvzoo_refund' AND disabled_at IS NOT NULL`
    )
    .all();

  const totalRefunds = refunds.length;

  const completionStmt = db.prepare(
    `SELECT completed_at FROM account_module_progress WHERE account_id = ? AND module_key = ?`
  );

  let unlockedBeforeRefund = 0;
  let watchedBeforeRefund = 0;

  for (const r of refunds) {
    const refundMs = new Date(r.disabled_at).getTime();

    // Unlocked-before-refund: requires a known first_login_at (the ONLY
    // input to the unlock schedule -- see moduleEngine.js). Missing
    // first_login_at means the unlock timestamp cannot be determined and
    // this refund is correctly excluded (never guessed).
    if (r.first_login_at != null && module10Hours != null) {
      const firstLoginMs = new Date(r.first_login_at).getTime();
      if (Number.isFinite(firstLoginMs)) {
        const unlockAtMs = firstLoginMs + module10Hours * HOUR_MS_M10;
        if (unlockAtMs <= refundMs) unlockedBeforeRefund++;
      }
    }

    // Watched-before-refund: requires the REAL persisted completion
    // timestamp <= the refund timestamp. A completion recorded AFTER the
    // refund (or no completion at all) never counts, per spec Part 17.
    const progressRow = completionStmt.get(r.id, MODULE_10_KEY);
    if (progressRow?.completed_at) {
      const completedMs = new Date(progressRow.completed_at).getTime();
      if (Number.isFinite(completedMs) && completedMs <= refundMs) {
        watchedBeforeRefund++;
      }
    }
  }

  // Denominators (Part 6/Part 3-audit-fix): "ever unlocked" / "ever
  // watched" evaluated against ALL customers -- but a DISABLED account
  // (any disable_reason) must have its eligibility FROZEN at its own
  // disabled_at, never evaluated against the current nowMs. Reason: once
  // an account is disabled, sessions are revoked (see
  // lib/accountDisable.js#disableAccount()) and account_module_progress
  // can never advance further for that account -- so "did Module 10 ever
  // become unlocked while this account could still act on it" is a
  // question that must be answered as of the disable moment, not as of
  // however much wall-clock time has since passed. Evaluating a disabled
  // account against nowMs instead would let mere time passage
  // retroactively promote a customer who was refunded BEFORE their
  // Module 10 unlock time into the "ever unlocked" cohort -- this was
  // confirmed as a real discrepancy in production data (a naive
  // now-based count matched 12 refunded accounts against a schedule
  // check, vs only 4 that were ACTUALLY unlocked before their own refund
  // -- the other 8 refunded before unlocking and only "caught up" to the
  // schedule numerically because so much time has since elapsed). Active
  // (non-disabled) accounts have no disable event to freeze at, so they
  // correctly continue to use nowMs.
  const allCustomers = db
    .prepare(
      `SELECT id, first_login_at, account_status, disabled_at FROM accounts WHERE role = 'customer'`
    )
    .all();
  let everUnlockedCount = 0;
  if (module10Hours != null) {
    for (const c of allCustomers) {
      if (c.first_login_at == null) continue;
      const firstLoginMs = new Date(c.first_login_at).getTime();
      if (!Number.isFinite(firstLoginMs)) continue;
      const unlockAtMs = firstLoginMs + module10Hours * HOUR_MS_M10;
      const evalMs =
        c.account_status === "disabled" && c.disabled_at
          ? new Date(c.disabled_at).getTime()
          : nowMs;
      if (Number.isFinite(evalMs) && unlockAtMs <= evalMs) everUnlockedCount++;
    }
  }

  const everWatchedCount = db
    .prepare(
      `SELECT COUNT(*) AS c FROM account_module_progress WHERE module_key = ? AND completed_at IS NOT NULL`
    )
    .get(MODULE_10_KEY).c;

  function pct(numerator, denominator) {
    if (!denominator) return 0;
    return Math.round((numerator / denominator) * 1000) / 10;
  }

  return {
    totalRefunds,
    unlockedBeforeRefund,
    unlockedBeforeRefundPct: pct(unlockedBeforeRefund, totalRefunds),
    watchedBeforeRefund,
    watchedBeforeRefundPct: pct(watchedBeforeRefund, totalRefunds),
    everUnlockedCount,
    everWatchedCount,
    // Reliable denominator-based rates only when the denominator is > 0
    // (avoids a misleading 0% when nobody has unlocked/watched at all).
    refundRateAmongUnlocked: everUnlockedCount > 0 ? pct(unlockedBeforeRefund, everUnlockedCount) : null,
    refundRateAmongWatched: everWatchedCount > 0 ? pct(watchedBeforeRefund, everWatchedCount) : null,
  };
}

export function computeIspApprovalConversion(db) {
  const rows = db
    .prepare(
      `SELECT isp_approval_source, isp_activation_source, isp_status,
              user_authorized_at, node_connected_at
       FROM accounts
       WHERE role = 'customer' AND isp_approved_at IS NOT NULL`
    )
    .all();

  const all = emptyConversionBucket();
  const manual = emptyConversionBucket();
  const automatic = emptyConversionBucket();
  const unknownSourceApproval = emptyConversionBucket();

  for (const row of rows) {
    const { approvalSource, activationBucket } = classifyApprovalRow(row);
    const bucketFor = (b) => {
      b.approved += 1;
      if (activationBucket === "customer_returned") b.customerReturned += 1;
      else if (activationBucket === "admin_completed") b.adminCompleted += 1;
      else if (activationBucket === "live_unknown_source") b.liveUnknownSource += 1;
      else b.notLive += 1;
    };
    bucketFor(all);
    if (approvalSource === "manual") bucketFor(manual);
    else if (approvalSource === "automatic") bucketFor(automatic);
    else bucketFor(unknownSourceApproval);
  }

  return {
    all: finalizeConversionBucket(all),
    manual: finalizeConversionBucket(manual),
    automatic: finalizeConversionBucket(automatic),
    unknownApprovalSource: finalizeConversionBucket(unknownSourceApproval),
  };
}
