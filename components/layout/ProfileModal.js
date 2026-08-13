"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAccount } from "@/lib/useAccount";
import { notifyAccountChanged } from "@/lib/accountEvents";
import Avatar from "@/components/ui/Avatar";
import { AccentButton, GhostButton } from "@/components/ui/Primitives";
import { X } from "lucide-react";
import { isAllowedImageMimeLabel } from "@/lib/uploadClientHelpers";

// Refinement pass: profile-management popup accessible from the top-right
// profile area (Header). Lets the authenticated account (customer OR
// admin) update their own first/last name and profile photo -- always
// scoped to the caller's own session (see app/api/profile and
// app/api/profile/photo), never another account's.
//
// POSITIONING FIX: this modal used to render as a plain child of
// <Header>, whose className includes `backdrop-blur-xl`. Per the CSS
// spec, an element with a `backdrop-filter` becomes a containing block
// for its `position: fixed` descendants -- so the modal's `fixed
// inset-0` was being sized/positioned relative to the thin <header> box
// (which sits at the very top of the page) instead of the actual
// viewport, making it appear pinned near the top of the screen instead
// of centered. Rendering via createPortal(document.body) escapes that
// containing-block chain entirely, so `fixed inset-0` now always means
// the real viewport regardless of which ancestor triggered this modal,
// on every page and at every viewport size.
const MIN_PASSWORD_LENGTH = 8;

export default function ProfileModal({ account, onClose }) {
  const { refetch } = useAccount();
  const [firstName, setFirstName] = useState(account?.firstName || "");
  const [lastName, setLastName] = useState(account?.lastName || "");
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState("");
  const [nameSaved, setNameSaved] = useState(false);

  const [uploading, setUploading] = useState(false);
  const [photoError, setPhotoError] = useState("");
  const [previewUrl, setPreviewUrl] = useState(account?.profilePhotoUrl || null);
  const fileInputRef = useRef(null);

  // Password reset: current/new/confirm fields, wired into the existing
  // /api/auth/change-password route (verifies currentPassword against the
  // stored scrypt hash server-side, then re-hashes newPassword via
  // lib/auth-crypto.js -- see app/api/auth/change-password/route.js).
  // Nothing here ever sees or sends a raw hash; only plaintext passwords
  // travel over the (same-origin, session-cookie-authenticated) request,
  // exactly like the existing login form.
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [passwordSaved, setPasswordSaved] = useState(false);

  const applyUpdatedAccount = useCallback(async () => {
    await refetch();
    notifyAccountChanged();
  }, [refetch]);

  useEffect(() => {
    // Mirrors the external `account.profilePhotoUrl` prop into local
    // preview state whenever a fresh account object arrives (e.g. after
    // applyUpdatedAccount()'s refetch() following a successful upload) --
    // not a local-only derived value being reset, so this is the
    // documented "adjusting state when a prop changes" case rather than
    // the anti-pattern react-hooks/set-state-in-effect targets.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreviewUrl(account?.profilePhotoUrl || null);
  }, [account?.profilePhotoUrl]);

  // Body-scroll lock: while this modal is open, the page behind it must
  // not scroll (per spec). Restores the PREVIOUS inline value on close/
  // unmount (rather than unconditionally clearing it) so this can never
  // clobber some other overflow rule if one is ever added elsewhere;
  // guarded for SSR since `document` doesn't exist during the server
  // render.
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  async function handleSaveName(e) {
    e.preventDefault();
    setNameError("");
    setNameSaved(false);
    const trimmedFirst = firstName.trim();
    if (!trimmedFirst) {
      setNameError("First name is required.");
      return;
    }
    setSavingName(true);
    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firstName: trimmedFirst, lastName: lastName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNameError(data.error || "Unable to save your name.");
        return;
      }
      setNameSaved(true);
      await applyUpdatedAccount();
    } catch {
      setNameError("Something went wrong. Please try again.");
    } finally {
      setSavingName(false);
    }
  }

  async function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoError("");

    if (!isAllowedImageMimeLabel(file.type)) {
      setPhotoError("Unsupported image type. Please choose a JPG, PNG, or WebP file.");
      e.target.value = "";
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setPhotoError("Image is too large. Maximum size is 5 MB.");
      e.target.value = "";
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("photo", file);
      const res = await fetch("/api/profile/photo", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) {
        setPhotoError(data.error || "Unable to upload photo.");
        return;
      }
      setPreviewUrl(data.account?.profilePhotoUrl || null);
      await applyUpdatedAccount();
    } catch {
      setPhotoError("Something went wrong. Please try again.");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  async function handleChangePassword(e) {
    e.preventDefault();
    setPasswordError("");
    setPasswordSaved(false);

    if (!currentPassword) {
      setPasswordError("Current password is required.");
      return;
    }
    if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
      setPasswordError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("New password and confirmation do not match.");
      return;
    }

    setSavingPassword(true);
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPasswordError(data.error || "Unable to update password.");
        return;
      }
      setPasswordSaved(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch {
      setPasswordError("Something went wrong. Please try again.");
    } finally {
      setSavingPassword(false);
    }
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    // items-center + a scrollable outer container (rather than a fixed
    // height) is what makes this work on short viewports: when the
    // modal card is taller than the viewport, the OUTER container
    // scrolls (py-8 gives breathing room top/bottom) instead of the
    // card overflowing off-screen or getting clipped -- the card itself
    // additionally caps its own height and scrolls its inner content so
    // the header/footer (X button, Save/Close buttons) stay reachable
    // even when a long error message or on a very short screen.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/80 p-4 py-8"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="my-auto flex max-h-[calc(100vh-4rem)] w-full max-w-md flex-col overflow-y-auto rounded-2xl border border-white/10 bg-[#1E1E1E] p-6"
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-bold text-white">Edit Profile</h3>
          <button onClick={onClose} className="text-white/60 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mb-6 flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            aria-label="Change profile photo"
            title="Change profile photo"
            className="rounded-full transition disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Avatar
              photoUrl={previewUrl}
              firstName={firstName || account?.firstName}
              email={account?.email}
              size={72}
            />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={handleFileChange}
          />
          <GhostButton
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="text-xs"
          >
            {uploading ? "Uploading…" : "Change Photo"}
          </GhostButton>
          {photoError && <div className="text-xs text-red-400">{photoError}</div>}
          <div className="text-[10px] text-[#707070]">JPG, PNG, or WebP — max 5 MB.</div>
        </div>

        <form onSubmit={handleSaveName} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs text-[#B0B0B0]">First Name</span>
            <input
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 text-sm text-white outline-none focus:ring-1 focus:ring-[#32B5FF]"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-[#B0B0B0]">Last Name</span>
            <input
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 text-sm text-white outline-none focus:ring-1 focus:ring-[#32B5FF]"
            />
          </label>
          {nameError && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{nameError}</div>}
          {nameSaved && !nameError && (
            <div className="rounded-lg bg-green-500/10 px-3 py-2 text-xs text-green-400">
              Profile updated.
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <GhostButton type="button" onClick={onClose} className="flex-1">
              Close
            </GhostButton>
            <AccentButton type="submit" disabled={savingName} className="flex-1">
              {savingName ? "Saving…" : "Save"}
            </AccentButton>
          </div>
        </form>

        <div className="my-6 border-t border-white/10" />

        <h4 className="mb-3 text-sm font-bold text-white">Change Password</h4>
        <form onSubmit={handleChangePassword} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs text-[#B0B0B0]">Current Password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 text-sm text-white outline-none focus:ring-1 focus:ring-[#32B5FF]"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-[#B0B0B0]">New Password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 text-sm text-white outline-none focus:ring-1 focus:ring-[#32B5FF]"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-[#B0B0B0]">Confirm New Password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 text-sm text-white outline-none focus:ring-1 focus:ring-[#32B5FF]"
            />
          </label>
          <div className="text-[10px] text-[#707070]">
            Minimum {MIN_PASSWORD_LENGTH} characters.
          </div>
          {passwordError && (
            <div className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {passwordError}
            </div>
          )}
          {passwordSaved && !passwordError && (
            <div className="rounded-lg bg-green-500/10 px-3 py-2 text-xs text-green-400">
              Password updated.
            </div>
          )}
          <div className="flex justify-end pt-1">
            <AccentButton type="submit" disabled={savingPassword} className="w-full sm:w-auto">
              {savingPassword ? "Updating…" : "Update Password"}
            </AccentButton>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
