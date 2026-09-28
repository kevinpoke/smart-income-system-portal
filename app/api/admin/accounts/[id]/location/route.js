import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { generateId } from "@/lib/auth-crypto";
import { toPublicAccount } from "@/lib/authz";
import { normalizeCity, resolveAdminStateInput, OTHER_STATE_CODE } from "@/lib/locationNormalize";

// Admin-only editor for a customer's canonical ISP City/State
// (User Management inline location edit). Writes DIRECTLY to
// accounts.isp_city/isp_state(/isp_state_is_other/isp_state_other_text)
// -- the SAME columns every other consumer in this app already reads
// live (ISP Setup, Dashboard, Header, Nodes Location, Payouts Location,
// hasPayoutsNodesAccess()). There is no second/duplicate location store
// to keep in sync: because every one of those consumers re-reads
// accounts.isp_city/isp_state fresh on every request (never cached),
// this single write immediately and automatically propagates
// everywhere, including the Payouts/Nodes lock recalculation
// (lib/moduleAccess.js hasPayoutsNodesAccess), without any extra
// plumbing.
//
// Uses the EXACT SAME lib/locationNormalize.js functions the customer-
// facing ISP Setup submission route uses (app/api/isp/submit) -- "do
// not maintain separate formatting logic in multiple routes."
//
// ADMIN-CUSTOM-LOCATION-EDITING batch: this route previously only
// accepted a real two-letter US_STATES code, forcibly clearing any
// existing Other marker on every save (see the git history for the
// prior "OTHER-STATE-ISP batch (post-review fix)" note -- kept here for
// context since the OLD behavior is explicitly what this batch
// replaces). Per spec sections 8-10, Admin must now be able to enter
// ANY reasonable custom City/State text (e.g. "Panama", "British
// Columbia", "Hong Kong", "New South Wales", "Mexico City"), not just a
// US two-letter code:
//   - If the typed State resolves to a genuine canonical US_STATES code
//     (case-insensitive two-letter match), it is stored as a NORMAL
//     State: isp_state = <code>, isp_state_is_other = 0,
//     isp_state_other_text = NULL (exactly the prior behavior for this
//     case -- a real code always wins/clears any stale Other marker).
//   - Otherwise, the typed text is stored via the SAME custom/Other
//     architecture the customer-facing "Other" ISP Setup flow already
//     uses: isp_state = OTHER_STATE_CODE ("OTHER"), isp_state_is_other
//     = 1, isp_state_other_text = the title-cased normalized custom
//     text (via resolveAdminStateInput -> normalizeCustomLocationText,
//     the SAME shared capitalization rule normalizeCity() uses -- "do
//     not maintain separate capitalization implementations"). This is
//     what lets Analytics keep a durable, authoritative Other
//     classification (isp_state_is_other = 1) while every other
//     display surface shows the admin's typed text verbatim via
//     lib/locationNormalize.js#displayLocationState().
//
// Explicitly scoped to ONLY isp_city/isp_state(/is_other/other_text):
// never touches balances, module progress, ISP status/timestamps,
// owned Nodes, payout countdowns, or account_status. Admin-only
// (requireAdmin() -> 403 for a customer), CSRF-checked, parameterized
// SQL, audit-logged with before/after values, and returns only the
// safe public account shape (toPublicAccount() -- never a raw row,
// never password hash/salt).
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
  const stateResolution = resolveAdminStateInput(rawState);

  if (!normalizedCity) {
    return NextResponse.json({ error: "City is required." }, { status: 400 });
  }
  if (!stateResolution.valid) {
    return NextResponse.json(
      { error: "State is required." },
      { status: 400 }
    );
  }

  const isOther = stateResolution.isOther;
  const storedState = isOther ? OTHER_STATE_CODE : stateResolution.value;
  const storedOtherText = isOther ? stateResolution.value : null;

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

  const before = {
    ispCity: target.isp_city,
    ispState: target.isp_state,
    ispStateIsOther: Boolean(target.isp_state_is_other),
    ispStateOtherText: target.isp_state_other_text,
  };
  const after = {
    ispCity: normalizedCity,
    ispState: storedState,
    ispStateIsOther: isOther,
    ispStateOtherText: storedOtherText,
  };

  db.exec("BEGIN");
  try {
    // ADMIN-CUSTOM-LOCATION-EDITING batch: an admin explicitly setting a
    // State via this editor -- whether a real code or a custom Other
    // region -- IS an explicit change to the account's location, so this
    // always writes a fully consistent combination of all four columns
    // together (never leaves isp_state_is_other/isp_state_other_text
    // stale or contradicting the isp_state value just written).
    db.prepare(
      `UPDATE accounts SET isp_city = ?, isp_state = ?, isp_state_is_other = ?, isp_state_other_text = ? WHERE id = ?`
    ).run(normalizedCity, storedState, isOther ? 1 : 0, storedOtherText, targetId);
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
