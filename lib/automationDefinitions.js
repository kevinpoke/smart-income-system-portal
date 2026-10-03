import crypto from "node:crypto";
import { generateId } from "./auth-crypto";
import {
  validateRuleTreeShape,
  collectConditionIds,
  computeAnchorCandidates,
  resolveRuleTreeIndexesToIds,
  buildLegacyRuleTree,
} from "./ruleTree";

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

// ---- Message Code allocation (permanent, monotonic, never reused) -------
//
// Backed by a single-row sequence table (automation_message_code_seq).
// Allocation is a SINGLE atomic UPDATE...RETURNING statement -- not a
// separate SELECT-then-UPDATE (which would race under concurrent
// callers) -- so two simultaneous creates can never observe/receive the
// same code; SQLite serializes the two UPDATEs against the same row.
function allocateNextMessageCode(db) {
  let row = db
    .prepare(`UPDATE automation_message_code_seq SET next_code = next_code + 1 WHERE id = 1 RETURNING next_code - 1 AS allocated`)
    .get();
  if (!row) {
    // First-ever call (fresh DB, seq row not created yet): seed it and
    // retry once. INSERT OR IGNORE + retry keeps this race-safe even if
    // two callers hit this branch simultaneously -- only one INSERT can
    // win, the loser's next UPDATE still succeeds against the winner's row.
    db.prepare(`INSERT OR IGNORE INTO automation_message_code_seq (id, next_code) VALUES (1, 1)`).run();
    row = db
      .prepare(`UPDATE automation_message_code_seq SET next_code = next_code + 1 WHERE id = 1 RETURNING next_code - 1 AS allocated`)
      .get();
  }
  return row.allocated;
}

// Ensures the sequence's next_code is always >= MAX(existing message_code) + 1,
// so a stale/lagging sequence row (e.g. restored from an older backup)
// can never hand out a code that collides with one already assigned.
// Never DECREASES next_code (archived/disabled rows must never free up
// their code for reuse).
function repairMessageCodeSequence(db) {
  const maxRow = db.prepare(`SELECT MAX(message_code) AS maxCode FROM automation_definitions`).get();
  const floor = (maxRow?.maxCode || 0) + 1;
  db.prepare(`INSERT OR IGNORE INTO automation_message_code_seq (id, next_code) VALUES (1, 1)`).run();
  db.prepare(`UPDATE automation_message_code_seq SET next_code = ? WHERE id = 1 AND next_code < ?`).run(floor, floor);
}

// Idempotently assigns permanent message codes. The 4 legacy keys are
// ALWAYS explicitly pinned to 1-4 (never inferred from created_at, which
// could tie or be reordered) -- this is the one hardcoded mapping in the
// whole system, by design, since it's a permanent historical fact,  not
// a computed value. Any other pre-existing unassigned definition (e.g.
// created before this migration ran) is then assigned 5+ in created_at
// order. Only rows with message_code IS NULL are ever touched; already-
// assigned codes are immutable and never reassigned.
const LEGACY_MESSAGE_CODES = {
  waitlist_selection: 1,
  isp_confirmation_reminder: 2,
  golden_bridge_followup: 3,
  non_waitlist_4day: 4,
};

function backfillMessageCodes(db) {
  repairMessageCodeSequence(db);

  for (const [key, code] of Object.entries(LEGACY_MESSAGE_CODES)) {
    const row = db.prepare(`SELECT message_code FROM automation_definitions WHERE key = ?`).get(key);
    if (row && row.message_code == null) {
      db.prepare(`UPDATE automation_definitions SET message_code = ? WHERE key = ?`).run(code, key);
    }
  }
  repairMessageCodeSequence(db); // re-floor after pinning 1-4

  const unassigned = db
    .prepare(`SELECT key FROM automation_definitions WHERE message_code IS NULL ORDER BY created_at ASC, key ASC`)
    .all();
  for (const row of unassigned) {
    const code = allocateNextMessageCode(db);
    db.prepare(`UPDATE automation_definitions SET message_code = ? WHERE key = ?`).run(code, row.key);
  }
}

export function formatMessageCode(code) {
  return `Message ${String(code).padStart(3, "0")}`;
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
  "MESSAGE_READ",
  // STATE condition (no occurrence timeline of its own) -- re-evaluated
  // fresh at send time against the canonical accounts.waitlist_joined_at
  // membership source (see lib/waitlistEngine.js / automationEvaluator.js).
  "DID_NOT_JOIN_WAITLIST",
]);

// EVENT conditions have a timestamped occurrence history per account and
// may serve as a rule's anchor/eligibility timeline. STATE conditions are
// pure current-truth gates with no occurrence of their own -- they can
// never anchor a rule by themselves and are always re-checked fresh
// immediately before send (see lib/ruleTree.js computeAnchorCandidates /
// recheckRuleTreeAtSendTime and lib/automationEvaluator.js).
export const STATE_TRIGGER_TYPES = new Set(["DID_NOT_JOIN_WAITLIST"]);
export const EVENT_TRIGGER_TYPES = new Set(
  [...VALID_TRIGGER_TYPES].filter((t) => !STATE_TRIGGER_TYPES.has(t))
);

// ---- Delay normalization (seconds is the authoritative unit) ------------
//
// Server-side normalization only -- the client's unit dropdown is purely
// presentational, the server always re-derives delay_seconds from
// (value, unit) and never trusts a client-submitted seconds total alone
// without this same validation.
const DELAY_UNIT_SECONDS = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
  days: 86400,
};

// Same ceiling as the previous 8760-hour (365-day) maximum, expressed in
// seconds so every unit shares one authoritative upper bound.
export const MAX_DELAY_SECONDS = 8760 * 3600;

export function normalizeDelayToSeconds(value, unit) {
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < 0) {
    return { ok: false, message: "Delay value must be a whole number >= 0." };
  }
  const multiplier = DELAY_UNIT_SECONDS[unit];
  if (!multiplier) {
    return { ok: false, message: "Delay unit must be seconds, minutes, hours, or days." };
  }
  const seconds = num * multiplier;
  if (seconds > MAX_DELAY_SECONDS) {
    return { ok: false, message: "Delay exceeds the maximum allowed (365 days)." };
  }
  return { ok: true, seconds };
}

// Validates ONE condition in isolation (no cycle check here -- see
// validateConditionsForKey below for the full graph check, which needs
// the automation's own key to detect self-reference/cycles).
function validateSingleCondition({ triggerType, triggerConfig }, db) {
  if (!VALID_TRIGGER_TYPES.has(triggerType)) return "Invalid trigger type.";
  if (triggerType === "WATCH_MODULE") {
    const mod = Number(triggerConfig?.module);
    if (!Number.isInteger(mod) || mod < 1 || mod > 10) {
      return "Watch-module trigger requires a module 1-10.";
    }
  }
  if (triggerType === "SUPPORT_TAG_ADDED") {
    const tag = typeof triggerConfig?.tagName === "string" ? triggerConfig.tagName.trim() : "";
    if (!tag) return "Support-tag trigger requires a non-empty tag name.";
    if (db) {
      const existing = db.prepare(`SELECT id FROM support_tags WHERE name = ?`).get(tag);
      if (!existing) return "Support-tag trigger requires an existing Support Chat tag.";
    }
  }
  if (triggerType === "MESSAGE_READ") {
    const sourceKey = typeof triggerConfig?.sourceAutomationKey === "string" ? triggerConfig.sourceAutomationKey.trim() : "";
    if (!sourceKey) return "Message-read trigger requires a source automation.";
    if (db) {
      const source = getAutomationDefinition(db, sourceKey);
      if (!source) return "Message-read trigger references a source automation that does not exist.";
    }
  }
  return null;
}

// Builds a directed graph of MESSAGE_READ dependencies (automationKey ->
// sourceAutomationKey) from every OTHER automation's CURRENT persisted
// conditions, overlays the PROPOSED conditions for `key` (the automation
// being created/edited), and detects a cycle reachable from `key`. Must
// be run with the proposed edges already substituted in, not the old
// ones, so an edit that WOULD introduce a cycle is caught before it's
// ever persisted.
function detectMessageReadCycle(db, key, proposedConditions) {
  const edges = new Map(); // automationKey -> Set(sourceAutomationKey)
  const allDefs = db.prepare(`SELECT key FROM automation_definitions`).all();
  for (const { key: otherKey } of allDefs) {
    if (otherKey === key) continue; // overridden by proposedConditions below
    const rows = db
      .prepare(`SELECT trigger_config_json FROM automation_trigger_conditions WHERE automation_key = ? AND trigger_type = 'MESSAGE_READ'`)
      .all(otherKey);
    for (const r of rows) {
      const cfg = r.trigger_config_json ? JSON.parse(r.trigger_config_json) : {};
      if (cfg.sourceAutomationKey) {
        if (!edges.has(otherKey)) edges.set(otherKey, new Set());
        edges.get(otherKey).add(cfg.sourceAutomationKey);
      }
    }
  }
  const proposedSources = proposedConditions
    .filter((c) => c.triggerType === "MESSAGE_READ")
    .map((c) => c.triggerConfig?.sourceAutomationKey)
    .filter(Boolean);
  if (proposedSources.length) edges.set(key, new Set(proposedSources));

  // DFS from `key` looking for a path back to `key`.
  const visiting = new Set();
  function hasCycle(node, isStart) {
    if (!isStart && node === key) return true;
    if (visiting.has(node)) return false; // already fully explored this branch without hitting key
    visiting.add(node);
    for (const next of edges.get(node) || []) {
      if (hasCycle(next, false)) return true;
    }
    return false;
  }
  return hasCycle(key, true);
}

// Full server-side validation for a proposed condition SET (>=1 required,
// each individually valid, no self-reference, no cycle). `key` is null
// for a brand-new automation (whose key doesn't exist yet, so it can
// never legitimately appear as its own source -- still checked defensively).
export function validateConditions(db, key, triggerMatchMode, conditions) {
  if (triggerMatchMode !== "all" && triggerMatchMode !== "any") {
    return "Trigger logic must be All or Any.";
  }
  if (!Array.isArray(conditions) || conditions.length === 0) {
    return "At least one trigger condition is required.";
  }
  for (const c of conditions) {
    const err = validateSingleCondition(c, db);
    if (err) return err;
    if (c.triggerType === "MESSAGE_READ" && key && c.triggerConfig?.sourceAutomationKey === key) {
      return "A message cannot depend on being read by its own send.";
    }
  }
  if (key && detectMessageReadCycle(db, key, conditions)) {
    return "This rule would create a circular Message Read dependency.";
  }
  return null;
}

// ---- RULE-BUILDER batch: structured rule tree validation -----------------
//
// `ruleTree` leaves use { conditionIndex } (position in the `conditions`
// array being created/replaced -- real condition ids don't exist yet at
// validation time for a create, and even for an edit we replace the whole
// condition set atomically, so index-addressing is the one scheme that
// works uniformly for both). Validates: shape/operators/depth (via
// lib/ruleTree.js), every index in range, every leaf index used at least
// once (no orphan condition row), and at least one EVENT-type condition
// reachable as an anchor (a rule with zero possible eligibility timeline
// -- e.g. "NONE OF" wrapping everything -- could never fire).
export function validateRuleTree(db, key, ruleTree, conditions) {
  if (!Array.isArray(conditions) || conditions.length === 0) {
    return "At least one trigger condition is required.";
  }
  for (const c of conditions) {
    const err = validateSingleCondition(c, db);
    if (err) return err;
    if (c.triggerType === "MESSAGE_READ" && key && c.triggerConfig?.sourceAutomationKey === key) {
      return "A message cannot depend on being read by its own send.";
    }
  }
  if (key && detectMessageReadCycle(db, key, conditions)) {
    return "This rule would create a circular Message Read dependency.";
  }

  const shapeErr = validateRuleTreeShape(ruleTree);
  if (shapeErr) return shapeErr;

  const indexes = collectConditionIds(ruleTree); // these are conditionIndex values pre-resolution
  for (const idx of indexes) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= conditions.length) {
      return "Rule references a condition that does not exist.";
    }
  }
  const usedIndexes = new Set(indexes);
  for (let i = 0; i < conditions.length; i++) {
    if (!usedIndexes.has(i)) return "Every added condition must be used somewhere in the rule.";
  }

  const eventIndexes = conditions
    .map((c, i) => (EVENT_TRIGGER_TYPES.has(c.triggerType) ? i : null))
    .filter((i) => i !== null);
  if (eventIndexes.length === 0) {
    return "At least one event-based condition (not just state conditions) is required so the rule can become eligible.";
  }
  const anchorCheck = computeAnchorCandidates(ruleTree, new Map(eventIndexes.map((i) => [i, [{ eventKey: "probe", occurredAt: 0 }]])));
  if (!anchorCheck.hasAnchor) {
    return "This rule can never become eligible (no reachable event condition).";
  }

  return null;
}

export function getAutomationConditions(db, key) {
  return db
    .prepare(`SELECT * FROM automation_trigger_conditions WHERE automation_key = ? ORDER BY position ASC`)
    .all(key)
    .map((r) => ({
      id: r.id,
      triggerType: r.trigger_type,
      triggerConfig: r.trigger_config_json ? JSON.parse(r.trigger_config_json) : {},
      position: r.position,
    }));
}

// Atomically replaces ALL condition rows for `key` with the new set --
// validation must already have passed before calling this (see
// validateConditions above). Also mirrors condition[0] onto the legacy
// trigger_type/trigger_config_json columns for backward-compat display
// only (see file-top note); the evaluator never reads those columns.
// Returns the inserted condition ids in the SAME order as `conditions`,
// so a caller holding an index-addressed rule tree can resolve it to the
// real ids in one pass (see resolveRuleTreeIndexesToIds in lib/ruleTree.js).
function replaceAutomationConditions(db, key, conditions) {
  const now = new Date().toISOString();
  const insertedIds = [];
  db.exec("BEGIN");
  try {
    db.prepare(`DELETE FROM automation_trigger_conditions WHERE automation_key = ?`).run(key);
    const insert = db.prepare(
      `INSERT INTO automation_trigger_conditions (id, automation_key, trigger_type, trigger_config_json, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    conditions.forEach((c, i) => {
      const id = generateId("trigcond");
      insert.run(id, key, c.triggerType, JSON.stringify(c.triggerConfig || {}), i, now, now);
      insertedIds.push(id);
    });
    const first = conditions[0];
    db.prepare(
      `UPDATE automation_definitions SET trigger_type = ?, trigger_config_json = ?, timing_direction = 'after', updated_at = ? WHERE key = ?`
    ).run(first.triggerType, JSON.stringify(first.triggerConfig || {}), now, key);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return insertedIds;
}

// Derives the triggerMatchMode ('all'/'any') that best represents a rule
// tree for legacy display/compat purposes only (e.g. the old UI column,
// reporting). Authoritative evaluation always uses rule_tree_json; this
// is a best-effort summary, never round-tripped back into the tree.
function summarizeTriggerMatchModeFromTree(ruleTree) {
  if (ruleTree && ruleTree.op === "ANY_OF") return "any";
  return "all";
}



// Rule edits affect only NOT-YET-SENT trigger occurrences -- already-sent
// automation_sends rows are never touched/reset here. `rule` shape:
// { ruleTree: {op,children with conditionIndex leaves}, conditions: [{triggerType, triggerConfig}, ...],
//   delayValue, delayUnit: 'seconds'|'minutes'|'hours'|'days' }.
// Legacy triggerMatchMode/delayHours payloads are still accepted for any
// caller not yet migrated to the rule-builder UI -- they're converted to
// an equivalent ALL_OF/ANY_OF tree + delay_seconds internally, so there
// is exactly ONE authoritative code path either way.
export function updateAutomationRule(db, key, rule, adminAccountId) {
  const existing = getAutomationDefinition(db, key);
  if (!existing) return { ok: false, reason: "not_found" };

  const conditions = rule.conditions;
  const ruleTree = rule.ruleTree || buildLegacyRuleTree(rule.triggerMatchMode || "all", (conditions || []).map((_, i) => i));

  const error = validateRuleTree(db, key, ruleTree, conditions);
  if (error) return { ok: false, reason: "invalid", message: error };

  const delayResult = normalizeDelayToSeconds(
    rule.delayValue !== undefined ? rule.delayValue : rule.delayHours,
    rule.delayUnit || (rule.delayHours !== undefined ? "hours" : undefined)
  );
  if (!delayResult.ok) return { ok: false, reason: "invalid", message: delayResult.message };

  const before = {
    ruleTree: existing.rule_tree_json ? JSON.parse(existing.rule_tree_json) : null,
    conditions: getAutomationConditions(db, key),
    delaySeconds: existing.delay_seconds,
  };

  const insertedIds = replaceAutomationConditions(db, key, conditions);
  const resolvedTree = resolveRuleTreeIndexesToIds(ruleTree, insertedIds);
  const triggerMatchMode = summarizeTriggerMatchModeFromTree(resolvedTree);

  db.prepare(
    `UPDATE automation_definitions
     SET trigger_match_mode = ?, rule_tree_json = ?, delay_seconds = ?, delay_hours = ?, updated_at = ?
     WHERE key = ?`
  ).run(
    triggerMatchMode,
    JSON.stringify(resolvedTree),
    delayResult.seconds,
    delayResult.seconds / 3600, // legacy compatibility column, derived not authoritative
    new Date().toISOString(),
    key
  );

  auditLog(db, {
    adminAccountId,
    key,
    field: "rule",
    before: JSON.stringify(before),
    after: JSON.stringify({ ruleTree: resolvedTree, conditions, delaySeconds: delayResult.seconds }),
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

// ---- CUSTOM-AI-SALES-AUTOMATIONS batch: admin-created definitions -------
//
// Internal keys are auto-generated from the display name (slugified) plus
// a short random suffix -- the admin never types/chooses a key. This
// guarantees uniqueness (UNIQUE(key) constraint is the final backstop,
// retried with a fresh suffix on the astronomically unlikely collision)
// and means two definitions may safely share the exact same display name
// (their internal identity never depends on it).
const RESERVED_KEYS = new Set([
  "waitlist_selection",
  "isp_confirmation_reminder",
  "golden_bridge_followup",
  "non_waitlist_4day",
]);

function slugifyName(name) {
  const slug = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "automation";
}

function generateAutomationKey(db, name) {
  const base = slugifyName(name);
  for (let attempt = 0; attempt < 20; attempt++) {
    const suffix = crypto.randomBytes(4).toString("hex");
    const candidate = `${base}_${suffix}`;
    if (RESERVED_KEYS.has(candidate)) continue;
    const existing = db.prepare(`SELECT 1 FROM automation_definitions WHERE key = ?`).get(candidate);
    if (!existing) return candidate;
  }
  // Should be unreachable (8 hex chars = 4 billion possibilities), but
  // never loop forever -- fall back to a fully random key.
  return `automation_${crypto.randomBytes(12).toString("hex")}`;
}

// Server-side validation for a NEW automation's core fields (name +
// message). Trigger/timing validation is shared with edits via
// validateRule() above -- never a second, divergent rule-checking path.
export function validateNewAutomation({ name, messageBody }) {
  if (typeof name !== "string" || !name.trim()) return "Automation name is required.";
  if (name.trim().length > 200) return "Automation name is too long.";
  if (typeof messageBody !== "string" || !messageBody.trim()) return "Message is required.";
  return null;
}

// Creates a new, admin-authored automation definition. Never assigns a
// legacy-reserved key, never lets the caller choose the key or the
// message_code, always writes a full audit-log entry (field: "created").
// `payload.ruleTree`/`conditions` are the authoritative rule (ruleTree
// leaves use conditionIndex, resolved to real ids after insert);
// condition[0] is mirrored onto the legacy trigger_type/trigger_config_json
// columns for backward-compat display only (see replaceAutomationConditions).
// `payload.triggerMatchMode`/`delayHours` are still accepted from any
// not-yet-migrated caller and converted internally -- one authoritative path.
export function createAutomationDefinition(
  db,
  { name, messageBody, triggerMatchMode = "all", ruleTree, conditions, delayHours, delayValue, delayUnit, enabled = true },
  adminAccountId
) {
  const nameError = validateNewAutomation({ name, messageBody });
  if (nameError) return { ok: false, reason: "invalid", message: nameError };

  const proposedTree = ruleTree || buildLegacyRuleTree(triggerMatchMode, (conditions || []).map((_, i) => i));
  const ruleError = validateRuleTree(db, null, proposedTree, conditions);
  if (ruleError) return { ok: false, reason: "invalid", message: ruleError };

  const delayResult = normalizeDelayToSeconds(
    delayValue !== undefined ? delayValue : delayHours,
    delayUnit || (delayHours !== undefined ? "hours" : undefined)
  );
  if (!delayResult.ok) return { ok: false, reason: "invalid", message: delayResult.message };

  const trimmedName = name.trim();
  const trimmedBody = messageBody.trim();
  const key = generateAutomationKey(db, trimmedName);
  const messageCode = allocateNextMessageCode(db);
  const now = new Date().toISOString();
  const first = conditions[0];
  const insertedIds = [];

  db.exec("BEGIN");
  try {
    conditions.forEach(() => insertedIds.push(generateId("trigcond")));
    const resolvedTree = resolveRuleTreeIndexesToIds(proposedTree, insertedIds);
    const finalTriggerMatchMode = summarizeTriggerMatchModeFromTree(resolvedTree);

    db.prepare(
      `INSERT INTO automation_definitions
         (id, key, name, enabled, message_body, trigger_type, trigger_config_json, timing_direction, delay_hours, delay_seconds, rule_tree_json, message_code, trigger_match_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'after', ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      generateId("automdef"),
      key,
      trimmedName,
      enabled ? 1 : 0,
      trimmedBody,
      first.triggerType,
      JSON.stringify(first.triggerConfig || {}),
      delayResult.seconds / 3600, // legacy compatibility column, derived not authoritative
      delayResult.seconds,
      JSON.stringify(resolvedTree),
      messageCode,
      finalTriggerMatchMode,
      now,
      now
    );
    const insertCond = db.prepare(
      `INSERT INTO automation_trigger_conditions (id, automation_key, trigger_type, trigger_config_json, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    conditions.forEach((c, i) => {
      insertCond.run(insertedIds[i], key, c.triggerType, JSON.stringify(c.triggerConfig || {}), i, now, now);
    });
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  auditLog(db, {
    adminAccountId,
    key,
    field: "created",
    before: null,
    after: JSON.stringify({
      name: trimmedName,
      messageCode,
      ruleTree: resolveRuleTreeIndexesToIds(proposedTree, insertedIds),
      conditions,
      delaySeconds: delayResult.seconds,
      enabled: Boolean(enabled),
    }),
  });

  return { ok: true, definition: getAutomationDefinition(db, key) };
}

// Idempotently seeds the 4 existing automations with EXACT current
// production message/timing so behavior is unchanged before any admin
// edits. Safe to call on every server start (INSERT OR IGNORE). Also
// backfills message_code (permanent 1-4 for these legacy keys) and
// migrates each into exactly ONE automation_trigger_conditions row
// (idempotent -- skipped if conditions already exist for that key, so a
// later admin edit of the migrated condition is never clobbered by a
// server restart).
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
       (id, key, name, enabled, message_body, trigger_type, trigger_config_json, timing_direction, delay_hours, trigger_match_mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'all', ?, ?)`
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

    // Idempotent condition migration: only inserts if this key has NO
    // condition rows yet (never overwrites an admin's already-edited
    // condition set on a later server restart).
    const existingConditionCount = db
      .prepare(`SELECT COUNT(*) c FROM automation_trigger_conditions WHERE automation_key = ?`)
      .get(s.key).c;
    if (existingConditionCount === 0) {
      db.prepare(
        `INSERT INTO automation_trigger_conditions (id, automation_key, trigger_type, trigger_config_json, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`
      ).run(generateId("trigcond"), s.key, s.triggerType, JSON.stringify(s.triggerConfig), now, now);
    }
  }

  backfillMessageCodes(db);
  migrateLegacyRuleTrees(db);

  // Idempotent, safe on every restart -- WHERE message_code IS NOT NULL
  // so future NULLs (shouldn't happen post-backfill, but defensive)
  // never collide against each other.
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_definitions_message_code
     ON automation_definitions(message_code) WHERE message_code IS NOT NULL`
  );
}

// RULE-BUILDER batch: additive/idempotent migration of every definition
// still missing rule_tree_json (legacy rows, or any row created before
// this batch) into the new structured-tree representation, derived
// EXACTLY from its existing trigger_match_mode + automation_trigger_conditions
// rows -- 'all' -> ALL_OF, 'any' -> ANY_OF, in existing position order.
// Never overwrites a non-NULL tree (an admin's already-built rule-builder
// tree survives every future restart untouched). Recipients/timing are
// never altered by this function -- delay_seconds migration is handled
// separately in lib/db.js's runMigrations().
function migrateLegacyRuleTrees(db) {
  const rows = db
    .prepare(`SELECT key, trigger_match_mode FROM automation_definitions WHERE rule_tree_json IS NULL`)
    .all();
  for (const row of rows) {
    const conditionIds = db
      .prepare(`SELECT id FROM automation_trigger_conditions WHERE automation_key = ? ORDER BY position ASC`)
      .all(row.key)
      .map((c) => c.id);
    if (conditionIds.length === 0) continue; // nothing to build a tree from yet
    const tree = buildLegacyRuleTree(row.trigger_match_mode, conditionIds);
    db.prepare(`UPDATE automation_definitions SET rule_tree_json = ? WHERE key = ? AND rule_tree_json IS NULL`).run(
      JSON.stringify(tree),
      row.key
    );
  }
}
