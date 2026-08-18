"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useLiveClock } from "@/lib/useLiveClock";
import { useHasMounted } from "@/lib/useHasMounted";
import { formatCompactDuration } from "@/lib/mockData";
import { normalizeModuleVideo } from "@/lib/moduleVideo";
import { GlassCard, SectionTitle, Badge, AccentButton } from "@/components/ui/Primitives";
import { Lock, PlayCircle, CheckCircle2, X } from "lucide-react";

// Refinement pass: module lock/unlock/completion state is now entirely
// server-persisted (see lib/moduleEngine.js, GET /api/modules, POST
// /api/modules/[key]/complete) -- this page no longer reads or writes
// the old Zustand `modules` state at all. Every countdown renders FROM a
// server-provided `unlockAt`/`countdownMs` value; a page refresh, logout/
// login, or opening the portal on a different device all show the exact
// same state because it's the same database row every time.
function ModuleCard({ mod, now, onOpen }) {
  const unlocked = mod.unlocked;
  const completed = mod.completed;
  // Live countdown recomputed every tick from the persisted unlockAt --
  // never from the countdownMs snapshot alone (that would freeze between
  // polls). unlockAt is only present once the module's row exists (i.e.
  // its countdown has actually started); modules further out that are
  // still awaiting a previous completion show fixed copy instead.
  const countdown =
    !unlocked && mod.unlockAt ? Math.max(0, new Date(mod.unlockAt).getTime() - now) : null;

  return (
    <motion.div whileHover={unlocked ? { y: -3 } : {}} className="h-full">
      <GlassCard
        className={`flex h-full flex-col overflow-hidden ${unlocked ? "" : "opacity-60"}`}
      >
        <div className="relative flex aspect-video items-center justify-center bg-gradient-to-br from-[#1c2a33] to-[#0e1a20]">
          {unlocked ? (
            <button
              onClick={() => onOpen(mod.id)}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-[#32B5FF]/20 text-[#32B5FF] backdrop-blur transition hover:bg-[#32B5FF]/30"
            >
              <PlayCircle className="h-8 w-8" />
            </button>
          ) : (
            <div className="flex flex-col items-center gap-2 px-4 text-center text-[#707070]">
              <Lock className="h-8 w-8" />
              {countdown != null && countdown > 0 ? (
                <span
                  className="animate-pulse font-mono text-xs font-semibold text-[#32B5FF] [animation-duration:2.5s] [text-shadow:0_0_8px_rgba(50,181,255,0.85),0_0_16px_rgba(50,181,255,0.5)]"
                >
                  Unlocks in {formatCompactDuration(countdown)}
                </span>
              ) : mod.awaitingPrevious ? (
                <span className="text-xs">Complete previous modules to Unlock this video</span>
              ) : null}
            </div>
          )}
          {completed && (
            <div className="absolute right-2 top-2">
              <Badge tone="success">
                <CheckCircle2 className="mr-1 h-3 w-3" /> Watched
              </Badge>
            </div>
          )}
        </div>
        <div className="flex flex-1 flex-col gap-1 p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-[#32B5FF]">
            Module {mod.id}
          </div>
          <h3 className="text-sm font-bold text-white">{mod.title}</h3>
          <p className="mt-1 flex-1 text-xs text-[#B0B0B0]">{mod.description}</p>
          <div className="mt-2 text-[11px] text-[#707070]">Duration: {mod.duration}</div>
        </div>
      </GlassCard>
    </motion.div>
  );
}

function VideoModal({ mod, onClose, onFinish, finishing }) {
  // Training Module video support: normalize the module's raw
  // admin-supplied videoUrl (if any) into a safe, embeddable descriptor
  // via lib/moduleVideo.js -- the ONLY place URL validation/normalization
  // happens. `video` is null whenever no URL is set OR the URL is
  // unsupported/invalid, in which case the existing placeholder card
  // below is shown unchanged (safe fallback, never raw HTML injection,
  // never an unvalidated iframe/video src).
  const video = mod.videoUrl ? normalizeModuleVideo(mod.videoUrl, mod.videoType) : null;

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
          <h3 className="text-sm font-semibold text-white">{mod.title}</h3>
          <button onClick={onClose} className="text-white/60 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>
        {/* Responsive 16:9 video container, per spec, shared by both the
            direct <video> and iframe (Google Drive/YouTube/Vimeo)
            render paths below -- aspect-video keeps the box the same
            ratio at any width, both desktop and mobile. */}
        {video?.kind === "direct" ? (
          <div className="aspect-video w-full bg-black">
            <video
              key={video.src}
              src={video.src}
              controls
              className="h-full w-full"
              title={mod.videoTitle || mod.title}
            >
              Your browser does not support embedded video playback.
            </video>
          </div>
        ) : video?.kind === "iframe" ? (
          <div className="aspect-video w-full bg-black">
            <iframe
              key={video.src}
              src={video.src}
              title={mod.videoTitle || mod.title}
              className="h-full w-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              // No referrer/sandbox override needed beyond the browser's
              // own iframe defaults -- src is already restricted to the
              // small explicit hostname allowlist in
              // lib/moduleVideo.js, so this can never render arbitrary
              // attacker-controlled markup or a javascript:/data: URL.
            />
          </div>
        ) : (
          <div className="flex aspect-video items-center justify-center bg-gradient-to-br from-[#1c2a33] to-[#0e1a20] text-center">
            <div className="max-w-sm px-6">
              <PlayCircle className="mx-auto mb-3 h-14 w-14 text-[#32B5FF]" />
              <p className="text-sm text-[#B0B0B0]">
                [Placeholder video — {mod.duration}] This training walks through &quot;{mod.title}
                &quot; in detail.
              </p>
            </div>
          </div>
        )}
        <div className="flex items-center justify-between p-4">
          <p className="text-xs text-[#707070]">
            {mod.completed
              ? "Already marked as watched."
              : "Mark as watched to unlock the next module in 12 hours."}
          </p>
          <AccentButton onClick={() => onFinish(mod.id)} disabled={finishing || mod.completed}>
            {mod.completed ? "Watched" : finishing ? "Saving…" : "Mark as Watched"}
          </AccentButton>
        </div>
      </motion.div>
    </motion.div>
  );
}

export default function ModulesPage() {
  const now = useLiveClock(1000);
  const hasMounted = useHasMounted();
  const [modules, setModules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openModuleId, setOpenModuleId] = useState(null);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/modules", { cache: "no-store" });
      const data = await res.json();
      setModules(data.modules || []);
    } catch {
      setError("Unable to load modules. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // fetch-on-mount, same pattern as lib/useAccount.js.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const openMod = modules.find((m) => m.id === openModuleId);

  async function handleFinish(moduleId) {
    setFinishing(true);
    setError("");
    try {
      const res = await fetch(`/api/modules/${moduleId}/complete`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Unable to mark this module as watched.");
        return;
      }
      setModules(data.modules || []);
      setOpenModuleId(null);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setFinishing(false);
    }
  }

  if (!hasMounted || loading) {
    return (
      <div className="space-y-6">
        <SectionTitle eyebrow="Training" title="Modules" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SectionTitle
        eyebrow="Training"
        title="Modules"
        subtitle={
          <>
            Please watch all the videos below to deepen your understanding of Smart Income System and learn
            how to maximize both your earnings and your contribution to the network.
            <br />
            <br />
            Each module unlocks 12 hours after the previous one. This pacing is designed to
            prevent users from rushing through the material and to ensure sufficient time to
            understand each section before continuing. The objective is not simply to complete
            the videos, but to develop a clear understanding of the business model.
          </>
        }
      />
      {error && (
        <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>
      )}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {modules.map((mod) => (
          <ModuleCard key={mod.id} mod={mod} now={now} onOpen={setOpenModuleId} />
        ))}
      </div>

      {openMod && (
        <VideoModal
          mod={openMod}
          onClose={() => setOpenModuleId(null)}
          onFinish={handleFinish}
          finishing={finishing}
        />
      )}
    </div>
  );
}
