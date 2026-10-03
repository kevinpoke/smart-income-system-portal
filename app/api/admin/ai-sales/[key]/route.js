import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import {
  getAutomationDefinition,
  getAutomationConditions,
  updateAutomationMessage,
  updateAutomationRule,
  setAutomationEnabled,
  getAutomationAuditLog,
  formatMessageCode,
} from "@/lib/automationDefinitions";

export async function GET(_request, { params }) {
  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }
  const { key } = await params;
  const db = getDb();
  const def = getAutomationDefinition(db, key);
  if (!def) {
    return NextResponse.json({ error: "Automation not found." }, { status: 404 });
  }
  return NextResponse.json({
    key: def.key,
    messageCode: def.message_code,
    messageCodeLabel: def.message_code != null ? formatMessageCode(def.message_code) : null,
    name: def.name,
    enabled: Boolean(def.enabled),
    messageBody: def.message_body,
    triggerMatchMode: def.trigger_match_mode || "all",
    ruleTree: def.rule_tree_json ? JSON.parse(def.rule_tree_json) : null,
    conditions: getAutomationConditions(db, key),
    delaySeconds: def.delay_seconds,
    delayHours: def.delay_hours,
    updatedAt: def.updated_at,
    auditLog: getAutomationAuditLog(db, key),
  });
}

// PATCH body: { messageBody?, rule?: {ruleTree, conditions, delayValue, delayUnit}, enabled? }
// Each field is independently optional/updatable; edits are prospective
// only (see lib/automationDefinitions.js -- never touches historical
// sends/idempotency). `key` and `messageCode` are NEVER accepted here --
// both are permanent, server-assigned identities and this route has no
// code path that can alter either. `rule.ruleTree` leaves use
// `conditionIndex` (position within `rule.conditions`) -- resolved to
// real condition-row ids server-side, atomically with the replace.
export async function PATCH(request, { params }) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }
  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }
  const { key } = await params;

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const db = getDb();

  if (typeof body.messageBody === "string") {
    const result = updateAutomationMessage(db, key, body.messageBody, guard.account.id);
    if (!result.ok) {
      return NextResponse.json({ error: result.reason || "Unable to update message." }, { status: 400 });
    }
  }

  if (body.rule && typeof body.rule === "object") {
    const result = updateAutomationRule(db, key, body.rule, guard.account.id);
    if (!result.ok) {
      return NextResponse.json({ error: result.message || result.reason || "Invalid rule." }, { status: 400 });
    }
  }

  if (typeof body.enabled === "boolean") {
    const result = setAutomationEnabled(db, key, body.enabled, guard.account.id);
    if (!result.ok) {
      return NextResponse.json({ error: result.reason || "Unable to update status." }, { status: 400 });
    }
  }

  const def = getAutomationDefinition(db, key);
  if (!def) {
    return NextResponse.json({ error: "Automation not found." }, { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    key: def.key,
    messageCode: def.message_code,
    messageCodeLabel: def.message_code != null ? formatMessageCode(def.message_code) : null,
    enabled: Boolean(def.enabled),
    messageBody: def.message_body,
    triggerMatchMode: def.trigger_match_mode || "all",
    ruleTree: def.rule_tree_json ? JSON.parse(def.rule_tree_json) : null,
    conditions: getAutomationConditions(db, key),
    delaySeconds: def.delay_seconds,
    delayHours: def.delay_hours,
  });
}
