"use client";

import clsx from "clsx";
import { Badge } from "./Primitives";

// Shared tier badge for owned Nodes -- Standard/Super render as the
// existing plain Badge (accent/warning tones, unchanged from before this
// refinement pass). Nova gets a distinct purple glow treatment: a
// visible purple border/text/box-shadow/text-shadow with a slow, subtle
// pulse -- SAME pulse timing/character already proven safe in this
// codebase for the module timer glow (see app/(portal)/modules/page.js:
// animate-pulse with a 2.5s custom duration and a soft multi-layer
// text-shadow) so Nova's glow reads as "premium accent," never
// distracting/flashing. Used everywhere a tier badge renders (Dashboard
// "Your Nodes", the Nodes marketplace, User Management's Node column,
// and both the Edit Node / Add Node admin popups) so there is exactly
// one visual definition of "what a Nova Node looks like."

// Refinement pass (Nova card glow fix): the badge above only glows a
// small pill -- it was never enough to satisfy "the entire Node card
// must visibly glow purple" (Dashboard "Your Nodes" row / Nodes
// marketplace row). This is the SINGLE shared class string applied to
// the whole table row/card container for a Nova Node in both places, so
// the Dashboard and Nodes-page Nova treatment stay visually identical
// forever (no duplicated glow definitions to drift out of sync). A
// static ambient glow (border + box-shadow + faint purple tint), NOT an
// animate-pulse loop -- pulsing the entire row would also fade the
// earnings text/numbers inside it on every cycle, which reads as
// "broken," not "premium." The badge itself keeps its own subtle pulse
// (small, isolated element) for the accent flourish.
export const NOVA_CARD_GLOW_CLASS =
  "relative z-0 border-purple-400/40 bg-purple-500/[0.07] " +
  "shadow-[inset_0_0_0_1px_rgba(192,132,252,0.35),0_0_18px_2px_rgba(192,132,252,0.35)]";

export default function NodeTierBadge({ tierKey, tier, className = "", children }) {
  const label = tier || (tierKey ? `${tierKey[0].toUpperCase()}${tierKey.slice(1)} Node` : "—");

  if (tierKey === "nova") {
    return (
      <span
        className={clsx(
          "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold",
          "animate-pulse [animation-duration:2.5s]",
          "border-purple-400/50 bg-purple-500/15 text-purple-300",
          "shadow-[0_0_10px_rgba(192,132,252,0.45)]",
          "[text-shadow:0_0_8px_rgba(192,132,252,0.65)]",
          className
        )}
      >
        {children}
        {label}
      </span>
    );
  }

  return (
    <Badge tone={tierKey === "super" ? "warning" : "accent"} className={className}>
      {children}
      {label}
    </Badge>
  );
}
