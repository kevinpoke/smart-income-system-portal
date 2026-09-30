import { generateId } from "./auth-crypto";
import { getOrCreateConversation, postMessageInner } from "./supportEngine";
import { listAutomationDefinitions, getAutomationConditions } from "./automationDefinitions";
import {
  WAITLIST_SELECTION_EVENT_PREFIX,
  ISP_CONFIRMATION_REMINDER_EVENT_PREFIX,
  GOLDEN_BRIDGE_FOLLOWUP_EVENT_PREFIX,
  NON_WAITLIST_4DAY_EVENT_PREFIX,
} from "./supportAutomation";

// AI-SALES batch: generic trigger evaluator for automations CREATED/
// CONFIGURED via the AI Sales UI. The 4 MIGRATED legacy automations
// (waitlist_selection, isp_confirmation_reminder, golden_bridge_followup,
// non_waitlist_4day) keep their own dedicated, call-site-triggered send
// functions in lib/supportAutomation.js -- those already read message/
// delay/enabled live from automation_definitions, so admin edits apply,
// but their TRIGGER WIRING is intentionally left on the existing proven
// call sites rather than re-routed through this generic path (never BOTH
// an old sender and new sender firing the same automation). This
// evaluator therefore explicitly SKIPS those 4 keys and only processes
// any OTHER (admin-created) automation_definitions row -- even though
// the legacy 4 now also have condition rows/message codes (for display
// and MESSAGE_READ source selection), those rows are never read as a
// SEND trigger for the legacy keys themselves here.
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
// trigger type has at most one occurrence per account by construction
// (a single authoritative timestamp column).
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

// Resolves every occurrence of ONE condition, independent of ALL/ANY
// combination logic (that happens one level up). Reuses the exact same
// authoritative signals the pre-multi-trigger evaluator used.
function resolveConditionOccurrences(db, condition) {
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

// ---- ALL / ANY combination -------------------------------------------

// ALL: every condition must have at least one occurrence for the same
// account. Uses each condition's EARLIEST occurrence per account (a
// condition, once satisfied, stays satisfied) and the combined
// eligibility timestamp is the MAX of those earliest-per-condition
// timestamps (i.e. the moment the LAST required condition first became
// true). The combined eventKey is built deterministically from the
// exact chosen occurrence keys (stable across reruns, never
// time-of-evaluation-derived) so re-running the evaluator can never
// produce a different identity for the same underlying satisfied set.
function computeAllCandidates(automationKey, conditions, perCondition) {
  const earliestByCondition = perCondition.map((occs) => {
    const map = new Map();
    for (const occ of occs) {
      const existing = map.get(occ.accountId);
      if (!existing || occ.occurredAtMs < existing.occurredAtMs) map.set(occ.accountId, occ);
    }
    return map;
  });

  const [firstMap, ...restMaps] = earliestByCondition;
  const candidates = [];
  for (const [accountId, firstOcc] of firstMap) {
    const chosen = [firstOcc];
    let satisfiesAll = true;
    for (const map of restMaps) {
      const occ = map.get(accountId);
      if (!occ) {
        satisfiesAll = false;
        break;
      }
      chosen.push(occ);
    }
    if (!satisfiesAll) continue;
    const occurredAtMs = Math.max(...chosen.map((o) => o.occurredAtMs));
    const eventKey = `all:${automationKey}:` + chosen.map((o, i) => `${i}:${o.eventKey}`).join("|");
    candidates.push({ accountId, eventKey, occurredAtMs });
  }
  return candidates;
}

// ANY: any single condition occurrence may qualify. Non-repeatable
// condition types (at most one occurrence per account) are collapsed
// into ONE shared, account-stable eligibility per account -- using the
// EARLIEST-firing condition's timestamp -- so whichever non-repeatable
// condition satisfies FIRST wins, and any other non-repeatable
// condition later satisfying for the same account maps to the exact
// SAME eventKey (already-sent, no duplicate). Repeatable condition
// types keep every one of their own distinct occurrences independently
// eligible (their own natural, stable per-occurrence eventKey), exactly
// matching their existing single-trigger repeatable semantics.
function computeAnyCandidates(automationKey, conditions, perCondition) {
  const candidates = [];
  const nonRepeatableEarliest = new Map(); // accountId -> occurrence

  conditions.forEach((cond, i) => {
    const occs = perCondition[i];
    if (REPEATABLE_TRIGGER_TYPES.has(cond.triggerType)) {
      for (const occ of occs) candidates.push(occ);
    } else {
      for (const occ of occs) {
        const existing = nonRepeatableEarliest.get(occ.accountId);
        if (!existing || occ.occurredAtMs < existing.occurredAtMs) {
          nonRepeatableEarliest.set(occ.accountId, occ);
        }
      }
    }
  });

  for (const [accountId, occ] of nonRepeatableEarliest) {
    candidates.push({
      accountId,
      eventKey: `any:${automationKey}:${accountId}:nonrepeatable`,
      occurredAtMs: occ.occurredAtMs,
    });
  }
  return candidates;
}

// Resolves the full candidate list for one automation definition,
// combining its condition(s) per its trigger_match_mode. For exactly
// ONE condition, ALL and ANY are behaviorally identical BY DESIGN (per
// spec) -- every occurrence of that single condition passes through
// unchanged, using its own natural eventKey, so a single repeatable
// condition (e.g. just EACH_LOGIN) still fires once per distinct login
// regardless of which mode is selected.
function computeCandidatesForDefinition(db, def) {
  const conditions = getAutomationConditions(db, def.key);
  if (conditions.length === 0) return [];
  const perCondition = conditions.map((c) => resolveConditionOccurrences(db, c));

  if (conditions.length === 1) {
    return perCondition[0].map((occ) => ({
      accountId: occ.accountId,
      eventKey: occ.eventKey,
      occurredAtMs: occ.occurredAtMs,
    }));
  }

  const matchMode = def.trigger_match_mode || "all";
  return matchMode === "any"
    ? computeAnyCandidates(def.key, conditions, perCondition)
    : computeAllCandidates(def.key, conditions, perCondition);
}

// Runs one evaluation pass over every non-legacy, enabled automation.
// Reuses the existing scheduler's call convention (plain function, no
// timers of its own) -- invoked from lib/backgroundScheduler.js's
// existing tick, never a new cron/container.
export function runGenericAutomationEvaluator(db) {
  const defs = listAutomationDefinitions(db).filter(
    (d) => d.enabled && !LEGACY_MANAGED_KEYS.has(d.key)
  );
  let sentCount = 0;
  const now = Date.now();

  for (const def of defs) {
    const delayMs = def.delay_hours * 60 * 60 * 1000;
    const candidates = computeCandidatesForDefinition(db, def);
    for (const c of candidates) {
      if (!Number.isFinite(c.occurredAtMs)) continue;
      if (now < c.occurredAtMs + delayMs) continue;
      const result = sendGenericAutomation(db, {
        automationKey: def.key,
        accountId: c.accountId,
        triggerEventKey: c.eventKey,
        body: def.message_body,
      });
      if (result.sent) sentCount += 1;
    }
  }

  return { sent: sentCount };
}
