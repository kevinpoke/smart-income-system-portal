// Client-safe MIME allow-list mirror of lib/uploads.js's server-side
// validation, used ONLY for immediate UI feedback before the file is
// even uploaded (a nicer error message than waiting for the network
// round-trip). This is NOT a security boundary -- the actual
// authoritative validation happens server-side in
// app/api/profile/photo/route.js via lib/uploads.js validateUploadFile(),
// which re-checks the real file's MIME type and size regardless of what
// the client claims.
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function isAllowedImageMimeLabel(mimeType) {
  return ALLOWED_MIME_TYPES.has(mimeType);
}
