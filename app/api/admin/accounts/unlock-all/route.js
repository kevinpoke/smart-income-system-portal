import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { generateId } from "@/lib/auth-crypto";

// Admin action: unlock all customer modules at once. Persists a
// per-account modules_unlocked flag (see lib/db.js) that gating logic
// (currently the Nodes page/API) treats as an override regardless of
// isp_status. Does not affect any admin-only route. Confirmation is
// enforced client-side (confirm dialog); this route applies the change
// server-side to every customer account in one transaction and records
// exactly one audit_log row for the bulk action.
export async function POST(request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const db = getDb();

  db.exec("BEGIN");
  try {
    db.prepare(`UPDATE accounts SET modules_unlocked = 1 WHERE role = 'customer'`).run();
    db.prepare(
      `INSERT INTO audit_log (id, admin_account_id, target_account_id, action, before_json, after_json, created_at)
       VALUES (?, ?, NULL, ?, NULL, ?, ?)`
    ).run(
      generateId("audit"),
      guard.account.id,
      "unlock_all_modules",
      JSON.stringify({ modules_unlocked: true }),
      new Date().toISOString()
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return NextResponse.json({ ok: true });
}
