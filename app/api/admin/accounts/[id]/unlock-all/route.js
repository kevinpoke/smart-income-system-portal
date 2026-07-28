import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { generateId } from "@/lib/auth-crypto";

// Dashboard adjustment pass: "Unlock All Modules" is now a PER-CUSTOMER
// admin action, not a global bulk operation -- this replaces the old
// global POST /api/admin/accounts/unlock-all route entirely (removed).
// Only the single account identified by [id] is affected; every other
// customer's modules_unlocked flag is left completely untouched.
//
// Security: requireAdmin() re-verifies the acting admin server-side from
// the session (never a client-supplied role/id). The target account id
// comes from the URL path (validated to exist and be a customer below),
// never trusted from the request body. Guards against targeting an
// invalid/deleted account by checking the row exists and is a customer
// before writing anything.
export async function POST(request, { params }) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const { id } = await params;
  const db = getDb();

  const target = db.prepare(`SELECT id, email, name, role, modules_unlocked FROM accounts WHERE id = ?`).get(id);
  if (!target) {
    return NextResponse.json({ error: "Account not found." }, { status: 404 });
  }
  if (target.role !== "customer") {
    return NextResponse.json(
      { error: "Unlock All Modules only applies to customer accounts." },
      { status: 400 }
    );
  }

  db.exec("BEGIN");
  try {
    db.prepare(`UPDATE accounts SET modules_unlocked = 1 WHERE id = ?`).run(id);
    db.prepare(
      `INSERT INTO audit_log (id, admin_account_id, target_account_id, action, before_json, after_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      generateId("audit"),
      guard.account.id,
      id,
      "unlock_all_modules",
      JSON.stringify({ modulesUnlocked: Boolean(target.modules_unlocked) }),
      JSON.stringify({ modulesUnlocked: true }),
      new Date().toISOString()
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const updated = db.prepare(`SELECT id, email, name, modules_unlocked FROM accounts WHERE id = ?`).get(id);

  return NextResponse.json({
    ok: true,
    message: `All modules unlocked for ${updated.email}.`,
    account: {
      id: updated.id,
      email: updated.email,
      name: updated.name,
      modulesUnlocked: Boolean(updated.modules_unlocked),
    },
  });
}
