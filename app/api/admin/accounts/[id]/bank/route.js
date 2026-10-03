import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { generateId } from "@/lib/auth-crypto";
import { maskBankInfoForAdmin, validateAdminBankField } from "@/lib/bank";

// BANK-INTERNATIONAL batch (Part D): admin-only view/edit of a customer's
// bank information, reusing the SAME existing bank_accounts row/model as
// the customer's own self-service route (app/api/withdrawals/bank) --
// never a second/parallel bank-profile table or endpoint family. Lives
// in the existing per-account admin route namespace
// (app/api/admin/accounts/[id]/...), mirroring set-password/balance/
// remove-bank's exact same security pattern, so User Management stays
// the ONE admin location bank information is viewed/edited from (no
// second Admin user-management page/section is created).
//
// GET returns the masked projection (maskBankInfoForAdmin -- same
// last-4 + presence-flag shape as the customer-facing maskBankInfo(),
// see lib/bank.js) -- the Admin UI never receives a raw account/
// routing/swift/iban value, matching the existing "Set Password" UX
// pattern of blank inputs that OVERWRITE rather than pre-filled secrets.
//
// POST is INTENTIONALLY more permissive than the customer route: each of
// fullName/address/accountNumber/routingNumber/swift/iban is
// independently optional. The request body may include any subset of
// these keys; a key that is OMITTED entirely leaves that column
// untouched, while a key present with value "" explicitly CLEARS it
// (see lib/bank.js validateAdminBankField -- an empty string is always
// valid for Admin). There is no domestic-pair or international-pair
// requirement here at all -- see spec Part D "CRITICAL ADMIN
// REQUIREMENT": Admin can save just one field, any 2/3 fields, all 4, or
// clear any individual field.
//
// Security (mirrors every other admin per-account mutation route in this
// app exactly -- set-password/remove-bank/balance are the closest
// precedents):
// - same-origin/CSRF check before any auth/DB work
// - requireAdmin() re-verifies the acting admin server-side from session
// - target account must exist and be a customer (bank info is a
//   customer-only concept, same restriction remove-bank already enforces)
// - audit_log records ONLY safe metadata (which field KEYS changed, never
//   any account/routing/swift/iban VALUE, not even redacted/partial --
//   per spec Part B/Security: "log only safe metadata such as 'bank info
//   updated, fields changed', not the actual values")
export async function GET(_request, { params }) {
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
      { error: "Bank information only applies to customer accounts." },
      { status: 400 }
    );
  }

  const row = db.prepare(`SELECT * FROM bank_accounts WHERE account_id = ?`).get(targetId);
  return NextResponse.json({ bank: maskBankInfoForAdmin(row) });
}

// Every field the admin's request body includes is independently
// trimmed/validated via lib/bank.js validateAdminBankField(); fields the
// body omits are left completely untouched in the DB (read from the
// existing row first, see below). fullName/address, when provided, only
// require non-empty-after-trim (same as the customer route) -- they are
// never treated as "paired" with anything.
const EDITABLE_FIELDS = [
  ["fullName", "full_name"],
  ["address", "address"],
  ["accountNumber", "account_number"],
  ["routingNumber", "routing_number"],
  ["swift", "swift"],
  ["iban", "iban"],
];

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
      { error: "Bank information only applies to customer accounts." },
      { status: 400 }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  // Validate every field PRESENT in the body (fullName/address use the
  // same "must be non-empty text" rule as the customer route when
  // provided; account/routing/swift/iban go through
  // validateAdminBankField, which allows "" as an explicit clear).
  const updates = {};
  for (const [bodyKey, column] of EDITABLE_FIELDS) {
    if (!(bodyKey in body)) continue; // omitted key -- leave this column untouched
    if (bodyKey === "fullName" || bodyKey === "address") {
      if (typeof body[bodyKey] !== "string" || !body[bodyKey].trim()) {
        return NextResponse.json(
          { error: `Field "${bodyKey}" cannot be blank.` },
          { status: 400 }
        );
      }
      updates[column] = body[bodyKey].trim();
    } else {
      const result = validateAdminBankField(bodyKey, body[bodyKey]);
      if (!result.ok) {
        return NextResponse.json({ error: result.message }, { status: 400 });
      }
      updates[column] = result.value;
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No bank fields provided to update." }, { status: 400 });
  }

  const now = new Date().toISOString();
  const existing = db.prepare(`SELECT * FROM bank_accounts WHERE account_id = ?`).get(targetId);

  // Merge: any column NOT present in `updates` keeps its existing value
  // (or a safe default for a brand-new row an admin is creating from
  // scratch with, say, only SWIFT -- fullName/address/routing/account
  // default to "" exactly like a first-time customer international-only
  // save would, never a fabricated placeholder).
  const merged = {
    full_name: updates.full_name ?? existing?.full_name ?? "",
    address: updates.address ?? existing?.address ?? "",
    account_number: updates.account_number ?? existing?.account_number ?? "",
    routing_number: updates.routing_number ?? existing?.routing_number ?? "",
    swift: updates.swift ?? existing?.swift ?? "",
    iban: updates.iban ?? existing?.iban ?? "",
  };

  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO bank_accounts (account_id, full_name, address, routing_number, account_number, swift, iban, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         full_name = excluded.full_name,
         address = excluded.address,
         routing_number = excluded.routing_number,
         account_number = excluded.account_number,
         swift = excluded.swift,
         iban = excluded.iban,
         updated_at = excluded.updated_at`
    ).run(
      targetId,
      merged.full_name,
      merged.address,
      merged.routing_number,
      merged.account_number,
      merged.swift,
      merged.iban,
      now
    );

    // SECURITY: audit log records ONLY which field keys were touched and
    // whether this was a create vs an update -- NEVER any actual
    // account/routing/swift/iban value, not even redacted/partial/last-4
    // (per spec: "not the actual account/routing/SWIFT/IBAN values").
    const changedFields = EDITABLE_FIELDS.filter(([bodyKey]) => bodyKey in body).map(([bodyKey]) => bodyKey);
    db.prepare(
      `INSERT INTO audit_log (id, admin_account_id, target_account_id, action, before_json, after_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      generateId("audit"),
      guard.account.id,
      targetId,
      "admin_bank_info_updated",
      JSON.stringify({ bankConfigured: Boolean(existing) }),
      JSON.stringify({ fieldsChanged: changedFields }),
      now
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const row = db.prepare(`SELECT * FROM bank_accounts WHERE account_id = ?`).get(targetId);
  return NextResponse.json({ ok: true, bank: maskBankInfoForAdmin(row) });
}
