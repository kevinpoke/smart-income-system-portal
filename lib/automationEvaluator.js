import { generateId } from "./auth-crypto";
import { getOrCreateConversation, postMessageInner } from "./supportEngine";
import { listAutomationDefinitions } from "./automationDefinitions";

// AI-SALES batch: generic trigger evaluator for automations CREATED/
// CONFIGURED via the AI Sales UI. The 4 MIGRATED legacy automations
// (waitlist_selection, isp_confirmation_reminder, golden_bridge_followup,
// non_waitlist_4day) keep their own dedicated, call-site-triggered send
// functions in lib/supportAutomation.js -- those already read message/
// delay/enabled live from automation_definitions (see that file), so
// admin edits apply, but their TRIGGER WIRING is intentionally left on
// the existing proven call sites (join/ISP-complete/module-complete)
// rather than re-routed through this generic path, per spec ("must not
// be BOTH an old sender and new sender firing the same automation").
// This evaluator therefore explicitly SKIPS those 4 keys and only
// processes any OTHER (admin-created) automation_definitions row.
const LEGACY_MANAGED_KEYS = new Set([
  "waitlist_selection",
  "isp_confirmation_reminder",
  "golden_bridge_followup",
  "non_waitlist_4day",
]);

function sendGenericAutomation(db, { automationKey, accountId, triggerEventKey, body }) {
  db.exec("BEGIN");
  try {
    let insertResult;
    try {
      insertResult = db
        .prepare(
          `INSERT INTO automation_sends (id, automation_key, account_id, trigger_event_key, sent_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(generateId("autosend"), automationKey, accountId, triggerEventKey, new Date().toISOString());
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
    postMessageInner(db, {
      conversationId: conversation.id,
      senderRole: "admin",
      senderAccountId: null,
      body,
    });
    db.exec("COMMIT");
    return { sent: true };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function candidatesForDefinition(db, def) {
  const triggerConfig = def.trigger_config_json ? JSON.parse(def.trigger_config_json) : {};
  const delayMs = def.delay_hours * 60 * 60 * 1000;

  switch (def.trigger_type) {
    case "JOIN_WAITLIST":
      return db
        .prepare(
          `SELECT id AS accountId, waitlist_joined_at AS triggerAt, id AS eventKey
           FROM accounts WHERE role = 'customer' AND waitlist_joined_at IS NOT NULL`
        )
        .all()
        .map((r) => ({ accountId: r.accountId, triggerAtMs: new Date(r.triggerAt).getTime(), eventKey: r.eventKey }));

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
          triggerAtMs: new Date(r.triggerAt).getTime(),
          eventKey: `${r.accountId}:module${moduleKey}`,
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
        .map((r) => ({ accountId: r.accountId, triggerAtMs: new Date(r.triggerAt).getTime(), eventKey: r.accountId }));

    case "FIRST_LOGIN":
      return db
        .prepare(
          `SELECT id AS accountId, first_login_at AS triggerAt
           FROM accounts WHERE role = 'customer' AND first_login_at IS NOT NULL`
        )
        .all()
        .map((r) => ({ accountId: r.accountId, triggerAtMs: new Date(r.triggerAt).getTime(), eventKey: r.accountId }));

    case "EACH_LOGIN":
      // PART V: idempotency key MUST be tied to the SPECIFIC login event
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
        .map((r) => ({
          accountId: r.accountId,
          triggerAtMs: new Date(r.triggerAt).getTime(),
          eventKey: r.eventId,
        }));

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
          triggerAtMs: new Date(r.triggerAt).getTime(),
          // PART: idempotency tied to the SPECIFIC tag-add event, not
          // merely account+tag, so re-adding the tag later (a distinct
          // event) is separately eligible.
          eventKey: `${r.conversationId}:${r.tagId}:${r.triggerAt}`,
        }));
    }

    default:
      return [];
  }
  void delayMs; // delay applied by caller
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
    const candidates = candidatesForDefinition(db, def);
    for (const c of candidates) {
      if (!Number.isFinite(c.triggerAtMs)) continue;
      if (now < c.triggerAtMs + delayMs) continue;
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
