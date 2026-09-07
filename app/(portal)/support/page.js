"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { GlassCard, SectionTitle, FadeIn } from "@/components/ui/Primitives";
import Avatar from "@/components/ui/Avatar";
import { useAccount } from "@/lib/useAccount";
import { Send, LifeBuoy, RefreshCw, Image as ImageIcon, X } from "lucide-react";
import LinkifiedText from "@/components/support/LinkifiedText";
import { attachFirstInteractionUnlock, playChime } from "@/lib/supportChime";

// NOTE: formatTime() was removed from this page -- the customer Support
// Chat no longer renders any message timestamp (admin-portal batch,
// requirement override section J). The ADMIN Support Chat
// (app/(portal)/admin/chats/page.js) has its own separate formatTime()
// and continues to show timestamps for both sides, unaffected.

// Long message composer (spec Part 14): the textarea grows with content
// up to MAX_COMPOSER_HEIGHT_PX, then scrolls internally rather than
// growing forever.
const MAX_COMPOSER_HEIGHT_PX = 160;
const MIN_COMPOSER_HEIGHT_PX = 44;

// Image messages (spec Part 8): kept in sync with lib/supportUploads.js's
// server-side validation -- the client check is purely a fast/friendly
// pre-check; the server re-validates everything regardless.
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function autosizeTextarea(el) {
  if (!el) return;
  el.style.height = "auto";
  const next = Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT_PX);
  el.style.height = `${Math.max(next, MIN_COMPOSER_HEIGHT_PX)}px`;
}

function MessageAttachmentImage({ attachment }) {
  if (!attachment) return null;
  const src = `/api/support/attachments/${attachment.id}`;
  return (
    <a
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1.5 block max-w-[220px] overflow-hidden rounded-lg"
      title="Open full size"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- authenticated,
          per-attachment API route (not a static/optimizable asset). */}
      <img
        src={src}
        alt="Attachment"
        className="max-h-[220px] w-full rounded-lg object-cover"
        loading="lazy"
      />
    </a>
  );
}

export default function SupportPage() {
  const { account } = useAccount();
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [imageFile, setImageFile] = useState(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState(null);
  const scrollRef = useRef(null);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  // SUPPORT-NEW-MESSAGE-SOUND batch: tracks every incoming (non-customer)
  // message id already seen during this page's active session, using
  // STABLE message ids (never array length -- edits/deletes/refetches
  // change counts without any new message existing). Seeded with every
  // id present at initial load WITHOUT chiming (per spec: "seed the
  // seen-set with all ids present at initial load without chiming, then
  // chime only for truly new arrivals after that point") -- only
  // silentRefresh (the poll) ever chimes.
  const seenMessageIdsRef = useRef(new Set());
  const hasSeededRef = useRef(false);

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
      const serverMessages = data.messages || [];
      setMessages(serverMessages);
      setStatus("ready");
      // Seed the seen-set once, from the FIRST successful load only --
      // every id present at initial load is marked seen WITHOUT chiming
      // (this is historical/already-read content, not a new arrival).
      // Guarded so a later manual `load()` call (e.g. the Retry button
      // after a transient error, or the post-send reconciliation call in
      // handleSend) never re-seeds/resets the set and never causes a
      // false chime for messages that arrived while status was "error".
      if (!hasSeededRef.current) {
        for (const m of serverMessages) {
          seenMessageIdsRef.current.add(m.id);
        }
        hasSeededRef.current = true;
      } else {
        // A later full load() (Retry / post-send) should still never
        // double-chime for messages the poll may not have processed yet
        // -- mark everything currently on the server as seen here too,
        // silently, exactly like the poll's own seeding pass.
        for (const m of serverMessages) {
          seenMessageIdsRef.current.add(m.id);
        }
      }
    } catch {
      setStatus("error");
    }
  }, []);

  const silentRefresh = useCallback(async () => {
    try {
      const res = await fetch("/api/support/messages", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const serverMessages = data.messages || [];

      // SUPPORT-NEW-MESSAGE-SOUND batch: chime exactly once per poll tick
      // that reveals at least one genuinely new incoming (non-customer)
      // message -- an id never seen before in this session. Never
      // triggers on: initial load (seeded separately in load() above,
      // never here), the customer's own sent message (senderRole ===
      // "customer" is excluded), a repeat poll of an already-seen id, an
      // edit/delete of an existing message (those don't introduce a new
      // id), or an attachment re-render of an existing message (same
      // reason). hasSeededRef guards against a race where silentRefresh's
      // very first tick could fire before load()'s own seeding commits.
      if (hasSeededRef.current) {
        let hasNewIncoming = false;
        for (const m of serverMessages) {
          if (seenMessageIdsRef.current.has(m.id)) continue;
          seenMessageIdsRef.current.add(m.id);
          if (m.senderRole !== "customer") {
            hasNewIncoming = true;
          }
        }
        if (hasNewIncoming) {
          playChime();
        }
      }

      // Merge rather than blind-replace to avoid visibly discarding an
      // optimistic pending message that hasn't been reconciled by the
      // in-flight send yet, and to avoid any duplicate keys -- server
      // data is always authoritative once it arrives, but a pending-*
      // optimistic row is kept if the server list doesn't yet include a
      // message with the same body sent within the last few seconds.
      setMessages((prev) => {
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

  // SUPPORT-NEW-MESSAGE-SOUND batch: lazily unlocks the shared
  // AudioContext on the first genuine click/keypress anywhere on this
  // page (never requests notification/microphone permission, never
  // shows a prompt) -- see lib/supportChime.js for why this is required
  // before playChime() can actually produce sound under browser autoplay
  // restrictions.
  useEffect(() => {
    return attachFirstInteractionUnlock();
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

  useEffect(() => {
    autosizeTextarea(textareaRef.current);
  }, [draft]);

  // Object URL cleanup for the local image preview.
  useEffect(() => {
    return () => {
      if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    };
  }, [imagePreviewUrl]);

  function handlePickImage() {
    fileInputRef.current?.click();
  }

  function handleImageSelected(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;
    setSendError("");
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      setSendError("Unsupported image type. Please choose a JPEG, PNG, WEBP, or GIF image.");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setSendError("Image is too large. Maximum size is 5 MB.");
      return;
    }
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    setImageFile(file);
    setImagePreviewUrl(URL.createObjectURL(file));
  }

  function clearSelectedImage() {
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    setImageFile(null);
    setImagePreviewUrl(null);
  }

  // Enter -> send, Shift+Enter -> newline (spec Part 15).
  function handleComposerKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleSend() {
    const text = draft.trim();
    // Per spec Part 15: image-only messages are sendable; a message with
    // neither text nor an image is never sent.
    if ((!text && !imageFile) || sending) return;
    setSendError("");
    setSending(true);
    // Optimistic append; reconciled by refetch below. Image-only optimistic
    // rows skip the attachment preview (it's reconciled almost immediately
    // by the real server round-trip) to avoid managing a second object URL
    // lifecycle for a transient placeholder.
    const optimistic = {
      id: `pending-${Date.now()}`,
      senderRole: "customer",
      body: text,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    setDraft("");
    const pendingImageFile = imageFile;
    clearSelectedImage();
    try {
      let res;
      if (pendingImageFile) {
        const formData = new FormData();
        formData.set("text", text);
        formData.set("image", pendingImageFile);
        res = await fetch("/api/support/messages", { method: "POST", body: formData });
      } else {
        res = await fetch("/api/support/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
      }
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
        subtitle="Chat with our team about your bridge, payouts, or account."
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
                      {/* Multiline rendering (spec Part 17): whitespace-pre-wrap
                          preserves newlines/blank lines exactly as stored,
                          break-words prevents horizontal overflow on long
                          unbroken tokens. Clickable-links batch: the text
                          content itself now goes through LinkifiedText
                          (never dangerouslySetInnerHTML) so any raw
                          http(s) URL becomes a clickable link while every
                          other character renders exactly as it did
                          before -- surrounding text and paragraph
                          spacing are completely unaffected. */}
                      {m.body && (
                        <div className="whitespace-pre-wrap break-words">
                          <LinkifiedText text={m.body} />
                        </div>
                      )}
                      <MessageAttachmentImage attachment={m.attachment} />
                      {/* Read-receipts batch: compact "Sent"/"Read" status
                          shown ONLY beneath the customer's OWN outgoing
                          messages -- never beneath incoming admin
                          messages (per spec: "Do NOT put 'Read'
                          underneath incoming Admin messages from
                          customer's perspective"). Deliberately does NOT
                          reintroduce a timestamp (section J above still
                          applies -- no created_at/edited_at rendering on
                          this page for either side); this is purely the
                          delivery-state word, matching a typical
                          messaging app's compact receipt style. `m.readAt`
                          comes from support_messages.read_at via GET
                          /api/support/messages (see that route), which is
                          only ever set by an ADMIN actually opening this
                          customer's conversation (lib/supportEngine.js
                          markConversationRead()) -- never by this same
                          GET request, background polling, or any other
                          customer-side action. A still-optimistic
                          "pending-*" message (not yet round-tripped to
                          the server) has no readAt and correctly shows
                          "Sent".
                      */}
                      {isCustomer && (
                        <div className="mt-1 text-right text-[10px] text-[#06121a]/60">
                          {m.readAt ? "Read" : "Sent"}
                        </div>
                      )}
                      {/* Admin-portal batch, requirement override (section
                          J): customer Support Chat now shows NO
                          timestamps on ANY message -- neither admin/Jenny
                          nor the customer's own. This SUPERSEDES the
                          prior "hide only on customer's own message" rule
                          (see app/(portal)/admin/chats/page.js for the
                          separate ADMIN Support Chat view, which still
                          shows timestamps for both sides -- unaffected by
                          this change). Display-only: created_at/edited_at
                          are still recorded/returned by the API for every
                          message (see app/api/support/messages/route.js),
                          simply never rendered on this page for either
                          side. */}
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
          {imagePreviewUrl && (
            <div className="flex items-center gap-2 border-t border-white/10 px-5 py-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- local
                  object URL preview, not a static/optimizable asset. */}
              <img
                src={imagePreviewUrl}
                alt="Selected"
                className="h-14 w-14 rounded-lg object-cover"
              />
              <button
                onClick={clearSelectedImage}
                className="rounded-lg bg-white/5 p-1.5 text-[#B0B0B0] hover:bg-white/10"
                title="Remove image"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <div className="flex items-end gap-2 border-t border-white/10 p-3">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="hidden"
              onChange={handleImageSelected}
            />
            <button
              onClick={handlePickImage}
              disabled={sending}
              title="Attach an image"
              className="flex-shrink-0 rounded-xl bg-white/5 p-2.5 text-[#B0B0B0] hover:bg-white/10 disabled:opacity-60"
            >
              <ImageIcon className="h-4 w-4" />
            </button>
            {/* Long message composer (spec Part 14): multiline textarea that
                auto-grows up to MAX_COMPOSER_HEIGHT_PX, then scrolls
                internally -- see autosizeTextarea(). Enter sends,
                Shift+Enter inserts a newline (spec Part 15). */}
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder="Type your message..."
              disabled={sending}
              rows={1}
              style={{ maxHeight: MAX_COMPOSER_HEIGHT_PX, minHeight: MIN_COMPOSER_HEIGHT_PX }}
              className="flex-1 resize-none overflow-y-auto rounded-xl bg-white/5 px-4 py-2.5 text-sm text-white placeholder-[#707070] outline-none focus:ring-1 focus:ring-[#32B5FF] disabled:opacity-60"
            />
            <button
              onClick={handleSend}
              disabled={sending || (!draft.trim() && !imageFile)}
              className="flex-shrink-0 rounded-xl bg-[#32B5FF] p-2.5 text-[#06121a] hover:bg-[#4dc0ff] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </GlassCard>
      </FadeIn>
    </div>
  );
}
