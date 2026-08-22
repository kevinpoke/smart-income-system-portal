"use client";

import { useCallback, useEffect, useState } from "react";
import { useLiveClock } from "@/lib/useLiveClock";
import { useHasMounted } from "@/lib/useHasMounted";
import { formatCountdown } from "@/lib/mockData";
import { GlassCard } from "@/components/ui/Primitives";
import { CheckCircle2, ShieldCheck, Search, X, ChevronLeft, ChevronRight } from "lucide-react";

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 30;
// Debounce delay for the search input, matching the existing User
// Management search box pattern in app/(portal)/admin/page.js.
const SEARCH_DEBOUNCE_MS = 300;

// Debounce hook -- identical pattern to the one already used in
// app/(portal)/admin/page.js's User Management search box, duplicated
// here (rather than imported) since that one is a page-local, unexported
// function.
function useDebouncedValue(value, delayMs) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

// Refinement pass: moved out of the combined admin/page.js "Users" tab
// into its own dedicated /admin/isp-approvals tab/page (per spec). Still
// the exact same real, SQLite-backed ISP approval panel (Phase 2) --
// operates on the same /api/admin/accounts data and the same
// /api/admin/isp/[id]/approve route; no Zustand/localStorage involved.
//
// Admin batch (search + pagination): this tab now reuses the SAME
// authoritative, server-side-driven /api/admin/accounts endpoint the
// User Management tab uses, adding the new `ispStatus=pending_review`
// filter param (see app/api/admin/accounts/route.js) so search and
// pagination both run server-side against the full ISP-approval record
// set, never a client-side slice of a single fetched page. This
// REPLACES the previous "fetch up to 100 and filter client-side"
// approach, which could silently hide records beyond that fixed window.
export default function AdminIspApprovalsPage() {
  const now = useLiveClock(1000);
  const hasMounted = useHasMounted();
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [approvingId, setApprovingId] = useState(null);
  const [error, setError] = useState("");

  const [searchInput, setSearchInput] = useState("");
  const searchTerm = useDebouncedValue(searchInput, SEARCH_DEBOUNCE_MS);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("ispStatus", "pending_review");
      // Stable ordering (oldest-submitted-first) so rows don't jump
      // between pages unexpectedly as new submissions arrive between
      // fetches -- unchanged from the previous implementation's sort.
      params.set("sortBy", "joined");
      params.set("sortDir", "asc");
      params.set("page", String(page));
      params.set("pageSize", String(PAGE_SIZE));
      if (searchTerm.trim()) params.set("q", searchTerm.trim());

      const res = await fetch(`/api/admin/accounts?${params.toString()}`, {
        cache: "no-store",
      });
      const data = await res.json();
      setAccounts(data.accounts || []);
      setTotal(data.total || 0);
      setTotalPages(data.totalPages || 1);
    } catch {
      // table just stays stale on a transient error
    } finally {
      setLoading(false);
    }
  }, [searchTerm, page]);

  useEffect(() => {
    // fetch-on-mount + whenever search/page changes, same pattern as
    // lib/useAccount.js / the User Management tab.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAccounts();
  }, [loadAccounts]);

  // Reset to page 1 whenever the search term changes -- a stale page
  // number from a previous, larger result set could otherwise land past
  // the end of a new, smaller set. Search itself persists across page
  // changes (only page resets on a NEW search).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPage(1);
  }, [searchTerm]);

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

  if (!hasMounted) {
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

      {/* Search: visible near the top of the tab, filters against the
          authoritative account records (email, name, and account id --
          the identifying fields the Admin Portal already exposes/
          supports), case-insensitive partial match, works across every
          ISP approval record server-side (not just the current page). */}
      <div className="border-b border-white/10 px-5 py-3">
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#707070]" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by email, name, or account ID…"
            aria-label="Search ISP approvals"
            className="w-full rounded-xl border border-white/10 bg-white/5 py-2 pl-8 pr-8 text-xs text-white placeholder-[#707070] outline-none focus:ring-1 focus:ring-[#32B5FF]"
          />
          {searchInput && (
            <button
              onClick={() => setSearchInput("")}
              title="Clear search"
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[#707070] hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="border-b border-white/10 px-5 py-3">
          <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>
        </div>
      )}
      {!loading && accounts.length === 0 ? (
        <div className="px-5 py-4 text-xs text-[#707070]">
          {searchTerm
            ? "No pending ISP approvals match your search."
            : "No accounts currently pending ISP review."}
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
              {loading ? (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-xs text-[#707070]">
                    Loading…
                  </td>
                </tr>
              ) : (
                accounts.map((a) => {
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
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination: server-driven, works together with search (search
          resets to page 1; page changes preserve the active search
          term). */}
      <div className="flex flex-col items-center justify-between gap-2 border-t border-white/10 px-5 py-3 sm:flex-row">
        <span className="text-[11px] text-[#707070]">
          {total === 0
            ? "0 results"
            : `Showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} of ${total}`}
          {loading && " · Loading…"}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="flex items-center gap-1 rounded-lg bg-white/5 px-2.5 py-1.5 text-xs font-semibold text-[#B0B0B0] hover:bg-white/10 disabled:opacity-30"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Previous
          </button>
          <span className="text-xs text-[#B0B0B0]">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="flex items-center gap-1 rounded-lg bg-white/5 px-2.5 py-1.5 text-xs font-semibold text-[#B0B0B0] hover:bg-white/10 disabled:opacity-30"
          >
            Next <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </GlassCard>
  );
}
