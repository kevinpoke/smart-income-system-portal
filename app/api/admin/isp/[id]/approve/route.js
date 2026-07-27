import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { generateId } from "@/lib/auth-crypto";

// Admin approves a pending ISP setup. Per Phase 2 spec this:
// - overrides the 3-day timer immediately (moves state forward regardless
//   of elapsed time)
// - sets isp_status = 'approved_awaiting_user'
// - sets isp_approved_at (once)
// - does NOT activate earnings and does NOT mark the WiFi as connected --
//   only the customer's own "I Approve" click (app/api/isp/authorize) may
//   do that.
// Audited: every admin ISP approval writes an audit_log row.
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

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE accounts
     SET isp_status = 'approved_awaiting_user',
         isp_approved_at = COALESCE(isp_approved_at, ?)
     WHERE id = ?`
  ).run(now, targetId);

  const after = { isp_status: "approved_awaiting_user", isp_approved_at: target.isp_approved_at || now };

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
