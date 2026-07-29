"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Shared 0%->100% "Establishing a Secure Connection..." progress engine,
// used by BOTH the Dashboard WiFi OFF->ON reconnection flow and the ISP
// Setup "I Approve" authorization flow. Both flows are structurally
// identical server-side (a persisted `*_started_at` timestamp gates a
// single completion POST that independently re-validates the real
// elapsed time -- see lib/wifiEngine.js / lib/ispEngine.js), so this is
// the ONE place the shared client behavior lives rather than two
// independently-drifting copies.
//
// ROOT CAUSE of the previous "stuck at 0%" bug: the old per-page timer
// effects (`setInterval(...)`) declared `[onDone, onError]` in their
// dependency array. `onDone`/`onError` were plain inline functions
// re-created on every render of the PARENT component (WifiToggleCard /
// IspSetupPage) -- and the parent re-renders on every ~15s earnings-
// summary poll, every `notifyAccountChanged()` broadcast, and any local
// state change (e.g. `pending`, `error`). Each of those re-renders gave
// the effect a brand-new `onDone`/`onError` identity, so React tore down
// and recreated the `setInterval` over and over. In the worst case
// (parent re-rendering faster than the tick interval, e.g. right after
// the optimistic "start" click immediately triggers a re-render before
// the very first 100ms tick fires) the interval could be cancelled and
// restarted indefinitely without ever completing a single tick, leaving
// the bar visually frozen at 0% even though `startedAtMsRef` and the
// server's persisted timestamp were both correct the whole time.
//
// FIX: `onDone`/`onError` are captured in refs that are updated on every
// render via a plain (non-conditional) effect with an EMPTY meaningful
// side effect (no dependency-driven re-subscription), so the actual
// ticking effect below only ever depends on `active` (and otherwise-
// stable primitives) and is never torn down by an unrelated parent
// re-render.
//
// STEPPED DISPLAY: per spec, the visible percentage must move in exact
// discrete 5-point steps once per second (0, 5, 10, ... 100) rather than
// a smooth/continuous interpolation. `progress` is always
// `Math.min(100, Math.floor(elapsedMs / stepMs) * stepPercent)`, ticked
// on a sub-second internal timer (250ms) purely so a step boundary is
// never visibly delayed -- the DISPLAYED value only ever lands on a
// multiple of `stepPercent`.
//
// COMPLETION RELIABILITY:
// - Only one completion POST is ever in flight at a time
//   (`completingRef`), so a duplicate/racing call from a fast retry can
//   never fire two concurrent requests.
// - `remainingMs` in a 409 response (server disagrees the window has
//   fully elapsed, e.g. clock drift) schedules exactly one retry after
//   that real remainder -- never resets `progress`.
// - Network failures and 5xx responses are treated as transient: bounded
//   exponential backoff (1s, 2s, 4s, 8s, capped, up to
//   MAX_TRANSIENT_RETRIES attempts) retries automatically. `progress`
//   stays pinned at 100 throughout -- the user is never bounced back to
//   0% while this retries in the background.
// - A success response is anything `res.ok` -- this includes the
//   idempotent "already connected/already active" success responses
//   the server returns for a duplicate completion call, so those are
//   treated as ordinary success, not an error.
// - Only once the retry budget is exhausted, or a genuine non-transient
//   (4xx, excluding the remainingMs case) error is returned, does this
//   call `onError` -- which is the ONLY path that should surface a
//   "Try Again" affordance to the user.
const MAX_TRANSIENT_RETRIES = 5;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 8000;

export function useSteppedConnectionProgress({
  active,
  startedAt,
  durationMs = 20000,
  stepMs = 1000,
  stepPercent = 5,
  completeUrl,
  onDone,
  onError,
}) {
  const [progress, setProgress] = useState(0);
  const [retrying, setRetrying] = useState(false);

  const startedAtMsRef = useRef(null);
  const completingRef = useRef(false);
  const retryCountRef = useRef(0);
  const doneRef = useRef(onDone);
  const errorRef = useRef(onError);
  const retryTimeoutRef = useRef(null);

  useEffect(() => {
    doneRef.current = onDone;
    errorRef.current = onError;
  });

  // Resolve/refresh the real starting instant from the SERVER-PERSISTED
  // `startedAt` timestamp -- never a client-only clock as the source of
  // truth. A mid-flow refresh remounts with `startedAt` already equal to
  // the real persisted value (read via /api/auth/me), so the very first
  // render already knows the true elapsed time and resumes at the
  // correct stepped percentage rather than restarting at 0%.
  useEffect(() => {
    if (!active) {
      startedAtMsRef.current = null;
      completingRef.current = false;
      retryCountRef.current = 0;
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
      // Resetting derived UI state (not mirroring an external prop/value)
      // in response to `active` flipping off -- not the anti-pattern the
      // set-state-in-effect rule targets, but the linter can't tell that
      // apart from a genuine render-triggering side effect here.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProgress(0);
      setRetrying(false);
      return;
    }
    if (startedAt) {
      startedAtMsRef.current = new Date(startedAt).getTime();
    } else if (startedAtMsRef.current === null) {
      // Optimistic fallback for the brief window between the customer's
      // click and the server's start-response/refetch landing -- the
      // branch above takes over the instant the real persisted value
      // arrives.
      startedAtMsRef.current = Date.now();
    }
  }, [active, startedAt]);

  const attemptCompletionRef = useRef(null);

  const attemptCompletion = useCallback(() => {
    if (completingRef.current) return; // one in-flight completion request at a time
    completingRef.current = true;

    function scheduleTransientRetry() {
      completingRef.current = false;
      retryCountRef.current += 1;
      if (retryCountRef.current > MAX_TRANSIENT_RETRIES) {
        setRetrying(false);
        errorRef.current?.("Unable to confirm your connection right now. Please try again.");
        return;
      }
      setRetrying(true);
      const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (retryCountRef.current - 1));
      retryTimeoutRef.current = setTimeout(() => attemptCompletionRef.current?.(), backoff);
    }

    fetch(completeUrl, { method: "POST" })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          completingRef.current = false;
          retryCountRef.current = 0;
          setRetrying(false);
          doneRef.current?.(data.account);
          return;
        }
        if (data.remainingMs) {
          // Server disagrees the full window has elapsed (clock drift) --
          // wait out the real remainder it reports, then retry once.
          // Does not count against the transient-failure retry budget.
          completingRef.current = false;
          retryTimeoutRef.current = setTimeout(
            () => attemptCompletionRef.current?.(),
            data.remainingMs + 200
          );
          return;
        }
        if (res.status >= 500 || res.status === 429) {
          scheduleTransientRetry();
          return;
        }
        // Any other 4xx is a genuine terminal failure, not transient.
        completingRef.current = false;
        setRetrying(false);
        errorRef.current?.(data.error || "Connection failed. Please try again.");
      })
      .catch(() => {
        // Network failure -- treated the same as a transient 5xx.
        scheduleTransientRetry();
      });
  }, [completeUrl]);

  useEffect(() => {
    attemptCompletionRef.current = attemptCompletion;
  }, [attemptCompletion]);

  useEffect(() => {
    if (!active) return undefined;
    const interval = setInterval(() => {
      if (startedAtMsRef.current === null) return;
      const elapsed = Date.now() - startedAtMsRef.current;
      const steps = Math.floor(elapsed / stepMs);
      const maxSteps = durationMs / stepMs;
      const pct = Math.min(100, steps * stepPercent);
      setProgress(pct);

      if (steps >= maxSteps) {
        attemptCompletion();
      }
    }, 250); // finer than stepMs so a step boundary is never visibly delayed
    return () => clearInterval(interval);
  }, [active, stepMs, stepPercent, durationMs, attemptCompletion]);

  useEffect(() => {
    return () => {
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
    };
  }, []);

  return { progress, retrying };
}
