"use client";

// Tiny cross-component pub/sub so state-changing actions (ISP connection
// completing, WiFi toggle flipping) can tell every mounted useAccount()
// consumer (Header, Sidebar, Dashboard, ISP Setup page, etc.) to refetch
// /api/auth/me immediately, without requiring a hard page refresh or a
// prop-drilled callback chain. This is intentionally NOT a data store --
// SQLite via the API route remains the only source of truth; this just
// broadcasts "something changed, go re-read it."
const EVENT_NAME = "sa:account-changed";

export function notifyAccountChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT_NAME));
}

export function subscribeAccountChanged(handler) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
