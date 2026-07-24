"use client";

import { useMemo } from "react";
import { useStore } from "@/lib/store";
import { generateNodes, formatCurrency } from "@/lib/mockData";
import { GlassCard, SectionTitle, FadeIn, Badge } from "@/components/ui/Primitives";
import { Server, Zap, Wifi } from "lucide-react";

export default function NodesPage() {
  const user = useStore((s) => s.users[s.currentUserId]);

  const seed = useMemo(
    () => Math.floor(new Date(user?.joinDate || Date.now()).getTime() / 1000) + 42,
    [user?.joinDate]
  );

  const nodes = useMemo(() => generateNodes(seed, 24), [seed]);

  return (
    <div className="space-y-6">
      <SectionTitle
        eyebrow="Marketplace"
        title="Nodes"
        subtitle="Premium node inventory in high demand — most sell out within hours."
      />

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {nodes.map((node, i) => {
          const isSuper = node.type === "Super Node";
          return (
            <FadeIn key={node.id} delay={Math.min(i * 0.02, 0.3)}>
              <GlassCard className="relative overflow-hidden p-5">
                {node.status === "SOLD" && (
                  <div className="absolute right-3 top-3 rotate-3 rounded-md bg-red-600 px-2.5 py-1 text-xs font-extrabold tracking-wide text-white shadow-lg">
                    SOLD
                  </div>
                )}
                <div className="mb-3 flex items-center gap-2">
                  <div
                    className={`rounded-lg p-2 ${
                      isSuper ? "bg-yellow-500/15" : "bg-[#32B5FF]/15"
                    }`}
                  >
                    {isSuper ? (
                      <Zap className="h-5 w-5 text-yellow-400" />
                    ) : (
                      <Server className="h-5 w-5 text-[#32B5FF]" />
                    )}
                  </div>
                  <div>
                    <div className="text-sm font-bold text-white">{node.id}</div>
                    <Badge tone={isSuper ? "warning" : "accent"}>{node.type}</Badge>
                  </div>
                </div>

                <div className="space-y-1.5 text-xs text-[#B0B0B0]">
                  <div className="flex items-center gap-1.5">
                    <Wifi className="h-3.5 w-3.5" />
                    <span className="font-mono">{node.ip}</span>
                  </div>
                  <div className="flex items-center justify-between pt-2">
                    <span>Est. Monthly</span>
                    <span className="font-mono font-semibold text-white">
                      {formatCurrency(node.estMonthly)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Cost</span>
                    <span className="font-mono font-semibold text-white">
                      {formatCurrency(node.cost)}
                    </span>
                  </div>
                </div>
              </GlassCard>
            </FadeIn>
          );
        })}
      </div>
    </div>
  );
}
