"use client";

import { useCallback, useEffect, useState } from "react";
import { subscribeAccountChanged } from "./accountEvents";

// Polls the persistent, server-side "does the customer have an unread
// ISP status change" indicator (see app/api/isp/unread/route.js) for the
// ISP Setup nav-tab badge. Deliberately mirrors lib/useSupportUnread.js
// exactly (same POLL_MS, same fetch-on-mount + interval + account-changed
// broadcast pattern) so both notification dots behave identically per
// spec ("Same visual style" / same automatic-appearance guarantee),
// while remaining fully independent of Support's own unread state --
// polling this never touches conversations.customer_unread and vice
// versa.
//
// A dedicated poll hook (rather than reading account.ispUnread off
// useAccount()) was chosen deliberately: useAccount() only refetches on
// mount and on the cross-component "account changed" broadcast, not on a
// steady interval, so it would not reliably surface an isp_unread flip
// that happens purely server-side (e.g. the 3-day auto-approval firing
// while the customer is idle on an unrelated page) within a bounded time
// window the way this ~4s poll does.
const POLL_MS = 4000;

export function useIspUnread() {
  const [unread, setUnread] = useState(false);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch("/api/isp/unread", { cache: "no-store" });
      const data = await res.json();
      setUnread(Boolean(data.unread));
    } catch {
      // keep last known value on a transient network error
    }
  }, []);

  useEffect(() => {
    // fetch-on-mount, same pattern as lib/useSupportUnread.js.
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
