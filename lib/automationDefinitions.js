import { generateId } from "./auth-crypto";

// AI-SALES batch: generic durable automation config layer. One row per
// automation; message/rule/enabled are all admin-editable here without
// touching source. Seeded once (idempotently) from current production
// behavior for the 4 existing flows -- see seedAutomationDefinitions().

export function listAutomationDefinitions(db) {
  return db.prepare(`SELECT * FROM automation_definitions ORDER BY created_at ASC`).all();
}

export function getAutomationDefinition(db, key) {
  return db.prepare(`SELECT * FROM automation_definitions WHERE key = ?`).get(key);
}

function auditLog(db, { adminAccountId, key, field, before, after }) {
  db.prepare(
    `INSERT INTO automation_audit_log (id, admin_account_id, automation_key, field, before_value, after_value, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(generateId("aaudit"), adminAccountId, key, field, before ?? null, after ?? null, new Date().toISOString());
}

// Message edits affect only FUTURE sends -- already-sent
// scheduled_support_messages/support_messages rows are immutable and are
// never touched here.
export function updateAutomationMessage(db, key, newBody, adminAccountId) {
  const existing = getAutomationDefinition(db, key);
  if (!existing) return { ok: false, reason: "not_found" };
  const trimmed = typeof newBody === "string" ? newBody.trim() : "";
  if (!trimmed) return { ok: false, reason: "empty_message" };

  const now = new Date().toISOString();
  db.prepare(`UPDATE automation_definitions SET message_body = ?, updated_at = ? WHERE key = ?`).run(
    trimmed,
    now,
    key
  );
  auditLog(db, {
    adminAccountId,
    key,
    field: "message_body",
    before: existing.message_body,
    after: trimmed,
  });
  return { ok: true };
}

const VALID_TRIGGER_TYPES = new Set([
  "JOIN_WAITLIST",
  "WATCH_MODULE",
  "AFTER_ISP_SETUP",
  "FIRST_LOGIN",
  "EACH_LOGIN",
  "SUPPORT_TAG_ADDED",
]);

// Server-side rule validation -- never trust client validation alone.
export function validateRule({ triggerType, triggerConfig, timingDirection, delayHours }) {
  if (!VALID_TRIGGER_TYPES.has(triggerType)) return "Invalid trigger type.";
  if (timingDirection !== "after") return "Only AFTER timing is currently supported.";
  const hours = Number(delayHours);
  if (!Number.isFinite(hours) || hours < 0 || !Number.isInteger(hours)) {
    return "Delay hours must be a whole non-negative number.";
  }
  if (triggerType === "WATCH_MODULE") {
    const mod = Number(triggerConfig?.module);
    if (!Number.isInteger(mod) || mod < 1 || mod > 10) {
      return "Watch-module trigger requires a module 1-10.";
    }
  }
  if (triggerType === "SUPPORT_TAG_ADDED") {
    const tag = typeof triggerConfig?.tagName === "string" ? triggerConfig.tagName.trim() : "";
    if (!tag) return "Support-tag trigger requires a non-empty tag name.";
  }
  return null;
}

// Rule edits affect only NOT-YET-SENT trigger occurrences -- already-sent
// automation_sends rows are never touched/reset here.
export function updateAutomationRule(db, key, rule, adminAccountId) {
  const existing = getAutomationDefinition(db, key);
  if (!existing) return { ok: false, reason: "not_found" };
  const error = validateRule(rule);
  if (error) return { ok: false, reason: "invalid", message: error };

  const before = {
    triggerType: existing.trigger_type,
    triggerConfig: existing.trigger_config_json ? JSON.parse(existing.trigger_config_json) : null,
    timingDirection: existing.timing_direction,
    delayHours: existing.delay_hours,
  };
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE automation_definitions
     SET trigger_type = ?, trigger_config_json = ?, timing_direction = ?, delay_hours = ?, updated_at = ?
     WHERE key = ?`
  ).run(
    rule.triggerType,
    JSON.stringify(rule.triggerConfig || {}),
    rule.timingDirection,
    rule.delayHours,
    now,
    key
  );
  auditLog(db, {
    adminAccountId,
    key,
    field: "rule",
    before: JSON.stringify(before),
    after: JSON.stringify(rule),
  });
  return { ok: true };
}

export function setAutomationEnabled(db, key, enabled, adminAccountId) {
  const existing = getAutomationDefinition(db, key);
  if (!existing) return { ok: false, reason: "not_found" };
  const now = new Date().toISOString();
  db.prepare(`UPDATE automation_definitions SET enabled = ?, updated_at = ? WHERE key = ?`).run(
    enabled ? 1 : 0,
    now,
    key
  );
  auditLog(db, {
    adminAccountId,
    key,
    field: "enabled",
    before: String(Boolean(existing.enabled)),
    after: String(Boolean(enabled)),
  });
  return { ok: true };
}

export function getAutomationAuditLog(db, key, limit = 50) {
  return db
    .prepare(
      `SELECT * FROM automation_audit_log WHERE automation_key = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(key, limit);
}

// Idempotently seeds the 4 existing automations with EXACT current
// production message/timing so behavior is unchanged before any admin
// edits. Safe to call on every server start (INSERT OR IGNORE).
export function seedAutomationDefinitions(db) {
  const now = new Date().toISOString();
  const seeds = [
    {
      key: "waitlist_selection",
      name: "Waitlist Confirmation",
      enabled: 1,
      messageBody:
        "You\u2019ve been selected from our waitlist and can purchase a maximum of 3 available Bridges per user. \n\nEach Bridge is a one-time purchase and cannot be resold. \n\nPlease let me know if you want to claim your spot for additional IX Bridges.",
      triggerType: "JOIN_WAITLIST",
      triggerConfig: {},
      timingDirection: "after",
      delayHours: 48,
    },
    {
      key: "isp_confirmation_reminder",
      name: "ISP Setup",
      enabled: 1,
      messageBody:
        "If you haven\u2019t already, I recommend you to join the \u201cWaitlist\u201d in the \u201cBridges\u201d section as soon as you can. Spots are starting to fill up.\n\nWe currently do not have any more bridges available for sale, but I will be reaching out to waitlisted members when they become available.",
      triggerType: "AFTER_ISP_SETUP",
      triggerConfig: {},
      timingDirection: "after",
      delayHours: 0.25, // 15 minutes
    },
    {
      key: "golden_bridge_followup",
      name: "Golden Bridge Follow Up",
      enabled: 1,
      messageBody:
        "I\u2019m not sure if you had a chance to review the modules yet, but we actually have 2 Golden Bridges available right now. Are you against adding more bridges to your account?",
      triggerType: "WATCH_MODULE",
      triggerConfig: { module: 7 },
      timingDirection: "after",
      delayHours: 0,
    },
    {
      key: "non_waitlist_4day",
      name: "Non-Waitlist 4 Day Follow Up",
      enabled: 0, // superseded by Golden Bridge Follow Up; no longer sends (see lib/supportAutomation.js runNonWaitlist4DayScan)
      messageBody:
        "I just checked your account and it seems like your ISP qualifies for additional bridge add-ons!\n\nHowever, due to a shortage of bridges, we're limiting users to be able to purchase 2 bridges max. \n\nPlease let me know if you want to claim your spot for additional IX Bridges.",
      triggerType: "FIRST_LOGIN",
      triggerConfig: {},
      timingDirection: "after",
      delayHours: 96,
    },
  ];

  const insert = db.prepare(
    `INSERT OR IGNORE INTO automation_definitions
       (id, key, name, enabled, message_body, trigger_type, trigger_config_json, timing_direction, delay_hours, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const s of seeds) {
    insert.run(
      generateId("automdef"),
      s.key,
      s.name,
      s.enabled,
      s.messageBody,
      s.triggerType,
      JSON.stringify(s.triggerConfig),
      s.timingDirection,
      s.delayHours,
      now,
      now
    );
  }
}
