import { NextResponse } from "next/server";
import { getCurrentAccountRaw } from "@/lib/session";
import { computeNodes } from "@/lib/nodesEngine";
import { hasPayoutsNodesAccess } from "@/lib/moduleAccess";

// Authenticated customer's demo Node inventory. Deterministic per account
// id -- never Math.random() at render/request time, never written to the
// earnings ledger. Only returns the fields the Nodes page needs; does not
// select or expose ssid/isp_provider/isp_street/isp_zip or any other
// account internals beyond city/state.
//
// Refinement pass: NODES must remain locked until BOTH (1) ISP setup is
// fully completed (isp_status === "active") AND (2) city+state are both
// stored -- see lib/moduleAccess.js hasPayoutsNodesAccess(). This is
// DELIBERATELY stricter than (and independent of) hasModuleAccess(): the
// admin's per-customer "Unlock All Modules" override affects training
// videos ONLY and must never unlock Nodes, so it is not consulted here
// at all, in either direction. Rather than 403'ing (which would force
// the page to special-case an error response), this returns locked:
// true with an empty node list so the client can render the same
// locked-state card it already uses elsewhere -- but a client that
// ignored `locked` entirely would still see zero nodes and no location,
// so the restriction is enforced here, not just in the UI.
export async function GET() {
  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const realLocation =
    account.isp_city && account.isp_state ? `${account.isp_city}, ${account.isp_state}` : null;
  const unlocked = hasPayoutsNodesAccess(account);

  if (!unlocked) {
    return NextResponse.json({
      mode: "demo",
      locked: true,
      location: null,
      nodes: [],
    });
  }

  const customerLocation = realLocation || "Your Area";
  const nodes = computeNodes(account.id, customerLocation);

  return NextResponse.json({
    mode: "demo",
    locked: false,
    location: customerLocation,
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
