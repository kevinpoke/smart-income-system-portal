"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GlassCard, Badge, GhostButton } from "@/components/ui/Primitives";
import Avatar from "@/components/ui/Avatar";
import {
  Plus,
  Send,
  ClipboardCheck,
  MoreVertical,
  RefreshCw,
  MailOpen,
  X,
  Search,
  BarChart3,
} from "lucide-react";
import clsx from "clsx";

function formatTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return "";
  }
}

// Part 2: graceful First + Last name display -- falls back to whichever
// pieces are actually present (never renders literal "undefined"/"null").
// Order of preference: "First Last" -> First only -> Last only -> plain
// `name` -> email -> a neutral placeholder.
function displayFullName({ firstName, lastName, name, email }) {
  const first = (firstName || "").trim();
  const last = (lastName || "").trim();
  if (first && last) return `${first} ${last}`;
  if (first) return first;
  if (last) return last;
  if (name && name.trim()) return name.trim();
  if (email && email.trim()) return email.trim();
  return "Unknown";
}

function formatDurationMs(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function StatCard({ label, value, sub, className = "" }) {
  return (
    <div className={clsx("rounded-xl border border-white/10 bg-white/[0.03] p-3.5", className)}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-[#707070]">{label}</div>
      <div className="mt-1 text-2xl font-bold text-white">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-[#B0B0B0]">{sub}</div>}
    </div>
  );
}

const PERIOD_OPTIONS = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last3", label: "Last 3 Days" },
  { value: "lastweek", label: "Last Week" },
  { value: "lastmonth", label: "Last Month" },
  { value: "custom", label: "Custom" },
];

// Part 1: Analytics tab. Fetches ONE server-side aggregate payload from
// /api/admin/support/analytics -- never fetches raw account/message rows
// for client-side computation (per the spec's "ANALYTICS PERFORMANCE"
// requirement).
function AnalyticsTab() {
  const [period, setPeriod] = useState("lastweek");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setStatus((s) => (s === "ready" ? s : "loading"));
    try {
      const params = new URLSearchParams();
      params.set("period", period);
      if (period === "custom") {
        if (customStart) params.set("start", customStart);
        if (customEnd) params.set("end", customEnd);
      }
      const res = await fetch(`/api/admin/support/analytics?${params.toString()}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "Unable to load analytics.");
        setStatus("error");
        return;
      }
      setData(json);
      setError("");
      setStatus("ready");
    } catch {
      setError("Something went wrong loading analytics.");
      setStatus("error");
    }
  }, [period, customStart, customEnd]);

  useEffect(() => {
    // fetch-on-mount / on-filter-change, same pattern as the rest of this page.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const responseTimeText = useMemo(() => {
    if (!data?.responseTime) return null;
    if (data.responseTime.error) return data.responseTime.error;
    if (data.responseTime.avgMs == null) return "No manually-answered conversations in this period yet.";
    return `${formatDurationMs(data.responseTime.avgMs)} — Based on ${data.responseTime.count} ${
      data.responseTime.count === 1 ? "reply" : "replies"
    }`;
  }, [data]);

  return (
    <GlassCard className="p-5">
      <div className="mb-4 flex items-center gap-2">
        <BarChart3 className="h-4 w-4 text-[#32B5FF]" />
        <h3 className="text-sm font-semibold text-white">Support Analytics</h3>
      </div>

      {status === "error" && (
        <div className="mb-4 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <StatCard label="Total Members" value={data ? data.totalMembers : "—"} />
        <StatCard
          label="Logged In At Least Once"
          value={data ? data.loggedInAtLeastOnce : "—"}
          sub={data ? `${data.loggedInAtLeastOnce} / ${data.totalMembers} · ${data.loggedInPct}%` : undefined}
        />
        <StatCard
          label="ISP Applications Submitted"
          value={data ? data.ispSubmitted : "—"}
          sub={
            data
              ? `${data.ispSubmitted} / ${data.loggedInAtLeastOnce} · ${data.ispSubmittedPct}%`
              : undefined
          }
        />
        <StatCard
          label="ISP Approved / Activated"
          value={data ? data.ispApprovedActivated : "—"}
          sub={
            data
              ? `${data.ispApprovedActivated} / ${data.loggedInAtLeastOnce} · ${data.ispApprovedActivatedPct}%`
              : undefined
          }
        />
        <StatCard
          label="Bridge Waitlist"
          value={data ? data.bridgeWaitlist : "—"}
          sub={
            data
              ? `${data.bridgeWaitlistPctOfTotal}% of Total · ${data.bridgeWaitlistPctOfLoggedIn}% of Logged-In`
              : undefined
          }
        />
        <StatCard label="Disabled Users" value={data ? data.disabledUsers : "—"} />
        <StatCard label="Module Timer Removed" value={data ? data.moduleTimerRemoved : "—"} />
        <StatCard label="Balance Increased" value={data ? data.balanceIncreased : "—"} />
      </div>

      <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="text-[11px] font-medium uppercase tracking-wide text-[#707070]">
            Average Support Response Time
          </div>
          <div className="flex flex-wrap gap-1.5">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setPeriod(opt.value)}
                className={clsx(
                  "rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
                  period === opt.value
                    ? "bg-[#32B5FF] text-[#06121a]"
                    : "bg-white/5 text-[#B0B0B0] hover:bg-white/10"
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        {period === "custom" && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <label className="text-[11px] text-[#B0B0B0]">
              Start
              <input
                type="date"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                className="ml-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-white outline-none focus:ring-1 focus:ring-[#32B5FF]"
              />
            </label>
            <label className="text-[11px] text-[#B0B0B0]">
              End
              <input
                type="date"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
                className="ml-1.5 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-white outline-none focus:ring-1 focus:ring-[#32B5FF]"
              />
            </label>
            <button
              onClick={load}
              className="rounded-lg bg-[#32B5FF]/20 px-2.5 py-1 text-[11px] font-medium text-[#32B5FF] hover:bg-[#32B5FF]/30"
            >
              Apply
            </button>
          </div>
        )}
        <div className="text-xl font-bold text-white">{responseTimeText || "—"}</div>
      </div>
    </GlassCard>
  );
}

function TagManager({ tags, onCreateTag, onDeleteTag, creating, deletingTagId }) {
  const [newTag, setNewTag] = useState("");
  const [open, setOpen] = useState(false);

  async function handleCreate() {
    const trimmed = newTag.trim();
    if (!trimmed) return;
    await onCreateTag(trimmed);
    setNewTag("");
  }

  function handleDeleteClick(tag) {
    const confirmed = window.confirm(
      `Permanently delete the tag "${tag.name}"? It will be removed from every conversation. This cannot be undone.`
    );
    if (!confirmed) return;
    onDeleteTag(tag.id);
  }

  return (
    <div className="relative">
      <GhostButton onClick={() => setOpen((v) => !v)} className="text-xs">
        <ClipboardCheck className="h-3.5 w-3.5" /> Manage Tags
      </GhostButton>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-64 rounded-xl border border-white/10 bg-[#1E1E1E] p-3 shadow-2xl">
          <div className="mb-2 text-xs font-semibold text-white">All Tags</div>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {tags.length === 0 && <span className="text-[11px] text-[#707070]">No tags yet.</span>}
            {tags.map((tag) => (
              <span
                key={tag.id}
                className="flex items-center gap-1 rounded-full bg-white/10 px-2 py-1 text-[11px] text-white"
              >
                {tag.name}
                <button
                  type="button"
                  onClick={() => handleDeleteClick(tag)}
                  disabled={deletingTagId === tag.id}
                  aria-label={`Delete tag ${tag.name}`}
                  title={`Delete tag ${tag.name}`}
                  className="ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full text-[#B0B0B0] hover:bg-red-500/30 hover:text-red-300 disabled:opacity-40"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-1.5">
            <input
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              placeholder="New tag..."
              className="flex-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-white outline-none focus:ring-1 focus:ring-[#32B5FF]"
            />
            <button
              onClick={handleCreate}
              disabled={creating || !newTag.trim()}
              className="rounded-lg bg-[#32B5FF]/20 px-2 py-1.5 text-[#32B5FF] disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AdminChatsPage() {
  // Part 1: 5th tab. "inbox" preserves all 4 existing inbox filter tabs'
  // combined UI (All/Read/Unread + tag chips + Upsell live inside the
  // inbox workspace itself, per the existing app convention where those
  // were never separate top-level page tabs to begin with -- see the
  // ORIGINAL 4-tab layout below). "analytics" is the new 5th tab.
  const [activeTab, setActiveTab] = useState("inbox");

  const [conversations, setConversations] = useState([]);
  const [listStatus, setListStatus] = useState("loading"); // loading | ready | error
  const [filter, setFilter] = useState("all"); // all | read | unread | upsell
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [tags, setTags] = useState([]);
  const [selectedTagIds, setSelectedTagIds] = useState([]);
  const [creatingTag, setCreatingTag] = useState(false);
  const [deletingTagId, setDeletingTagId] = useState(null);
  const [counts, setCounts] = useState({ unreadCount: 0, upsellCount: 0 });

  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null); // { conversation, messages }
  const [detailStatus, setDetailStatus] = useState("idle"); // idle | loading | ready | error

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");

  const [contextMenu, setContextMenu] = useState(null); // { id, x, y }

  // Part 6: scroll-to-bottom control for the message pane. `pendingScroll`
  // forces a scroll-to-bottom on the NEXT render for: initial conversation
  // open, switching conversations, and after the admin sends a message.
  // It deliberately does NOT force-scroll on every silent poll re-render,
  // so an admin who has scrolled up to read history isn't yanked back
  // down by the 4s background refresh.
  const messagePaneRef = useRef(null);
  const pendingScrollRef = useRef(false);

  // Part 4: keep the composer keyboard-ready without ever stealing focus
  // during unrelated admin interactions (search, filters, tag manager,
  // analytics date range, etc.). `composerRef` is the SAME ref used for
  // the reply textarea's value/onChange -- nothing else in this file
  // touches DOM focus imperatively. `focusComposer()` is only ever
  // called from the three approved moments below (conversation initially
  // opened, conversation switched, manual send succeeded) -- it is never
  // wired into a poll interval or a plain render-tracking effect.
  const composerRef = useRef(null);
  function focusComposer() {
    // rAF so this runs after the DOM has painted (composer may have just
    // been re-enabled from `disabled` during sending, or the pane may
    // have just mounted for the first selected conversation).
    requestAnimationFrame(() => {
      composerRef.current?.focus();
    });
  }

  function scrollMessagePaneToBottom() {
    const el = messagePaneRef.current;
    if (!el) return;
    // rAF so this runs after the DOM has painted the new message list.
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }

  // Portal reliability pass: keep the latest selectedId/detail message
  // count in refs so the polling intervals below (which capture these in
  // closures created once per effect run) always compare against the
  // CURRENT selection/thread length rather than a stale snapshot from
  // when the interval was created -- this avoids needing to restart the
  // interval on every selection change while still detecting new
  // messages correctly.
  const selectedIdRef = useRef(null);
  const detailMessageCountRef = useRef(0);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);
  useEffect(() => {
    detailMessageCountRef.current = (detail?.messages || []).length;
  }, [detail]);

  const loadConversations = useCallback(async () => {
    setListStatus((s) => (s === "ready" ? s : "loading"));
    try {
      const params = new URLSearchParams();
      params.set("filter", filter);
      if (selectedTagIds.length > 0) params.set("tags", selectedTagIds.join(","));
      if (search) params.set("search", search);
      const res = await fetch(`/api/admin/support/conversations?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("failed");
      const data = await res.json();
      setConversations(data.conversations || []);
      if (data.counts) setCounts(data.counts);
      setListStatus("ready");
    } catch {
      setListStatus("error");
    }
  }, [filter, selectedTagIds, search]);

  // Portal reliability pass: silent variant used by the polling interval
  // -- never flips listStatus back to "loading" (which would blank the
  // conversation list and disrupt browsing) and never clobbers state on
  // a transient network error. Preserves whatever filter/tag/search
  // selection is currently active since it reads the same params as
  // loadConversations.
  const silentRefreshList = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      params.set("filter", filter);
      if (selectedTagIds.length > 0) params.set("tags", selectedTagIds.join(","));
      if (search) params.set("search", search);
      const res = await fetch(`/api/admin/support/conversations?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = await res.json();
      setConversations(data.conversations || []);
      if (data.counts) setCounts(data.counts);
    } catch {
      // keep the last known list on a transient network error
    }
  }, [filter, selectedTagIds, search]);

  const loadTags = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/support/tags", { cache: "no-store" });
      const data = await res.json();
      setTags(data.tags || []);
    } catch {
      // non-fatal; tag filter UI just stays empty
    }
  }, []);

  useEffect(() => {
    // fetch-on-mount, same pattern as lib/useAccount.js.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial
    loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    // fetch-on-mount, same pattern as lib/useAccount.js.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial
    loadTags();
  }, [loadTags]);

  // Part 3: debounce the search box so every keystroke doesn't fire a
  // server round-trip -- 300ms after the admin stops typing.
  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(id);
  }, [searchInput]);

  // Portal reliability pass: poll the conversation list every ~4s so a
  // NEW customer message (a new conversation, or a bump to the top of an
  // existing one) appears in the admin inbox automatically -- per spec,
  // "no hard refresh should be required" and newest-activity sorting/
  // unread indicators/timestamps must be preserved (they already are,
  // since silentRefreshList re-fetches through the exact same
  // listConversationsForAdmin() query the initial load uses). Only polls
  // while the inbox tab is active.
  useEffect(() => {
    if (activeTab !== "inbox") return undefined;
    const id = setInterval(silentRefreshList, 4000);
    return () => clearInterval(id);
  }, [silentRefreshList, activeTab]);

  const loadDetail = useCallback(
    async (conversationId, { forceScrollBottom = false } = {}) => {
      setDetailStatus("loading");
      if (forceScrollBottom) pendingScrollRef.current = true;
      try {
        const res = await fetch(`/api/admin/support/conversations/${conversationId}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error("failed");
        const data = await res.json();
        setDetail(data);
        setDetailStatus("ready");
        // Opening (GET) already marked customer messages read server-side;
        // refresh the list so the green dot/Unread badge count clears
        // immediately.
        loadConversations();
      } catch {
        setDetailStatus("error");
      }
    },
    [loadConversations]
  );

  // Part 6/Part 4: force scroll-to-bottom AND refocus the composer
  // exactly when the message list actually changed AND a scroll was
  // requested (initial open / conversation switch / after send) -- never
  // on unrelated re-renders. `pendingScrollRef` is ONLY ever set true by
  // selectConversation() and the post-send loadDetail() call below, so
  // this effect firing on every silent poll's `detail` update (which
  // does NOT set pendingScrollRef) is a correctly-guarded no-op --
  // that's what keeps the composer from aggressively stealing focus
  // during background polling or unrelated UI interaction.
  useEffect(() => {
    if (pendingScrollRef.current && detailStatus === "ready") {
      scrollMessagePaneToBottom();
      pendingScrollRef.current = false;
      focusComposer();
    }
  }, [detail, detailStatus]);

  // Portal reliability pass: silently polls the currently-open thread's
  // messages every ~4s so a new customer message arriving WHILE the
  // admin already has that conversation open appears without needing to
  // reselect it. Deliberately does NOT call the GET-marks-read route
  // logic differently than loadDetail -- it's the same endpoint, so a new
  // customer message is marked read the moment this poll picks it up
  // (matching "opening a conversation marks incoming customer messages as
  // read" -- the admin has the thread open, so that's correct). Skips
  // silently if no conversation is selected, and never disrupts the
  // scroll position via a "Loading..." flash on every tick (only updates
  // `detail`, not `detailStatus`, unless the fetch fails while nothing
  // has loaded yet). Part 6: deliberately does NOT force a scroll here --
  // only the initial open/switch/send actions do that, so an admin
  // reading older history during a poll tick is never yanked to bottom.
  const silentRefreshDetail = useCallback(async () => {
    const currentId = selectedIdRef.current;
    if (!currentId) return;
    try {
      const res = await fetch(`/api/admin/support/conversations/${currentId}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = await res.json();
      const newCount = (data.messages || []).length;
      setDetail(data);
      // Only refresh the list (to clear the unread dot / bump ordering)
      // when the thread actually grew -- avoids an extra request on
      // every single poll tick when nothing changed.
      if (newCount !== detailMessageCountRef.current) {
        loadConversations();
      }
    } catch {
      // keep the last known detail on a transient network error
    }
  }, [loadConversations]);

  useEffect(() => {
    if (activeTab !== "inbox") return undefined;
    const id = setInterval(silentRefreshDetail, 4000);
    return () => clearInterval(id);
  }, [silentRefreshDetail, activeTab]);

  function selectConversation(id) {
    setSelectedId(id);
    setContextMenu(null);
    // Part 6: switching conversations always starts at the bottom/newest.
    loadDetail(id, { forceScrollBottom: true });
  }

  async function handleCreateTag(name) {
    setCreatingTag(true);
    try {
      const res = await fetch("/api/admin/support/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (res.ok) {
        await loadTags();
      }
      return data;
    } finally {
      setCreatingTag(false);
    }
  }

  // Refinement pass: permanently deletes a tag (admin-only). Removes it
  // from the local filter selection (if currently selected) so the
  // conversation list doesn't keep filtering by an id that no longer
  // exists, then reloads both the tag list and the conversation list/
  // open detail so every tag chip everywhere reflects the deletion
  // immediately, without requiring a manual refresh.
  async function handleDeleteTag(tagId) {
    setDeletingTagId(tagId);
    try {
      await fetch(`/api/admin/support/tags/${tagId}`, { method: "DELETE" });
      setSelectedTagIds((prev) => prev.filter((id) => id !== tagId));
      await loadTags();
      await loadConversations();
      if (selectedId) await loadDetail(selectedId);
    } catch {
      // non-fatal; tag list just stays stale until next manual refresh
    } finally {
      setDeletingTagId(null);
    }
  }

  async function handleToggleConversationTag(tagId, assign) {
    if (!selectedId) return;
    try {
      await fetch(`/api/admin/support/conversations/${selectedId}/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tagId, assign }),
      });
      await loadDetail(selectedId);
      await loadConversations();
    } catch {
      // surfaced implicitly: tag toggle UI reflects detail state, which
      // simply won't have changed on failure
    }
  }

  async function handleMarkUnread(conversationId) {
    setContextMenu(null);
    try {
      await fetch(`/api/admin/support/conversations/${conversationId}/mark-unread`, {
        method: "POST",
      });
      await loadConversations();
    } catch {
      // non-fatal
    }
  }

  async function handleSend() {
    const text = draft.trim();
    if (!text || !selectedId || sending) return;
    setSendError("");
    setSending(true);
    try {
      const res = await fetch(`/api/admin/support/conversations/${selectedId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) {
        // Send failed: per spec, do NOT clear the typed draft and keep
        // the composer focused so the admin can immediately retry.
        setSendError(data.error || "Unable to send message.");
        focusComposer();
        return;
      }
      setDraft("");
      // Part 6: after the admin sends a message, keep the pane pinned to
      // the newest message at the bottom -- never jump toward the top.
      await loadDetail(selectedId, { forceScrollBottom: true });
      await loadConversations();
    } catch {
      // Network/unexpected failure: same "don't destroy the draft, keep
      // focus" guarantee as the !res.ok branch above.
      setSendError("Something went wrong. Please try again.");
      focusComposer();
    } finally {
      setSending(false);
    }
  }

  function toggleFilterTag(tagId) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((t) => t !== tagId) : [...prev, tagId]
    );
  }

  const selectedConversationMeta = useMemo(
    () => conversations.find((c) => c.id === selectedId) || null,
    [conversations, selectedId]
  );

  const detailTagIds = useMemo(
    () => new Set((detail?.conversation?.tags || []).map((t) => t.id)),
    [detail]
  );

  const headerName = displayFullName({
    firstName: detail?.conversation?.accountFirstName || selectedConversationMeta?.accountFirstName,
    lastName: detail?.conversation?.accountLastName || selectedConversationMeta?.accountLastName,
    name: detail?.conversation?.accountName || selectedConversationMeta?.accountName,
    email: detail?.conversation?.accountEmail || selectedConversationMeta?.accountEmail,
  });

  return (
    <div
      className="flex min-h-0 flex-col gap-4"
      style={{ height: "calc(100vh - 230px)", minHeight: "560px" }}
    >
      {/* TOP: Admin Support header/tabs (Part 7 layout requirement) */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-white/10 pb-3">
        {[
          { id: "inbox", label: "Support Inbox" },
          { id: "analytics", label: "Analytics" },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={clsx(
              "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
              activeTab === t.id
                ? "bg-[#32B5FF]/15 text-[#32B5FF]"
                : "text-[#B0B0B0] hover:bg-white/5 hover:text-white"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === "analytics" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <AnalyticsTab />
        </div>
      ) : (
        // Part 7: high-volume support inbox layout. Fills the remaining
        // viewport height (min-h-0 + flex-1 on the parent, h-full on this
        // grid) with a two-pane workspace: LEFT = conversation list
        // (independently scrolling), RIGHT = selected conversation
        // (header + independently-scrolling message history + composer
        // pinned at the bottom).
        <div
          className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[300px_1fr]"
          onClick={() => contextMenu && setContextMenu(null)}
        >
          <GlassCard className="flex min-h-0 flex-col overflow-hidden">
            <div className="flex-shrink-0 border-b border-white/10 px-3 py-2.5">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-white">Support Inbox</h3>
                <button
                  onClick={loadConversations}
                  className="rounded-lg bg-white/5 p-1.5 text-[#B0B0B0] hover:bg-white/10"
                  title="Refresh"
                >
                  <RefreshCw className={clsx("h-3.5 w-3.5", listStatus === "loading" && "animate-spin")} />
                </button>
              </div>

              {/* Part 3: search by first/last/full name/email */}
              <div className="relative mb-2">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#707070]" />
                <input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search name or email…"
                  className="w-full rounded-lg border border-white/10 bg-white/5 py-1.5 pl-7 pr-2 text-xs text-white placeholder-[#707070] outline-none focus:ring-1 focus:ring-[#32B5FF]"
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

              {/* Part 4: filter tabs with counts on Unread/Upsell only */}
              <div className="flex flex-wrap gap-1.5">
                {[
                  { id: "all", label: "All" },
                  { id: "read", label: "Read" },
                  { id: "unread", label: "Unread", count: counts.unreadCount },
                  { id: "upsell", label: "Upsell", count: counts.upsellCount },
                ].map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setFilter(f.id)}
                    className={clsx(
                      "flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
                      filter === f.id ? "bg-[#32B5FF] text-[#06121a]" : "bg-white/5 text-[#B0B0B0] hover:bg-white/10"
                    )}
                  >
                    {f.label}
                    {typeof f.count === "number" && (
                      <span
                        className={clsx(
                          "rounded-full px-1.5 text-[10px] font-bold",
                          filter === f.id ? "bg-[#06121a]/20 text-[#06121a]" : "bg-white/10 text-white"
                        )}
                      >
                        {f.count}
                      </span>
                    )}
                  </button>
                ))}
              </div>

              {tags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {tags.map((tag) => (
                    <button
                      key={tag.id}
                      onClick={() => toggleFilterTag(tag.id)}
                      className={clsx(
                        "rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors",
                        selectedTagIds.includes(tag.id)
                          ? "bg-[#32B5FF]/30 text-[#32B5FF]"
                          : "bg-white/5 text-[#707070] hover:bg-white/10"
                      )}
                    >
                      {tag.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* LEFT PANE: internal scrolling, tighter rows (Part 7) */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {listStatus === "loading" && (
                <div className="p-3 text-xs text-[#707070]">Loading conversations…</div>
              )}
              {listStatus === "error" && (
                <div className="p-3 text-xs text-red-400">Unable to load conversations.</div>
              )}
              {listStatus === "ready" && conversations.length === 0 && (
                <div className="p-3 text-xs text-[#707070]">No conversations match this filter.</div>
              )}
              {listStatus === "ready" &&
                conversations.map((c) => {
                  const rowName = displayFullName({
                    firstName: c.accountFirstName,
                    lastName: c.accountLastName,
                    name: c.accountName,
                    email: c.accountEmail,
                  });
                  return (
                    <div
                      key={c.id}
                      onClick={() => selectConversation(c.id)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setContextMenu({ id: c.id, x: e.clientX, y: e.clientY });
                      }}
                      className={clsx(
                        "group flex w-full cursor-pointer flex-col gap-0 border-b border-white/5 px-2.5 py-1.5 text-left transition-colors",
                        selectedId === c.id ? "bg-[#32B5FF]/10" : "hover:bg-white/[0.03]"
                      )}
                    >
                      {/* Part 3: compact row -- name (left, non-shrinking)
                          and email (right, flexes + truncates with an
                          ellipsis via CSS only -- the underlying
                          c.accountEmail value is never modified) share
                          ONE line. Date/time is intentionally not
                          rendered here (still available on `c` for any
                          other consumer); unread dot + Upsell badge stay
                          inline and compact so they don't add row
                          height. */}
                      <div className="flex min-w-0 items-center gap-1.5">
                        <Avatar
                          photoUrl={c.accountPhotoUrl}
                          firstName={c.accountFirstName}
                          email={c.accountEmail}
                          size={18}
                        />
                        {c.unread && (
                          <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-green-500" title="Unread" />
                        )}
                        <span className="flex-shrink-0 truncate text-[12.5px] font-medium text-white" style={{ maxWidth: "55%" }}>
                          {rowName}
                        </span>
                        {c.accountUpsellPurchased && (
                          <Badge tone="accent" className="flex-shrink-0 px-1.5 py-0 text-[9px]">
                            Upsell
                          </Badge>
                        )}
                        <span
                          className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-right text-[11px] text-[#909090]"
                          title={c.accountEmail}
                        >
                          {c.accountEmail}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setContextMenu({ id: c.id, x: e.clientX, y: e.clientY });
                          }}
                          className="flex-shrink-0 rounded p-0.5 text-[#707070] opacity-0 hover:bg-white/10 hover:text-white group-hover:opacity-100"
                          title="More actions"
                        >
                          <MoreVertical className="h-3 w-3" />
                        </button>
                      </div>
                      <div className="flex items-center justify-between gap-2 pl-[24px]">
                        <span className="min-w-0 flex-1 truncate text-[10.5px] text-[#707070]">
                          {c.lastMessagePreview}
                        </span>
                        {(c.tags || []).length > 0 && (
                          <div className="flex flex-shrink-0 flex-wrap gap-1">
                            {(c.tags || []).map((tag) => (
                              <Badge key={tag.id} tone="accent" className="px-1.5 py-0 text-[9px]">
                                {tag.name}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          </GlassCard>

          {contextMenu && (
            <div
              className="fixed z-50 w-48 rounded-lg border border-white/10 bg-[#1E1E1E] py-1 shadow-2xl"
              style={{ top: contextMenu.y, left: contextMenu.x }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => handleMarkUnread(contextMenu.id)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-white hover:bg-white/10"
              >
                <MailOpen className="h-3.5 w-3.5" /> Mark Unread
              </button>
            </div>
          )}

          {/* RIGHT PANE: compact header, message history takes most of the
              vertical space and scrolls independently, composer pinned at
              the bottom (Part 7). */}
          <GlassCard className="flex min-h-0 flex-col overflow-hidden">
            {!selectedId ? (
              <div className="flex flex-1 items-center justify-center text-sm text-[#707070]">
                Select a conversation to view the thread.
              </div>
            ) : (
              <>
                <div className="flex flex-shrink-0 items-center justify-between border-b border-white/10 px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <Avatar
                      photoUrl={detail?.conversation?.accountPhotoUrl || selectedConversationMeta?.accountPhotoUrl}
                      firstName={detail?.conversation?.accountFirstName || selectedConversationMeta?.accountFirstName}
                      email={detail?.conversation?.accountEmail || selectedConversationMeta?.accountEmail}
                      size={28}
                    />
                    <div>
                      <div className="text-sm font-semibold text-white">{headerName}</div>
                      <div className="text-[11px] text-[#707070]">
                        {detail?.conversation?.accountEmail || selectedConversationMeta?.accountEmail}
                      </div>
                    </div>
                  </div>
                  <TagManager
                    tags={tags}
                    onCreateTag={handleCreateTag}
                    onDeleteTag={handleDeleteTag}
                    creating={creatingTag}
                    deletingTagId={deletingTagId}
                  />
                </div>

                {tags.length > 0 && (
                  <div className="flex flex-shrink-0 flex-wrap gap-1.5 border-b border-white/10 px-4 py-2">
                    {tags.map((tag) => {
                      const active = detailTagIds.has(tag.id);
                      return (
                        <button
                          key={tag.id}
                          onClick={() => handleToggleConversationTag(tag.id, !active)}
                          className={clsx(
                            "rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
                            active
                              ? "bg-[#32B5FF] text-[#06121a]"
                              : "bg-white/5 text-[#B0B0B0] hover:bg-white/10"
                          )}
                        >
                          {tag.name}
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Part 6/7: independently-scrolling message history */}
                <div ref={messagePaneRef} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-4">
                  {detailStatus === "loading" && (
                    <div className="mt-20 text-center text-sm text-[#707070]">Loading messages…</div>
                  )}
                  {detailStatus === "error" && (
                    <div className="mt-20 text-center text-sm text-red-400">
                      Unable to load this conversation.
                    </div>
                  )}
                  {detailStatus === "ready" && (detail?.messages || []).length === 0 && (
                    <div className="mt-20 text-center text-sm text-[#707070]">No messages yet.</div>
                  )}
                  {detailStatus === "ready" &&
                    (detail?.messages || []).map((m) => {
                      const isAdmin = m.senderRole === "admin";
                      // Canonical sender identity: ALWAYS the per-message
                      // senderFirstName/senderPhotoUrl fields computed
                      // server-side by lib/supportEngine.js
                      // enrichMessagesWithIdentity() (see lib/supportEngine.js
                      // for the single canonical sender-display resolver).
                      const displayName = isAdmin
                        ? m.senderFirstName || "Ashley"
                        : m.senderFirstName || "Customer";
                      const photoUrl = m.senderPhotoUrl;
                      return (
                        <div
                          key={m.id}
                          className={`flex items-end gap-2 ${isAdmin ? "justify-end" : "justify-start"}`}
                        >
                          {!isAdmin && (
                            <Avatar photoUrl={photoUrl} firstName={displayName} size={24} />
                          )}
                          <div
                            className={`max-w-[70%] rounded-2xl px-3.5 py-2 text-sm ${
                              isAdmin ? "bg-[#32B5FF] text-[#06121a]" : "bg-white/10 text-white"
                            }`}
                          >
                            <div
                              className={`mb-0.5 text-[10px] font-semibold ${
                                isAdmin ? "text-[#06121a]/70" : "text-[#32B5FF]"
                              }`}
                            >
                              {displayName}
                            </div>
                            <div>{m.body}</div>
                            <div
                              className={`mt-1 text-[10px] ${
                                isAdmin ? "text-[#06121a]/60" : "text-[#B0B0B0]"
                              }`}
                            >
                              {formatTime(m.createdAt)}
                            </div>
                          </div>
                          {isAdmin && <Avatar photoUrl={photoUrl} firstName={displayName} size={24} />}
                        </div>
                      );
                    })}
                </div>

                {sendError && (
                  <div className="flex-shrink-0 border-t border-white/10 px-4 py-2 text-xs text-red-400">
                    {sendError}
                  </div>
                )}

                <div className="flex-shrink-0 border-t border-white/10 p-2.5">
                  <div className="flex items-center gap-2">
                    <input
                      ref={composerRef}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleSend()}
                      placeholder="Reply as admin..."
                      disabled={sending}
                      className="flex-1 rounded-xl bg-white/5 px-3.5 py-2.5 text-sm text-white placeholder-[#707070] outline-none focus:ring-1 focus:ring-[#32B5FF] disabled:opacity-60"
                    />
                    <button
                      onClick={handleSend}
                      disabled={sending || !draft.trim()}
                      className="rounded-xl bg-[#32B5FF] p-2.5 text-[#06121a] hover:bg-[#4dc0ff] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Send className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </>
            )}
          </GlassCard>
        </div>
      )}
    </div>
  );
}
