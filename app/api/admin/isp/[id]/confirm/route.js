import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { generateId } from "@/lib/auth-crypto";
import { completeIspAuthorization } from "@/lib/ispEngine";

// Admin-only "ISP Confirmation" action: performs the customer's final
// post-verification ISP confirmation/activation step ON THEIR BEHALF, so
// the customer doesn't have to personally return and click their own
// "I Approve" button. This is deliberately NOT a second, parallel
// activation implementation -- it calls the EXACT SAME canonical
// lib/ispEngine.js#completeIspAuthorization() helper that
// POST /api/isp/authorize/complete (the customer-facing route) calls,
// so admin-confirmed and customer-confirmed activations are always
// byte-for-byte the same persisted state: same isp_status transition,
// same user_authorized_at/node_connected_at stamping, same WiFi-on
// initialization, same first owned Node grant via
// lib/ownedNodes.js#addOwnedNode(). Nothing here manipulates a balance,
// timestamp, or Bridge/Node record directly -- see
// lib/ispEngine.js#completeIspAuthorization for the actual mutation.
//
// STATE MACHINE (server-side, never trusts button visibility alone):
//   - Account not found                          -> 404
//   - isp_status already 'active'                 -> 200 idempotent no-op
//     (alreadyActive: true) -- no duplicate Node/earnings-start/audit.
//   - isp_status !== 'approved_awaiting_user'      -> 409 (covers "never
//     submitted", "submitted but not yet admin-approved", and any other
//     state that isn't the correct pre-confirmation stage)
//   - isp_status === 'approved_awaiting_user'      -> proceed
//
// Unlike the customer's own /api/isp/authorize/complete route, this
// admin path does NOT require (or wait for) the 20-second
// isp_authorize_started_at server-verified window, since there is no
// customer-facing "Establishing a Secure Connection..." progress modal
// to honor here -- the admin is deliberately performing the customer's
// final step immediately on their behalf. To satisfy
// completeIspAuthorization()'s own precondition (`isp_authorize_started_at`
// must be set and >= AUTHORIZE_DURATION_MS old), this route seeds/backdates
// that timestamp itself, in the SAME table/column the customer flow uses,
// before calling the shared helper -- it does not bypass or duplicate the
// helper's activation logic, it only satisfies the one precondition that
// only exists because of the customer-facing visual timer, which does not
// apply to an admin-initiated confirmation.
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
  const target = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(targetId);

  if (!target) {
    return NextResponse.json({ error: "Account not found." }, { status: 404 });
  }

  if (target.isp_status === "active") {
    // Idempotent: repeated confirmation after the account is already
    // active is a safe no-op -- no duplicate earnings-start, no
    // duplicate Node, no duplicate audit row.
    return NextResponse.json({
      ok: true,
      alreadyActive: true,
      account: { id: target.id, email: target.email, ispStatus: target.isp_status },
    });
  }

  if (target.isp_status !== "approved_awaiting_user") {
    // Covers: never submitted (not_started), submitted but the existing
    // admin approval step hasn't run yet (pending_review), or any other
    // unexpected state -- ISP Confirmation is only ever valid at exactly
    // the "admin-approved, awaiting the customer's final confirmation"
    // stage.
    return NextResponse.json(
      { error: "This account is not currently awaiting final ISP confirmation." },
      { status: 409 }
    );
  }

  const before = {
    isp_status: target.isp_status,
    isp_authorize_started_at: target.isp_authorize_started_at,
  };

  // Satisfy completeIspAuthorization()'s server-verified-elapsed-time
  // precondition (see lib/ispEngine.js) without reproducing any of its
  // actual state transition: back-date isp_authorize_started_at far
  // enough that the helper's own elapsed-time check passes immediately,
  // exactly the same column/mechanism the customer's own 20-second flow
  // writes to. This does not skip validation -- if the account is not in
  // 'approved_awaiting_user' the guard above already rejected the
  // request, and completeIspAuthorization() independently re-validates
  // the exact same state before doing anything.
  if (!target.isp_authorize_started_at) {
    const backdated = new Date(Date.now() - 60_000).toISOString(); // safely > AUTHORIZE_DURATION_MS (20s)
    db.prepare(`UPDATE accounts SET isp_authorize_started_at = ? WHERE id = ?`).run(backdated, targetId);
  }

  const result = completeIspAuthorization(db, targetId);

  if (!result.ok) {
    // completeIspAuthorization() itself lost a race (e.g. concurrent
    // customer self-confirmation) or found unexpected state between our
    // check above and this call -- surface the same 409 shape rather
    // than partially mutating anything.
    const messages = {
      not_authorizing: "This account is not currently awaiting final ISP confirmation.",
      not_found: "Account not found.",
      too_early: "Please try again in a moment.",
    };
    return NextResponse.json(
      { error: messages[result.reason] || "Unable to complete ISP confirmation." },
      { status: 409 }
    );
  }

  if (result.alreadyActive) {
    // A concurrent customer self-confirmation (or a retried admin click)
    // won the race between our guard check and this call -- safe,
    // idempotent no-op, same shape as the up-front already-active check.
    return NextResponse.json({
      ok: true,
      alreadyActive: true,
      account: { id: result.account.id, email: result.account.email, ispStatus: result.account.isp_status },
    });
  }

  const after = {
    isp_status: result.account.isp_status,
    user_authorized_at: result.account.user_authorized_at,
    node_connected_at: result.account.node_connected_at,
  };

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO audit_log (id, admin_account_id, target_account_id, action, before_json, after_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    generateId("audit"),
    guard.account.id,
    targetId,
    "admin_isp_confirmation",
    JSON.stringify(before),
    JSON.stringify(after),
    now
  );

  const updated = db
    .prepare(`SELECT id, email, name, isp_status, user_authorized_at, node_connected_at FROM accounts WHERE id = ?`)
    .get(targetId);

  return NextResponse.json({ ok: true, account: updated });
}
