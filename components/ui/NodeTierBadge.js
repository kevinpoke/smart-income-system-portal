"use client";

import clsx from "clsx";
import { Badge } from "./Primitives";
import { tierKeyToBridgeDisplayName } from "@/lib/nodeTiers";

// Shared tier badge for owned Bridges (formerly "Nodes" -- internal
// tier keys/DB values are unchanged, see lib/nodeTiers.js). Bridge
// (standard) and Golden Bridge (super) render as the existing plain
// Badge (accent/warning tones, unchanged from before this rebrand
// pass). XI Bridge (nova) keeps its distinct purple glow treatment: a
// visible purple border/text/box-shadow/text-shadow with a slow, subtle
// pulse -- SAME pulse timing/character already proven safe in this
// codebase for the module timer glow (see app/(portal)/modules/page.js:
// animate-pulse with a 2.5s custom duration and a soft multi-layer
// text-shadow) so XI Bridge's glow reads as "premium accent" visual
// treatment, never distracting/flashing (note: XI Bridge/nova is now
// the LOWEST-earning tier per lib/nodeTiers.js -- only its VISUAL
// styling is preserved unchanged, not its earnings rank). Used
// everywhere a tier badge renders (Dashboard "Your Bridges", the Data
// Bridges marketplace, User Management's Bridge column, and both the
// Edit Bridge / Add Bridge admin popups) so there is exactly one visual
// definition of "what an XI Bridge looks like."

// Refinement pass (Nova/XI Bridge card glow fix): the badge above only
// glows a small pill -- it was never enough to satisfy "the entire
// card must visibly glow purple" (Dashboard "Your Bridges" row /
// Data Bridges marketplace row). This is the SINGLE shared class string
// applied to the whole table row/card container for an XI Bridge in
// both places, so the Dashboard and Data-Bridges-page treatment stay
// visually identical forever (no duplicated glow definitions to drift
// out of sync). A static ambient glow (border + box-shadow + faint
// purple tint), NOT an animate-pulse loop -- pulsing the entire row
// would also fade the earnings text/numbers inside it on every cycle,
// which reads as "broken," not "premium." The badge itself keeps its
// own subtle pulse (small, isolated element) for the accent flourish.
export const NOVA_CARD_GLOW_CLASS =
  "relative z-0 border-purple-400/40 bg-purple-500/[0.07] " +
  "shadow-[inset_0_0_0_1px_rgba(192,132,252,0.35),0_0_18px_2px_rgba(192,132,252,0.35)]";

// `tier` (if passed) is the INTERNAL display string ("Standard Node" /
// "Super Node" / "Nova Node", as still stored in owned_nodes.tier) --
// this component never renders that internal string directly; it
// always derives the customer/admin-facing Bridge label from
// `tierKey` via tierKeyToBridgeDisplayName() so the badge text is
// always "Bridge" / "Golden Bridge" / "XI Bridge" regardless of what
// legacy display string was passed in.
export default function NodeTierBadge({ tierKey, tier, className = "", children }) {
  const label = tierKeyToBridgeDisplayName(tierKey);

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
