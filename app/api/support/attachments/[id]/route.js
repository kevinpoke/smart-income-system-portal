import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentAccountRaw } from "@/lib/session";
import { readSupportImage } from "@/lib/supportUploads";

// Authenticated Support Chat image retrieval (spec Part 10 / 22).
//
// - Never a static/public file path -- this is the ONLY way to read a
//   support image's bytes back, so access control is enforced on every
//   single fetch, not just at upload time.
// - Customers may only retrieve an attachment that belongs to a message
//   inside THEIR OWN conversation (looked up via the authenticated
//   session's account id -- never a client-supplied account/conversation
//   id anywhere in this route).
// - Admins may retrieve any attachment (mirrors the existing admin
//   Support authorization model -- requireAdmin() style role check).
// - The :id path parameter is the attachment's own opaque database id
//   (support_message_attachments.id, a generateId("att") value) -- never
//   the storage filename/key, so no filesystem path is ever exposed to
//   the client, and no path-traversal input can reach the filesystem
//   lookup (lib/supportUploads.js#readSupportImage() looks up the real
//   storage_key server-side by this id, not from anything client-typed).
export async function GET(request, { params }) {
  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const { id: attachmentId } = await params;
  const db = getDb();

  const row = db
    .prepare(
      `SELECT att.id, att.storage_key, att.mime_type, c.account_id
       FROM support_message_attachments att
       JOIN support_messages m ON m.id = att.message_id
       JOIN conversations c ON c.id = m.conversation_id
       WHERE att.id = ?`
    )
    .get(attachmentId);

  if (!row) {
    return NextResponse.json({ error: "Attachment not found." }, { status: 404 });
  }

  const isOwner = account.role !== "admin" && row.account_id === account.id;
  const isAdmin = account.role === "admin";
  if (!isOwner && !isAdmin) {
    // Deliberately the same 404 as "not found" (rather than 403) so an
    // unauthorized customer can't use the response code to enumerate
    // which attachment ids exist for other customers.
    return NextResponse.json({ error: "Attachment not found." }, { status: 404 });
  }

  const bytes = readSupportImage(row.storage_key);
  if (!bytes) {
    return NextResponse.json({ error: "Attachment not found." }, { status: 404 });
  }

  return new NextResponse(bytes, {
    status: 200,
    headers: {
      "Content-Type": row.mime_type,
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Length": String(bytes.length),
    },
  });
}
