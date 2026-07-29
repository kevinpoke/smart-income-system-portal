import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Server-only helpers for storing an uploaded profile photo safely on
// local disk under public/uploads/avatars/ (gitignored -- see
// .gitignore) and returning only a safe PUBLIC URL. Raw image bytes/
// base64 are NEVER written to SQLite; accounts.profile_photo_url only
// ever stores a path like "/uploads/avatars/<safe-unique-name>.jpg".

const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads", "avatars");
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

const ALLOWED_MIME_TO_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function isAllowedImageType(mimeType) {
  return Object.prototype.hasOwnProperty.call(ALLOWED_MIME_TO_EXT, mimeType);
}

export function maxUploadBytes() {
  return MAX_BYTES;
}

// Validates a File/Blob-like object (from FormData) server-side: real
// MIME type (never trust just the filename extension) and size cap.
// Returns an error string, or null if valid.
export function validateUploadFile(file) {
  if (!file || typeof file.size !== "number") {
    return "No file provided.";
  }
  if (!isAllowedImageType(file.type)) {
    return "Unsupported image type. Please upload a JPG, PNG, or WebP file.";
  }
  if (file.size <= 0) {
    return "The uploaded file is empty.";
  }
  if (file.size > MAX_BYTES) {
    return "Image is too large. Maximum size is 5 MB.";
  }
  return null;
}

// Writes the given bytes to a NEW, safe, unique filename inside the
// avatars upload directory -- never derived from the client-supplied
// filename (which could contain path-traversal sequences like "../"),
// only from a random id plus the extension implied by the SERVER-
// VALIDATED MIME type. Returns the public URL path to store in
// accounts.profile_photo_url.
export async function saveAvatarUpload(accountId, file) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  const ext = ALLOWED_MIME_TO_EXT[file.type];
  // accountId is a server-generated internal id (never raw user input),
  // and randomBytes guarantees uniqueness even for the same account
  // uploading repeatedly -- there is no scenario where this filename can
  // escape UPLOAD_DIR (no path separators are ever included).
  const safeName = `${accountId}-${crypto.randomBytes(8).toString("hex")}.${ext}`;
  const destPath = path.join(UPLOAD_DIR, safeName);

  // Defensive check: resolved destination must stay inside UPLOAD_DIR.
  const resolvedDest = path.resolve(destPath);
  const resolvedDir = path.resolve(UPLOAD_DIR);
  if (!resolvedDest.startsWith(resolvedDir + path.sep)) {
    throw new Error("Resolved upload path escaped the uploads directory.");
  }

  const arrayBuffer = await file.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(arrayBuffer));

  return `/uploads/avatars/${safeName}`;
}

// Best-effort cleanup of a previous avatar file when replaced -- never
// throws (a missing/already-deleted file is not an error worth failing
// the request over).
export function deleteAvatarIfLocal(publicUrl) {
  if (!publicUrl || !publicUrl.startsWith("/uploads/avatars/")) return;
  const filename = path.basename(publicUrl);
  const resolvedPath = path.resolve(UPLOAD_DIR, filename);
  const resolvedDir = path.resolve(UPLOAD_DIR);
  if (!resolvedPath.startsWith(resolvedDir + path.sep)) return;
  try {
    fs.unlinkSync(resolvedPath);
  } catch {
    // ignore -- best effort only
  }
}
