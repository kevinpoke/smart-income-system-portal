"use client";

import { useCallback, useEffect, useState } from "react";
import { subscribeAccountChanged } from "./accountEvents";

// Polls the persistent, server-side "does the customer have an unread
// admin support reply" indicator (see lib/supportEngine.js
// getCustomerUnread) for the Support nav-tab badge. Deliberately reads
// via GET /api/support/unread (a lightweight read-only check) rather than
// the full message-list route, so polling this from the Sidebar/MobileNav
// on every page never marks anything read -- only the customer actually
// opening the Support page itself (which calls GET
// /api/support/messages) clears the badge, per spec.
//
// Polls on a steady ~4s interval while mounted (comfortably inside the
// spec's "around 3-5 seconds" guidance) and also refetches immediately on
// the shared "account changed" broadcast so a fresh admin reply arriving
// while the customer is actively using another part of the portal is
// picked up without waiting out the full interval.
const POLL_MS = 4000;

export function useSupportUnread() {
  const [unread, setUnread] = useState(false);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch("/api/support/unread", { cache: "no-store" });
      const data = await res.json();
      setUnread(Boolean(data.unread));
    } catch {
      // keep last known value on a transient network error
    }
  }, []);

  useEffect(() => {
    // fetch-on-mount, same pattern as lib/useAccount.js.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refetch();
  }, [refetch]);

  useEffect(() => {
    const id = setInterval(refetch, POLL_MS);
    return () => clearInterval(id);
  }, [refetch]);

  useEffect(() => subscribeAccountChanged(refetch), [refetch]);

  return { unread, refetch };
}
