import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { deleteTag } from "@/lib/supportEngine";
import { generateId } from "@/lib/auth-crypto";

// Permanently deletes a support tag (admin-only). Removes the tag AND
// every conversation_tags mapping referencing it in one transaction --
// conversations and their messages are never touched (see
// lib/supportEngine.js deleteTag()). Idempotent: deleting an id that no
// longer exists (e.g. a duplicate/retried request) returns 200 with
// deleted: false rather than erroring, so a double-click can't surface
// an error to the admin.
export async function DELETE(request, { params }) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const guard = await requireAdmin();
  if (!guard.account) {
    return NextResponse.json({ error: guard.errorMessage }, { status: guard.errorStatus });
  }

  const { id } = await params;
  const db = getDb();
  const result = deleteTag(db, id);

  if (!result.deleted) {
    // Not found is treated as an already-successful delete for
    // idempotency -- the end state (tag gone) matches what the caller
    // wanted either way.
    return NextResponse.json({ ok: true, deleted: false });
  }

  db.prepare(
    `INSERT INTO audit_log (id, admin_account_id, target_account_id, action, before_json, after_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    generateId("audit"),
    guard.account.id,
    null,
    "delete_support_tag",
    JSON.stringify({ tagId: result.tag.id, tagName: result.tag.name }),
    JSON.stringify({ deleted: true }),
    new Date().toISOString()
  );

  return NextResponse.json({ ok: true, deleted: true });
}
