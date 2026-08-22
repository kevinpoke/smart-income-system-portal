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
// plus the required player.js loader script, executed fresh every time
// this component mounts. This NEVER uses dangerouslySetInnerHTML or
// executes arbitrary caller-supplied HTML -- every DOM node here is
// created via normal React/DOM APIs from two already-validated string
// values (a player id matching a strict [a-zA-Z0-9_-]+ pattern, and a
// script URL restricted to VTurb's own scripts.converteai.net host).
//
// CONFIRMED ROOT CAUSE of the production black-screen regression
// (verified by downloading and reading VTurb's actual player.js for
// player 6a86975e7133d4864b6763c1): VTurb's loader looks up the target
// element by its EXACT official DOM id at parse time --
//
//   t = document.getElementById("vid-" + playerId)
//
// -- and later, inside setupPlayerElement():
//
//   t.id = "vid-" + n.id;
//   if (!t) {
//     t = document.createElement("vturb-smartplayer");
//     t.id = "vid-" + n.id;
//     <insert this brand-new element next to the <script> tag>
//   }
//
// A previous "fix" for the reopen bug made this component render
// `id={`vid-${domId}`}` with a NEW RANDOM domId on every open instead of
// the stable, official `vid-${playerId}`. That meant
// `getElementById("vid-" + playerId)` never found our real modal
// element, so VTurb silently created and mounted its OWN orphan
// `<vturb-smartplayer>` elsewhere in the document (next to the injected
// `<script>` tag -- NOT inside our modal). Our modal's actual element
// just sat there empty forever: script downloads fine, the custom
// element tag exists, "Lesson video is being prepared" never shows
// (because `vturb` config normalizes fine) -- but the visible player
// area is a permanent black box. This exactly matches every symptom
// reported in production. Randomized DOM ids are therefore CONFIRMED
// INCOMPATIBLE with VTurb SmartPlayer and must never be used for the
// element id again.
//
// FIX: the DOM element id is now ALWAYS the official, stable
// `vid-${playerId}` -- never randomized -- so VTurb's own
// `getElementById` lookup finds our real modal element and attaches to
// it instead of creating an orphan. Reopen is solved differently: since
// VTurb's player.js is a self-contained IIFE with its own local closure
// state (re-declaring `t`, `e`, `mounted`, etc. from scratch every time
// it runs), re-executing a FRESH `<script>` tag against a FRESH,
// freshly-mounted `vid-${playerId}` element (the parent VideoModal in
// app/(portal)/modules/page.js still remounts via a changing React
// `key` on every open, including reopening the same module) makes VTurb
// treat it as a brand-new player every time, with no reliance on any
// stale global id. The ONE thing that must stay stable across opens is
// the DOM id itself -- never the script execution.
export default function VturbPlayer({ playerId, scriptUrl, title }) {
  const containerRef = useRef(null);
  const scriptRef = useRef(null);

  useEffect(() => {
    if (!playerId || !scriptUrl) return;

    // Always inject a FRESH <script> tag on every mount (every open of
    // the modal), rather than deduplicating by src/data-attribute as a
    // prior version did. VTurb's player.js is a self-contained IIFE
    // with no shared/global "already initialized" guard keyed on
    // anything other than the DOM element it finds by id at parse
    // time -- so it is safe, and in fact REQUIRED, to re-run it every
    // time a fresh `vid-${playerId}` element is mounted; the browser's
    // own HTTP cache means re-fetching costs nothing after the first
    // load. This is what makes reopen work correctly now that the
    // element id itself is stable: without re-executing the script,
    // VTurb would never re-attach to the newly (re)mounted element.
    const script = document.createElement("script");
    script.src = scriptUrl;
    script.async = true;
    script.dataset.vturbPlayer = playerId;
    document.head.appendChild(script);
    scriptRef.current = script;

    return () => {
      // Clean up the script tag we injected for THIS mount when the
      // modal closes (component unmounts). This does not touch VTurb's
      // separately-loaded, globally shared `vturb-smartplayer-js` web
      // component definition script (that one is deduplicated by
      // VTurb's own player.js via its own `id` check, and is
      // intentionally left alone here) -- only the small per-player
      // loader script this effect appended.
      if (scriptRef.current && scriptRef.current.parentNode) {
        scriptRef.current.parentNode.removeChild(scriptRef.current);
      }
      scriptRef.current = null;
    };
  }, [playerId, scriptUrl]);

  if (!playerId || !scriptUrl) return null;

  return (
    <div ref={containerRef} className="aspect-video w-full bg-black">
      {/* vturb-smartplayer is a real custom element registered by VTurb's player.js, not a typo'd standard tag.
          id MUST stay exactly `vid-${playerId}` -- VTurb's player.js looks up this EXACT id via
          document.getElementById() to attach to. Never randomize this. */}
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
