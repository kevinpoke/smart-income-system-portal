"use client";

import { useState } from "react";

// Admin-only editable Upsell Yes/No control for the User Management
// table. Mirrors the existing LocationCell.js inline-edit pattern (same
// file's header comment explains the shared convention): a compact
// control, an optimistic-but-verified save through the dedicated admin
// API route, and an inline error on failure. POSTs to
// /api/admin/accounts/[id]/upsell, which is the ONLY place this value is
// written server-side. This is a manual admin record-keeping flag for
// an actual upsell PURCHASE (accounts.upsell_purchased) -- distinct
// from and independent of Training Module 3 completion (the "upsell
// pitch" training video); see that route's header comment for the full
// rationale.
export default function UpsellCell({ account, onSaved }) {
  const [value, setValue] = useState(Boolean(account.upsellCompleted));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleChange(e) {
    const next = e.target.value === "yes";
    const previous = value;
    setError("");
    setValue(next); // optimistic
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/accounts/${account.id}/upsell`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upsell: next }),
      });
      const data = await res.json();
      if (!res.ok) {
        setValue(previous); // revert on failure
        setError(data.error || "Unable to save.");
        return;
      }
      setValue(Boolean(data.upsellCompleted));
      onSaved?.();
    } catch {
      setValue(previous);
      setError("Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <select
        value={value ? "yes" : "no"}
        onChange={handleChange}
        disabled={saving}
        aria-label={`Upsell status for ${account.email}`}
        className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs font-semibold text-white outline-none focus:ring-1 focus:ring-[#32B5FF] disabled:opacity-50"
      >
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
      {error && <div className="text-[10px] text-red-400">{error}</div>}
    </div>
  );
}
