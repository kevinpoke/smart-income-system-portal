// Server + client shared helper for validating a raw admin-configured
// VTurb SmartPlayer descriptor (player id + script URL) into a safe
// value the UI can render. This is the SINGLE canonical place VTurb
// config validation happens for Training Module videos -- the
// customer-facing VideoModal renderer (app/(portal)/modules/page.js)
// must go through this file, never duplicate this logic inline.
//
// VTurb ships a "SmartPlayer" embed, NOT a plain iframe-compatible URL:
//
//   <vturb-smartplayer id="vid-PLAYER_ID" style="...">
//     <div class="vturb-player-placeholder" style="..."></div>
//   </vturb-smartplayer>
//   <script type="text/javascript" src="SCRIPT_URL" async defer></script>
//
// This module never returns a value unless the script URL matches an
// explicit trusted hostname allowlist (VTurb's own CDN) and looks like
// a real player.js loader for the given player id. Callers must treat
// an unsupported/invalid config as "no video" (render the placeholder/
// fallback) -- this never falls back to raw HTML injection or an
// unvalidated <iframe src>/<script src>.
//
// SOURCE OF TRUST: playerId/scriptUrl only ever reach this function via
// the developer-edited, trusted lib/mockData.js MODULES_META config --
// never from unauthenticated customer input -- but this still validates
// shape defensively so a future admin-editing UI can reuse the exact
// same guard rails.

const VTURB_SCRIPT_HOSTS = new Set(["scripts.converteai.net"]);
const PLAYER_ID_RE = /^[a-zA-Z0-9_-]+$/;

function safeParseUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Validates a VTurb SmartPlayer player id + script URL pair.
 *
 * @param {string} playerId - VTurb SmartPlayer id (e.g. "6a86975e7133d4864b6763c1").
 * @param {string} scriptUrl - the VTurb-hosted player.js loader URL for that player id.
 * @returns {{ playerId: string, scriptUrl: string } | null} a safe, validated pair, or null if unsupported/invalid.
 */
export function normalizeVturbConfig(playerId, scriptUrl) {
  if (typeof playerId !== "string" || !PLAYER_ID_RE.test(playerId)) return null;

  const url = safeParseUrl(scriptUrl);
  if (!url) return null;
  if (!VTURB_SCRIPT_HOSTS.has(url.hostname.toLowerCase())) return null;
  if (!url.pathname.toLowerCase().endsWith("/player.js")) return null;
  // Tie the script URL to the declared player id so one module's config
  // can never accidentally point at a different module's player.
  if (!url.pathname.includes(`/players/${playerId}/`)) return null;

  return { playerId, scriptUrl: url.toString() };
}

// MODULE-THUMBNAILS batch: derives VTurb's own genuine first-frame/cover
// image URL for a module card thumbnail -- NOT a scrape, NOT a
// transcode/download, just an <img> pointed at the same CDN asset VTurb
// itself generates and already serves alongside the player (confirmed by
// downloading and reading the real player.js: it references
// `poster:"https://cdn.converteai.net/.../poster.jpg"` for the in-player
// poster, and a separate, equally genuine cover image lives at this
// `images.converteai.net/{accountId}/players/{playerId}/cover.jpg`
// pattern -- verified HTTP 200 for every real module + the Bridges
// waitlist video player id).
//
// SAFE BY CONSTRUCTION, not by re-validating caller input: this only
// ever runs against an ALREADY-VALIDATED `{ playerId, scriptUrl }` pair
// returned by normalizeVturbConfig() above (never raw admin/user input
// directly), and derives the accountId strictly from that same
// trusted, already-host/path-allowlisted scriptUrl -- so the resulting
// cover URL can never point anywhere other than this account's own
// VTurb asset namespace on VTurb's own CDN host.
const VTURB_IMAGE_HOST = "images.converteai.net";

export function getVturbCoverUrl(normalizedConfig) {
  if (!normalizedConfig || !normalizedConfig.playerId || !normalizedConfig.scriptUrl) return null;
  const url = safeParseUrl(normalizedConfig.scriptUrl);
  if (!url || !VTURB_SCRIPT_HOSTS.has(url.hostname.toLowerCase())) return null;
  const accountId = url.pathname.split("/").filter(Boolean)[0];
  if (!accountId) return null;
  return `https://${VTURB_IMAGE_HOST}/${accountId}/players/${normalizedConfig.playerId}/cover.jpg`;
}
