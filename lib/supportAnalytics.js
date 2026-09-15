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
export function computeDisabledFunnel(db, range = null, totalMembers = 0) {
  // TASK 2/COHORT RULE: `range`, when provided, filters the DISABLED
  // cohort by its OWN canonical anchor timestamp -- disabled_at (the
  // moment lib/accountDisable.js#disableAccount() actually fired) --
  // never by created_at or any other column. range === null preserves
  // the historical all-time behavior (used by no current caller, kept
  // for safety/future reuse).
  const rangeSql = range ? `AND disabled_at >= ? AND disabled_at < ?` : "";
  const rangeParams = range ? [new Date(range.startMs).toISOString(), new Date(range.endMs).toISOString()] : [];

  const rows = db
    .prepare(
      `SELECT disable_stage_snapshot AS stage, COUNT(*) AS c
       FROM accounts
       WHERE role = 'customer' AND account_status = 'disabled' ${rangeSql}
       GROUP BY disable_stage_snapshot`
    )
    .all(...rangeParams);

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
       WHERE role = 'customer' AND account_status = 'disabled' ${rangeSql}
       GROUP BY disable_reason`
    )
    .all(...rangeParams);
  const reasonCounts = { manual_admin: 0, jvzoo_refund: 0, unknown: 0 };
  for (const row of reasonRows) {
    const key = row.reason && reasonCounts.hasOwnProperty(row.reason) ? row.reason : "unknown";
    reasonCounts[key] += row.c;
  }

  // TASK 3 fix: the top-level "Disabled Users" percentage must be
  // disabledUsers / totalMembers * 100 -- using the SAME totalMembers
  // count (for the SAME selected range) as every other top-level stat
  // on the Analytics page, NEVER totalDisabled (which would answer a
  // different question: "of disabled users, what % are in each stage").
  // `totalMembers` is passed in by the caller (the analytics route
  // already computes totalMembers once for the whole payload) so this
  // function never re-derives its own, possibly-inconsistent, count.
  // totalMembers === 0 returns 0 rather than dividing by zero.
  const disabledPctOfTotalMembers = totalMembers
    ? Math.round((totalDisabled / totalMembers) * 10000) / 100 // 2 decimals
    : 0;

  return {
    totalDisabled,
    disabledPctOfTotalMembers,
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

export function computeModule10RefundAnalytics(db, nowMs = Date.now(), range = null) {
  const module10Hours = MODULE_UNLOCK_HOURS[MODULE_10_KEY];

  // TASK 2: Module 10 Refunds is anchored to disabled_at (the refund
  // disable event itself) for the SELECTED range, per spec -- range
  // filters WHICH refunds are counted at all, not merely a display
  // window.
  const rangeSql = range ? `AND disabled_at >= ? AND disabled_at < ?` : "";
  const rangeParams = range ? [new Date(range.startMs).toISOString(), new Date(range.endMs).toISOString()] : [];

  const refunds = db
    .prepare(
      `SELECT id, first_login_at, disabled_at
       FROM accounts
       WHERE role = 'customer' AND disable_reason = 'jvzoo_refund' AND disabled_at IS NOT NULL ${rangeSql}`
    )
    .all(...rangeParams);

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

export function computeIspApprovalConversion(db, range = null) {
  // TASK 2: ISP Approval Conversion is anchored to isp_approved_at
  // within the selected range, per spec -- range filters WHICH approved
  // customers are counted at all (the "Total ISP Approved" denominator
  // itself moves with the selected range), not merely a display window.
  const rangeSql = range ? `AND isp_approved_at >= ? AND isp_approved_at < ?` : "";
  const rangeParams = range ? [new Date(range.startMs).toISOString(), new Date(range.endMs).toISOString()] : [];

  const rows = db
    .prepare(
      `SELECT isp_approval_source, isp_activation_source, isp_status,
              user_authorized_at, node_connected_at
       FROM accounts
       WHERE role = 'customer' AND isp_approved_at IS NOT NULL ${rangeSql}`
    )
    .all(...rangeParams);

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

// ---- TASK 4: Post-ISP login retention analytics -------------------------
//
// COHORT RULE (documented once here, applies throughout this file): a
// cohort's membership is determined ENTIRELY by its own canonical
// starting event falling inside the selected range -- here, that event
// is isp_submitted_at (confirmed authoritative for "ISP setup
// submission" in lib/db.js's own column comment: "set only by POST
// /api/isp/submit on genuine customer submission"). Once an account is
// IN the cohort, its FOLLOW-UP events (a Day-2/Day-3 return login) are
// evaluated on their own merits even if they fall AFTER the selected
// range's end boundary -- e.g. a customer who submitted ISP setup on
// the last day of a 7-day range and returns to log in 2 days later
// (which is after the range ends) still correctly counts as a Day-2
// return for that cohort. This is deliberate and matches how retention/
// cohort analysis is conventionally done elsewhere (e.g. "day-7
// retention for this week's signups" always looks 7 days past each
// day's own cohort, not truncated at the reporting window's edge).
//
// LOGIN SOURCE: login_events ONLY (see lib/db.js) -- deliberately NEVER
// falls back to accounts.first_login_at/last_login_at for a cohort
// member, even though those columns might independently suggest a
// login happened. Reason: first_login_at only ever records the VERY
// FIRST login ever (useless for "did they return after ISP setup,
// which usually happens well after the first login"), and
// last_login_at is overwritten on every login so it can only ever
// prove the MOST RECENT login, not whether one occurred within a
// specific historical 24h window. login_events is the only source that
// can honestly answer "give me every discrete login timestamp for this
// account" -- if it has zero rows for an account in the needed window,
// this correctly reports no return for that account (a true historical
// limitation, since this table only starts recording from its own
// migration date -- see historicalLimitationNote below -- not a bug).
export function computeIspRetention(db, range) {
  const rangeSql = range ? `AND isp_submitted_at >= ? AND isp_submitted_at < ?` : "";
  const rangeParams = range
    ? [new Date(range.startMs).toISOString(), new Date(range.endMs).toISOString()]
    : [];

  const cohort = db
    .prepare(
      `SELECT id, isp_submitted_at
       FROM accounts
       WHERE role = 'customer' AND isp_submitted_at IS NOT NULL ${rangeSql}`
    )
    .all(...rangeParams);

  const totalIspSetups = cohort.length;

  const returnedAfterStmt = db.prepare(
    `SELECT 1 FROM login_events WHERE account_id = ? AND logged_in_at > ? LIMIT 1`
  );

  let returnedAfterIspCount = 0;

  const HOUR_MS = 60 * 60 * 1000;

  for (const c of cohort) {
    if (returnedAfterStmt.get(c.id, c.isp_submitted_at)) {
      returnedAfterIspCount += 1;
    }
  }

  // day2Return = at least one login in [submitted+24h, submitted+48h);
  // day3Return = at least one login in [submitted+48h, submitted+72h).
  // Exact half-open window semantics per spec, via a single >= start
  // AND < end parameterized statement.
  const windowStmt = db.prepare(
    `SELECT 1 FROM login_events
     WHERE account_id = ? AND logged_in_at >= ? AND logged_in_at < ? LIMIT 1`
  );
  let day2Count = 0;
  let day3Count = 0;
  for (const c of cohort) {
    const submittedMs = new Date(c.isp_submitted_at).getTime();
    if (!Number.isFinite(submittedMs)) continue;
    const day2StartIso = new Date(submittedMs + 24 * HOUR_MS).toISOString();
    const day2EndIso = new Date(submittedMs + 48 * HOUR_MS).toISOString();
    const day3StartIso = new Date(submittedMs + 48 * HOUR_MS).toISOString();
    const day3EndIso = new Date(submittedMs + 72 * HOUR_MS).toISOString();
    if (windowStmt.get(c.id, day2StartIso, day2EndIso)) day2Count += 1;
    if (windowStmt.get(c.id, day3StartIso, day3EndIso)) day3Count += 1;
  }

  function pct(n) {
    if (!totalIspSetups) return 0;
    return Math.round((n / totalIspSetups) * 1000) / 10;
  }

  return {
    totalIspSetups,
    returnedAfterIsp: { count: returnedAfterIspCount, pct: pct(returnedAfterIspCount) },
    day2Return: { count: day2Count, pct: pct(day2Count) },
    day3Return: { count: day3Count, pct: pct(day3Count) },
    historicalLimitationNote:
      "Retention is measured ONLY from the login_events table, which began recording on the date this feature was deployed and has NO backfilled historical login data. ISP setups that happened before that deployment date will show artificially low or zero returns for this metric even if the customer genuinely did log back in, because their historical logins were never captured as discrete, timestamped events -- only accounts.last_login_at (a single overwritten value) existed for them at the time, which cannot answer 'did a login happen inside this specific 24-48h/48-72h window.' Retention figures become fully reliable only for ISP setups that occurred after login_events went live.",
  };
}

// ---- TASK 5: Automated Support Messages analytics ------------------------
//
// Authoritative list of the 3 real automations currently wired into
// lib/supportAutomation.js (verified by reading that file at HEAD --
// see its own header comments for each one's exact trigger/timing):
//   - WAITLIST_SELECTION_EVENT_PREFIX = 'waitlist_selection:'
//       ~48h after a customer's waitlist join.
//   - ISP_CONFIRMATION_REMINDER_EVENT_PREFIX = 'isp_confirmation_reminder:'
//       ~15min after the customer's OWN final ISP Confirmation.
//   - NON_WAITLIST_4DAY_EVENT_PREFIX = 'non_waitlist_4day_followup:'
//       4 days after signup, only if the customer never joined the
//       waitlist.
// These three event_key PREFIXES are how every row in
// scheduled_support_messages is unambiguously attributed to exactly one
// automation -- event_key is always `${PREFIX}${accountId}`, so a
// prefix match is exact and can never mis-attribute a row.
import {
  WAITLIST_SELECTION_EVENT_PREFIX,
  ISP_CONFIRMATION_REMINDER_EVENT_PREFIX,
  NON_WAITLIST_4DAY_EVENT_PREFIX,
} from "./supportAutomation";

const AUTOMATION_DEFS = [
  { key: "waitlist_selection", name: "Waitlist Selection", prefix: WAITLIST_SELECTION_EVENT_PREFIX },
  {
    key: "isp_confirmation_reminder",
    name: "ISP Confirmation Reminder",
    prefix: ISP_CONFIRMATION_REMINDER_EVENT_PREFIX,
  },
  { key: "non_waitlist_4day", name: "Non-Waitlist 4-Day Follow-up", prefix: NON_WAITLIST_4DAY_EVENT_PREFIX },
];

const REPLY_ATTRIBUTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Computes Sent / Replied / Reply Rate for EACH of the 3 automations
// SEPARATELY (never combined into one row), filtered by delivered_at
// (the sent timestamp) within `range` -- per TASK 5/TASK 2's shared
// cohort-range principle, the cohort (which sends count) is fixed by
// its own canonical anchor (delivered_at, i.e. "sent" time) falling in
// range; a reply may legitimately land AFTER the range's end boundary
// as long as it is still within that send's own 7-day (or
// next-automated-send, whichever is sooner) attribution window.
//
// Sent = distinct scheduled_support_messages rows for this automation's
// event_key prefix, delivered_at IS NOT NULL, delivered_at within
// range. cancelled_at IS NOT NULL rows are excluded from "Sent" by
// construction (a cancelled row can never also have delivered_at set --
// see lib/supportAutomation.js's atomic claim/cancel guards, which are
// mutually exclusive `WHERE delivered_at IS NULL` conditions), but the
// filter is also stated explicitly below for defense-in-depth/clarity.
//
// Replied = EXISTS at least one support_messages row with
// sender_role='customer' AND created_at > this send's delivered_at AND
// created_at < the EARLIER OF (a) this SAME account's NEXT automated
// send's delivered_at across ANY of the 3 automations, or (b)
// delivered_at + 7 days. Each send contributes at most 1 to the
// Replied count (EXISTS, not COUNT, so a customer sending 5 messages in
// the window still counts as exactly 1 reply for that one send).
export function computeAutomatedMessageAnalytics(db, range) {
  const rangeStartIso = range ? new Date(range.startMs).toISOString() : null;
  const rangeEndIso = range ? new Date(range.endMs).toISOString() : null;

  // Every delivered automated send for ANY of the 3 automations,
  // ordered per-account by delivered_at -- needed so each send can find
  // "this same account's NEXT automated send" regardless of WHICH of
  // the 3 automations that next send belongs to.
  const allPrefixesLike = AUTOMATION_DEFS.map((d) => `event_key LIKE ?`).join(" OR ");
  const allDeliveredSends = db
    .prepare(
      `SELECT account_id, event_key, delivered_at
       FROM scheduled_support_messages
       WHERE delivered_at IS NOT NULL AND cancelled_at IS NULL AND (${allPrefixesLike})
       ORDER BY account_id ASC, delivered_at ASC`
    )
    .all(...AUTOMATION_DEFS.map((d) => `${d.prefix}%`));

  // Map: account_id -> sorted array of delivered_at ISO strings (for
  // finding "this account's next automated send after X").
  const sendsByAccount = new Map();
  for (const row of allDeliveredSends) {
    if (!sendsByAccount.has(row.account_id)) sendsByAccount.set(row.account_id, []);
    sendsByAccount.get(row.account_id).push(row.delivered_at);
  }

  const replyExistsStmt = db.prepare(
    `SELECT 1 FROM support_messages
     WHERE conversation_id = (SELECT id FROM conversations WHERE account_id = ?)
       AND sender_role = 'customer'
       AND created_at > ?
       AND created_at < ?
     LIMIT 1`
  );

  const results = [];
  for (const def of AUTOMATION_DEFS) {
    const rangeSql = range ? `AND delivered_at >= ? AND delivered_at < ?` : "";
    const rangeParams = range ? [rangeStartIso, rangeEndIso] : [];
    const sentRows = db
      .prepare(
        `SELECT account_id, delivered_at
         FROM scheduled_support_messages
         WHERE event_key LIKE ? AND delivered_at IS NOT NULL AND cancelled_at IS NULL ${rangeSql}`
      )
      .all(`${def.prefix}%`, ...rangeParams);

    const sent = sentRows.length;
    let replied = 0;

    for (const row of sentRows) {
      const deliveredMs = new Date(row.delivered_at).getTime();
      if (!Number.isFinite(deliveredMs)) continue;

      // Find this account's next automated send (any of the 3
      // automations) strictly after THIS send's delivered_at.
      const accountSends = sendsByAccount.get(row.account_id) || [];
      let nextSendIso = null;
      for (const iso of accountSends) {
        if (iso > row.delivered_at) {
          nextSendIso = iso;
          break; // accountSends is sorted ascending -- first match is the soonest
        }
      }
      const sevenDayEndIso = new Date(deliveredMs + REPLY_ATTRIBUTION_WINDOW_MS).toISOString();
      const windowEndIso =
        nextSendIso && nextSendIso < sevenDayEndIso ? nextSendIso : sevenDayEndIso;

      if (replyExistsStmt.get(row.account_id, row.delivered_at, windowEndIso)) {
        replied += 1;
      }
    }

    const replyRatePct = sent > 0 ? Math.round((replied / sent) * 1000) / 10 : 0;
    results.push({
      automationKey: def.key,
      automationName: def.name,
      sent,
      replied,
      replyRatePct,
    });
  }

  return results;
}
