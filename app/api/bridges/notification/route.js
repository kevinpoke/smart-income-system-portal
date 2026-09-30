import { NextResponse } from "next/server";
import { getCurrentAccountRaw, getCurrentSessionRaw } from "@/lib/session";
import { computeBridgesNotification } from "@/lib/bridgesNotification";

// Read-only poll for the Bridges nav-tab badge. Mirrors GET
// /api/isp/unread -- never clears anything itself (only POST
// /api/bridges/dismiss, called when the customer opens the Bridges page,
// does that).
export async function GET() {
  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const session = await getCurrentSessionRaw();
  const { show } = computeBridgesNotification(account, session);
  return NextResponse.json({ show });
}
