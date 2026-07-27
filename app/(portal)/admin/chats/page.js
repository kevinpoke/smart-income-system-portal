"use client";

import { useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import { GlassCard, Badge, GhostButton, AccentButton } from "@/components/ui/Primitives";
import { Plus, X, Send, Zap, ClipboardCheck } from "lucide-react";
import clsx from "clsx";

const QUICK_REPLIES = [
  {
    label: "Upsell Node",
    text: "I noticed you're getting great uptime! Have you considered upgrading to a Super Node for higher monthly earnings?",
  },
  {
    label: "Check Status",
    text: "Let me check your account status now — one moment please.",
  },
];

function TagManager({ tagOptions, addTagOption, removeTagOption }) {
  const [newTag, setNewTag] = useState("");
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <GhostButton onClick={() => setOpen((v) => !v)} className="text-xs">
        <ClipboardCheck className="h-3.5 w-3.5" /> Manage Tags
      </GhostButton>
      {open && (
        <div className="absolute right-0 z-10 mt-2 w-64 rounded-xl border border-white/10 bg-[#1E1E1E] p-3 shadow-2xl">
          <div className="mb-2 text-xs font-semibold text-white">Tag Options</div>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {tagOptions.map((tag) => (
              <span
                key={tag}
                className="flex items-center gap-1 rounded-full bg-white/10 px-2 py-1 text-[11px] text-white"
              >
                {tag}
                <button onClick={() => removeTagOption(tag)} className="text-white/50 hover:text-red-400">
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-1.5">
            <input
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              placeholder="New tag..."
              className="flex-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-white outline-none focus:ring-1 focus:ring-[#32B5FF]"
            />
            <button
              onClick={() => {
                if (newTag.trim()) {
                  addTagOption(newTag.trim());
                  setNewTag("");
                }
              }}
              className="rounded-lg bg-[#32B5FF]/20 px-2 py-1.5 text-[#32B5FF]"
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
  const users = useStore((s) => s.users);
  const tagOptions = useStore((s) => s.tagOptions);
  const addTagOption = useStore((s) => s.addTagOption);
  const removeTagOption = useStore((s) => s.removeTagOption);
  const toggleUserTag = useStore((s) => s.toggleUserTag);
  const adminSendChatMessage = useStore((s) => s.adminSendChatMessage);

  const chatUsers = useMemo(
    () =>
      Object.values(users)
        .filter((u) => u.chat.messages.length > 0)
        .sort((a, b) => {
          const aLast = a.chat.messages[a.chat.messages.length - 1]?.at || "";
          const bLast = b.chat.messages[b.chat.messages.length - 1]?.at || "";
          return bLast.localeCompare(aLast);
        }),
    [users]
  );

  const [selectedId, setSelectedId] = useState(chatUsers[0]?.id || null);
  const [draft, setDraft] = useState("");

  const selectedUser = users[selectedId] || chatUsers[0];

  function handleSend(text) {
    if (!selectedUser || !text.trim()) return;
    adminSendChatMessage(selectedUser.id, text.trim());
    setDraft("");
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
      <GlassCard className="overflow-hidden">
        <div className="border-b border-white/10 px-4 py-3">
          <h3 className="text-sm font-semibold text-white">Active Chats</h3>
        </div>
        <div className="max-h-[600px] overflow-y-auto">
          {chatUsers.length === 0 && (
            <div className="p-4 text-xs text-[#707070]">No active chats yet.</div>
          )}
          {chatUsers.map((u) => {
            const lastMsg = u.chat.messages[u.chat.messages.length - 1];
            return (
              <button
                key={u.id}
                onClick={() => setSelectedId(u.id)}
                className={clsx(
                  "flex w-full flex-col gap-1 border-b border-white/5 px-4 py-3 text-left transition-colors",
                  selectedUser?.id === u.id ? "bg-[#32B5FF]/10" : "hover:bg-white/[0.03]"
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-white">{u.name}</span>
                </div>
                <span className="truncate text-xs text-[#707070]">{lastMsg?.text}</span>
                <div className="flex flex-wrap gap-1">
                  {u.chat.tags.map((tag) => (
                    <Badge key={tag} tone="accent" className="text-[10px]">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      </GlassCard>

      <GlassCard className="flex h-[664px] flex-col overflow-hidden">
        {selectedUser ? (
          <>
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
              <div>
                <div className="text-sm font-semibold text-white">{selectedUser.name}</div>
                <div className="text-xs text-[#707070]">{selectedUser.email}</div>
              </div>
              <TagManager
                tagOptions={tagOptions}
                addTagOption={addTagOption}
                removeTagOption={removeTagOption}
              />
            </div>

            <div className="flex flex-wrap gap-1.5 border-b border-white/10 px-5 py-3">
              {tagOptions.map((tag) => {
                const active = selectedUser.chat.tags.includes(tag);
                return (
                  <button
                    key={tag}
                    onClick={() => toggleUserTag(selectedUser.id, tag)}
                    className={clsx(
                      "rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
                      active
                        ? "bg-[#32B5FF] text-[#06121a]"
                        : "bg-white/5 text-[#B0B0B0] hover:bg-white/10"
                    )}
                  >
                    {tag}
                  </button>
                );
              })}
            </div>

            <div className="flex-1 space-y-3 overflow-y-auto p-5">
              {selectedUser.chat.messages.map((m) => (
                <div
                  key={m.id}
                  className={`flex ${m.sender === "admin" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[70%] rounded-2xl px-4 py-2.5 text-sm ${
                      m.sender === "admin"
                        ? "bg-[#32B5FF] text-[#06121a]"
                        : m.sender === "system"
                        ? "bg-white/5 italic text-[#B0B0B0]"
                        : "bg-white/10 text-white"
                    }`}
                  >
                    {m.text}
                  </div>
                </div>
              ))}
            </div>

            <div className="border-t border-white/10 p-3">
              <div className="mb-2 flex flex-wrap gap-1.5">
                {QUICK_REPLIES.map((qr) => (
                  <button
                    key={qr.label}
                    onClick={() => handleSend(qr.text)}
                    className="flex items-center gap-1 rounded-lg bg-white/5 px-2.5 py-1.5 text-xs font-medium text-[#B0B0B0] hover:bg-white/10 hover:text-white"
                  >
                    <Zap className="h-3 w-3 text-[#32B5FF]" /> {qr.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSend(draft)}
                  placeholder="Reply as admin..."
                  className="flex-1 rounded-xl bg-white/5 px-3.5 py-2.5 text-sm text-white placeholder-[#707070] outline-none focus:ring-1 focus:ring-[#32B5FF]"
                />
                <button
                  onClick={() => handleSend(draft)}
                  className="rounded-xl bg-[#32B5FF] p-2.5 text-[#06121a] hover:bg-[#4dc0ff]"
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-[#707070]">
            Select a chat to view the conversation.
          </div>
        )}
      </GlassCard>
    </div>
  );
}
