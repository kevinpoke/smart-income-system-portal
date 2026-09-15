import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { listNeverLoggedIn3Day } from "@/lib/neverLoggedIn";

// ANALYTICS/SUPPORT/BRIDGE batch: admin-only read endpoint for the
// durable Never-Logged-In-By-Day-3 list (see lib/db.js
// admin_never_logged_in_3day table + lib/neverLoggedIn.js for the
// population/read logic). Supports ?search=<email text>,
// ?page= (1-indexed, default 1), ?pageSize= (default 50). Backend-only
// for this batch -- no UI page consumes this yet.
export async function GET(request) {
  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const { searchParams } = new URL(request.url);
  const search = searchParams.get("search") || "";

  const rawPage = Number.parseInt(searchParams.get("page"), 10);
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;

  const rawPageSize = Number.parseInt(searchParams.get("pageSize"), 10);
  const pageSize = Number.isInteger(rawPageSize) && rawPageSize > 0 ? rawPageSize : 50;

  const db = getDb();
  const { rows, totalCount } = listNeverLoggedIn3Day(db, { search, page, pageSize });

  return NextResponse.json({ rows, totalCount, page, pageSize });
}
