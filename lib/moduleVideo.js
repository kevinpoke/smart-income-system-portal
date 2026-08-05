// Server + client shared helper for normalizing a raw admin-provided
// video URL into a safe, embeddable form. This is the SINGLE canonical
// place URL normalization/validation happens for Training Module videos
// -- both the (future) admin editing UI and the customer-facing
// VideoModal renderer must go through this file, never duplicate this
// logic inline.
//
// SUPPORTED SOURCES (per spec):
//   A. Direct hosted MP4/WebM file  -> rendered with the native <video> tag
//   B. Google Drive share link      -> normalized to the /preview iframe URL
//   C. YouTube / Vimeo link         -> normalized to their standard embed URL
//
// SECURITY: this module NEVER returns a URL for rendering unless it
// matches one of a small explicit hostname allowlist per type, and
// always rejects `javascript:`/`data:`/any other non-http(s) scheme
// outright. Callers must treat an unsupported/invalid URL as "no video"
// (render the placeholder/fallback), never fall back to raw HTML
// injection or an unvalidated <iframe src>.

const ALLOWED_DIRECT_VIDEO_EXTENSIONS = [".mp4", ".webm"];

const GOOGLE_DRIVE_HOSTS = new Set(["drive.google.com"]);
const YOUTUBE_HOSTS = new Set(["www.youtube.com", "youtube.com", "youtu.be", "m.youtube.com"]);
const VIMEO_HOSTS = new Set(["vimeo.com", "www.vimeo.com", "player.vimeo.com"]);

function safeParseUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    // Reject javascript:/data:/vbscript:/file: and any other scheme
    // outright -- only ever accept http/https for an admin-supplied
    // video link. This is the ONE place that guards against a
    // javascript:-scheme or similar injection ever making it into an
    // <a>/<video src>/<iframe src>.
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

// Extracts a Google Drive file ID from either supported share-link
// shape:
//   https://drive.google.com/file/d/FILE_ID/view
//   https://drive.google.com/open?id=FILE_ID
function extractGoogleDriveFileId(url) {
  const fileMatch = url.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) return fileMatch[1];
  const idParam = url.searchParams.get("id");
  if (idParam && /^[a-zA-Z0-9_-]+$/.test(idParam)) return idParam;
  return null;
}

// Extracts a YouTube video ID from any of the common URL shapes:
//   https://www.youtube.com/watch?v=VIDEO_ID
//   https://youtu.be/VIDEO_ID
//   https://www.youtube.com/embed/VIDEO_ID
function extractYouTubeVideoId(url) {
  if (url.hostname === "youtu.be") {
    const id = url.pathname.replace(/^\//, "");
    return /^[a-zA-Z0-9_-]{6,}$/.test(id) ? id : null;
  }
  const vParam = url.searchParams.get("v");
  if (vParam && /^[a-zA-Z0-9_-]{6,}$/.test(vParam)) return vParam;
  const embedMatch = url.pathname.match(/\/embed\/([a-zA-Z0-9_-]{6,})/);
  if (embedMatch) return embedMatch[1];
  return null;
}

// Extracts a Vimeo video ID from:
//   https://vimeo.com/VIDEO_ID
//   https://player.vimeo.com/video/VIDEO_ID
function extractVimeoVideoId(url) {
  const match = url.pathname.match(/\/(?:video\/)?(\d+)/);
  return match ? match[1] : null;
}

/**
 * Normalizes a raw admin-supplied video URL + declared type into a safe,
 * embeddable descriptor, or null if unsupported/invalid.
 *
 * @param {string} rawUrl - the raw URL as entered by an admin/developer.
 * @param {string} declaredType - one of "direct" | "drive" | "youtube" | "vimeo" (optional hint; auto-detected from hostname when omitted or when it doesn't match).
 * @returns {{ kind: "direct"|"iframe", src: string, title?: string } | null}
 */
export function normalizeModuleVideo(rawUrl, declaredType) {
  const url = safeParseUrl(rawUrl);
  if (!url) return null;

  const host = url.hostname.toLowerCase();

  // B. Google Drive share link -> /preview iframe embed.
  if (GOOGLE_DRIVE_HOSTS.has(host)) {
    const fileId = extractGoogleDriveFileId(url);
    if (!fileId) return null;
    return { kind: "iframe", src: `https://drive.google.com/file/d/${fileId}/preview` };
  }

  // C. YouTube -> standard embed URL.
  if (YOUTUBE_HOSTS.has(host)) {
    const videoId = extractYouTubeVideoId(url);
    if (!videoId) return null;
    return { kind: "iframe", src: `https://www.youtube-nocookie.com/embed/${videoId}` };
  }

  // C. Vimeo -> standard player embed URL.
  if (VIMEO_HOSTS.has(host)) {
    const videoId = extractVimeoVideoId(url);
    if (!videoId) return null;
    return { kind: "iframe", src: `https://player.vimeo.com/video/${videoId}` };
  }

  // A. Direct hosted MP4/WebM file -- allow ANY https(s) host (this is
  // meant for the admin's own hosted media, not a third-party
  // allowlist), but ONLY when the path genuinely ends in a supported
  // video extension, and only ever rendered via the native <video> tag
  // (never an <iframe>, never innerHTML).
  const pathLower = url.pathname.toLowerCase();
  const hasVideoExtension = ALLOWED_DIRECT_VIDEO_EXTENSIONS.some((ext) => pathLower.endsWith(ext));
  if (declaredType === "direct" || hasVideoExtension) {
    if (!hasVideoExtension) return null;
    return { kind: "direct", src: url.toString() };
  }

  return null;
}
