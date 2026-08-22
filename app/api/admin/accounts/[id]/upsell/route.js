import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { generateId } from "@/lib/auth-crypto";

// Admin-only editable "Upsell" toggle for the User Management table.
//
// AUTHORITATIVE FIELD: accounts.upsell_purchased (see lib/db.js
// ACCOUNT_COLUMNS). This is a DEDICATED, admin-only manual
// record-keeping flag representing whether the customer actually
// purchased an upsell product/package -- per explicit product
// clarification during this batch, this is a DIFFERENT fact from
// Training Module 3 ("How to Earn More (Upsell)") completion, which
// only indicates the customer watched the upsell pitch video. An
// earlier implementation conflated the two; this route and the
// account_module_progress module-completion system are now fully
// independent -- this route NEVER reads or writes
// account_module_progress, and completing/uncompleting Module 3 never
// touches this column in either direction.
//
// There is currently no automated JVZoo upsell-purchase signal wired up
// (see lib/jvzoo.js APPROVED_PRODUCT_IDS -- only the single base-access
// product is mapped; upsell products are explicitly deferred to a
// future phase), so this value has no verified purchase-detection
// backing yet: it is a plain manual admin toggle for record-keeping,
// editable ONLY through this admin-only route.
export async function POST(request, { params }) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const { id: targetId } = await params;
  if (typeof targetId !== "string" || !targetId.trim()) {
    return NextResponse.json({ error: "Invalid account id." }, { status: 400 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (typeof body.upsell !== "boolean") {
    return NextResponse.json({ error: "upsell must be a boolean." }, { status: 400 });
  }

  const db = getDb();
  const target = db
    .prepare(`SELECT id, email, role, upsell_purchased FROM accounts WHERE id = ?`)
    .get(targetId);
  if (!target) {
    return NextResponse.json({ error: "Account not found." }, { status: 404 });
  }
  if (target.role !== "customer") {
    return NextResponse.json(
      { error: "Upsell editing only applies to customer accounts." },
      { status: 400 }
    );
  }

  const before = { upsellPurchased: Boolean(target.upsell_purchased) };
  const after = { upsellPurchased: Boolean(body.upsell) };

  db.exec("BEGIN");
  try {
    db.prepare(`UPDATE accounts SET upsell_purchased = ? WHERE id = ?`).run(
      body.upsell ? 1 : 0,
      targetId
    );
    db.prepare(
      `INSERT INTO audit_log (id, admin_account_id, target_account_id, action, before_json, after_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      generateId("audit"),
      guard.account.id,
      targetId,
      "admin_upsell_updated",
      JSON.stringify(before),
      JSON.stringify(after),
      new Date().toISOString()
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const updated = db.prepare(`SELECT upsell_purchased FROM accounts WHERE id = ?`).get(targetId);

  return NextResponse.json({ ok: true, upsellCompleted: Boolean(updated.upsell_purchased) });
}
