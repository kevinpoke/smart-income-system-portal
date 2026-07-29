import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getCurrentAccountRaw, toPublicAccount } from "@/lib/session";
import { isSameOrigin } from "@/lib/csrf";
import { validateUploadFile, saveAvatarUpload, deleteAvatarIfLocal } from "@/lib/uploads";

// Authenticated account's own profile-photo upload. Accepts a
// multipart/form-data body with a single "photo" field. Always scoped to
// the session's own account id -- customers may only update their own
// photo, and an admin using this same route only ever updates their own
// admin photo (see app/api/profile/route.js for the same scoping rule
// applied to name fields).
//
// Safeguards:
// - MIME type is validated against a real allow-list (JPG/PNG/WebP),
//   never trusted from the client-supplied filename extension.
// - Size is capped at 5 MB.
// - The stored filename is server-generated (accountId + random hex),
//   never derived from the client's filename -- this makes path
//   traversal structurally impossible (see lib/uploads.js for the
//   defensive resolved-path check as well).
// - The raw image bytes are written to a local, gitignored uploads
//   directory (public/uploads/avatars/) -- NEVER base64-encoded into
//   SQLite. Only the resulting safe public URL is persisted.
// - The previous photo file (if any, and if it was a local upload) is
//   deleted after a successful replace so orphaned files don't
//   accumulate.
export async function POST(request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const account = await getCurrentAccountRaw();
  if (!account) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid upload request." }, { status: 400 });
  }

  const file = formData.get("photo");
  const validationError = validateUploadFile(file);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const publicUrl = await saveAvatarUpload(account.id, file);

  const db = getDb();
  const previous = db
    .prepare(`SELECT profile_photo_url FROM accounts WHERE id = ?`)
    .get(account.id);
  db.prepare(`UPDATE accounts SET profile_photo_url = ? WHERE id = ?`).run(publicUrl, account.id);

  if (previous?.profile_photo_url && previous.profile_photo_url !== publicUrl) {
    deleteAvatarIfLocal(previous.profile_photo_url);
  }

  const updated = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(account.id);
  return NextResponse.json({ ok: true, account: toPublicAccount(updated) });
}
