"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { GlassCard, SectionTitle, FadeIn } from "@/components/ui/Primitives";
import Avatar from "@/components/ui/Avatar";
import { useAccount } from "@/lib/useAccount";
import { Send, LifeBuoy, RefreshCw } from "lucide-react";

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return "";
  }
}

export default function SupportPage() {
  const { account } = useAccount();
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const scrollRef = useRef(null);

  // Portal reliability pass: silent background refresh used by the
  // polling interval below -- unlike `load()`, this never flips `status`
  // back to "loading" (which would blank the thread and disrupt reading/
  // scrolling) and never clobbers messages on a transient network error.
  const pollRef = useRef(null);

  const load = useCallback(async () => {
    setStatus((s) => (s === "ready" ? s : "loading"));
    try {
      const res = await fetch("/api/support/messages", { cache: "no-store" });
      if (!res.ok) throw new Error("failed");
      const data = await res.json();
      setMessages(data.messages || []);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, []);

  const silentRefresh = useCallback(async () => {
    try {
      const res = await fetch("/api/support/messages", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      // Merge rather than blind-replace to avoid visibly discarding an
      // optimistic pending message that hasn't been reconciled by the
      // in-flight send yet, and to avoid any duplicate keys -- server
      // data is always authoritative once it arrives, but a pending-*
      // optimistic row is kept if the server list doesn't yet include a
      // message with the same body sent within the last few seconds.
      setMessages((prev) => {
        const serverMessages = data.messages || [];
        const stillPending = prev.filter(
          (m) =>
            typeof m.id === "string" &&
            m.id.startsWith("pending-") &&
            !serverMessages.some((sm) => sm.body === m.body && sm.senderRole === "customer")
        );
        return [...serverMessages, ...stillPending];
      });
    } catch {
      // keep the last known messages on a transient network error
    }
  }, []);

  useEffect(() => {
    // fetch-on-mount, same pattern as lib/useAccount.js.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial
    load();
  }, [load]);

  // Portal reliability pass: poll for new messages (admin replies) while
  // this page is open, per spec ("Poll for new messages while the
  // Support page is open... a polling interval around 3-5 seconds is
  // acceptable"). Uses the silent variant so an in-progress read/scroll
  // isn't disrupted by a "Loading..." flash on every tick.
  useEffect(() => {
    pollRef.current = setInterval(silentRefresh, 4000);
    return () => clearInterval(pollRef.current);
  }, [silentRefresh]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  async function handleSend() {
    const text = draft.trim();
    if (!text || sending) return;
    setSendError("");
    setSending(true);
    // Optimistic append; reconciled by refetch below.
    const optimistic = {
      id: `pending-${Date.now()}`,
      senderRole: "customer",
      body: text,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    setDraft("");
    try {
      const res = await fetch("/api/support/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSendError(data.error || "Unable to send message.");
        setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
        return;
      }
      await load();
    } catch {
      setSendError("Something went wrong. Please try again.");
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-6">
      <SectionTitle
        eyebrow="Help"
        title="Support"
        subtitle="Chat with our team about your node, payouts, or account."
      />
      <FadeIn>
        <GlassCard className="flex h-[560px] flex-col overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-white/10 px-5 py-4">
            <div className="flex items-center gap-2">
              <LifeBuoy className="h-4 w-4 text-[#32B5FF]" />
              <h3 className="text-sm font-semibold text-white">Live Support</h3>
            </div>
            {status === "error" && (
              <button
                onClick={load}
                className="flex items-center gap-1 rounded-lg bg-white/5 px-2.5 py-1.5 text-xs font-semibold text-[#B0B0B0] hover:bg-white/10"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Retry
              </button>
            )}
          </div>
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-5">
            {status === "loading" && (
              <div className="mt-20 text-center text-sm text-[#707070]">
                Loading your conversation…
              </div>
            )}
            {status === "error" && (
              <div className="mt-20 text-center text-sm text-red-400">
                Unable to load your messages. Please try again.
              </div>
            )}
            {status === "ready" && messages.length === 0 && (
              <div className="mt-20 text-center text-sm text-[#707070]">
                Ask us anything — a real agent typically responds within a few
                minutes.
              </div>
            )}
            {status === "ready" &&
              messages.map((m) => {
                const isCustomer = m.senderRole === "customer";
                // Canonical sender identity: prefer the per-message
                // senderFirstName/senderPhotoUrl fields the server
                // resolved via lib/supportEngine.js
                // enrichMessagesWithIdentity() -- the SAME canonical
                // shape the admin Support Chats inbox reads, so this
                // page and the admin view can never disagree about who
                // sent a message. `account` (from useAccount(), backed
                // by the authenticated /api/auth/me session, never a
                // client-supplied value) is used ONLY as a fallback for
                // the customer's own optimistic "pending-*" message
                // before the server round-trip has attached
                // senderFirstName/senderPhotoUrl.
                const displayName = isCustomer
                  ? m.senderFirstName || account?.firstName || "You"
                  : m.senderFirstName || "Ashley";
                const photoUrl = isCustomer
                  ? m.senderPhotoUrl || account?.profilePhotoUrl
                  : m.senderPhotoUrl;
                return (
                  <div
                    key={m.id}
                    className={`flex items-end gap-2 ${isCustomer ? "justify-end" : "justify-start"}`}
                  >
                    {!isCustomer && (
                      <Avatar photoUrl={photoUrl} firstName={displayName} size={28} />
                    )}
                    <div
                      className={`max-w-[70%] rounded-2xl px-4 py-2.5 text-sm ${
                        isCustomer ? "bg-[#32B5FF] text-[#06121a]" : "bg-white/10 text-white"
                      }`}
                    >
                      <div
                        className={`mb-0.5 text-[10px] font-semibold ${
                          isCustomer ? "text-[#06121a]/70" : "text-[#32B5FF]"
                        }`}
                      >
                        {displayName}
                      </div>
                      <div>{m.body}</div>
                      <div
                        className={`mt-1 text-[10px] ${
                          isCustomer ? "text-[#06121a]/60" : "text-[#B0B0B0]"
                        }`}
                      >
                        {formatTime(m.createdAt)}
                      </div>
                    </div>
                    {isCustomer && (
                      <Avatar
                        photoUrl={photoUrl}
                        firstName={displayName}
                        email={account?.email}
                        size={28}
                      />
                    )}
                  </div>
                );
              })}
          </div>
          {sendError && (
            <div className="border-t border-white/10 px-5 py-2 text-xs text-red-400">
              {sendError}
            </div>
          )}
          <div className="flex items-center gap-2 border-t border-white/10 p-3">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
              placeholder="Type your message..."
              disabled={sending}
              className="flex-1 rounded-xl bg-white/5 px-4 py-2.5 text-sm text-white placeholder-[#707070] outline-none focus:ring-1 focus:ring-[#32B5FF] disabled:opacity-60"
            />
            <button
              onClick={handleSend}
              disabled={sending || !draft.trim()}
              className="rounded-xl bg-[#32B5FF] p-2.5 text-[#06121a] hover:bg-[#4dc0ff] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </GlassCard>
      </FadeIn>
    </div>
  );
}
