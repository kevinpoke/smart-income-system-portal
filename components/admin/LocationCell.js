"use client";

import { useState } from "react";
import { normalizeCity, normalizeState } from "@/lib/locationNormalize";

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
export default function LocationCell({ account, field, onSaved }) {
  const isCity = field === "city";
  const currentValue = isCity ? account.ispCity : account.ispState;
  const [editing, setEditing] = useState(false);
  // OTHER-STATE-ISP batch (post-review fix): the State editor's draft
  // must never start pre-filled with the raw "OTHER" sentinel -- that
  // string is meaningless to an admin and isn't a valid two-letter code
  // this editor could re-save anyway. Starting blank instead makes it
  // obvious a real State needs to be typed; the "Will save as:" preview
  // and the warning below (rendered only for the State field on an
  // Other-flagged account) explain the consequence before they click Save.
  const [draft, setDraft] = useState(!isCity && account.ispStateIsOther ? "" : currentValue || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const preview = isCity ? normalizeCity(draft) : normalizeState(draft);

  // OTHER-STATE-ISP batch: minimal, read-only display enhancement for
  // the State column only -- when the customer selected Other, show
  // "Other — <typed region>" instead of the raw stored sentinel
  // ("OTHER"), so an admin can immediately tell (a) this was an Other
  // selection and (b) exactly what they typed, without opening the
  // inline editor. Does not change the City column, does not change
  // what value the inline editor loads/saves (still the raw isp_state
  // sentinel, matching the existing admin location-edit contract), and
  // never rewrites any stored value -- purely a display-time label.
  const displayValue =
    !isCity && account.ispStateIsOther
      ? `Other — ${account.ispStateOtherText || "(no region entered)"}`
      : currentValue;

  async function handleSave() {
    setError("");
    // Both city and state are sent together (even though this cell only
    // edits one of the two) because the admin location API updates both
    // columns atomically -- reuse the account's OTHER current value for
    // the field not being edited right now, so a City-only edit doesn't
    // accidentally send an empty/undefined State (and vice versa).
    const body = isCity
      ? { city: draft, state: account.ispState || "" }
      : { city: account.ispCity || "", state: draft };

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
            className="w-24 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-white outline-none focus:ring-1 focus:ring-[#32B5FF]"
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
              setDraft(!isCity && account.ispStateIsOther ? "" : currentValue || "");
              setError("");
            }}
            className="text-[10px] text-[#707070] hover:text-white"
          >
            Cancel
          </button>
        </div>
        {!isCity && account.ispStateIsOther && (
          <div className="text-[10px] text-amber-400">
            This customer selected &ldquo;Other&rdquo; ({account.ispStateOtherText || "no region entered"}).
            Saving a State here will replace it and clear the Other marker.
          </div>
        )}
        {draft && preview !== draft && (
          <div className="text-[10px] text-[#707070]">Will save as: {preview}</div>
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
      {displayValue || "—"}
    </button>
  );
}
