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
