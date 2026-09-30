import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { listAutomationDefinitions } from "@/lib/automationDefinitions";
import {
  computeAutomatedMessageAnalytics,
  resolvePeriodRange,
} from "@/lib/supportAnalytics";

// AI Sales main list. Reuses the EXACT SAME shared analytics function
// (computeAutomatedMessageAnalytics) Admin Analytics already calls, keyed
// by the same event_key prefixes -- never a second metric definition.
// Generic (non-legacy) automations have no historical prefix-based
// analytics yet (they use automation_sends, not scheduled_support_messages)
// so they report sent/replied as null rather than fabricating a number.
export async function GET(request) {
  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }
  const db = getDb();
  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period") || "lastweek";
  const range = resolvePeriodRange(period, {
    customStart: searchParams.get("start") || undefined,
    customEnd: searchParams.get("end") || undefined,
  });

  const defs = listAutomationDefinitions(db);
  const legacyAnalytics = computeAutomatedMessageAnalytics(db, range);
  const analyticsByKey = new Map(legacyAnalytics.map((a) => [a.automationKey, a]));

  const workflows = defs.map((d) => {
    const analytics = analyticsByKey.get(d.key) || null;
    return {
      key: d.key,
      name: d.name,
      enabled: Boolean(d.enabled),
      messageBody: d.message_body,
      triggerType: d.trigger_type,
      triggerConfig: d.trigger_config_json ? JSON.parse(d.trigger_config_json) : {},
      timingDirection: d.timing_direction,
      delayHours: d.delay_hours,
      updatedAt: d.updated_at,
      analytics,
    };
  });

  return NextResponse.json({ workflows });
}
