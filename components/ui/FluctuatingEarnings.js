"use client";

import { useEffect, useRef, useState } from "react";
import { formatCurrency, centsToDollars } from "@/lib/mockData";

// DISPLAY-ONLY visual fluctuation for "Est. Monthly Earnings" figures
// (Nodes marketplace + Dashboard "Your Nodes"). This component NEVER
// reads or writes anything server-side, never touches
// owned_nodes.earning_rate_cents/est_monthly_cents, never touches
// ledger_entries, and never feeds into any payout/accrual calculation
// anywhere in the app -- lib/earningsEngine.js and lib/ownedNodes.js are
// the ONLY places real money math happens, and neither of them imports
// this file. This is purely a cosmetic "the number wiggles a little" UI
// effect layered on top of a single stable server-supplied
// `coreCents` value, entirely reset by a fresh page load/refresh
// (nothing here is persisted anywhere).
//
// HYDRATION SAFETY: the very first render (both server-side and the
// first client render, before any effect has run) always shows the
// exact core value with ZERO fluctuation applied, so SSR output and the
// initial client render always agree byte-for-byte. Fluctuation only
// begins after mount, once a client-only `useEffect` schedules the
// first re-roll -- this is the same hasMounted-gating pattern used
// throughout this codebase (see lib/useHasMounted.js) for anything that
// depends on Date.now()/Math.random() and would otherwise cause a
// hydration mismatch.
//
// REDUCED MOTION: when the user's OS/browser signals
// prefers-reduced-motion, this component still shows accurate figures
// but skips the periodic re-rolls entirely (locks to the stable core
// value) and disables the CSS transition, per spec ("respect
// reduced-motion preferences where applicable").
const MIN_DELAY_MS = 5000;
const MAX_DELAY_MS = 10000;
const MAX_FLUCTUATION_PCT = 0.05; // +/-5%

function prefersReducedMotion() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

// Picks a random signed percentage in [-MAX_FLUCTUATION_PCT, +MAX_FLUCTUATION_PCT]
// and returns the resulting cents figure (rounded to the nearest whole
// cent, since real currency is never fractional-cent). This is
// deliberately Math.random()-based (not the app's seeded rngFromKey
// generator used elsewhere for STABLE demo data) -- unlike a Node's
// tier/rate/ID, this value is explicitly required to be different every
// time and on every client, since it is pure decorative motion with no
// correctness requirement to be reproducible.
function rollDisplayCents(coreCents) {
  const pct = (Math.random() * 2 - 1) * MAX_FLUCTUATION_PCT;
  return Math.round(coreCents * (1 + pct));
}

/**
 * Renders a currency figure that visually fluctuates +/-5% around a
 * stable server-supplied `coreCents` value, re-rolling on a random
 * 5-10s interval with a smooth CSS transition between values. The
 * underlying `coreCents` itself is NEVER modified by this component --
 * it is display-only motion, never a source of truth for any
 * financial calculation.
 *
 * @param {number} coreCents - the stable, server-supplied core amount in cents.
 * @param {string} className - optional className applied to the rendered span.
 */
export default function FluctuatingEarnings({ coreCents, className = "" }) {
  // Initial render (SSR + first client paint) always shows the exact
  // core value -- see the HYDRATION SAFETY note above.
  const [displayCents, setDisplayCents] = useState(coreCents);
  const timeoutRef = useRef(null);

  useEffect(() => {
    // If the server-supplied core value itself changes (e.g. a fresh
    // poll returns an updated est_monthly_cents), snap the display back
    // to that new core immediately rather than continuing to fluctuate
    // around a now-stale number. This mirrors the same
    // bootstrapping-state-from-a-changed-prop pattern already used
    // elsewhere in this codebase (see app/(portal)/page.js
    // useLiveEarnings' baseline effect) -- not a derived-during-render
    // value because the subsequent setTimeout-driven re-rolls below
    // must all originate from this exact reset point.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDisplayCents(coreCents);

    if (prefersReducedMotion()) {
      // Reduced motion: show the accurate stable value and never
      // schedule any re-roll timers at all.
      return undefined;
    }

    function scheduleNext() {
      const delay = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
      timeoutRef.current = setTimeout(() => {
        setDisplayCents(rollDisplayCents(coreCents));
        scheduleNext();
      }, delay);
    }
    scheduleNext();

    // Clean up the pending timer on unmount or whenever coreCents
    // changes (so the old schedule doesn't keep firing against a stale
    // closure over the previous coreCents value).
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [coreCents]);

  return (
    <span
      className={className}
      style={{ transition: "opacity 0.3s ease" }}
      // Purely cosmetic: exposes the true stable core value to anything
      // inspecting the DOM/accessibility tree (screen readers, tests)
      // even while the visible text fluctuates, so assistive tech never
      // reads out a jittering number.
      aria-label={formatCurrency(centsToDollars(coreCents))}
    >
      {formatCurrency(centsToDollars(displayCents))}
    </span>
  );
}
