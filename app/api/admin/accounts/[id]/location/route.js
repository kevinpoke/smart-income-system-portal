import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { generateId } from "@/lib/auth-crypto";
import { toPublicAccount } from "@/lib/authz";
import { normalizeCity, normalizeState, isValidStateCode } from "@/lib/locationNormalize";

// Admin-only editor for a customer's canonical ISP City/State
// (User Management inline location edit). Writes DIRECTLY to
// accounts.isp_city/isp_state -- the SAME two columns every other
// consumer in this app already reads live (ISP Setup, Dashboard,
// Header, Nodes Location, Payouts Location, hasPayoutsNodesAccess()).
// There is no second/duplicate location store to keep in sync: because
// every one of those consumers re-reads accounts.isp_city/isp_state
// fresh on every request (never cached), this single write immediately
// and automatically propagates everywhere, including the Payouts/Nodes
// lock recalculation (lib/moduleAccess.js hasPayoutsNodesAccess),
// without any extra plumbing.
//
// Uses the EXACT SAME lib/locationNormalize.js functions the customer-
// facing ISP Setup submission route uses (app/api/isp/submit) -- "do
// not maintain separate formatting logic in multiple routes."
//
// Explicitly scoped to ONLY isp_city/isp_state: never touches balances,
// module progress, ISP status/timestamps, owned Nodes, payout
// countdowns, or account_status. Admin-only (requireAdmin() -> 403 for
// a customer), CSRF-checked, parameterized SQL, audit-logged with
// before/after values, and returns only the safe public account shape
// (toPublicAccount() -- never a raw row, never password hash/salt).
export async function PATCH(request, { params }) {
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

  const rawCity = typeof body.city === "string" ? body.city : "";
  const rawState = typeof body.state === "string" ? body.state : "";

  const normalizedCity = normalizeCity(rawCity);
  const normalizedState = normalizeState(rawState);

  if (!normalizedCity) {
    return NextResponse.json({ error: "City is required." }, { status: 400 });
  }
  if (!isValidStateCode(normalizedState)) {
    return NextResponse.json(
      { error: "State must be a valid two-letter US state code." },
      { status: 400 }
    );
  }

  const db = getDb();
  const target = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(targetId);
  if (!target) {
    return NextResponse.json({ error: "Account not found." }, { status: 404 });
  }
  if (target.role !== "customer") {
    return NextResponse.json(
      { error: "Location editing only applies to customer accounts." },
      { status: 400 }
    );
  }

  const before = { ispCity: target.isp_city, ispState: target.isp_state };
  const after = { ispCity: normalizedCity, ispState: normalizedState };

  db.exec("BEGIN");
  try {
    db.prepare(`UPDATE accounts SET isp_city = ?, isp_state = ? WHERE id = ?`).run(
      normalizedCity,
      normalizedState,
      targetId
    );
    db.prepare(
      `INSERT INTO audit_log (id, admin_account_id, target_account_id, action, before_json, after_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      generateId("audit"),
      guard.account.id,
      targetId,
      "location_edit",
      JSON.stringify(before),
      JSON.stringify(after),
      new Date().toISOString()
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const updated = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(targetId);

  return NextResponse.json({ ok: true, account: toPublicAccount(updated) });
}
