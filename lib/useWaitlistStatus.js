"use client";

import { useCallback, useEffect, useState } from "react";

// Polls the SQLite-backed waitlist status. No Zustand/localStorage
// involvement -- every value originates from accounts.first_login_at /
// waitlist_joined_at via /api/waitlist/status.
export function useWaitlistStatus(pollMs = 5000) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch("/api/waitlist/status", { cache: "no-store" });
      const data = await res.json();
      setStatus(data.status || null);
    } catch {
      // keep last known status on transient network error
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial
    // fetch-on-mount, same pattern used elsewhere in this app.
    refetch();
  }, [refetch]);

  useEffect(() => {
    const id = setInterval(refetch, pollMs);
    return () => clearInterval(id);
  }, [refetch, pollMs]);

  return { status, loading, refetch };
}
