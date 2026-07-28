import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { generateId } from "@/lib/auth-crypto";
import { recomputeAndGetBalance } from "@/lib/adminLedger";

// Admin adjusts a customer's balance as an AUDITABLE ledger entry (never
// a silent overwrite of current_balance_cents). event_type is
// 'admin_credit' or 'admin_debit' per the schema comment in lib/db.js.
// Requires a non-empty reason. Rejects a debit that would push the
// account's resulting balance negative (this app's existing business rule
// per accounts.current_balance_cents never going below 0 elsewhere).
export async function POST(request, { params }) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const { id: targetId } = await params;
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const amountCents = Number(body.amountCents);
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";

  if (!Number.isFinite(amountCents) || amountCents === 0 || !Number.isInteger(amountCents)) {
    return NextResponse.json(
      { error: "A non-zero whole-cent amount is required." },
      { status: 400 }
    );
  }
  if (!reason) {
    return NextResponse.json({ error: "A reason is required." }, { status: 400 });
  }

  const db = getDb();
  const target = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(targetId);
  if (!target) {
    return NextResponse.json({ error: "Account not found." }, { status: 404 });
  }

  const eventType = amountCents > 0 ? "admin_credit" : "admin_debit";
  const magnitudeCents = Math.abs(amountCents);
  const resultingBalance = target.current_balance_cents + amountCents;

  if (resultingBalance < 0) {
    return NextResponse.json(
      { error: "This adjustment would result in a negative balance, which is not allowed." },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();
  const ledgerId = generateId("ledger");

  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO ledger_entries
         (id, account_id, event_type, base_amount_cents, multiplier, final_amount_cents, effective_date, created_at, source_reference, metadata_json)
       VALUES (?, ?, ?, ?, 1.0, ?, ?, ?, ?, ?)`
    ).run(
      ledgerId,
      targetId,
      eventType,
      magnitudeCents,
      magnitudeCents,
      now.slice(0, 10),
      now,
      `admin:${ledgerId}`,
      JSON.stringify({ reason, adminAccountId: guard.account.id })
    );

    db.prepare(
      `INSERT INTO audit_log (id, admin_account_id, target_account_id, action, before_json, after_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      generateId("audit"),
      guard.account.id,
      targetId,
      "balance_adjustment",
      JSON.stringify({ current_balance_cents: target.current_balance_cents }),
      JSON.stringify({ amountCents, eventType, reason }),
      now
    );

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const newBalance = recomputeAndGetBalance(db, targetId);

  return NextResponse.json({ ok: true, currentBalanceCents: newBalance });
}
