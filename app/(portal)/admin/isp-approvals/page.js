"use client";

import { useCallback, useEffect, useState } from "react";
import { useLiveClock } from "@/lib/useLiveClock";
import { useHasMounted } from "@/lib/useHasMounted";
import { formatCountdown } from "@/lib/mockData";
import { GlassCard } from "@/components/ui/Primitives";
import { CheckCircle2, ShieldCheck } from "lucide-react";

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

// Refinement pass: moved out of the combined admin/page.js "Users" tab
// into its own dedicated /admin/isp-approvals tab/page (per spec). Still
// the exact same real, SQLite-backed ISP approval panel (Phase 2) --
// operates on the same /api/admin/accounts data and the same
// /api/admin/isp/[id]/approve route; no Zustand/localStorage involved.
export default function AdminIspApprovalsPage() {
  const now = useLiveClock(1000);
  const hasMounted = useHasMounted();
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [approvingId, setApprovingId] = useState(null);
  const [error, setError] = useState("");

  const loadAccounts = useCallback(async () => {
    try {
      // Pending review is typically a small subset; fetch a generous page
      // size so this tab doesn't need its own pagination for a workload
      // that should stay small in practice.
      const res = await fetch("/api/admin/accounts?pageSize=100&sortBy=createdAt&sortDir=asc", {
        cache: "no-store",
      });
      const data = await res.json();
      setAccounts((data.accounts || []).filter((a) => a.ispStatus === "pending_review"));
    } catch {
      // table just stays stale on a transient error
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // fetch-on-mount, same pattern as lib/useAccount.js.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAccounts();
  }, [loadAccounts]);

  async function handleApprove(id) {
    setError("");
    setApprovingId(id);
    try {
      const res = await fetch(`/api/admin/isp/${id}/approve`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Approval failed.");
        return;
      }
      await loadAccounts();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setApprovingId(null);
    }
  }

  if (!hasMounted || loading) {
    return (
      <GlassCard className="p-6 text-sm text-[#707070]">Loading pending ISP approvals…</GlassCard>
    );
  }

  return (
    <GlassCard className="overflow-hidden">
      <div className="border-b border-white/10 px-5 py-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
          <ShieldCheck className="h-4 w-4 text-[#32B5FF]" /> ISP Approvals
        </h3>
        <p className="text-xs text-[#B0B0B0]">
          Approving here only moves the account to &ldquo;approved, awaiting user&rdquo; --
          earnings/connection only begin once the customer clicks &ldquo;I Approve&rdquo; on their
          own ISP Setup page.
        </p>
      </div>
      {error && (
        <div className="border-b border-white/10 px-5 py-3">
          <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>
        </div>
      )}
      {accounts.length === 0 ? (
        <div className="px-5 py-4 text-xs text-[#707070]">
          No accounts currently pending ISP review.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-[#707070]">
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Submitted</th>
                <th className="px-4 py-3">Review Countdown</th>
                <th className="px-4 py-3">Approve</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const deadline = a.ispSubmittedAt
                  ? new Date(a.ispSubmittedAt).getTime() + THREE_DAYS_MS
                  : null;
                const remaining = deadline != null ? Math.max(0, deadline - now) : null;
                return (
                  <tr key={a.id} className="border-b border-white/5 text-[#B0B0B0]">
                    <td className="px-4 py-3 font-mono text-xs text-white">{a.email}</td>
                    <td className="px-4 py-3 text-xs">
                      {a.ispSubmittedAt ? new Date(a.ispSubmittedAt).toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {remaining != null ? formatCountdown(remaining) : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleApprove(a.id)}
                        disabled={approvingId === a.id}
                        className="flex items-center gap-1 rounded-lg bg-green-500/15 px-2 py-1.5 text-xs font-semibold text-green-400 hover:bg-green-500/25 disabled:opacity-50"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        {approvingId === a.id ? "Approving…" : "Approve"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </GlassCard>
  );
}
