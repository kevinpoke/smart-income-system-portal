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
