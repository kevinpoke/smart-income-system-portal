"use client";

import { useCallback, useEffect, useState } from "react";
import { useLiveClock } from "@/lib/useLiveClock";
import { useHasMounted } from "@/lib/useHasMounted";
import { formatCountdown, ISP_AUTO_APPROVE_AFTER_MS } from "@/lib/mockData";
import {
  ISP_ACTION,
  computeIspAction,
  ispActionFilterToIspStatusParam,
  ISP_ACTION_FILTER_OPTIONS,
} from "@/lib/ispActionState";
import { GlassCard } from "@/components/ui/Primitives";
import { CheckCircle2, ShieldCheck, Search, X, ChevronLeft, ChevronRight, Zap } from "lucide-react";

// ISP support controls + special bridges batch: matches
// lib/ispEngine.js AUTO_APPROVE_AFTER_MS (now 1 hour, was 3 days) --
// imported from lib/mockData.js (see that file's comment) so this
// admin-facing countdown can never disagree with the server's real
// deadline.
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
  const [confirmingId, setConfirmingId] = useState(null);
  const [error, setError] = useState("");

  const [searchInput, setSearchInput] = useState("");
  const searchTerm = useDebouncedValue(searchInput, SEARCH_DEBOUNCE_MS);
  // Admin-portal batch: Action filter ("all" | "approve" |
  // "isp_confirmation") -- reuses the EXISTING server-side `ispStatus`
  // query param this route already supports (see
  // lib/ispActionState.js#ispActionFilterToIspStatusParam), so this is
  // genuinely server-side filtering, not a client-side slice of an
  // already-fetched page.
  const [actionFilter, setActionFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      // Admin ISP Confirmation batch: list BOTH rows still awaiting the
      // existing admin approval action AND rows the admin already
      // approved that are now awaiting final ISP Confirmation, in one
      // server-side query/page -- see GET /api/admin/accounts's
      // comma-separated ispStatus support. Admin-portal batch: the
      // Action filter narrows this SAME param to a single isp_status
      // value instead of the full pair -- see
      // lib/ispActionState.js#ispActionFilterToIspStatusParam, the ONE
      // place this mapping lives (shared with the Action column's own
      // label logic below via computeIspAction()) so filter and column
      // can never disagree.
      params.set("ispStatus", ispActionFilterToIspStatusParam(actionFilter));
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
  }, [searchTerm, actionFilter, page]);

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

  // Same reset rule for the Action filter -- switching filters must not
  // leave the user stranded on a page number that no longer exists for
  // the newly (possibly much smaller) filtered set. Search term is
  // preserved across a filter change (both persist independently).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPage(1);
  }, [actionFilter]);

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

  // Admin ISP Confirmation: performs the customer's own final
  // confirmation/activation step on their behalf via the admin-only
  // POST /api/admin/isp/[id]/confirm route, which itself calls the same
  // canonical lib/ispEngine.js#completeIspAuthorization() the customer's
  // own confirmation uses -- see that route for the full contract.
  async function handleConfirm(id) {
    setError("");
    setConfirmingId(id);
    try {
      const res = await fetch(`/api/admin/isp/${id}/confirm`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "ISP confirmation failed.");
        return;
      }
      await loadAccounts();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setConfirmingId(null);
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
      <div className="flex flex-wrap items-center gap-3 border-b border-white/10 px-5 py-3">
        <div className="relative max-w-sm flex-1">
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
        {/* Admin-portal batch: Action filter -- All / Approve / ISP
            Confirmation. Purely a read filter: changing it only affects
            which rows are FETCHED (via the ispStatus query param), it
            never calls the approve/confirm routes or otherwise mutates
            any account's isp_status. */}
        <div className="flex items-center gap-1.5">
          <label htmlFor="isp-action-filter" className="text-xs font-medium text-[#B0B0B0]">
            Action
          </label>
          <select
            id="isp-action-filter"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            aria-label="Filter by Action"
            className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white outline-none focus:ring-1 focus:ring-[#32B5FF]"
          >
            {ISP_ACTION_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
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
                <th className="px-4 py-3">Action</th>
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
                    ? new Date(a.ispSubmittedAt).getTime() + ISP_AUTO_APPROVE_AFTER_MS
                    : null;
                  const remaining = deadline != null ? Math.max(0, deadline - now) : null;
                  // Admin-portal batch: the Action COLUMN now derives its
                  // button/label from the SAME computeIspAction() helper
                  // the Action FILTER uses (lib/ispActionState.js) --
                  // this is the "reuse the exact state logic" requirement
                  // from spec section C, guaranteeing filter and column
                  // can never disagree about what a given row's Action is.
                  const action = computeIspAction(a.ispStatus);
                  const awaitingConfirmation = action === ISP_ACTION.ISP_CONFIRMATION;
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
                        {awaitingConfirmation ? (
                          <button
                            onClick={() => handleConfirm(a.id)}
                            disabled={confirmingId === a.id}
                            className="flex items-center gap-1 rounded-lg bg-[#32B5FF]/15 px-2 py-1.5 text-xs font-semibold text-[#32B5FF] hover:bg-[#32B5FF]/25 disabled:opacity-50"
                          >
                            <Zap className="h-3.5 w-3.5" />
                            {confirmingId === a.id ? "Confirming…" : "ISP Confirmation"}
                          </button>
                        ) : (
                          <button
                            onClick={() => handleApprove(a.id)}
                            disabled={approvingId === a.id}
                            className="flex items-center gap-1 rounded-lg bg-green-500/15 px-2 py-1.5 text-xs font-semibold text-green-400 hover:bg-green-500/25 disabled:opacity-50"
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            {approvingId === a.id ? "Approving…" : "Approve"}
                          </button>
                        )}
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
