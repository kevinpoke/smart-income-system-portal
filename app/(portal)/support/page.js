"use client";

import { useState, useRef, useEffect } from "react";
import { useStore } from "@/lib/store";
import { GlassCard, SectionTitle, FadeIn } from "@/components/ui/Primitives";
import { Send, LifeBuoy } from "lucide-react";

export default function SupportPage() {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef(null);
  const messages = useStore((s) => s.users[s.currentUserId]?.chat.messages || []);
  const sendChatMessage = useStore((s) => s.sendChatMessage);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  function handleSend() {
    const text = draft.trim();
    if (!text) return;
    sendChatMessage(text, "user");
    setDraft("");
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
          <div className="flex items-center gap-2 border-b border-white/10 px-5 py-4">
            <LifeBuoy className="h-4 w-4 text-[#32B5FF]" />
            <h3 className="text-sm font-semibold text-white">Live Support</h3>
          </div>
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-5">
            {messages.length === 0 && (
              <div className="mt-20 text-center text-sm text-[#707070]">
                Ask us anything — a real agent typically responds within a few
                minutes.
              </div>
            )}
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex ${m.sender === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[70%] rounded-2xl px-4 py-2.5 text-sm ${
                    m.sender === "user"
                      ? "bg-[#32B5FF] text-[#06121a]"
                      : m.sender === "admin"
                      ? "bg-white/10 text-white"
                      : "bg-white/5 italic text-[#B0B0B0]"
                  }`}
                >
                  {m.text}
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 border-t border-white/10 p-3">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
              placeholder="Type your message..."
              className="flex-1 rounded-xl bg-white/5 px-4 py-2.5 text-sm text-white placeholder-[#707070] outline-none focus:ring-1 focus:ring-[#32B5FF]"
            />
            <button
              onClick={handleSend}
              className="rounded-xl bg-[#32B5FF] p-2.5 text-[#06121a] hover:bg-[#4dc0ff]"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </GlassCard>
      </FadeIn>
    </div>
  );
}
