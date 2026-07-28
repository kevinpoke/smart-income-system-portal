"use client";

import { useCallback, useEffect, useState } from "react";
import { subscribeAccountChanged } from "./accountEvents";

// Client-side fetcher for the authenticated account, backed entirely by
// SQLite via /api/auth/me. This intentionally does NOT go through the
// Zustand/localStorage demo store -- for the ISP setup / node activation
// workflow (and account identity generally), the server is the only
// source of truth per this project's data-integrity rules.
//
// Also subscribes to the cross-component "account changed" broadcast
// (lib/accountEvents.js) so every consumer of this hook (Header, Sidebar,
// Dashboard, etc.) refetches immediately when another part of the app
// mutates the account (e.g. the ISP connection progress flow completing,
// or the WiFi toggle), satisfying the "update portal state without a hard
// refresh" requirement.
export function useAccount() {
  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      const data = await res.json();
      setAccount(data.account || null);
    } catch {
      setAccount(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // in app/(portal)/admin/page.js); refetch() is user-triggerable via the
    // returned function too, this just seeds the initial value.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refetch();
  }, [refetch]);

  useEffect(() => subscribeAccountChanged(refetch), [refetch]);

  return { account, loading, refetch };
}
