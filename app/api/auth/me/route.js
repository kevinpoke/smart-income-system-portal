import { NextResponse } from "next/server";
import { getCurrentAccountRaw, toPublicAccount } from "@/lib/session";
import { getDb } from "@/lib/db";
import { checkAndAutoApproveIsp } from "@/lib/ispEngine";

// Production feature/fix batch: this is the request every page load and
// every useAccount() refetch goes through, which makes it the correct
// single place to run the server-authoritative ISP 3-day auto-approval
// check (see lib/ispEngine.js#checkAndAutoApproveIsp) -- no cron/timer
// needed, an account overdue for auto-approval is promoted on the very
// next time anything asks "who is this account" for it, including one
// that was already overdue at deploy time.
export async function GET() {
  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ account: null }, { status: 200 });
  }
  const db = getDb();
  const fresh = checkAndAutoApproveIsp(db, account);
  return NextResponse.json({ account: toPublicAccount(fresh) });
}
