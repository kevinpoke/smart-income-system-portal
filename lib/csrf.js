// Minimal same-origin check used as CSRF protection for state-changing
// (non-GET) API routes. Since this app uses cookie-based sessions with
// SameSite=Lax (not Strict, to allow top-level GET navigation after login
// redirects) plus no custom auth header, a same-origin check on the
// Origin/Referer header is the standard lightweight mitigation for
// cross-site POST/PUT/DELETE requests that XSS on a *different* origin
// might try to fire cross-site.
export function isSameOrigin(request) {
  const origin = request.headers.get("origin");
  // Some same-origin requests (older browsers, some fetch configurations)
  // omit Origin but include Referer -- fall back to that.
  const referer = request.headers.get("referer");
  const host = request.headers.get("host");
  if (!host) return false;

  const candidate = origin || referer;
  if (!candidate) {
    // No Origin/Referer at all is suspicious for a state-changing request
    // from a browser; reject rather than silently trust it.
    return false;
  }

  try {
    const url = new URL(candidate);
    return url.host === host;
  } catch {
    return false;
  }
}


