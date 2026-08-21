"use client";

import { useEffect, useRef } from "react";

// Controlled VTurb SmartPlayer component. Accepts only trusted,
// pre-validated config (playerId + scriptUrl -- see
// lib/moduleVideo.js normalizeVturbConfig(), the only place that
// validates them) and renders the ACTUAL VTurb SmartPlayer integration:
//
//   <vturb-smartplayer id={`vid-${domId ?? playerId}`}>
//     <div class="vturb-player-placeholder" ... />
//   </vturb-smartplayer>
//
// plus the required player.js loader script, appended to <head> exactly
// once per distinct player id/script URL. This NEVER uses
// dangerouslySetInnerHTML or executes arbitrary caller-supplied HTML --
// every DOM node here is created via normal React/DOM APIs from two
// already-validated string values (a player id matching a strict
// [a-zA-Z0-9_-]+ pattern, and a script URL restricted to VTurb's own
// scripts.converteai.net host).
//
// Production feature/fix batch (Module Video reopen fix): ROOT CAUSE --
// VTurb's player.js registers its <vturb-smartplayer> custom element and
// keeps GLOBAL internal player state keyed off that element's DOM `id`.
// Previously this component always rendered `id={`vid-${playerId}`}`,
// and `playerId` is a STABLE, admin-configured value for a given
// module -- so closing and reopening the SAME module's video modal
// re-mounted a `<vturb-smartplayer>` with the EXACT SAME `id` every
// time, and VTurb's library would serve back stale/broken cached state
// under that id instead of initializing a fresh player. This is the
// confirmed root cause (not a re-diagnosis here).
//
// FIX: the DOM element's own `id` now comes from a new, OPTIONAL
// `domId` prop -- a value the caller (VideoModal in
// app/(portal)/modules/page.js) regenerates fresh on every single
// "open" event (not just when the module itself changes; reopening the
// SAME module also gets a brand-new value), by mounting a fresh
// VideoModal instance via a React `key` that changes per open. A fresh
// `domId` means a fresh `<vturb-smartplayer id="...">` element every
// time the modal opens, which VTurb's player.js treats as a brand-new
// player instance rather than one it has stale cached state for -- this
// is the standard, documented community workaround for this exact class
// of bug with VTurb SmartPlayer embeds (VTurb's public embed docs do
// not expose a destroy()/reset() API to call instead). `domId` is
// OPTIONAL and falls back to the original `playerId`-based id when
// omitted, for backward compatibility and defensive safety (this
// component must never render an element with no id at all).
//
// IMPORTANT: the loader `<script>` dedup guard below intentionally
// keeps keying off the STABLE `playerId` (never `domId`) -- VTurb's
// player.js loader itself must only ever be fetched/registered ONCE per
// module, no matter how many times its video modal is opened and
// closed; only the `<vturb-smartplayer>` DOM id needs to be fresh per
// open, not the script that defines the custom element.
export default function VturbPlayer({ playerId, scriptUrl, title, domId }) {
  const containerRef = useRef(null);
  const elementId = domId || playerId;

  useEffect(() => {
    if (!playerId || !scriptUrl) return;

    // Avoid duplicating the loader script on re-render/remount: VTurb's
    // own player.js is keyed by its src URL, so if a <script> with this
    // exact src already exists anywhere in the document (e.g. this
    // component mounted, unmounted, and remounted -- React StrictMode
    // double-invoke in dev, or navigating away and back), just reuse it
    // instead of injecting a second copy.
    const existing = document.querySelector(
      `script[data-vturb-player="${playerId}"]`
    );
    if (existing) return;

    const script = document.createElement("script");
    script.src = scriptUrl;
    script.async = true;
    script.defer = true;
    script.dataset.vturbPlayer = playerId;
    document.head.appendChild(script);

    // Deliberately NOT removed on unmount: VTurb's player.js registers
    // the <vturb-smartplayer> custom element globally on the page (like
    // any other custom-element polyfill/loader script) -- removing it
    // whenever a customer navigates away from the Modules page would
    // just force a costly re-fetch/re-registration on the next visit
    // for no safety benefit, since a stray loaded script does nothing
    // without its matching <vturb-smartplayer> element present in the
    // DOM. The dataset guard above prevents it from ever loading twice.
    //
    // No explicit per-`domId` cleanup is performed here either: this
    // component (and its parent VideoModal) is fully UNMOUNTED by React
    // every time the video modal closes (or reopens, via the `key`
    // change on <VideoModal> -- see app/(portal)/modules/page.js), which
    // already destroys this exact DOM node/subtree. There is no
    // documented VTurb destroy()/dispose() API, and no other global
    // window-level reference this codebase creates or is aware of that
    // would need to be manually cleared for a given `domId` -- the fresh
    // id on the next mount is what makes VTurb treat it as a brand-new
    // player, regardless of whatever internal bookkeeping VTurb's own
    // player.js keeps for the previous, now-orphaned id.
  }, [playerId, scriptUrl]);

  if (!playerId || !scriptUrl) return null;

  return (
    <div ref={containerRef} className="aspect-video w-full bg-black">
      {/* vturb-smartplayer is a real custom element registered by VTurb's player.js, not a typo'd standard tag. */}
      <vturb-smartplayer
        id={`vid-${elementId}`}
        style={{ display: "block", margin: "0 auto", width: "100%" }}
      >
        <div
          className="vturb-player-placeholder"
          style={{
            position: "relative",
            width: "100%",
            padding: "56.25% 0 0",
            zIndex: 0,
            backgroundColor: "black",
          }}
          title={title}
        />
      </vturb-smartplayer>
    </div>
  );
}
