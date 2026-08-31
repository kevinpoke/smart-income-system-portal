"use client";

import { useState } from "react";
import { GhostButton, AccentButton } from "@/components/ui/Primitives";

// PASSWORDLESS-CUSTOMER-LOGIN batch: "Reset Login Link" confirmation
// dialog (spec Part 14) + optional "Reset & Send Login Email" (spec
// Part 15) -- both share this one modal; `sendEmail` toggles which
// backend call/copy is used. After a successful reset, the modal
// shows the NEW link with its own one-click Copy button ("make the
// new link easy to copy" -- spec Part 14) instead of auto-closing.
export default function ResetLoginLinkModal({ account, sendEmail, onClose, onReset }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null); // { url, emailDelivered? }
  const [copyState, setCopyState] = useState("idle");

  async function handleConfirm() {
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/accounts/${account.id}/login-link/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sendEmail: Boolean(sendEmail) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Unable to reset login link.");
        return;
      }
      setResult(data);
      onReset?.();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCopyNewLink() {
    if (!result?.url) return;
    try {
      await navigator.clipboard.writeText(result.url);
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 1500);
    } catch {
      setCopyState("error");
      setTimeout(() => setCopyState("idle"), 1500);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#161616] p-6">
        {!result ? (
          <>
            <h3 className="mb-1 text-base font-bold text-white">
              Reset this customer&rsquo;s login link?
            </h3>
            <p className="mb-4 text-xs text-[#B0B0B0]">
              Their previous login link will immediately stop working.
            </p>
            {sendEmail && (
              <p className="mb-4 text-xs text-[#B0B0B0]">
                The new link will also be emailed to {account.email} via the account-ready login email.
              </p>
            )}
            {error && <div className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>}
            <div className="flex gap-2">
              <GhostButton type="button" onClick={onClose} className="flex-1" disabled={submitting}>
                Cancel
              </GhostButton>
              <AccentButton type="button" onClick={handleConfirm} disabled={submitting} className="flex-1">
                {submitting ? "Resetting…" : "Reset Link"}
              </AccentButton>
            </div>
          </>
        ) : (
          <>
            <h3 className="mb-1 text-base font-bold text-white">Login link reset</h3>
            <p className="mb-3 text-xs text-[#B0B0B0]">
              The old link is now dead. Their new link is ready to copy.
              {sendEmail && (
                <>
                  {" "}
                  {result.emailDelivered
                    ? "The login email was sent."
                    : "The login email could not be sent — copy the link manually instead."}
                </>
              )}
            </p>
            <button
              type="button"
              onClick={handleCopyNewLink}
              className="mb-4 w-full rounded-lg bg-white/5 px-3 py-2 text-xs font-semibold text-[#B0B0B0] hover:bg-white/10 hover:text-white"
            >
              {copyState === "copied" ? "Copied" : copyState === "error" ? "Failed" : "Copy New Login Link"}
            </button>
            <AccentButton type="button" onClick={onClose} className="w-full">
              Done
            </AccentButton>
          </>
        )}
      </div>
    </div>
  );
}
