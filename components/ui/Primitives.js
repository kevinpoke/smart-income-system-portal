"use client";

import { motion } from "framer-motion";
import clsx from "clsx";
import Link from "next/link";

export function GlassCard({ children, className = "", ...props }) {
  return (
    <div
      className={clsx(
        "rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-xl",
        "shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_8px_30px_rgba(0,0,0,0.4)]",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function PulsingDot({ color = "#22c55e", className = "" }) {
  return (
    <span className={clsx("relative inline-flex h-2.5 w-2.5", className)}>
      <span
        className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
        style={{ backgroundColor: color }}
      />
      <span
        className="relative inline-flex h-2.5 w-2.5 rounded-full"
        style={{ backgroundColor: color }}
      />
    </span>
  );
}

export function AccentButton({ children, className = "", disabled, ...props }) {
  return (
    <button
      disabled={disabled}
      className={clsx(
        "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold",
        "transition-all duration-200 active:scale-[0.98]",
        disabled
          ? "cursor-not-allowed bg-white/5 text-white/30"
          : "bg-[#32B5FF] text-[#06121a] shadow-[0_0_20px_rgba(50,181,255,0.35)] hover:bg-[#4dc0ff] hover:shadow-[0_0_28px_rgba(50,181,255,0.5)]",
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function GhostButton({ children, className = "", ...props }) {
  return (
    <button
      className={clsx(
        "inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 px-4 py-2.5 text-sm font-medium text-white/80",
        "transition-all duration-200 hover:border-[#32B5FF]/50 hover:text-white active:scale-[0.98]",
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function SectionTitle({ eyebrow, title, subtitle }) {
  return (
    <div className="mb-6">
      {eyebrow && (
        <div className="mb-1 text-xs font-semibold uppercase tracking-[0.2em] text-[#32B5FF]">
          {eyebrow}
        </div>
      )}
      <h1 className="text-2xl font-bold text-white sm:text-3xl">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-[#B0B0B0]">{subtitle}</p>}
    </div>
  );
}

export function Badge({ children, tone = "default", className = "" }) {
  const tones = {
    default: "bg-white/10 text-white/80",
    accent: "bg-[#32B5FF]/15 text-[#32B5FF] border border-[#32B5FF]/30",
    success: "bg-green-500/15 text-green-400 border border-green-500/30",
    warning: "bg-yellow-500/15 text-yellow-400 border border-yellow-500/30",
    danger: "bg-red-500/15 text-red-400 border border-red-500/30",
  };
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold",
        tones[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

export function FadeIn({ children, delay = 0, className = "" }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay, ease: "easeOut" }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

// Shared "Location Required" locked-state card, used by both the Payouts
// page and the Nodes page (per spec: "Show the same 'Location Required'
// locked-state popup/card used in the Payouts section"). `title`/`body`
// are overridable so each page can phrase the copy appropriately while
// keeping the exact same visual card and CTA.
export function LocationRequiredCard({
  title = "Location Required",
  body = "Complete your ISP Setup to continue.",
}) {
  return (
    <FadeIn>
      <GlassCard className="flex flex-col items-start justify-between gap-3 p-5 sm:flex-row sm:items-center">
        <div>
          <div className="text-sm font-semibold text-white">{title}</div>
          <div className="text-xs text-[#B0B0B0]">{body}</div>
        </div>
        <Link
          href="/isp-setup"
          className="rounded-xl bg-[#32B5FF] px-4 py-2.5 text-sm font-semibold text-[#06121a] shadow-[0_0_20px_rgba(50,181,255,0.35)] hover:bg-[#4dc0ff]"
        >
          Complete ISP Setup
        </Link>
      </GlassCard>
    </FadeIn>
  );
}
