"use client";

import { useState } from "react";

// Admin-portal batch: admin-only editable Waitlist Yes/No control for the
// User Management table. Mirrors the existing UpsellCell.js/
// LocationCell.js inline-edit pattern exactly (same optimistic-but-
// verified save through a dedicated admin API route, inline error on
// failure). POSTs to /api/admin/accounts/[id]/waitlist, which reads/
// writes ONLY the existing accounts.waitlist_joined_at column -- the
// SAME authoritative field every other waitlist consumer already reads
// (lib/waitlistEngine.js, the Support Chat "Waitlist" badge, the
// existing "waitlist" column sort in app/api/admin/accounts/route.js).
// No duplicate/new boolean is introduced.
export default function WaitlistCell({ account, onSaved }) {
  const [value, setValue] = useState(Boolean(account.waitlistJoined));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleChange(e) {
    const next = e.target.value === "yes";
    const previous = value;
    setError("");
    setValue(next); // optimistic
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/accounts/${account.id}/waitlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ joined: next }),
      });
      const data = await res.json();
      if (!res.ok) {
        setValue(previous); // revert on failure
        setError(data.error || "Unable to save.");
        return;
      }
      setValue(Boolean(data.waitlistJoined));
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
        aria-label={`Waitlist status for ${account.email}`}
        className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs font-semibold text-white outline-none focus:ring-1 focus:ring-[#32B5FF] disabled:opacity-50"
      >
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
      {error && <div className="text-[10px] text-red-400">{error}</div>}
    </div>
  );
}
