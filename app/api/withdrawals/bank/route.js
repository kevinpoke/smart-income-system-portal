import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentAccountRaw } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { maskBankInfo, validateBankInfo } from "@/lib/bank";
import { hasModuleAccess } from "@/lib/moduleAccess";

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
export async function GET() {
  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const locked = !hasModuleAccess(account);
  const db = getDb();
  const row = db.prepare(`SELECT * FROM bank_accounts WHERE account_id = ?`).get(account.id);
  return NextResponse.json({ locked, bank: maskBankInfo(row) });
}

export async function POST(request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
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

  const db = getDb();
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

