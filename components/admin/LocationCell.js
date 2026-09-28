"use client";

import { useState } from "react";
import { normalizeCity, displayLocationState, resolveAdminStateInput } from "@/lib/locationNormalize";

// Inline click-to-edit City/State cell for the User Management table.
// Mirrors the existing "click email to edit" pattern in AccountRow
// (app/(portal)/admin/page.js) -- click to reveal an input, Save/Cancel
// buttons, an inline error on failure. On save, PATCHes the shared
// admin location API (/api/admin/accounts/[id]/location), which
// normalizes server-side via the SAME lib/locationNormalize.js
// functions used here for the client-side live preview -- the preview
// is cosmetic only; the value actually persisted is whatever the server
// computes from its own independent call to the same normalizer, never
// trusted from the client.
//
// CUSTOM-LOCATION-DISPLAY + ADMIN-CUSTOM-LOCATION-EDITING batch: the
// State field is no longer restricted to a two-letter US code -- Admin
// may type ANY custom region ("Panama", "British Columbia", "Hong
// Kong"). The displayed value (both the closed-cell label and the
// editor's starting draft) is now the SAME text a customer/Analytics-
// excluded surface would see -- via the shared
// lib/locationNormalize.js#displayLocationState() helper -- never the
// old "Other — <region>" hybrid label and never the raw "OTHER"
// sentinel.
export default function LocationCell({ account, field, onSaved }) {
  const isCity = field === "city";
  const currentDisplayValue = isCity ? account.ispCity : displayLocationState(account);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(currentDisplayValue || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Live preview of what the server will actually store/display, using
  // the SAME resolution logic the server applies (resolveAdminStateInput
  // for State, normalizeCity for City) -- cosmetic only, never trusted
  // as the persisted value.
  const statePreviewResolution = !isCity ? resolveAdminStateInput(draft) : null;
  const preview = isCity
    ? normalizeCity(draft)
    : statePreviewResolution?.valid
      ? statePreviewResolution.value
      : draft;
  const previewWillBeOther = !isCity && Boolean(statePreviewResolution?.isOther);

  async function handleSave() {
    setError("");
    // Both city and state are sent together (even though this cell only
    // edits one of the two) because the admin location API updates both
    // columns atomically -- reuse the account's OTHER current DISPLAY
    // value for the field not being edited right now (never the raw
    // isp_state sentinel), so a City-only edit re-submits the State's
    // real displayed text (a canonical code or the customer/admin's own
    // typed custom region) rather than accidentally reverting it.
    const otherFieldDisplayValue = isCity ? displayLocationState(account) : account.ispCity || "";
    const body = isCity
      ? { city: draft, state: otherFieldDisplayValue }
      : { city: otherFieldDisplayValue, state: draft };

    setSaving(true);
    try {
      const res = await fetch(`/api/admin/accounts/${account.id}/location`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Unable to save.");
        return;
      }
      setEditing(false);
      onSaved();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={`${isCity ? "City" : "State"} for ${account.email}`}
            placeholder={isCity ? "Austin" : "CA, or Panama, Ontario, Hong Kong..."}
            className="w-32 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-white outline-none focus:ring-1 focus:ring-[#32B5FF]"
          />
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-[#32B5FF]/20 px-2 py-1 text-[10px] font-semibold text-[#32B5FF] disabled:opacity-50"
          >
            {saving ? "…" : "Save"}
          </button>
          <button
            onClick={() => {
              setEditing(false);
              setDraft(currentDisplayValue || "");
              setError("");
            }}
            className="text-[10px] text-[#707070] hover:text-white"
          >
            Cancel
          </button>
        </div>
        {draft && preview !== draft && (
          <div className="text-[10px] text-[#707070]">Will save as: {preview}</div>
        )}
        {previewWillBeOther && (
          <div className="text-[10px] text-amber-400">
            This isn&rsquo;t a standard US state code, so it will be saved as a custom
            region (classified as &ldquo;Other&rdquo; in Analytics only).
          </div>
        )}
        {error && <div className="text-[10px] text-red-400">{error}</div>}
      </div>
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className="text-xs text-[#B0B0B0] underline decoration-dotted hover:text-white"
      title={`Click to edit ${isCity ? "city" : "state"}`}
    >
      {currentDisplayValue || "—"}
    </button>
  );
}
