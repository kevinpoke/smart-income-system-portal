import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentAccountRaw } from "@/lib/session";
import { computeEarningsSummary } from "@/lib/earningsEngine";

// Authenticated customer's own earnings summary, entirely SQLite-backed.
// GET (not a mutation) but still triggers idempotent catch-up ledger
// writes as a side effect -- that's intentional per the "write periodic or
// login-time catch-up ledger events" requirement, and is safe precisely
// because the writes are idempotent (UNIQUE(account_id, source_reference)).
export async function GET() {
  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const db = getDb();
  const summary = computeEarningsSummary(db, account.id);

  return NextResponse.json({ summary });
}
