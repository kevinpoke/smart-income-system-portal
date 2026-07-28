"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { GlassCard, SectionTitle, FadeIn } from "@/components/ui/Primitives";
import { Send, LifeBuoy, RefreshCw } from "lucide-react";

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return "";
  }
}

export default function SupportPage() {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const scrollRef = useRef(null);

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

  useEffect(() => {
    // fetch-on-mount, same pattern as lib/useAccount.js.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial
    load();
  }, [load]);

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
              messages.map((m) => (
                <div
                  key={m.id}
                  className={`flex ${m.senderRole === "customer" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[70%] rounded-2xl px-4 py-2.5 text-sm ${
                      m.senderRole === "customer"
                        ? "bg-[#32B5FF] text-[#06121a]"
                        : "bg-white/10 text-white"
                    }`}
                  >
                    <div>{m.body}</div>
                    <div
                      className={`mt-1 text-[10px] ${
                        m.senderRole === "customer" ? "text-[#06121a]/60" : "text-[#B0B0B0]"
                      }`}
                    >
                      {formatTime(m.createdAt)}
                    </div>
                  </div>
                </div>
              ))}
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
