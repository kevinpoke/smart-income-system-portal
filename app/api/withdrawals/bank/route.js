import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentAccountRaw } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { maskBankInfo, validateBankInfo } from "@/lib/bank";
import { hasModuleAccess, hasPayoutAccess } from "@/lib/moduleAccess";

// Customer's own bank info for withdrawals. GET returns only the masked
// (last-4) representation -- full routing/account numbers are never
// serialized in any API response. POST saves/updates it, always scoped to
// the authenticated session's own account id (never a client-supplied id).
//
// Portal reliability pass: Withdrawals is one of the sections the admin's
// per-customer "Unlock All Modules" override is meant to control (see
// lib/moduleAccess.js hasModuleAccess(), the SAME helper used by
// /api/nodes and /api/payouts/estimates) -- a customer without an active
// Node and without the admin override cannot yet save bank info or see
// the payout countdown here. GET additionally returns `locked` so the
// page can render the shared "Location Required" card instead of the
// bank-info form.
//
// Admin/module/withdrawal/dashboard fix batch: Withdrawals now has a
// SECOND, independent, ADDITIONAL gate on top of the existing
// hasModuleAccess() ISP-setup requirement -- the customer must have
// ACTUALLY COMPLETED Module 10 ("How Payouts Work"), per
// hasPayoutAccess()/lib/moduleEngine.js isModuleCompleted(), the SAME
// shared helper/table the Payouts page already uses
// (app/api/payouts/estimates/route.js). This is deliberately the SAME
// function, not a re-implementation, so both consumers can never
// disagree about what counts as "Module 10 complete."
//
// CRITICAL: the admin's per-customer "Unlock All Modules" TIMING
// override (accounts.modules_unlocked) must NEVER satisfy this gate --
// hasPayoutAccess() only ever reads account_module_progress.completed_at
// (real completion), and never reads/considers modules_unlocked at all,
// so a customer under the admin override who has NOT clicked "Mark as
// Watched" on Module 10 remains correctly blocked here.
//
// This Module 10 gate is ADDITIONAL to, not a replacement for, the
// existing hasModuleAccess() ISP-setup gate AND the existing 4-calendar-
// month withdrawal eligibility timer (lib/earningsEngine.js
// getPayoutTargetAt(), rendered by the Withdrawals page from
// useEarningsSummary() -- entirely untouched by this change, computed
// completely independently and still enforced on the client's own
// "Next withdrawal available in..." display). Both gates are enforced
// server-side; a request that bypasses the frontend (calling this route
// directly) is still rejected the same way.
const MODULE_10_LOCK_MESSAGE = "Complete Module 10 to unlock";

export async function GET() {
  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const db = getDb();
  const module10Locked = !hasPayoutAccess(db, account);
  const locked = module10Locked || !hasModuleAccess(account);
  const row = db.prepare(`SELECT * FROM bank_accounts WHERE account_id = ?`).get(account.id);
  return NextResponse.json({
    locked,
    module10Locked,
    lockMessage: module10Locked ? MODULE_10_LOCK_MESSAGE : null,
    bank: maskBankInfo(row),
  });
}

export async function POST(request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const db = getDb();

  // Module 10 gate takes priority, per spec ("Module 10 is an ADDITIONAL
  // prerequisite, not a replacement"), and is checked first so a direct
  // API request against this route can never bypass it regardless of
  // ISP-setup state.
  if (!hasPayoutAccess(db, account)) {
    return NextResponse.json({ error: MODULE_10_LOCK_MESSAGE }, { status: 403 });
  }

  if (!hasModuleAccess(account)) {
    return NextResponse.json(
      { error: "Complete your ISP Setup to unlock Withdrawals." },
      { status: 403 }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const validationError = validateBankInfo(body);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO bank_accounts (account_id, full_name, address, routing_number, account_number, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       full_name = excluded.full_name,
       address = excluded.address,
       routing_number = excluded.routing_number,
       account_number = excluded.account_number,
       updated_at = excluded.updated_at`
  ).run(
    account.id,
    body.fullName.trim(),
    body.address.trim(),
    body.routingNumber.trim(),
    body.accountNumber.trim(),
    now
  );

  const row = db.prepare(`SELECT * FROM bank_accounts WHERE account_id = ?`).get(account.id);
  return NextResponse.json({ ok: true, bank: maskBankInfo(row) });
}

