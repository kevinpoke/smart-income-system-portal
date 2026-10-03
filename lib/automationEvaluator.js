import { generateId } from "./auth-crypto";
import { getOrCreateConversation, postMessageInner } from "./supportEngine";
import { listAutomationDefinitions, getAutomationConditions, STATE_TRIGGER_TYPES } from "./automationDefinitions";
import { computeWaitlistStatus } from "./waitlistEngine";
import {
  computeAnchorCandidates,
  recheckRuleTreeAtSendTime,
  buildLegacyRuleTree,
} from "./ruleTree";
import {
  WAITLIST_SELECTION_EVENT_PREFIX,
  ISP_CONFIRMATION_REMINDER_EVENT_PREFIX,
  GOLDEN_BRIDGE_FOLLOWUP_EVENT_PREFIX,
  NON_WAITLIST_4DAY_EVENT_PREFIX,
} from "./supportAutomation";

// AI-SALES batch (extended by RULE-BUILDER + SECOND-LEVEL-TIMING batch):
// generic trigger evaluator for automations CREATED/CONFIGURED via the AI
// Sales UI. The 4 MIGRATED legacy automations (waitlist_selection,
// isp_confirmation_reminder, golden_bridge_followup, non_waitlist_4day)
// keep their own dedicated, call-site-triggered send functions in
// lib/supportAutomation.js -- those already read message/delay/enabled
// live from automation_definitions, so admin edits apply, but their
// TRIGGER WIRING is intentionally left on the existing proven call sites
// rather than re-routed through this generic path (never BOTH an old
// sender and new sender firing the same automation). This evaluator
// therefore explicitly SKIPS those 4 keys and only processes any OTHER
// (admin-created) automation_definitions row.
//
// AUTHORITATIVE TRUTH as of this batch: rule_tree_json + delay_seconds.
// trigger_match_mode/delay_hours are legacy/compat columns only, read
// here ONLY as a defensive fallback for a row that somehow still has a
// NULL rule_tree_json (should not happen post-migration --
// migrateLegacyRuleTrees() in lib/automationDefinitions.js runs on every
// boot -- but a generic automation can never silently stop evaluating
// just because that migration hasn't run yet in some edge case).
const LEGACY_MANAGED_KEYS = new Set([
  "waitlist_selection",
  "isp_confirmation_reminder",
  "golden_bridge_followup",
  "non_waitlist_4day",
]);

// Trigger types that can legitimately produce MULTIPLE distinct
// occurrences per account, each independently eligible (never collapsed
// to "first one only"): repeated logins, repeated tag add/remove/re-add,
// and repeated reads of distinct source message instances. Every other
// EVENT trigger type has at most one occurrence per account by
// construction (a single authoritative timestamp column). STATE trigger
// types (DID_NOT_JOIN_WAITLIST) have no occurrence concept at all.
const REPEATABLE_TRIGGER_TYPES = new Set(["EACH_LOGIN", "SUPPORT_TAG_ADDED", "MESSAGE_READ"]);

// Legacy automation key -> its scheduled_support_messages event_key
// prefix, needed so MESSAGE_READ can find a legacy automation's sent
// rows (legacy sends live in scheduled_support_messages, not
// automation_sends). Kept in sync with lib/supportAutomation.js's own
// exported prefix constants -- never redefined/duplicated as literals.
const LEGACY_EVENT_PREFIX_BY_KEY = {
  waitlist_selection: WAITLIST_SELECTION_EVENT_PREFIX,
  isp_confirmation_reminder: ISP_CONFIRMATION_REMINDER_EVENT_PREFIX,
  golden_bridge_followup: GOLDEN_BRIDGE_FOLLOWUP_EVENT_PREFIX,
  non_waitlist_4day: NON_WAITLIST_4DAY_EVENT_PREFIX,
};

function sendGenericAutomation(db, { automationKey, accountId, triggerEventKey, body }) {
  db.exec("BEGIN");
  try {
    const sendId = generateId("autosend");
    let insertResult;
    try {
      insertResult = db
        .prepare(
          `INSERT INTO automation_sends (id, automation_key, account_id, trigger_event_key, sent_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(sendId, automationKey, accountId, triggerEventKey, new Date().toISOString());
    } catch (err) {
      if (String(err?.message || "").includes("UNIQUE")) {
        db.exec("ROLLBACK");
        return { sent: false, reason: "already_sent" };
      }
      throw err;
    }
    if (insertResult.changes === 0) {
      db.exec("ROLLBACK");
      return { sent: false, reason: "already_sent" };
    }
    const conversation = getOrCreateConversation(db, accountId);
    const posted = postMessageInner(db, {
      conversationId: conversation.id,
      senderRole: "admin",
      senderAccountId: null,
      body,
    });
    // Link this send occurrence to the EXACT support_messages row just
    // created -- required so a downstream MESSAGE_READ trigger can key
    // off this specific sent instance's own customer_read_at, never a
    // guess based on account+timestamp. Both writes commit atomically
    // together below, so a mid-crash can never leave the send row
    // pointing at nothing / a message row unlinked from its send.
    db.prepare(`UPDATE automation_sends SET support_message_id = ? WHERE id = ?`).run(posted.id, sendId);
    db.exec("COMMIT");
    return { sent: true };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ---- MESSAGE_READ resolver ------------------------------------------
//
// Finds every DELIVERED, LINKED sent instance of `sourceAutomationKey`
// (generic via automation_sends.support_message_id, or legacy via
// scheduled_support_messages.support_message_id) whose linked
// support_messages row has a non-NULL customer_read_at -- the SAME
// authoritative "has the customer actually viewed this admin message"
// signal Support Chat's own read-receipt UI already uses (see
// lib/supportEngine.js#markAdminMessagesReadByCustomer). No new
// telemetry. Historical rows written before support_message_id existed
// (NULL) are intentionally excluded -- never guessed/backfilled.
function resolveMessageReadOccurrences(db, sourceAutomationKey) {
  if (!sourceAutomationKey) return [];
  let sentRows;
  const legacyPrefix = LEGACY_EVENT_PREFIX_BY_KEY[sourceAutomationKey];
  if (legacyPrefix) {
    sentRows = db
      .prepare(
        `SELECT account_id AS accountId, support_message_id AS supportMessageId
         FROM scheduled_support_messages
         WHERE event_key LIKE ? AND delivered_at IS NOT NULL AND cancelled_at IS NULL
           AND support_message_id IS NOT NULL`
      )
      .all(`${legacyPrefix}%`);
  } else {
    sentRows = db
      .prepare(
        `SELECT account_id AS accountId, support_message_id AS supportMessageId
         FROM automation_sends WHERE automation_key = ? AND support_message_id IS NOT NULL`
      )
      .all(sourceAutomationKey);
  }

  const occurrences = [];
  for (const row of sentRows) {
    const msg = db.prepare(`SELECT customer_read_at FROM support_messages WHERE id = ?`).get(row.supportMessageId);
    if (msg && msg.customer_read_at) {
      occurrences.push({
        accountId: row.accountId,
        // Includes the ACTUAL source sent-message instance id -- a
        // repeatable source (e.g. EACH_LOGIN) producing multiple
        // distinct messages stays distinguishable; opening the SAME
        // message repeatedly always maps to this SAME eventKey (stable,
        // since customer_read_at is set only once, ever) so it can
        // never re-qualify a second time.
        eventKey: `message-read:${sourceAutomationKey}:${row.supportMessageId}`,
        occurredAtMs: new Date(msg.customer_read_at).getTime(),
      });
    }
  }
  return occurrences;
}

// Resolves every occurrence of ONE EVENT condition, independent of the
// rule tree's boolean combination logic (that happens one level up via
// lib/ruleTree.js computeAnchorCandidates). Reuses the exact same
// authoritative signals the pre-rule-builder evaluator used.
function resolveEventOccurrences(db, condition) {
  const triggerConfig = condition.triggerConfig || {};

  switch (condition.triggerType) {
    case "JOIN_WAITLIST":
      return db
        .prepare(
          `SELECT id AS accountId, waitlist_joined_at AS triggerAt
           FROM accounts WHERE role = 'customer' AND waitlist_joined_at IS NOT NULL`
        )
        .all()
        .map((r) => ({ accountId: r.accountId, eventKey: r.accountId, occurredAtMs: new Date(r.triggerAt).getTime() }));

    case "WATCH_MODULE": {
      const moduleKey = Number(triggerConfig.module);
      if (!Number.isInteger(moduleKey)) return [];
      return db
        .prepare(
          `SELECT account_id AS accountId, completed_at AS triggerAt
           FROM account_module_progress WHERE module_key = ? AND completed_at IS NOT NULL`
        )
        .all(moduleKey)
        .map((r) => ({
          accountId: r.accountId,
          eventKey: `${r.accountId}:module${moduleKey}`,
          occurredAtMs: new Date(r.triggerAt).getTime(),
        }));
    }

    case "AFTER_ISP_SETUP":
      // Canonical ISP completion/activation event -- user_authorized_at,
      // set once by lib/ispEngine.js#completeIspAuthorization() regardless
      // of source (customer or admin).
      return db
        .prepare(
          `SELECT id AS accountId, user_authorized_at AS triggerAt
           FROM accounts WHERE role = 'customer' AND user_authorized_at IS NOT NULL`
        )
        .all()
        .map((r) => ({ accountId: r.accountId, eventKey: r.accountId, occurredAtMs: new Date(r.triggerAt).getTime() }));

    case "FIRST_LOGIN":
      return db
        .prepare(
          `SELECT id AS accountId, first_login_at AS triggerAt
           FROM accounts WHERE role = 'customer' AND first_login_at IS NOT NULL`
        )
        .all()
        .map((r) => ({ accountId: r.accountId, eventKey: r.accountId, occurredAtMs: new Date(r.triggerAt).getTime() }));

    case "EACH_LOGIN":
      // Idempotency key MUST be tied to the SPECIFIC login event
      // (login_events.id), not merely account, so every distinct login
      // can independently trigger a send.
      return db
        .prepare(
          `SELECT le.id AS eventId, le.account_id AS accountId, le.logged_in_at AS triggerAt
           FROM login_events le
           JOIN accounts a ON a.id = le.account_id
           WHERE a.role = 'customer'`
        )
        .all()
        .map((r) => ({ accountId: r.accountId, eventKey: r.eventId, occurredAtMs: new Date(r.triggerAt).getTime() }));

    case "SUPPORT_TAG_ADDED": {
      const tagName = (triggerConfig.tagName || "").trim();
      if (!tagName) return [];
      return db
        .prepare(
          `SELECT c.account_id AS accountId, ct.created_at AS triggerAt, ct.conversation_id AS conversationId, ct.tag_id AS tagId
           FROM conversation_tags ct
           JOIN support_tags t ON t.id = ct.tag_id
           JOIN conversations c ON c.id = ct.conversation_id
           WHERE t.name = ?`
        )
        .all(tagName)
        .map((r) => ({
          accountId: r.accountId,
          // Idempotency tied to the SPECIFIC tag-add event, not merely
          // account+tag, so re-adding the tag later (a distinct event)
          // is separately eligible.
          eventKey: `${r.conversationId}:${r.tagId}:${r.triggerAt}`,
          occurredAtMs: new Date(r.triggerAt).getTime(),
        }));
    }

    case "MESSAGE_READ":
      return resolveMessageReadOccurrences(db, triggerConfig.sourceAutomationKey);

    default:
      return [];
  }
}

// ---- STATE predicate resolution (current truth, no occurrence) ---------
//
// Returns boolean truth for ONE account against ONE state condition.
// DID_NOT_JOIN_WAITLIST reuses the EXACT SAME canonical waitlist
// membership logic the Bridges/waitlist UI already uses
// (lib/waitlistEngine.js#computeWaitlistStatus, which reads only
// accounts.waitlist_joined_at) -- never a second/divergent "has joined"
// definition, and never waitlist_submissions (a separate location-detail
// table, not membership truth -- see lib/waitlistEngine.js header note).
function resolveStatePredicate(db, condition, account) {
  switch (condition.triggerType) {
    case "DID_NOT_JOIN_WAITLIST":
      return computeWaitlistStatus(account).state !== "joined";
    default:
      return false;
  }
}

// Resolves the full candidate list (one entry per eligible send occasion)
// for one automation definition, using its rule_tree_json as the
// authoritative boolean expression. Falls back to deriving an equivalent
// tree from trigger_match_mode + conditions if rule_tree_json is somehow
// still NULL (defensive -- migrateLegacyRuleTrees() should have already
// populated every row by the time this runs).
function computeCandidatesForDefinition(db, def) {
  const conditions = getAutomationConditions(db, def.key);
  if (conditions.length === 0) return [];

  const ruleTree = def.rule_tree_json
    ? JSON.parse(def.rule_tree_json)
    : buildLegacyRuleTree(def.trigger_match_mode || "all", conditions.map((c) => c.id));

  // Build occurrencesByConditionId FOR EVENT CONDITIONS ONLY, grouped by
  // account, then run computeAnchorCandidates per account. STATE
  // conditions are deliberately NOT added to this map -- computeAnchorCandidates
  // treats a missing key as "state, no anchor contribution" (see lib/ruleTree.js).
  const occurrencesByConditionIdByAccount = new Map(); // accountId -> Map(conditionId -> occ[])

  for (const condition of conditions) {
    if (STATE_TRIGGER_TYPES.has(condition.triggerType)) continue; // no occurrence timeline
    const occs = resolveEventOccurrences(db, condition);
    const repeatable = REPEATABLE_TRIGGER_TYPES.has(condition.triggerType);
    for (const occ of occs) {
      if (!occurrencesByConditionIdByAccount.has(occ.accountId)) {
        occurrencesByConditionIdByAccount.set(occ.accountId, new Map());
      }
      const perCondition = occurrencesByConditionIdByAccount.get(occ.accountId);
      if (!perCondition.has(condition.id)) perCondition.set(condition.id, []);
      perCondition.get(condition.id).push({ eventKey: occ.eventKey, occurredAt: occ.occurredAtMs, repeatable });
    }
  }

  // Also ensure every account that has AT LEAST ONE occurrence of ANY
  // event condition in this rule is considered -- an account with zero
  // occurrences of a required AND-like condition correctly produces no
  // candidates (reduceAllLike's early-out in lib/ruleTree.js).
  const candidates = [];
  for (const [accountId, perConditionMap] of occurrencesByConditionIdByAccount) {
    const { candidates: accountCandidates } = computeAnchorCandidates(ruleTree, perConditionMap);
    for (const c of accountCandidates) {
      if (!Number.isFinite(c.anchorMs)) continue;
      // Deterministic event key from the ACTUAL selected occurrence keys
      // -- never Date.now()/random/tick time. Stable across reruns for
      // the same underlying satisfied occurrence set.
      const eventKey = `rule:${def.key}:` + c.keyParts.map((p) => p.eventKey).sort().join("|");
      candidates.push({ accountId, eventKey, occurredAtMs: c.anchorMs });
    }
  }
  return candidates;
}

// Immediately before sending, re-evaluates EVERY condition in the rule
// tree (event conditions as "has this specific occurrence still
// happened" -- trivially true, since an event occurrence is permanent --
// and STATE conditions freshly against current DB truth) and runs the
// full boolean tree. This is what makes DID_NOT_JOIN_WAITLIST (and any
// other state/negative predicate: DOES_NOT_HAVE, NONE_OF, NEITHER_NOR,
// BUT_NOT's excluded side) suppress a send if the user's state changed
// between eligibility and the delayed send time -- never a stale
// snapshot taken at anchor time.
function recheckAtSendTime(db, def, conditions, accountId) {
  const ruleTree = def.rule_tree_json
    ? JSON.parse(def.rule_tree_json)
    : buildLegacyRuleTree(def.trigger_match_mode || "all", conditions.map((c) => c.id));

  const account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
  if (!account) return false;

  const truthByConditionId = new Map();
  for (const condition of conditions) {
    if (STATE_TRIGGER_TYPES.has(condition.triggerType)) {
      truthByConditionId.set(condition.id, resolveStatePredicate(db, condition, account));
    } else {
      // EVENT conditions: once an occurrence has happened it is
      // permanent truth (a login, a module watch, a tag add are never
      // "un-happened") -- re-resolve occurrences and check at least one
      // exists for this account. Cheap re-check, no fabricated state.
      const occs = resolveEventOccurrences(db, condition).filter((o) => o.accountId === accountId);
      truthByConditionId.set(condition.id, occs.length > 0);
    }
  }
  return recheckRuleTreeAtSendTime(ruleTree, truthByConditionId);
}

// Runs one evaluation pass over every non-legacy, enabled automation.
// Called both from the recurring background-scheduler tick (durable
// recovery/reconciliation) AND from the nearest-due wake timer (see
// lib/automationWake.js) -- same function either way, fully idempotent.
// `now` is injectable for deterministic disposable-DB testing.
export function runGenericAutomationEvaluator(db, now = Date.now()) {
  const defs = listAutomationDefinitions(db).filter(
    (d) => d.enabled && !LEGACY_MANAGED_KEYS.has(d.key)
  );
  let sentCount = 0;
  let nextDueAtMs = null;

  for (const def of defs) {
    const delayMs = (def.delay_seconds != null ? def.delay_seconds : def.delay_hours * 3600) * 1000;
    const conditions = getAutomationConditions(db, def.key);
    const candidates = computeCandidatesForDefinition(db, def);
    for (const c of candidates) {
      const dueAtMs = c.occurredAtMs + delayMs;
      if (now < dueAtMs) {
        if (nextDueAtMs === null || dueAtMs < nextDueAtMs) nextDueAtMs = dueAtMs;
        continue;
      }
      // Due now -- recheck state/negative predicates immediately before
      // sending (see recheckAtSendTime header comment). A suppressed
      // send here is NOT retried later for the same occurrence -- the
      // underlying event occurrence is permanent, but once its state
      // gate fails at a due check, re-running the evaluator again still
      // re-checks the SAME current state, so if the user re-un-joins
      // (impossible for waitlist, but general principle) it could still
      // send later; this is intentional per spec ("re-evaluate state
      // immediately before send", not "snapshot the rejection").
      if (!recheckAtSendTime(db, def, conditions, c.accountId)) {
        continue; // suppressed -- state changed since anchor, e.g. user joined waitlist
      }
      const result = sendGenericAutomation(db, {
        automationKey: def.key,
        accountId: c.accountId,
        triggerEventKey: c.eventKey,
        body: def.message_body,
      });
      if (result.sent) sentCount += 1;
    }
  }

  return { sent: sentCount, nextDueAtMs };
}
