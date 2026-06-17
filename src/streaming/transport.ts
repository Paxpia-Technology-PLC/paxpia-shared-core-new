// OVERLAY TRANSPORT + ROOM HANDLE — the THIN platform-binding interfaces between
// the shared render-brain / gate (pure `@paxpia/core`) and the LiveKit SDK that
// only ever lives in a platform shell.
//
// ── Why these are interfaces, not impls ──────────────────────────────────────
// Per the unified-overlay architecture (§5b, §8 hard rule #2) NO `livekit-client`
// import may appear in `@paxpia/core` or `@paxpia/ui`. The render-brain
// (`useOverlaySession`, Task C) and the gate (`gate.ts`, Task D) consume these
// plain interfaces; the platform shell (Paxpia-web / Paxpia-mobile) implements
// them over the real `Room` / data channel and passes them in. That keeps the
// brain + gate pure + portable and confines the SDK to one adapter per platform.
//
// PURE: type-only module. References only existing core types. No DOM/RN/SDK.

import type { OverlayChannelEvent } from '../overlays/consume';

/** A wire message ready to publish on the `overlay` data topic — the BYTES the
 *  producer side emits (built by the sync source's `localMutate`, §3c) and the
 *  transport puts on the channel. Kept as the raw encoded payload so the transport
 *  stays codec-agnostic: the sync source owns encode (`encodeLiveSyncMsg` /
 *  `encodeSceneSyncMsg` / overlay encoders), the transport only delivers. */
export interface WireOutbound {
  /** The encoded payload to publish on the data channel. */
  bytes: Uint8Array;
  /** Whether the channel must deliver this reliably (snapshots/state) vs lossy
   *  (high-frequency, self-healing). Defaults to reliable when omitted. */
  reliable?: boolean;
  /** The data topic to publish on. Defaults to the `overlay` topic when omitted
   *  (the multiplexed bus `decodeOverlayChannelMsg` classifies). */
  topic?: string;
}

/** The THIN transport the render-brain drives. It owns ONLY the three channel
 *  verbs — it never decodes, folds, or holds state (that's the sync source +
 *  render-brain). A platform binds this to the LiveKit `Room` data channel.
 *
 *  Symmetry with `OverlaySyncSource` (§3c): the sync source decides WHAT to send
 *  (returns `WireOutbound[]` from `localMutate`/`onReconnect`); the transport just
 *  PUTS those on the wire and SURFACES inbound decoded events back to the brain. */
export interface OverlayTransport {
  /** Send a single viewer reply (e.g. a vote `overlay.response`) on the channel.
   *  The brain calls this from `OverlayViewProps.onVote`. */
  respond(out: WireOutbound): void;
  /** Ask the server bot (+ streamer) to REPLAY current state — the active overlay,
   *  my committed vote, the latest live.sync/scene.sync. Used on (re)join + after a
   *  transport drop (the `onReconnect` plan, §3c). */
  requestState(): void;
  /** Publish a producer-side broadcast (live.sync / scene.sync / overlay.*) on the
   *  channel — the studio/creator direction. The brain feeds it the `WireOutbound[]`
   *  the sync source's `localMutate` produced. */
  publish(out: WireOutbound): void;
  /** Subscribe to DECODED inbound channel events (already run through
   *  `decodeOverlayChannelMsg` by the platform binding). Returns an unsubscribe.
   *  The render-brain wires this to the sync source's `ingest`. */
  onEvent(cb: (ev: OverlayChannelEvent) => void): () => void;
}

/** An opaque handle to a CONNECTED LiveKit room, produced by the gate's
 *  `GateAdapter.connectRoom` (§5b) and handed to the final live surface on
 *  `canHandOff`. The pure layer touches ONLY these abstract handles — never the
 *  `Room` / `Track` / `RemoteAudioTrack` SDK types directly (hard rule #2).
 *
 *  `track`/`audio` are deliberately `unknown`-typed opaque tokens: the platform
 *  shell knows their concrete SDK type, the core does not need to. The render
 *  surface forwards them straight to the platform's `<VideoTrack>` / audio
 *  attach — it never inspects them. */
export interface RoomHandle {
  /** Tear down this room connection + release all its resources. The gate calls
   *  this on a FAILED or ABORTED join so leftover LiveKit state from an aborted
   *  join is cleaned (lifecycle hygiene, §5b). Idempotent. */
  teardown(): void;
  /** The remote VIDEO track token to attach to a platform video element, or null
   *  when there is no video source (video-less / audio-only room). Opaque to core. */
  videoTrack: unknown | null;
  /** The remote AUDIO track token to attach to the platform output device, or null
   *  when no audio is published yet. Opaque to core. Mute is applied to the OUTPUT
   *  (pre-session, §7a), never by unsubscribing this. */
  audioTrack: unknown | null;
  /** The transport bound to THIS room's `overlay` data channel — the render-brain
   *  drives this for respond/requestState/publish/onEvent. */
  transport: OverlayTransport;
}
