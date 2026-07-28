"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeAccountChanged } from "./accountEvents";

// Polls the SQLite-backed earnings summary. This intentionally does NOT
// try to recompute money client-side -- it periodically re-fetches the
// server's authoritative summary (which itself runs idempotent catch-up
// ledger writes) so a day rollover / admin balance edit / multiplier
// change is picked up without a manual refresh. The "live ticking" visual
// effect in the dashboard interpolates smoothly BETWEEN polls using
// Date.now(), but every interpolation baseline comes from the server.
//
// Also refetches immediately on the shared "account changed" broadcast
// (lib/accountEvents.js) so a WiFi toggle flip or ISP connection
// completing updates the Dashboard's live earnings without waiting for
// the next poll interval.
export function useEarningsSummary(pollMs = 15000) {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef(null);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch("/api/earnings/summary", { cache: "no-store" });
      const data = await res.json();
      setSummary(data.summary || null);
    } catch {
      // keep the last known summary rather than clearing it on a transient
      // network error
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // fetch-on-mount, same pattern as lib/useAccount.js.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial
    refetch();
  }, [refetch]);

  useEffect(() => {
    timerRef.current = setInterval(refetch, pollMs);
    return () => clearInterval(timerRef.current);
  }, [refetch, pollMs]);

  useEffect(() => subscribeAccountChanged(refetch), [refetch]);

  return { summary, loading, refetch };
}
