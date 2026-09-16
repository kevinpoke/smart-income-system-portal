"use client";

// UI TASK C: admin-facing view of the permanent Never-Logged-In-By-Day-3
// list (see lib/neverLoggedIn.js / lib/db.js admin_never_logged_in_3day
// for the backend). This list is a historical, append-only fact set --
// an account that eventually DID log in (currentFirstLoginAt non-null)
// still permanently belongs here, per spec, so it is never filtered out
// client-side; the table just shows "Never" vs. the actual timestamp.
import { useCallback, useEffect, useState } from "react";
import { GlassCard } from "@/components/ui/Primitives";
import { formatAdminDateTime } from "@/lib/adminTime";
import { Search, UserX, X, Download } from "lucide-react";

const PAGE_SIZE_OPTIONS = [30, 50, 100, 200, 500];

function displayName(row) {
  const first = (row.firstName || "").trim();
  const last = (row.lastName || "").trim();
  if (first && last) return `${first} ${last}`;
  if (first) return first;
  if (last) return last;
  if (row.name && row.name.trim()) return row.name.trim();
  return "—";
}

export default function NeverLoggedInPage() {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50); // spec default pageSize 50
  const [rows, setRows] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  const load = useCallback(async () => {
    setStatus((s) => (s === "ready" ? s : "loading"));
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      const res = await fetch(`/api/admin/never-logged-in?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("failed");
      const data = await res.json();
      setRows(data.rows || []);
      setTotalCount(typeof data.totalCount === "number" ? data.totalCount : 0);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, [search, page, pageSize]);

  useEffect(() => {
    // fetch-on-mount / on-filter-change, same pattern as the rest of the
    // admin portal (AnalyticsPanel.js, chats page).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // On-submit search (Enter or the Search button), matching the chats
  // page's debounced-but-explicit search UX closely enough while
  // keeping this page simple -- a new search always resets to page 1.
  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(id);
  }, [searchInput]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPage(1);
  }, [search]);

  function handlePageSizeChange(nextSize) {
    setPageSize(nextSize);
    setPage(1);
  }

  // NEVER-LOGGED-IN-EXPORT batch: "Export All" always exports the ENTIRE
  // permanent cohort, completely independent of the current page/
  // pageSize/search state (spec: "The main button should export ALL
  // cohort members regardless of current pagination... do NOT silently
  // export only filtered rows"). Deliberately never passes `search` to
  // the export endpoint, so an active search box filter can never
  // silently narrow what this specific button downloads. Triggers a
  // real browser file download via a temporary object URL + anchor
  // click (no server-rendered link, no new tab) so the admin stays on
  // this page throughout.
  async function handleExportAll() {
    if (exporting) return;
    setExporting(true);
    setExportError("");
    try {
      const res = await fetch("/api/admin/never-logged-in/export", { cache: "no-store" });
      if (!res.ok) throw new Error("export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const dateStamp = new Date().toISOString().slice(0, 10);
      a.download = `never-logged-in-emails-${dateStamp}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setExportError("Unable to export the list. Please try again.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <GlassCard className="p-5">
      <div className="mb-4 flex items-center gap-2">
        <UserX className="h-4 w-4 text-[#32B5FF]" />
        <h3 className="text-sm font-semibold text-white">Never Logged In (By Day 3)</h3>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-[#B0B0B0]">
          Total: <span className="font-semibold text-white">{totalCount}</span> account
          {totalCount === 1 ? "" : "s"}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleExportAll}
            disabled={exporting}
            className="flex items-center gap-1.5 rounded-lg border border-[#32B5FF]/40 bg-[#32B5FF]/10 px-3 py-1.5 text-xs font-semibold text-[#32B5FF] transition hover:bg-[#32B5FF]/20 disabled:cursor-not-allowed disabled:opacity-50"
            title="Export the entire Never Logged In cohort as a CSV file"
          >
            <Download className="h-3.5 w-3.5" />
            {exporting ? "Exporting…" : "Export All"}
          </button>
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#707070]" />
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by email…"
              className="w-full rounded-lg border border-white/10 bg-white/5 py-1.5 pl-7 pr-7 text-xs text-white placeholder-[#707070] outline-none focus:ring-1 focus:ring-[#32B5FF]"
            />
            {searchInput && (
              <button
                onClick={() => setSearchInput("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[#707070] hover:text-white"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      </div>

      {exportError && (
        <div className="mb-4 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">
          {exportError}
        </div>
      )}


      {status === "error" && (
        <div className="mb-4 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">
          Unable to load this list.
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-[#707070]">
              <th className="px-3 py-3">Email</th>
              <th className="px-3 py-3">Joined Date</th>
              <th className="px-3 py-3">First Login</th>
              <th className="px-3 py-3">Qualified Date</th>
            </tr>
          </thead>
          <tbody>
            {status === "loading" && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-xs text-[#707070]">
                  Loading…
                </td>
              </tr>
            )}
            {status === "ready" && rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-xs text-[#707070]">
                  No accounts match this search.
                </td>
              </tr>
            )}
            {status === "ready" &&
              rows.map((row) => (
                <tr
                  key={row.accountId}
                  className="border-b border-white/5 align-top text-[#B0B0B0] hover:bg-white/[0.03]"
                >
                  <td className="px-3 py-3">
                    <div className="text-xs font-medium text-white">
                      {row.currentEmail || row.emailSnapshot}
                    </div>
                    <div className="text-[11px] text-[#707070]">{displayName(row)}</div>
                  </td>
                  <td className="px-3 py-3 text-xs">{formatAdminDateTime(row.createdAtSnapshot)}</td>
                  <td className="px-3 py-3 text-xs">
                    {row.currentFirstLoginAt ? (
                      formatAdminDateTime(row.currentFirstLoginAt)
                    ) : (
                      <span className="text-[#707070]">Never</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-xs">{formatAdminDateTime(row.qualifiedAt)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <select
          value={pageSize}
          onChange={(e) => handlePageSizeChange(Number(e.target.value))}
          className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[10px] font-medium text-[#B0B0B0] outline-none focus:ring-1 focus:ring-[#32B5FF]"
          title="Rows per page"
        >
          {PAGE_SIZE_OPTIONS.map((size) => (
            <option key={size} value={size} className="bg-[#1E1E1E] text-white">
              {size} / page
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="rounded-full bg-white/5 px-2.5 py-1 text-[11px] font-medium text-[#B0B0B0] hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-[11px] text-[#707070]">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="rounded-full bg-white/5 px-2.5 py-1 text-[11px] font-medium text-[#B0B0B0] hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>
    </GlassCard>
  );
}
