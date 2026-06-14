// VIEWER-ENTRY GATE — the shared, platform-agnostic state machine that sequences
// a viewer's path INTO a live room so the manifest can NEVER race the media. It is
// the canonical answer to the mobile "PC manager closed / stale PNG" bug: the room
// MUST NOT connect until this gate reports `ready`.
//
// ── Why a SEPARATE machine from viewer.ts ────────────────────────────────────
// `viewer.ts`'s ViewerState models the IN-ROOM lifecycle (connecting → preloading
// → live → ended) — it assumes you are ALREADY connected and folds the streamer's
// live-sync snapshots. That post-connect gate is fine for WEB, where a guest can
// only obtain the manifest from the in-room broadcast, so the video element stays
// mounted (covered by the preloader) while materials warm.
//
// On MOBILE the same "join first, learn about materials later" ordering is what
// breaks: the native PeerConnection + H.264 decoder come up, the doc slot paints a
// stale page (the previous room's cached PNG) while the manifest is still in
// flight, and a benign re-render then bounces the connection ("PC manager being
// closed"). The fix is to make ENTRY explicit and ORDERED, BEFORE any connect:
//
//   idle → fetchingManifest → preloading → ready ─→ (the screen connects the room)
//                                   │
//                                   └─ (no materials) ─→ ready immediately
//
// The room connection is gated on `isEntryReady(state)`. Once ready, the EXISTING
// in-room machinery (useLiveKitRoom + useLivestreamSync / viewer.ts) takes over —
// this gate's only job is to guarantee the manifest + preload finished first, so
// the doc slot has WARM bytes the instant the first frame paints and there is no
// manifest-vs-room race to recover from.
//
// ── What's shared vs per-platform ────────────────────────────────────────────
// Shared (this module): the phase model, the ordered transitions, the
// "ready?"/"gated?"/progress derivations, and the decision of whether a room even
// HAS a gate (manifestHasMaterials). Per-platform: the actual manifest FETCH
// (a REST call, or — for a guest who can't fetch — skipping straight past the
// fetch since the in-room broadcast is the only source) and the byte-level
// preload (web: fetch + pdf.js; RN: the doc-render seam in docRender.ts). Those
// are injected; this file holds zero IO.

import { manifestHasMaterials } from './viewer';
import type { LiveManifest } from './live';

/** The viewer-entry phase. Strictly ordered; a viewer only ever moves forward
 *  (except `reset`, which returns to `idle` for a brand-new room).
 *   'idle'             — nothing started yet (screen mounted, no room targeted).
 *   'fetchingManifest' — asking the streaming/materials API what this room shows.
 *   'preloading'       — warming every material behind a real-progress gate.
 *   'ready'            — manifest + preload done (or the room has no materials);
 *                        the screen is CLEARED TO CONNECT the LiveKit room.
 *   'failed'           — the manifest fetch failed hard; the screen may proceed
 *                        DEGRADED (connect anyway, render video-only) or retry. */
export type EntryPhase = 'idle' | 'fetchingManifest' | 'preloading' | 'ready' | 'failed';

/** The complete, serializable entry-gate state. A render layer holds exactly this
 *  and derives its gate UI (spinner / progress bar / "connect now") from it. */
export interface EntryState {
  phase: EntryPhase;
  /** The room this gate is for (so a room switch can `reset` cleanly). */
  roomName: string | null;
  /** The fetched manifest (null until fetchingManifest resolves, or when the room
   *  has no materials). Drives the preload step + the in-room doc render. */
  manifest: LiveManifest | null;
  /** Preload progress, bytes warmed / total (for the gate's bar). */
  loadedBytes: number;
  totalBytes: number;
  /** A human-readable reason when phase === 'failed' (logged, not necessarily
   *  shown). */
  error?: string;
}

/** The initial gate state for a room (or none). The screen calls this on mount /
 *  on a room change, THEN drives the transitions below before connecting. */
export function initialEntryState(roomName: string | null = null): EntryState {
  return { phase: 'idle', roomName, manifest: null, loadedBytes: 0, totalBytes: 0 };
}

/** Begin the gate: move idle → fetchingManifest for `roomName`. Idempotent for the
 *  SAME room already in flight (returns the state unchanged) so a re-render can't
 *  restart the fetch; a DIFFERENT room resets first. */
export function beginEntry(state: EntryState, roomName: string): EntryState {
  if (state.roomName === roomName && state.phase !== 'idle') return state;
  return { ...initialEntryState(roomName), phase: 'fetchingManifest' };
}

/** The manifest fetch resolved. Decide the next phase:
 *   • manifest has materials ⇒ preloading (gate stays up; warm them).
 *   • no materials (null/empty) ⇒ ready immediately (nothing to warm; connect).
 *  A late resolution for a room we've since switched away from is ignored (guard
 *  on roomName at the call site; this stays pure). */
export function onManifestFetched(state: EntryState, manifest: LiveManifest | null): EntryState {
  if (manifestHasMaterials(manifest)) {
    return {
      ...state,
      phase: 'preloading',
      manifest,
      totalBytes: manifest!.totalSizeBytes,
      loadedBytes: 0,
    };
  }
  return { ...state, phase: 'ready', manifest: manifest ?? null };
}

/** The manifest fetch failed (network / 4xx). Move to `failed` so the screen can
 *  decide: connect DEGRADED (video-only — the in-room broadcast may still deliver
 *  a manifest a guest can use) or surface a retry. We never block forever on a
 *  fetch the guest path can't even make. */
export function onManifestFailed(state: EntryState, error?: string): EntryState {
  return { ...state, phase: 'failed', error };
}

/** Advance preload progress (the byte-fetch layer streams the materials). Pure. */
export function onEntryPreloadProgress(state: EntryState, loadedBytes: number, totalBytes?: number): EntryState {
  return {
    ...state,
    loadedBytes: Math.max(state.loadedBytes, loadedBytes),
    totalBytes: totalBytes ?? state.totalBytes,
  };
}

/** Lift the gate: preload finished (or the viewer skipped) → `ready`. Idempotent.
 *  After this the screen is cleared to connect the LiveKit room. */
export function markEntryReady(state: EntryState): EntryState {
  if (state.phase === 'ready') return state;
  return { ...state, phase: 'ready', loadedBytes: Math.max(state.loadedBytes, state.totalBytes) };
}

/** Reset for a brand-new room (or teardown). Returns a fresh idle gate. */
export function resetEntry(roomName: string | null = null): EntryState {
  return initialEntryState(roomName);
}

/** THE GATE PREDICATE the room connection hangs on. True ⇒ the screen may connect
 *  the LiveKit room. We admit on `ready` AND on `failed` (degraded video-only path
 *  — better a video-only stream than an indefinite spinner when a guest could
 *  never fetch the manifest anyway; the in-room broadcast still feeds the doc slot
 *  once connected). 'idle'/'fetchingManifest'/'preloading' all HOLD the connect. */
export function isEntryReady(state: EntryState): boolean {
  return state.phase === 'ready' || state.phase === 'failed';
}

/** True while the gate is COVERING the screen (a spinner or progress bar shows and
 *  the room is NOT yet connected). The inverse of "show the live view". */
export function isEntryGating(state: EntryState): boolean {
  return state.phase === 'fetchingManifest' || state.phase === 'preloading';
}

/** Preload progress as a 0..100 integer (the gate's bar). 100 once ready. */
export function entryPreloadPct(state: EntryState): number {
  if (state.phase === 'ready') return 100;
  if (state.phase !== 'preloading' || state.totalBytes <= 0) return 0;
  return Math.min(100, Math.round((state.loadedBytes / state.totalBytes) * 100));
}

/** A short, user-facing label for the current gate phase (web + RN render the same
 *  copy). Returns '' once past the gate. */
export function entryStatusLabel(state: EntryState): string {
  switch (state.phase) {
    case 'fetchingManifest':
      return 'Preparing stream…';
    case 'preloading':
      return 'Loading stream contents…';
    case 'failed':
      return 'Joining…';
    default:
      return '';
  }
}
