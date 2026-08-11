import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentAccountRaw } from "@/lib/session";
import { listOwnedNodes, computeNodeEarningsTotals } from "@/lib/ownedNodes";
import {
  computeEarningsSummary,
  computeNodeOnDurationMs,
  computeAvgDailyEarningsCents,
} from "@/lib/earningsEngine";

// Authenticated customer's persisted, OWNED Node records (Dashboard "Your
// Nodes" section) -- distinct from /api/nodes (the browsable marketplace
// demo inventory). Location is always read live from the account's own
// isp_city/isp_state so it can never disagree with ISP Setup.
//
// Dashboard adjustment pass: each row now also carries `totalEarningsCents`
// -- this Node's cumulative contribution to the account's earnings,
// including its live share of the current in-progress cycle (so it
// updates in lockstep with the account-level Live Earnings ticker and
// freezes with it while WiFi is off/reconnecting). Calling
// computeEarningsSummary() here (rather than a lighter-weight query)
// ensures this route uses the EXACT SAME live-accrual/WiFi-gating source
// of truth as the Dashboard's own earnings summary -- never a second,
// independently-computed live number that could drift out of sync.
//
// "Avg Daily Earnings" column: each row also carries `avgDailyEarningsCents`,
// computed from this SAME totalEarningsCents numerator divided by the
// Node's own canonical ON/earning duration (lib/earningsEngine.js
// computeNodeOnDurationMs, which replays the SAME wifi_events history
// computeOnMsInRange already uses for actual accrual) -- never the
// account's age and never a naive calendar-day count that would ignore
// disconnected time.
export async function GET() {
  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const db = getDb();
  const nodes = listOwnedNodes(db, account);
  const summary = computeEarningsSummary(db, account.id);
  const nodeEarnings = summary?.nodeEarnings || computeNodeEarningsTotals(db, account.id);

  return NextResponse.json({
    mode: "demo",
    nodes: nodes.map((n) => {
      const totalEarningsCents = nodeEarnings[n.id] || 0;
      const onDurationMs = computeNodeOnDurationMs(db, account, n);
      return {
        ...n,
        totalEarningsCents,
        onDurationMs,
        avgDailyEarningsCents: computeAvgDailyEarningsCents(totalEarningsCents, onDurationMs),
      };
    }),
  });
}
