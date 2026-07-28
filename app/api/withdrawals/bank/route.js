import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentAccountRaw } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { maskBankInfo, validateBankInfo } from "@/lib/bank";

// Customer's own bank info for withdrawals. GET returns only the masked
// (last-4) representation -- full routing/account numbers are never
// serialized in any API response. POST saves/updates it, always scoped to
// the authenticated session's own account id (never a client-supplied id).
export async function GET() {
  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const db = getDb();
  const row = db.prepare(`SELECT * FROM bank_accounts WHERE account_id = ?`).get(account.id);
  return NextResponse.json({ bank: maskBankInfo(row) });
}

export async function POST(request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
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
