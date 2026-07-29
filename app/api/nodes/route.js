import { NextResponse } from "next/server";
import { getCurrentAccountRaw } from "@/lib/session";
import { computeNodes } from "@/lib/nodesEngine";
import { hasModuleAccess } from "@/lib/moduleAccess";

// Authenticated customer's demo Node inventory. Deterministic per account
// id -- never Math.random() at render/request time, never written to the
// earnings ledger. Only returns the fields the Nodes page needs; does not
// select or expose ssid/isp_provider/isp_street/isp_zip or any other
// account internals beyond city/state.
//
// Phase 5 server-side enforcement: the Nodes section must be inaccessible
// before ISP Setup is completed and approved (isp_status === 'active'),
// mirroring the "Location Required" locked UI state. Rather than 403'ing
// (which would force the page to special-case an error response), this
// returns locked: true with an empty node list so the client can render
// the same locked-state card it already uses elsewhere -- but a client
// that ignored `locked` entirely would still see zero nodes and no
// location, so the restriction is enforced here, not just in the UI.
//
// Portal reliability pass: the unlock check now goes through the shared
// lib/moduleAccess.js hasModuleAccess() helper (same one used by the
// Modules page's own API route and the client-side gating logic) instead
// of an inline expression duplicated per route -- this is what makes the
// admin's individual "Unlock All Modules" override behave identically
// everywhere it's supposed to apply.
//
// Bugfix (live A/B verification): this route previously required BOTH
// hasModuleAccess() AND a real ISP address on file (`unlocked &&
// customerLocation`), which meant the admin's per-customer "Unlock All
// Modules" override had NO effect here for an account that never
// completed ISP Setup -- confirmed live: an admin-unlocked account still
// saw Nodes locked while Payouts/Withdrawals correctly unlocked. Nodes
// now mirrors the SAME "unlock on EITHER condition" pattern already used
// by /api/payouts/estimates and /api/withdrawals/bank: unlocked if the
// customer has a real address OR the shared override applies. When
// unlocked via the override alone (no address yet), Nodes are shown for
// a generic "Your Area" placeholder location instead of staying empty --
// computeNodes() only needs *some* stable location string to seed
// deterministic demo rows, and it is naturally replaced by the real
// city/state the moment the customer's ISP Setup is complete.
export async function GET() {
  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const realLocation =
    account.isp_city && account.isp_state ? `${account.isp_city}, ${account.isp_state}` : null;
  const unlocked = Boolean(realLocation) || hasModuleAccess(account);

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
