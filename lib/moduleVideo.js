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
