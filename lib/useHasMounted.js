"use client";

import { useEffect, useState } from "react";

/**
 * Returns false on the server and during the first client render, then true
 * after mount. Use this to gate any UI that depends on client-only state
 * (localStorage-persisted Zustand store, Date.now()-based values, etc.) so the
 * server-rendered HTML matches the first client render and React doesn't throw
 * a hydration mismatch.
 */
export function useHasMounted() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
