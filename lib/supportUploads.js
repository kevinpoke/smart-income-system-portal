import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Server-only helpers for storing Support Chat image attachments.
//
// PERSISTENCE (spec Part 9): unlike lib/uploads.js's avatar uploads (which
// write into public/uploads/avatars -- a directory baked into the Next.js
// build output and COPYed into the Docker image at build time, see
// Dockerfile `COPY --from=builder /app/public ./public` -- and therefore
// NOT preserved across a container rebuild/recreate), Support Chat images
// are written under data/support-uploads/, i.e. INSIDE the same directory
// that is already the app's one bind-mounted persistent volume in
// production (see docker-compose.prod.yml:
// `/opt/smart-income-system/data:/app/data`, and lib/db.js DATA_DIR /
// DB_PATH, which puts auth.db in that exact same directory). Because
// data/ is already mounted host storage, this requires NO additional
// Docker Compose volume entry -- support-uploads/ is simply a
// subdirectory the app creates lazily inside the volume that is already
// mounted. data/ is also already fully gitignored (see .gitignore
// `/data/`), so uploaded images can never end up committed to git.
//
// Images are served through an authenticated API route
// (app/api/support/attachments/[id]/route.js), never through a static/
// public file path, so this directory does not need to (and must not) be
// reachable directly by the Next.js static file server.
const UPLOAD_DIR = path.join(process.cwd(), "data", "support-uploads");
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB, per spec Part 8

// SVG is deliberately excluded (spec: "Do NOT allow SVG" -- SVG can embed
// script content and is not a safe "picture" format to trust for display).
const ALLOWED_MIME_TO_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function isAllowedSupportImageType(mimeType) {
  return Object.prototype.hasOwnProperty.call(ALLOWED_MIME_TO_EXT, mimeType);
}

export function maxSupportImageBytes() {
  return MAX_BYTES;
}

// Validates a File/Blob-like object (from FormData) server-side: real
// MIME type (never trust the client-supplied filename or its extension),
// size cap, and a minimal content sanity check. Returns an error string
// for the caller to surface to the user, or null when valid.
export function validateSupportImageFile(file) {
  if (!file || typeof file.size !== "number") {
    return "No image was provided.";
  }
  if (file.size <= 0) {
    return "The uploaded image is empty.";
  }
  if (file.size > MAX_BYTES) {
    return "Image is too large. Maximum size is 5 MB.";
  }
  if (!isAllowedSupportImageType(file.type)) {
    return "Unsupported image type. Please upload a JPEG, PNG, WEBP, or GIF image.";
  }
  return null;
}

// Lightweight magic-byte sniff so a renamed/relabeled non-image file
// (e.g. a .txt renamed to report a fake image/png Content-Type) can't
// sail through on the client-declared MIME type alone. This is a
// reasonable, low-cost content check -- not a full image decoder -- per
// spec Part 10 ("validate extension/content reasonably").
function sniffMatchesDeclaredType(buffer, mimeType) {
  if (buffer.length < 4) return false;
  const b = buffer;
  switch (mimeType) {
    case "image/jpeg":
      return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case "image/png":
      return (
        b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
        b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
      );
    case "image/gif":
      return (
        b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 // "GIF8"
      );
    case "image/webp":
      // "RIFF"...."WEBP"
      return (
        b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b.length >= 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
      );
    default:
      return false;
  }
}

// Writes the given bytes to a NEW, safe, unique filename inside the
// support-uploads directory -- never derived from the client-supplied
// filename (which could contain path-traversal sequences like "../" or
// an executable-looking extension); only from crypto.randomBytes plus
// the extension implied by the SERVER-VALIDATED MIME type. Returns
// { storageKey, mimeType, sizeBytes } for the caller to persist in
// support_message_attachments -- storageKey is an opaque id, never a
// filesystem path, and is the only thing ever exposed to the client (via
// the attachment's database id, not even the storageKey itself -- see
// the attachments API route).
export async function saveSupportImageUpload(file) {
  const validationError = validateSupportImageFile(file);
  if (validationError) {
    throw new Error(validationError);
  }

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (!sniffMatchesDeclaredType(buffer, file.type)) {
    throw new Error("The file's content does not match its declared image type.");
  }

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  const ext = ALLOWED_MIME_TO_EXT[file.type];
  const storageKey = `${crypto.randomBytes(16).toString("hex")}.${ext}`;
  const destPath = path.join(UPLOAD_DIR, storageKey);

  // Defensive check: resolved destination must stay inside UPLOAD_DIR --
  // storageKey is server-generated hex + a fixed extension so this can
  // never actually escape, but this mirrors the same belt-and-suspenders
  // check lib/uploads.js already uses for avatar uploads.
  const resolvedDest = path.resolve(destPath);
  const resolvedDir = path.resolve(UPLOAD_DIR);
  if (!resolvedDest.startsWith(resolvedDir + path.sep)) {
    throw new Error("Resolved upload path escaped the uploads directory.");
  }

  fs.writeFileSync(destPath, buffer);

  return { storageKey, mimeType: file.type, sizeBytes: buffer.length };
}

// Reads a previously-saved attachment's bytes back off disk, given its
// server-generated storageKey (from the support_message_attachments row
// -- NEVER a client-supplied filename/path). Rejects (returns null)
// rather than throwing if the resolved path would somehow escape
// UPLOAD_DIR (path traversal) or the file no longer exists, so a caller
// can respond 404 either way without distinguishing the two cases to the
// client.
export function readSupportImage(storageKey) {
  if (!storageKey || typeof storageKey !== "string") return null;
  // storageKey is always exactly `${32 hex chars}.${ext}` as generated
  // above; reject anything containing a path separator or "..' defensively
  // even though a well-formed key could never contain one.
  if (storageKey.includes("/") || storageKey.includes("\\") || storageKey.includes("..")) {
    return null;
  }

  const resolvedPath = path.resolve(UPLOAD_DIR, storageKey);
  const resolvedDir = path.resolve(UPLOAD_DIR);
  if (!resolvedPath.startsWith(resolvedDir + path.sep)) return null;

  try {
    return fs.readFileSync(resolvedPath);
  } catch {
    return null;
  }
}

// ISP support controls + special bridges batch: safely removes a
// previously-saved attachment's file from disk, given its own
// server-generated storageKey -- used ONLY by the admin message-delete
// route (see app/api/admin/support/conversations/[id]/messages/
// [messageId]/route.js), and ONLY after confirming (server-side, via
// lib/supportEngine.js#deleteMessage()'s returned attachmentStorageKey,
// itself only ever populated from a real support_message_attachments
// row already scoped to the exact message just deleted) that this
// specific file belongs to the message being deleted -- there is no
// route anywhere that lets a caller pass an arbitrary storageKey of
// their own choosing. Reuses the EXACT SAME path-resolution/containment
// check as readSupportImage() above so this can never be tricked into
// deleting a file outside UPLOAD_DIR. Silently no-ops (never throws) if
// the key is invalid or the file is already gone, since "the file no
// longer exists" and "successfully removed it" are equally acceptable
// end states for a cleanup helper.
export function deleteSupportImage(storageKey) {
  if (!storageKey || typeof storageKey !== "string") return false;
  if (storageKey.includes("/") || storageKey.includes("\\") || storageKey.includes("..")) {
    return false;
  }
  const resolvedPath = path.resolve(UPLOAD_DIR, storageKey);
  const resolvedDir = path.resolve(UPLOAD_DIR);
  if (!resolvedPath.startsWith(resolvedDir + path.sep)) return false;
  try {
    fs.unlinkSync(resolvedPath);
    return true;
  } catch {
    return false;
  }
}
