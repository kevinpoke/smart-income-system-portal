"use client";

import { useEffect, useMemo, useState } from "react";
import { formatCurrency, centsToDollars, formatCountdown } from "@/lib/mockData";
import { useWaitlistStatus } from "@/lib/useWaitlistStatus";
import { useLiveClock } from "@/lib/useLiveClock";
import { useHasMounted } from "@/lib/useHasMounted";
import { GlassCard, SectionTitle, FadeIn, Badge } from "@/components/ui/Primitives";
import { Server, Zap, Wifi, Clock3, CheckCircle2 } from "lucide-react";

function WaitlistButton() {
  const { status, refetch } = useWaitlistStatus(5000);
  const now = useLiveClock(1000);
  const hasMounted = useHasMounted();
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState("");

  // deadlineAt - now depends on Date.now(), which differs between the
  // server render and the first client render. Gate behind hasMounted so
  // both agree (remainingMs === null, "Closes in ..." omitted) until the
  // real countdown appears right after mount and ticks every second.
  //
  // Computed inline (not useMemo) -- the React Compiler auto-memoizes this
  // and its own dependency inference disagreed with an explicit dep array
  // that includes hasMounted/now.
  let remainingMs = null;
  if (hasMounted && status?.deadlineAt) {
    remainingMs = Math.max(0, new Date(status.deadlineAt).getTime() - now);
  }

  async function handleJoin() {
    setError("");
    setJoining(true);
    try {
      const res = await fetch("/api/waitlist/join", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Unable to join waitlist.");
        return;
      }
      await refetch();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setJoining(false);
    }
  }

  if (!status) return null;

  const disabled = status.state !== "open" || joining;
  let label = "Join Waitlist";
  if (status.state === "joined") label = "Waitlist Joined";
  else if (status.state === "closed") label = "Waitlist Closed";
  else if (joining) label = "Joining…";

  return (
    <div className="flex flex-col items-end gap-1.5">
      <button
        onClick={handleJoin}
        disabled={disabled}
        aria-disabled={disabled}
        className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-all ${
          disabled
            ? "cursor-not-allowed bg-white/5 text-white/30"
            : "bg-[#32B5FF] text-[#06121a] shadow-[0_0_20px_rgba(50,181,255,0.35)] hover:bg-[#4dc0ff]"
        }`}
      >
        {status.state === "joined" && <CheckCircle2 className="h-4 w-4" />}
        {status.state === "open" && <Clock3 className="h-4 w-4" />}
        {label}
      </button>
      {status.state === "open" && remainingMs != null && (
        <span className="font-mono text-[11px] text-[#707070]">
          Closes in {formatCountdown(remainingMs)}
        </span>
      )}
      {error && <span className="text-[11px] text-red-400">{error}</span>}
    </div>
  );
}

export default function NodesPage() {
  const [nodes, setNodes] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/nodes", { cache: "no-store" });
        const data = await res.json();
        if (!cancelled) setNodes(data.nodes || []);
      } catch {
        if (!cancelled) setNodes([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <SectionTitle
          eyebrow="Marketplace"
          title="Nodes"
          subtitle="Premium node inventory in high demand — most sell out within hours."
        />
        <WaitlistButton />
      </div>

      <FadeIn>
        <GlassCard className="overflow-hidden">
          {loading ? (
            <div className="p-8 text-center text-sm text-[#707070]">Loading nodes…</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-[#707070]">
                    <th className="px-4 py-3">Node ID</th>
                    <th className="px-4 py-3">Location</th>
                    <th className="px-4 py-3">Node Tier</th>
                    <th className="px-4 py-3">IP Address</th>
                    <th className="px-4 py-3 text-right">Est. Monthly Earnings</th>
                    <th className="px-4 py-3 text-right">Cost</th>
                    <th className="px-4 py-3 text-right">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {nodes.map((node) => {
                    const isSuper = node.tier === "Super Node";
                    return (
                      <tr
                        key={node.nodeId}
                        className="border-b border-white/5 text-[#B0B0B0] transition hover:bg-white/[0.03]"
                      >
                        <td className="px-4 py-3 font-mono text-xs text-white">#{node.nodeId}</td>
                        <td className="px-4 py-3 text-xs">
                          <span className="inline-flex items-center gap-1">
                            <Wifi className="h-3 w-3 text-[#707070]" />
                            {node.location}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <Badge tone={isSuper ? "warning" : "accent"}>
                            {isSuper && <Zap className="mr-1 h-3 w-3" />}
                            {!isSuper && <Server className="mr-1 h-3 w-3" />}
                            {node.tier}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs">{node.ip}</td>
                        <td className="px-4 py-3 text-right font-mono text-xs text-white">
                          {formatCurrency(centsToDollars(node.estMonthlyCents))}
                          <div className="text-[10px] font-sans text-[#707070]">estimated</div>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs text-white">
                          {formatCurrency(centsToDollars(node.costCents))}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span className="rounded-md bg-red-600 px-2.5 py-1 text-[10px] font-extrabold tracking-wide text-white">
                            {node.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </GlassCard>
      </FadeIn>
    </div>
  );
}
