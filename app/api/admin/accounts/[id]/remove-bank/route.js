import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { generateId } from "@/lib/auth-crypto";

// ADMIN-REMOVE-BANK-INFO batch: admin-only action that clears ONLY a
// customer's currently-saved bank/payout destination fields (the single
// bank_accounts row keyed by account_id -- see lib/bank.js/lib/db.js for
// the audited schema: full_name, address, routing_number, account_number,
// updated_at). This is a full DELETE of that one row -- bank_accounts has
// no other columns and no other table has an FK into it (verified: no
// ledger_entries/payout/withdrawal-history table references
// bank_accounts at all -- historical withdrawal/payout records are
// stored independently in ledger_entries and are never joined against
// bank_accounts for display), so removing this row cannot cascade into
// or null out anything else: the account row itself (email, login,
// auth_mode/passwordless vs legacy), earnings/balance/lifetime totals,
// ledger_entries, historical withdrawal/payout amounts, withdrawal/
// payout eligibility timers, Bridges/owned_nodes, ISP state, module
// progress, Support messages, waitlist state, and account_status are ALL
// completely untouched by this route.
//
// After removal, GET /api/withdrawals/bank naturally returns
// `bank: null` again (maskBankInfo(null) === null, see lib/bank.js) --
// the exact same "not configured" shape a customer who never saved bank
// info sees -- so both the customer Withdrawals page and any admin view
// reading that same route immediately reflect "not configured" with no
// separate flag to maintain, and the customer can POST a fresh bank_accounts
// row afterward exactly like a first-time save (ON CONFLICT upsert, per
// that route).
//
// Security (mirrors every other admin mutation route in this app exactly
// -- app/api/admin/accounts/[id]/set-password is the closest precedent):
// - same-origin/CSRF check before any auth/DB work
// - requireAdmin() re-verifies the acting admin server-side from session
// - target account must exist and be a customer
// - audited via the shared audit_log table (admin_account_id,
//   target_account_id, action, timestamp) -- before/after JSON
//   deliberately records ONLY the fact that a bank record existed/was
//   removed, NEVER any routing/account number value (not even a
//   redacted/last-4/partial one), per spec ("explicitly must NOT store
//   bank account number/routing number/any sensitive bank value in the
//   audit entry, even redacted/partial").
export async function POST(request, { params }) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const { id: targetId } = await params;
  const db = getDb();

  const target = db.prepare(`SELECT id, email, role FROM accounts WHERE id = ?`).get(targetId);
  if (!target) {
    return NextResponse.json({ error: "Account not found." }, { status: 404 });
  }
  if (target.role !== "customer") {
    return NextResponse.json(
      { error: "Remove Bank Information only applies to customer accounts." },
      { status: 400 }
    );
  }

  db.exec("BEGIN");
  try {
    const existing = db
      .prepare(`SELECT account_id FROM bank_accounts WHERE account_id = ?`)
      .get(targetId);
    db.prepare(`DELETE FROM bank_accounts WHERE account_id = ?`).run(targetId);

    // Audited regardless of whether a row actually existed (an admin
    // clicking this on an account with no bank info on file is a
    // harmless no-op action, but is still worth a durable audit trail
    // entry showing the action was taken and what its outcome was).
    // Never records any bank field value -- only booleans/metadata.
    db.prepare(
      `INSERT INTO audit_log (id, admin_account_id, target_account_id, action, before_json, after_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      generateId("audit"),
      guard.account.id,
      targetId,
      "remove_bank_information",
      JSON.stringify({ bankConfigured: Boolean(existing) }),
      JSON.stringify({ bankConfigured: false }),
      new Date().toISOString()
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return NextResponse.json({
    ok: true,
    message: `Bank information removed for ${target.email}.`,
  });
}
