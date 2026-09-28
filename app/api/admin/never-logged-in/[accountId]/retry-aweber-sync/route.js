import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { syncThreeDayNoLoginToAweber } from "@/lib/aweberSync";

// AWEBER-3DAY-NO-LOGIN-SYNC batch: admin-only manual "Retry AWeber Sync"
// action (spec section 23 -- "simple and safe... Automatic scheduler
// remains the primary mechanism"). Calls the SAME canonical
// syncThreeDayNoLoginToAweber() function the background scheduler uses
// -- no separate/duplicated retry logic -- so a manual retry behaves
// identically to (and is just as idempotent as) a scheduler tick
// picking this account up again. Scoped to ONE account per call; the
// admin UI's Retry button targets a single row.
export async function POST(request, { params }) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const { accountId } = await params;
  if (typeof accountId !== "string" || !accountId.trim()) {
    return NextResponse.json({ error: "Invalid account id." }, { status: 400 });
  }

  const db = getDb();
  const account = db.prepare(`SELECT id, email FROM accounts WHERE id = ?`).get(accountId);
  if (!account) {
    return NextResponse.json({ error: "Account not found." }, { status: 404 });
  }

  // AWEBER-3DAY-NO-LOGIN-SYNC batch (post-review fix): a genuine AWeber
  // API/auth failure (invalid/expired credentials, network outage, rate
  // limit) must surface as a clean, safe JSON error response -- never an
  // uncaught exception that becomes a framework-level 500 with no body.
  // syncThreeDayNoLoginToAweber() already durably records the failure on
  // the account's own sync row (status/last_error) for the admin UI to
  // display; this catch only prevents that same failure from ALSO
  // crashing this one request. Never includes the raw error object or
  // any token/credential value in the response -- only a generic,
  // human-readable message.
  try {
    const result = await syncThreeDayNoLoginToAweber(db, account);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "AWeber sync attempt failed. See the account's status for details." },
      { status: 502 }
    );
  }
}
