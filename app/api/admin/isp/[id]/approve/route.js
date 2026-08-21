import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { generateId } from "@/lib/auth-crypto";
import { transitionIspToApproved } from "@/lib/ispEngine";

// Admin approves a pending ISP setup. Per Phase 2 spec this:
// - overrides the 3-day timer immediately (moves state forward regardless
//   of elapsed time)
// - sets isp_status = 'approved_awaiting_user'
// - sets isp_approved_at (once)
// - does NOT activate earnings and does NOT mark the WiFi as connected --
//   only the customer's own "I Approve" click (app/api/isp/authorize) may
//   do that.
// Audited: every admin ISP approval writes an audit_log row.
//
// Production feature/fix batch: the actual state transition (isp_status,
// isp_approved_at, the new isp_unread flag, and the one-time
// ISP_APPROVED_MESSAGE) now lives in the single shared
// lib/ispEngine.js#transitionIspToApproved(), also used by the fully
// automatic 3-day timeout (checkAndAutoApproveIsp) -- this route no
// longer duplicates that UPDATE inline, so manual and automatic approval
// can never drift out of sync with each other.
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

  if (target.isp_status !== "pending_review") {
    return NextResponse.json(
      { error: "This account is not currently pending ISP review." },
      { status: 409 }
    );
  }

  const before = {
    isp_status: target.isp_status,
    isp_approved_at: target.isp_approved_at,
  };

  const result = transitionIspToApproved(db, targetId, { approvedBy: guard.account.id });

  if (!result.transitioned) {
    // Lost a race against a concurrent approval (manual or auto) between
    // our pending_review check above and the transition attempt -- same
    // 409 shape as the pre-existing check, since from the caller's point
    // of view nothing they can do here changes: the account is simply no
    // longer pending.
    return NextResponse.json(
      { error: "This account is not currently pending ISP review." },
      { status: 409 }
    );
  }

  const after = {
    isp_status: result.account.isp_status,
    isp_approved_at: result.account.isp_approved_at,
  };

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO audit_log (id, admin_account_id, target_account_id, action, before_json, after_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    generateId("audit"),
    guard.account.id,
    targetId,
    "isp_approval",
    JSON.stringify(before),
    JSON.stringify(after),
    now
  );

  const updated = db.prepare(`SELECT id, email, name, isp_status, isp_approved_at FROM accounts WHERE id = ?`).get(targetId);

  return NextResponse.json({ ok: true, account: updated });
}
