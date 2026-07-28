import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentAccountRaw } from "@/lib/session";
import { listOwnedNodes } from "@/lib/ownedNodes";

// Authenticated customer's persisted, OWNED Node records (Dashboard "Your
// Nodes" section) -- distinct from /api/nodes (the browsable marketplace
// demo inventory). Location is always read live from the account's own
// isp_city/isp_state so it can never disagree with ISP Setup.
export async function GET() {
  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const db = getDb();
  const nodes = listOwnedNodes(db, account);

  return NextResponse.json({ mode: "demo", nodes });
}
