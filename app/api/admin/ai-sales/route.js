import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import {
  listAutomationDefinitions,
  createAutomationDefinition,
  getAutomationConditions,
  formatMessageCode,
} from "@/lib/automationDefinitions";
import { computeAutomatedMessageAnalytics, resolvePeriodRange } from "@/lib/supportAnalytics";

// AI Sales main list. Reuses the EXACT SAME shared analytics function
// (computeAutomatedMessageAnalytics) Admin Analytics already calls, keyed
// by the same event_key prefixes -- never a second metric definition.
// Generic (non-legacy) automations have no historical prefix-based
// analytics yet (they use automation_sends, not scheduled_support_messages)
// so they report sent/replied as null rather than fabricating a number.
//
// Lists EVERY row in automation_definitions -- no hardcoded four-row
// assumption anywhere in this route, and the list is NEVER filtered by
// the selected date range (only the `analytics` field per row responds
// to `period`/`start`/`end` -- see RULE-BUILDER+DATE-FILTERS batch note
// in lib/supportAnalytics.js resolvePeriodRange). Sorted by message_code
// (permanent display order), not created_at.
export async function GET(request) {
  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }
  const db = getDb();
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period") || "last7";
  let range;
  try {
    range = resolvePeriodRange(period, {
      customStart: searchParams.get("start") || undefined,
      customEnd: searchParams.get("end") || undefined,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message || "Invalid date range." }, { status: 400 });
  }

  const defs = [...listAutomationDefinitions(db)].sort((a, b) => (a.message_code || 0) - (b.message_code || 0));
  const legacyAnalytics = computeAutomatedMessageAnalytics(db, range);
  const analyticsByKey = new Map(legacyAnalytics.map((a) => [a.automationKey, a]));

  const workflows = defs.map((d) => {
    const analytics = analyticsByKey.get(d.key) || null;
    return {
      key: d.key,
      messageCode: d.message_code,
      messageCodeLabel: d.message_code != null ? formatMessageCode(d.message_code) : null,
      name: d.name,
      enabled: Boolean(d.enabled),
      messageBody: d.message_body,
      triggerMatchMode: d.trigger_match_mode || "all",
      ruleTree: d.rule_tree_json ? JSON.parse(d.rule_tree_json) : null,
      conditions: getAutomationConditions(db, d.key),
      delaySeconds: d.delay_seconds,
      delayHours: d.delay_hours,
      updatedAt: d.updated_at,
      analytics,
    };
  });

  return NextResponse.json({ workflows, range: { period, startMs: range.startMs, endMs: range.endMs } });
}

// POST body: { name, messageBody, ruleTree, conditions, delayValue, delayUnit, enabled }
// Creates a NEW admin-authored automation. The internal key AND
// permanent message_code are always server-generated (see
// lib/automationDefinitions.js#createAutomationDefinition) -- the client
// never supplies or chooses either, so neither can ever collide
// with/overwrite a legacy identity, and two automations may safely
// share the same display name. `ruleTree` leaves use `conditionIndex`
// (position within `conditions`) -- the server resolves these to real
// condition-row ids atomically, never trusting a client-supplied id.
export async function POST(request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }
  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const db = getDb();
  const result = createAutomationDefinition(
    db,
    {
      name: body.name,
      messageBody: body.messageBody,
      ruleTree: body.ruleTree,
      triggerMatchMode: body.triggerMatchMode === "any" ? "any" : "all",
      conditions: Array.isArray(body.conditions) ? body.conditions : [],
      delayValue: body.delayValue,
      delayUnit: body.delayUnit,
      delayHours: body.delayHours,
      enabled: body.enabled !== false,
    },
    guard.account.id
  );

  if (!result.ok) {
    return NextResponse.json({ error: result.message || result.reason || "Unable to create automation." }, { status: 400 });
  }

  const def = result.definition;
  return NextResponse.json({
    ok: true,
    key: def.key,
    messageCode: def.message_code,
    messageCodeLabel: formatMessageCode(def.message_code),
    name: def.name,
    enabled: Boolean(def.enabled),
    messageBody: def.message_body,
    triggerMatchMode: def.trigger_match_mode,
    ruleTree: def.rule_tree_json ? JSON.parse(def.rule_tree_json) : null,
    conditions: getAutomationConditions(db, def.key),
    delaySeconds: def.delay_seconds,
    delayHours: def.delay_hours,
  });
}
