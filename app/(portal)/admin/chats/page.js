"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GlassCard, Badge, GhostButton } from "@/components/ui/Primitives";
import Avatar from "@/components/ui/Avatar";
import { Plus, Send, ClipboardCheck, MoreVertical, RefreshCw, MailOpen, X } from "lucide-react";
import clsx from "clsx";

function formatTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return "";
  }
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
  const [conversations, setConversations] = useState([]);
  const [listStatus, setListStatus] = useState("loading"); // loading | ready | error
  const [filter, setFilter] = useState("all"); // all | read | unread
  const [tags, setTags] = useState([]);
  const [selectedTagIds, setSelectedTagIds] = useState([]);
  const [creatingTag, setCreatingTag] = useState(false);
  const [deletingTagId, setDeletingTagId] = useState(null);

  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null); // { conversation, messages }
  const [detailStatus, setDetailStatus] = useState("idle"); // idle | loading | ready | error

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");

  const [contextMenu, setContextMenu] = useState(null); // { id, x, y }

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
      const res = await fetch(`/api/admin/support/conversations?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("failed");
      const data = await res.json();
      setConversations(data.conversations || []);
      setListStatus("ready");
    } catch {
      setListStatus("error");
    }
  }, [filter, selectedTagIds]);

  // Portal reliability pass: silent variant used by the polling interval
  // -- never flips listStatus back to "loading" (which would blank the
  // conversation list and disrupt browsing) and never clobbers state on
  // a transient network error. Preserves whatever filter/tag selection
  // is currently active since it reads the same params as loadConversations.
  const silentRefreshList = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      params.set("filter", filter);
      if (selectedTagIds.length > 0) params.set("tags", selectedTagIds.join(","));
      const res = await fetch(`/api/admin/support/conversations?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = await res.json();
      setConversations(data.conversations || []);
    } catch {
      // keep the last known list on a transient network error
    }
  }, [filter, selectedTagIds]);

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

  // Portal reliability pass: poll the conversation list every ~4s so a
  // NEW customer message (a new conversation, or a bump to the top of an
  // existing one) appears in the admin inbox automatically -- per spec,
  // "no hard refresh should be required" and newest-activity sorting/
  // unread indicators/timestamps must be preserved (they already are,
  // since silentRefreshList re-fetches through the exact same
  // listConversationsForAdmin() query the initial load uses).
  useEffect(() => {
    const id = setInterval(silentRefreshList, 4000);
    return () => clearInterval(id);
  }, [silentRefreshList]);

  const loadDetail = useCallback(
    async (conversationId) => {
      setDetailStatus("loading");
      try {
        const res = await fetch(`/api/admin/support/conversations/${conversationId}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error("failed");
        const data = await res.json();
        setDetail(data);
        setDetailStatus("ready");
        // Opening (GET) already marked customer messages read server-side;
        // refresh the list so the green dot clears immediately.
        loadConversations();
      } catch {
        setDetailStatus("error");
      }
    },
    [loadConversations]
  );

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
  // has loaded yet).
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
    const id = setInterval(silentRefreshDetail, 4000);
    return () => clearInterval(id);
  }, [silentRefreshDetail]);

  function selectConversation(id) {
    setSelectedId(id);
    setContextMenu(null);
    loadDetail(id);
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
        setSendError(data.error || "Unable to send message.");
        return;
      }
      setDraft("");
      await loadDetail(selectedId);
      await loadConversations();
    } catch {
      setSendError("Something went wrong. Please try again.");
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

  return (
    <div
      className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]"
      onClick={() => contextMenu && setContextMenu(null)}
    >
      <GlassCard className="overflow-hidden">
        <div className="border-b border-white/10 px-4 py-3">
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
          <div className="flex gap-1.5">
            {["all", "read", "unread"].map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={clsx(
                  "rounded-full px-2.5 py-1 text-[11px] font-medium capitalize transition-colors",
                  filter === f ? "bg-[#32B5FF] text-[#06121a]" : "bg-white/5 text-[#B0B0B0] hover:bg-white/10"
                )}
              >
                {f}
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
        <div className="max-h-[600px] overflow-y-auto">
          {listStatus === "loading" && (
            <div className="p-4 text-xs text-[#707070]">Loading conversations…</div>
          )}
          {listStatus === "error" && (
            <div className="p-4 text-xs text-red-400">Unable to load conversations.</div>
          )}
          {listStatus === "ready" && conversations.length === 0 && (
            <div className="p-4 text-xs text-[#707070]">No conversations match this filter.</div>
          )}
          {listStatus === "ready" &&
            conversations.map((c) => (
              <div
                key={c.id}
                onClick={() => selectConversation(c.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ id: c.id, x: e.clientX, y: e.clientY });
                }}
                className={clsx(
                  "group flex w-full cursor-pointer flex-col gap-1 border-b border-white/5 px-4 py-3 text-left transition-colors",
                  selectedId === c.id ? "bg-[#32B5FF]/10" : "hover:bg-white/[0.03]"
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-white">
                    <Avatar
                      photoUrl={c.accountPhotoUrl}
                      firstName={c.accountFirstName}
                      email={c.accountEmail}
                      size={24}
                    />
                    {c.unread && (
                      <span className="h-2 w-2 flex-shrink-0 rounded-full bg-green-500" title="Unread" />
                    )}
                    <span className="truncate">{c.accountFirstName || c.accountName || c.accountEmail}</span>
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setContextMenu({ id: c.id, x: e.clientX, y: e.clientY });
                    }}
                    className="rounded p-0.5 text-[#707070] opacity-0 hover:bg-white/10 hover:text-white group-hover:opacity-100"
                    title="More actions"
                  >
                    <MoreVertical className="h-3.5 w-3.5" />
                  </button>
                </div>
                <span className="truncate text-xs text-[#707070]">{c.lastMessagePreview}</span>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-[#707070]">{formatTime(c.lastMessageAt)}</span>
                  <div className="flex flex-wrap gap-1">
                    {(c.tags || []).map((tag) => (
                      <Badge key={tag.id} tone="accent" className="text-[10px]">
                        {tag.name}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>
            ))}
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

      <GlassCard className="flex h-[664px] flex-col overflow-hidden">
        {!selectedId ? (
          <div className="flex flex-1 items-center justify-center text-sm text-[#707070]">
            Select a conversation to view the thread.
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
              <div className="flex items-center gap-2.5">
                <Avatar
                  photoUrl={detail?.conversation?.accountPhotoUrl || selectedConversationMeta?.accountPhotoUrl}
                  firstName={detail?.conversation?.accountFirstName || selectedConversationMeta?.accountFirstName}
                  email={detail?.conversation?.accountEmail || selectedConversationMeta?.accountEmail}
                  size={32}
                />
                <div>
                  <div className="text-sm font-semibold text-white">
                    {detail?.conversation?.accountFirstName ||
                      detail?.conversation?.accountName ||
                      selectedConversationMeta?.accountName}
                  </div>
                  <div className="text-xs text-[#707070]">
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
              <div className="flex flex-wrap gap-1.5 border-b border-white/10 px-5 py-3">
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

            <div className="flex-1 space-y-3 overflow-y-auto p-5">
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
                  const displayName = isAdmin
                    ? m.senderFirstName || "Ashley"
                    : detail?.conversation?.accountFirstName ||
                      detail?.conversation?.accountName ||
                      selectedConversationMeta?.accountName ||
                      "Customer";
                  const photoUrl = isAdmin
                    ? m.senderPhotoUrl
                    : detail?.conversation?.accountPhotoUrl;
                  return (
                    <div
                      key={m.id}
                      className={`flex items-end gap-2 ${isAdmin ? "justify-end" : "justify-start"}`}
                    >
                      {!isAdmin && (
                        <Avatar photoUrl={photoUrl} firstName={displayName} size={28} />
                      )}
                      <div
                        className={`max-w-[70%] rounded-2xl px-4 py-2.5 text-sm ${
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
                      {isAdmin && <Avatar photoUrl={photoUrl} firstName={displayName} size={28} />}
                    </div>
                  );
                })}
            </div>

            {sendError && (
              <div className="border-t border-white/10 px-5 py-2 text-xs text-red-400">
                {sendError}
              </div>
            )}

            <div className="border-t border-white/10 p-3">
              <div className="flex items-center gap-2">
                <input
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
  );
}
