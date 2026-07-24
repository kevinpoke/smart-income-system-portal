"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useStore } from "@/lib/store";
import { useLiveClock } from "@/lib/useLiveClock";
import { MODULES_META, formatCompactDuration } from "@/lib/mockData";
import { GlassCard, SectionTitle, Badge, AccentButton } from "@/components/ui/Primitives";
import { Lock, PlayCircle, CheckCircle2, X } from "lucide-react";

function ModuleCard({ meta, moduleState, now, onOpen }) {
  const unlocked =
    moduleState?.unlockedAt && new Date(moduleState.unlockedAt).getTime() <= now;
  const viewed = Boolean(moduleState?.viewedAt);
  const countdown = moduleState?.unlockedAt
    ? Math.max(0, new Date(moduleState.unlockedAt).getTime() - now)
    : null;

  return (
    <motion.div
      whileHover={unlocked ? { y: -3 } : {}}
      className="h-full"
    >
      <GlassCard
        className={`flex h-full flex-col overflow-hidden ${
          unlocked ? "" : "opacity-60"
        }`}
      >
        <div className="relative flex aspect-video items-center justify-center bg-gradient-to-br from-[#1c2a33] to-[#0e1a20]">
          {unlocked ? (
            <button
              onClick={() => onOpen(meta.id)}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-[#32B5FF]/20 text-[#32B5FF] backdrop-blur transition hover:bg-[#32B5FF]/30"
            >
              <PlayCircle className="h-8 w-8" />
            </button>
          ) : (
            <div className="flex flex-col items-center gap-2 text-[#707070]">
              <Lock className="h-8 w-8" />
              {countdown != null && countdown > 0 && (
                <span className="font-mono text-xs">
                  Unlocks in {formatCompactDuration(countdown)}
                </span>
              )}
            </div>
          )}
          {viewed && (
            <div className="absolute right-2 top-2">
              <Badge tone="success">
                <CheckCircle2 className="mr-1 h-3 w-3" /> Watched
              </Badge>
            </div>
          )}
        </div>
        <div className="flex flex-1 flex-col gap-1 p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-[#32B5FF]">
            Module {meta.id}
          </div>
          <h3 className="text-sm font-bold text-white">{meta.title}</h3>
          <p className="mt-1 flex-1 text-xs text-[#B0B0B0]">{meta.description}</p>
          <div className="mt-2 text-[11px] text-[#707070]">
            Duration: {meta.duration}
          </div>
        </div>
      </GlassCard>
    </motion.div>
  );
}

function VideoModal({ meta, onClose, onFinish }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl overflow-hidden rounded-2xl border border-white/10 bg-[#1E1E1E]"
      >
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <h3 className="text-sm font-semibold text-white">{meta.title}</h3>
          <button onClick={onClose} className="text-white/60 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex aspect-video items-center justify-center bg-black text-center">
          <div className="max-w-sm px-6">
            <PlayCircle className="mx-auto mb-3 h-14 w-14 text-[#32B5FF]" />
            <p className="text-sm text-[#B0B0B0]">
              [Placeholder video — {meta.duration}] This training walks
              through &quot;{meta.title}&quot; in detail.
            </p>
          </div>
        </div>
        <div className="flex items-center justify-between p-4">
          <p className="text-xs text-[#707070]">
            Mark as watched to unlock the next module in 12 hours.
          </p>
          <AccentButton onClick={() => onFinish(meta.id)}>
            Mark as Watched
          </AccentButton>
        </div>
      </motion.div>
    </motion.div>
  );
}

export default function ModulesPage() {
  const user = useStore((s) => s.users[s.currentUserId]);
  const viewModule = useStore((s) => s.viewModule);
  const now = useLiveClock(1000);
  const [openModuleId, setOpenModuleId] = useState(null);

  const openMeta = MODULES_META.find((m) => m.id === openModuleId);

  return (
    <div className="space-y-6">
      <SectionTitle
        eyebrow="Training"
        title="Modules"
        subtitle="Watch each module to unlock the next one, 12 hours after you finish."
      />
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {MODULES_META.map((meta) => (
          <ModuleCard
            key={meta.id}
            meta={meta}
            moduleState={user?.modules?.[meta.id]}
            now={now}
            onOpen={setOpenModuleId}
          />
        ))}
      </div>

      {openMeta && (
        <VideoModal
          meta={openMeta}
          onClose={() => setOpenModuleId(null)}
          onFinish={(id) => {
            viewModule(id);
            setOpenModuleId(null);
          }}
        />
      )}
    </div>
  );
}
