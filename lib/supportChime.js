"use client";

// SUPPORT-NEW-MESSAGE-SOUND batch: tiny, dependency-free notification
// chime for a genuinely NEW incoming Support message (spec section D).
// Deliberately Web Audio API (OscillatorNode), NOT a static audio asset
// -- no new binary file, no licensing/size concerns, and this codebase
// already leans on small inline helpers (e.g. lib/adminTime.js,
// lib/waitlistEngine.js) rather than adding static assets for simple
// synthesized effects. No external CDN, ever.
//
// Autoplay-safety: browsers block AudioContext from actually producing
// sound until it has been created/resumed after a genuine user gesture.
// This module NEVER creates the AudioContext eagerly at import time --
// callers must call ensureAudioUnlocked() from a real user interaction
// (see useChimeOnFirstInteraction() below) before playChime() can
// actually be heard. Never requests notification permission or
// microphone access, never shows any permission prompt -- Web Audio
// output requires none of that, only the gesture-unlock dance above.
//
// Every function here is wrapped so a blocked/unsupported/exception case
// silently resolves rather than throwing -- Support must keep working
// normally even if sound can never play in a given browser/tab.
let sharedAudioContext = null;

function getOrCreateAudioContext() {
  if (typeof window === "undefined") return null;
  try {
    if (sharedAudioContext) return sharedAudioContext;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    sharedAudioContext = new Ctor();
    return sharedAudioContext;
  } catch {
    return null;
  }
}

// Called from a real user gesture (first click/keypress anywhere on the
// page, per spec -- "acceptable to lazily create/resume the AudioContext
// on first genuine user interaction with the page"). Safe to call many
// times; only actually does anything the first time (or if the context
// was suspended).
export function ensureAudioUnlocked() {
  try {
    const ctx = getOrCreateAudioContext();
    if (ctx && ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
  } catch {
    // never let this crash the page
  }
}

// Attaches one-time-per-mount document-level listeners that unlock audio
// on the first genuine click/keypress anywhere on the page, exactly per
// spec ("the first click/keypress anywhere, or the first time the user
// actually opens Support"). Returns a cleanup function. Pass this the
// current React lifecycle (call from a useEffect with an empty dep
// array); it removes its own listeners after the first successful
// unlock attempt since nothing further is needed afterward.
export function attachFirstInteractionUnlock() {
  if (typeof document === "undefined") return () => {};
  let done = false;
  function handler() {
    if (done) return;
    done = true;
    ensureAudioUnlocked();
    document.removeEventListener("pointerdown", handler);
    document.removeEventListener("keydown", handler);
  }
  document.addEventListener("pointerdown", handler);
  document.addEventListener("keydown", handler);
  return () => {
    document.removeEventListener("pointerdown", handler);
    document.removeEventListener("keydown", handler);
  };
}

// Plays a short, pleasant two-tone "bell" chime (per spec: "a pure Web
// Audio API generated 2-tone bell"). Entirely synthesized -- no asset
// file. Wrapped end-to-end in try/catch; any failure (blocked context,
// unsupported API, thrown exception) resolves silently with zero console
// spam and zero effect on the rest of the page.
export function playChime() {
  try {
    const ctx = getOrCreateAudioContext();
    if (!ctx) return;
    // If the context is still suspended (no user gesture has unlocked it
    // yet), do not attempt to play -- this would either silently no-op
    // or throw depending on the browser; either way, never surface an
    // error to the caller.
    if (ctx.state === "suspended") return;

    const now = ctx.currentTime;
    const tones = [
      { freq: 880, start: 0, duration: 0.16 }, // A5
      { freq: 1320, start: 0.1, duration: 0.22 }, // E6
    ];
    for (const tone of tones) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(tone.freq, now + tone.start);
      // Quick attack, gentle decay -- a soft "bell" envelope rather than
      // an abrupt on/off click.
      gain.gain.setValueAtTime(0, now + tone.start);
      gain.gain.linearRampToValueAtTime(0.16, now + tone.start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + tone.start + tone.duration);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(now + tone.start);
      oscillator.stop(now + tone.start + tone.duration + 0.02);
    }
  } catch {
    // resolve silently -- Support must keep functioning regardless
  }
}

// ---- ADMIN SHARED DE-DUP (spec section D) -----------------------------
//
// Admin Portal > Support has TWO independent polls that can both observe
// the exact same new customer message in the same tick/cycle: the
// conversation-LIST poll (silentRefreshList) and the open-conversation
// DETAIL poll (silentRefreshDetail). Both must route through this ONE
// shared, module-level Set of already-chimed message ids so a message
// that both polls happen to detect in the same cycle (or across
// consecutive cycles, before either has "seen" it) still only ever
// produces exactly one chime -- per spec: "need de-dup shared state, e.g.
// a single module-level/shared Set or ref of already-chimed message
// IDs, or route both polls through one detector."
//
// Module-level (not component state/ref) specifically because the list
// and detail polls live in two different parts of the same page
// component tree and must share the identical Set instance regardless of
// render/mount order.
const adminChimedMessageIds = new Set();
// Simple unbounded-growth guard for a long-lived admin tab -- once the
// set gets large, drop the oldest half. Correctness doesn't depend on
// keeping every id forever, only on not re-chiming for an id chimed
// recently, so this is a safe, simple cap.
const ADMIN_CHIMED_ID_CAP = 2000;

// Attempts to "claim" a message id for chiming. Returns true (and
// records the id) only the FIRST time it is called for that id from
// EITHER poll -- a second call for the same id (from the same poll on a
// later tick, or from the other poll in the same or a later tick)
// returns false and is a no-op. Callers should call playChime() only
// when this returns true.
export function claimChimeForMessageId(messageId) {
  if (!messageId) return false;
  if (adminChimedMessageIds.has(messageId)) return false;
  adminChimedMessageIds.add(messageId);
  if (adminChimedMessageIds.size > ADMIN_CHIMED_ID_CAP) {
    const excess = adminChimedMessageIds.size - ADMIN_CHIMED_ID_CAP / 2;
    let removed = 0;
    for (const id of adminChimedMessageIds) {
      if (removed >= excess) break;
      adminChimedMessageIds.delete(id);
      removed += 1;
    }
  }
  return true;
}

// Seeds the shared claim-set with an id WITHOUT ever chiming for it --
// used to mark ids already known at initial load (list/detail) as
// "already seen" so they can never later be mistaken for a genuinely new
// arrival.
export function seedChimedMessageId(messageId) {
  if (!messageId) return;
  adminChimedMessageIds.add(messageId);
}

