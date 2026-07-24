"use client";

import { useEffect, useState } from "react";

/**
 * Ticks at the given interval and returns Date.now(). Used to drive the
 * live earnings ticker, uptime clock, and countdown timers without each
 * consumer running its own setInterval.
 */
export function useLiveClock(intervalMs = 100) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
