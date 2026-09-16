import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { listAllNeverLoggedIn3Day } from "@/lib/neverLoggedIn";
import { buildCsv } from "@/lib/csv";

// NEVER-LOGGED-IN-EXPORT batch: admin-only CSV export of the ENTIRE
// permanent Never-Logged-In-By-Day-3 cohort (spec section A). Uses the
// exact same requireAdmin() guard every other admin-only route in this
// codebase uses -- a non-admin or unauthenticated caller gets 401/403,
// never a customer-reachable path (there is no client-side link to this
// route anywhere outside the admin Never Logged In page).
//
// "Export All always exports the entire permanent cohort" (spec's
// preferred implementation): this route intentionally does NOT read
// ?page=/?pageSize= at all, so the admin UI's current pagination state
// can never limit what gets exported -- listAllNeverLoggedIn3Day() has
// no LIMIT/OFFSET in its SQL, so this is structurally guaranteed, not
// merely "a very large page size." An optional ?search= is honored
// (only reachable via a hypothetical future "Export Filtered Results"
// button, per spec -- the current UI's "Export All" button never sends
// it), matching the read-list route's own search semantics.
//
// Columns (spec's preferred set): Email, Joined Date, First Login,
// Qualified Date. Email prefers the account's CURRENT email (falls back
// to the frozen email_snapshot only if the live account row is somehow
// missing that field) -- same "prefer live, fall back to snapshot"
// precedent the admin UI table itself already uses. First Login shows
// the literal word "Never" when the account has still never logged in
// (spec: "For First Login: if NULL: Never"); if they eventually did log
// in after qualifying for this permanent cohort, the real timestamp is
// shown, per spec ("they remain permanently in this cohort" either way).
// No passwords, login links, tokens, or bank info are ever included --
// only cohort-relevant, already-admin-visible fields.
export async function GET(request) {
  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const { searchParams } = new URL(request.url);
  const search = searchParams.get("search") || "";

  const db = getDb();
  const rows = listAllNeverLoggedIn3Day(db, { search });

  const headers = ["Email", "Joined Date", "First Login", "Qualified Date"];
  const csvRows = rows.map((r) => [
    r.currentEmail || r.emailSnapshot || "",
    r.createdAtSnapshot || "",
    r.currentFirstLoginAt || "Never",
    r.qualifiedAt || "",
  ]);

  const csv = buildCsv(headers, csvRows);

  const dateStamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const filename = `never-logged-in-emails-${dateStamp}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
