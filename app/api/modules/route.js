import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentAccountRaw } from "@/lib/session";
import { computeModuleStatuses } from "@/lib/moduleEngine";
import { MODULES_META } from "@/lib/mockData";

// Authenticated customer's own persisted training-module progression.
// Always scoped to the session's own account id -- there is no account
// id parameter anywhere in this route, so a customer can never read
// another customer's module progress.
export async function GET() {
  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const db = getDb();
  const statuses = computeModuleStatuses(db, account);

  return NextResponse.json({
    modulesUnlocked: Boolean(account.modules_unlocked),
    modules: statuses.map((s) => {
      const meta = MODULES_META.find((m) => m.id === s.id);
      return { ...s, title: meta?.title, description: meta?.description, duration: meta?.duration };
    }),
  });
}
