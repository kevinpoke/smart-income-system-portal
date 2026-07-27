import { NextResponse } from "next/server";
import { getCurrentAccountRaw } from "@/lib/session";
import { computeWaitlistStatus } from "@/lib/waitlistEngine";

// Authenticated customer's own waitlist status. Derived entirely from
// SQLite (accounts.first_login_at / waitlist_joined_at) via the session --
// there is no account id parameter anywhere in this route, so a customer
// can never read another customer's waitlist state.
export async function GET() {
  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const status = computeWaitlistStatus(account);
  return NextResponse.json({ status });
}
