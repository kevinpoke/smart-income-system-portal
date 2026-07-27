import { NextResponse } from "next/server";
import { getCurrentAccountRaw } from "@/lib/session";
import { computeNodes } from "@/lib/nodesEngine";

// Authenticated customer's demo Node inventory. Deterministic per account
// id -- never Math.random() at render/request time, never written to the
// earnings ledger. Only returns the fields the Nodes page needs; does not
// select or expose ssid/isp_provider/isp_street/isp_zip or any other
// account internals beyond city/state (used once, to personalize row 0's
// location).
export async function GET() {
  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const customerLocation =
    account.isp_city && account.isp_state
      ? `${account.isp_city}, ${account.isp_state}`
      : null;

  const nodes = computeNodes(account.id, customerLocation);

  return NextResponse.json({
    mode: "demo",
    nodes: nodes.map((n) => ({
      nodeId: n.nodeId,
      location: n.location,
      tier: n.tier,
      ip: n.ip,
      estMonthlyCents: n.estMonthlyCents,
      costCents: n.costCents,
      status: n.status,
    })),
  });
}
