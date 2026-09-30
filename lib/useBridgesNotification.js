"use client";

import { useCallback, useEffect, useState } from "react";
import { subscribeAccountChanged } from "./accountEvents";

// Polls the persistent, session-aware Bridges nav-tab badge (see
// lib/bridgesNotification.js). Mirrors lib/useIspUnread.js's poll pattern
// exactly.
const POLL_MS = 4000;

export function useBridgesNotification() {
  const [show, setShow] = useState(false);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch("/api/bridges/notification", { cache: "no-store" });
      const data = await res.json();
      setShow(Boolean(data.show));
    } catch {
      // keep last known value on a transient network error
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refetch();
  }, [refetch]);

  useEffect(() => {
    const id = setInterval(refetch, POLL_MS);
    return () => clearInterval(id);
  }, [refetch]);

  useEffect(() => subscribeAccountChanged(refetch), [refetch]);

  return { show, refetch };
}
