// THE OVERLAY SYNC SOURCE SEAM (§3c) — the SINGLE interface the render-brain
// consumes to get a converged `ViewerState`, with TWO swappable implementations
// behind it (`LwwSyncSource` first, `CrdtSyncSource` later) that the render-brain,
// the views, and the gate NEVER have to know apart.
//
// ── Why a seam, designed now / implemented later ─────────────────────────────
// Reconnects + collaborative tools + money-tied events mean we will eventually need
// to PERSIST, RECOVER, and MERGE overlay/scene state from multiple sources at
// different latencies. Today the convergence is last-write-wins-by-producer with
// zero merge (`applyFullScene` is idempotent + monotonic-by-`nonce`; votes are keyed
// by `(overlayId, gen, stableIdentity)`) — already the right FIRST cut. This seam
// stops the render-brain from reaching past that convergence so a CRDT-backed layer
// can slot UNDER it without touching any manifestation (web viewer, mobile viewer,
// studio preview/interactive, mobile-creator preview/interactive).
//
//   • `LwwSyncSource` (Task B, ship first): wraps the EXISTING pure reducers
//     (`applyLiveSync` / `applySceneSync` / `applyOverlayChanged`). Behaviour
//     identical to today. Zero risk.
//   • `CrdtSyncSource` (Task J, later): SAME interface; folds the same wire events
//     keyed by a per-field causal clock / OR-set. The render-brain + views + gate
//     are UNCHANGED — they only ever see `ViewerState` out of `getState()`/`subscribe`.
//
// THIS FILE IS TASK A: the INTERFACE + its supporting types ONLY. No implementation
// (`LwwSyncSource`/`CrdtSyncSource` are Tasks B/J). PURE: references existing core
// types only — no DOM/RN/SDK, no `livekit-client`.

import type { OverlayChannelEvent } from '../overlays/consume';
import type { OverlayInstance } from '../overlays/types';
import type { ViewerState } from './viewer';
import type { DocPresenterState, LiveScene, LiveManifest } from './live';
import type { RenderedScene } from './scene';
import type { WireOutbound } from './transport';

// NOTE: `OverlayChannelEvent` (from overlays/consume.ts) and `WireOutbound` (from
// streaming/transport.ts) are the seam's natural vocabulary and are re-exported at
// the package barrel (src/index.ts) alongside this module — they are NOT re-exported
// here to avoid an ambiguous duplicate `export *` through the streaming subpath
// barrel (transport.ts + consume.ts already own them).

/** A PRODUCE-side local mutation the streamer/creator makes (studio + the coming
 *  mobile-creator dashboard), to be folded into convergence AND turned into wire
 *  messages to broadcast. The render-brain calls `localMutate(m)`; the sync source
 *  returns the `WireOutbound[]` to publish.
 *
 *  Today (LWW) these map straight onto `buildRenderedScene` + `deriveManifest` +
 *  the doc/overlay builders; tomorrow (CRDT) the same intents emit causal ops. The
 *  shape is the INTENT, not the wire — the source owns the encode so the producer
 *  direction is identical across platforms.
 *
 *  A tagged union so it stays exhaustive as producer verbs are added (Tasks B/K
 *  flesh out the handling; this enumerates the seam's contract). */
export type LocalOverlayMutation =
  /** Broadcast a new FULL-REPLACE rendered scene (scene switch / overlay add/remove
   *  / authored-rect edit). Carries the complete set — the producer is the single
   *  source of truth. The source bumps `nonce` monotonically. */
  | { kind: 'set-scene'; scene: RenderedScene }
  /** Push/replace the active DOC slot instance (a served material, a page flip), or
   *  clear it with `doc: null`. Rides `live.sync`. */
  | { kind: 'set-doc'; doc: OverlayInstance | null }
  /** Update the presenter's pan/zoom on the active doc (mirrors the streamer's view
   *  to joiners). Rides `live.sync.docPresenter`. */
  | { kind: 'set-doc-presenter'; presenter: DocPresenterState | null }
  /** Select / change the broadcast scene definition (layout mirror). Rides
   *  `live.sync.scene`. `null` ⇒ clear (viewers fall back to local default). */
  | { kind: 'set-live-scene'; scene: LiveScene | null }
  /** Re-publish / update the room material MANIFEST (ids + sizes + presigned URLs).
   *  Rides `live.sync.manifest`. */
  | { kind: 'set-manifest'; manifest: LiveManifest | null }
  /** End the stream — broadcast the {doc:null, scene:null} wipe sentinel. */
  | { kind: 'end-live' };

/** The RECONNECT recovery plan a sync source returns from `onReconnect()` after a
 *  transport drop — formalizing "after a drop, re-request state + dedupe the
 *  re-granted manifest + re-fold the latest `nonce`" as ONE shared plan instead of
 *  the three ad-hoc effects it is today (`requestState()`, the streamer's
 *  on-`ParticipantConnected` re-broadcast, the connection-guard's swallow).
 *
 *  The transport executes it: it `requestState()`s if asked, publishes any
 *  `replay` outbounds (the producer re-broadcasting its current snapshot to a late
 *  joiner), and the source has already deduped/re-folded internally. */
export interface ReconnectPlan {
  /** Ask the server bot + streamer to replay current state (active overlay, my
   *  vote, latest live.sync/scene.sync). The CONSUMER direction's recovery. */
  requestState: boolean;
  /** PRODUCER-direction recovery: wire messages to re-broadcast so a (re)joining
   *  participant reconstructs the current scene/doc/manifest. Empty for a pure
   *  consumer. The manifest in these is already deduped (`dedupeManifest`) so a
   *  re-grant doesn't trigger the reload loop. */
  replay: WireOutbound[];
}

/** THE SEAM. The render-brain (`useOverlaySession`, Task C) consumes ONLY this to
 *  paint — it never reaches past `getState()`/`subscribe` (hard rule #5), so a
 *  CRDT-backed implementation can slot under it untouched. Two implementations live
 *  behind it: `LwwSyncSource` (Task B) and `CrdtSyncSource` (Task J), both
 *  surfacing the EXACT same `ViewerState`. */
export interface OverlaySyncSource {
  /** Current converged snapshot the render layer paints from. */
  getState(): ViewerState;
  /** Subscribe to converged-state changes (debounced/coalesced by the source).
   *  Returns an unsubscribe function. */
  subscribe(cb: (s: ViewerState) => void): () => void;
  /** Feed a decoded inbound event (from `decodeOverlayChannelMsg`). The source folds
   *  it into convergence. Today: `applyLiveSync` / `applySceneSync` /
   *  `applyOverlayChanged`. Tomorrow (CRDT): merge by causal order, not last-write.
   *  `nowMs` is the injectable clock (tests / RN) — the source never reads a wall
   *  clock itself. */
  ingest(ev: OverlayChannelEvent, nowMs: number): void;
  /** Produce-side local mutations (streamer/creator), returned as wire messages to
   *  broadcast. Today: build live.sync/scene.sync. Tomorrow: emit CRDT ops. */
  localMutate(m: LocalOverlayMutation): WireOutbound[];
  /** Reconnect recovery: what to (re)request + replay after a transport drop. */
  onReconnect(): ReconnectPlan;
}
