"use client";

import { useEffect, useRef } from "react";

// Controlled VTurb SmartPlayer component. Accepts only trusted,
// pre-validated config (playerId + scriptUrl -- see
// lib/moduleVideo.js normalizeVturbConfig(), the only place that
// validates them) and renders the ACTUAL VTurb SmartPlayer integration:
//
//   <vturb-smartplayer id={`vid-${playerId}`}>
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
export default function VturbPlayer({ playerId, scriptUrl, title }) {
  const containerRef = useRef(null);

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
  }, [playerId, scriptUrl]);

  if (!playerId || !scriptUrl) return null;

  return (
    <div ref={containerRef} className="aspect-video w-full bg-black">
      {/* vturb-smartplayer is a real custom element registered by VTurb's player.js, not a typo'd standard tag. */}
      <vturb-smartplayer
        id={`vid-${playerId}`}
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
