"use client";

import { useState } from "react";

// PASSWORDLESS-CUSTOMER-LOGIN batch: compact "Copy Login Link" control
// for the new User Management "Login" column (spec Part 11/12).
// Fetches the customer's CURRENT valid URL from the dedicated
// admin-only per-account endpoint on click (never pre-fetched into
// the page's normal accounts list) and copies it to the clipboard,
// then briefly shows "Copied" before reverting -- the URL is never
// held in this component's state longer than the copy operation
// itself needs, and is never logged to the console.
export default function LoginLinkCell({ accountId }) {
  const [state, setState] = useState("idle"); // idle | copying | copied | error

  async function handleCopy() {
    setState("copying");
    try {
      const res = await fetch(`/api/admin/accounts/${accountId}/login-link/copy`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) {
        setState("error");
        setTimeout(() => setState("idle"), 1500);
        return;
      }
      await navigator.clipboard.writeText(data.url);
      setState("copied");
      setTimeout(() => setState("idle"), 1500);
    } catch {
      setState("error");
      setTimeout(() => setState("idle"), 1500);
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      disabled={state === "copying"}
      className="rounded-lg bg-white/5 px-2.5 py-1.5 text-[11px] font-semibold text-[#B0B0B0] hover:bg-white/10 hover:text-white disabled:opacity-50"
      title="Copy this customer's current login link"
    >
      {state === "copied" ? "Copied" : state === "error" ? "Failed" : "Copy Login Link"}
    </button>
  );
}
