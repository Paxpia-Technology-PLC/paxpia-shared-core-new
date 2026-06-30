// THE COMPOSITOR SEAM (§1.4) — the ONE platform-binding interface between the
// shared producer brain (`DirectorSession`/`useLiveSession`, §2.1) and the
// platform code that actually PAINTS scene items into a single 9:16 publishable
// video track.
//
// ── Why this is an interface, not an impl ────────────────────────────────────
// A "compositor" is irreducibly platform-specific: web rasterizes camera/screen
// <video>s into a <canvas> on a rAF loop and exposes the result via
// `canvas.captureStream()` (see `Paxpia-web/src/studio/compositor.ts`); React
// Native has no canvas/captureStream and must composite natively (GL surface, or
// per-tile `<VideoTrack>` views the host pre-composites, §3.5). What is COMMON is
// the producer's INTENT — "these items, in this scene, switch to that scene, give
// me the one output track to publish." That intent is what this seam captures, so
// the producer brain can drive a compositor WITHOUT a platform dependency
// (analogous to `OverlayTransport` for the data channel + `LeafAdapter` for
// pixel-decoding leaves).
//
// PURE: type-only module. No DOM, no React Native, no `livekit-client`, no
// `MediaStream`/`canvas` types. Platform media handles cross the seam as OPAQUE
// `unknown` tokens (the `MediaStreamLike`/`MediaTrackLike` aliases below) — the
// web impl knows they are a `MediaStream`/`MediaStreamTrack`, the core does not.
// The `fitToBox`/`rectToPixels`/`itemsInDrawOrder` geometry every compositor uses
// to PLACE items stays shared in `@paxpia/core/layout` (already there) — this seam
// only describes the lifecycle + binding, never re-implements the math.

import type { LayoutItem, Scene } from '../layout/types';

/** A platform media-SOURCE handle bound to a scene item (web: a `MediaStream` from
 *  getUserMedia/getDisplayMedia; RN: a LiveKit `LocalVideoTrack` / track ref).
 *  Opaque to core — the compositor impl is the only thing that decodes it, exactly
 *  like `RoomHandle.videoTrack`/`audioTrack` are opaque tokens in `transport.ts`. */
export type MediaSourceHandle = unknown;

/** The single composited OUTPUT video track the producer publishes to the SFU
 *  (web: `canvas.captureStream().getVideoTracks()[0]`; RN: the native/GL output
 *  track). Opaque to core — the producer brain forwards it straight to the
 *  platform's `room.localParticipant.publishTrack(...)`, never inspecting it. */
export type OutputVideoTrack = unknown;

/** The frame geometry a compositor renders against. The output is a portrait 9:16
 *  track by construction (matching `FRAME_ASPECT` in `layout/types`); `width`/
 *  `height` are the pixel resolution of the composited surface (web's canvas
 *  defaults to 720×1280 @ 30fps). All optional — a platform picks sane defaults. */
export interface CompositorConfig {
  /** Output surface width in px (web canvas default 720). */
  width?: number;
  /** Output surface height in px (web canvas default 1280, i.e. 9:16). */
  height?: number;
  /** Target capture frame rate (web `captureStream(fps)` default 30). */
  fps?: number;
}

/** THE COMPOSITOR — the producer brain's view of "paint this scene into one
 *  publishable 9:16 track." Mirrors the real web usage in `store/live.ts` +
 *  `studio/compositor.ts`, but with the scene state PUSHED in (the brain owns it)
 *  rather than the impl reaching into a web zustand store, so it is driveable from
 *  any platform.
 *
 *  ── Lifecycle (matches `store/live.ts`) ─────────────────────────────────────
 *  On go-live the brain: constructs the compositor (platform factory), seeds the
 *  scenes via `setScene`/`setActiveScene`, binds each media item's source track
 *  via `upsertItem`, calls `start()`, then publishes `getOutputTrack()`. On a
 *  scene hot-swap it calls `setActiveScene(id)` (+ `upsertItem` for any newly-live
 *  inputs) — the OUTPUT TRACK NEVER CHANGES, only its content (the web canvas
 *  reads the active scene each frame; an RN impl re-binds its tile tree). On a
 *  layout edit (move/resize/fit/z) it calls `setScene` with the updated scene. On
 *  end-live it calls `stop()`.
 *
 *  ── Which items the compositor paints ───────────────────────────────────────
 *  ONLY `camera`/`screen` items carry pixels the compositor bakes into the H.264
 *  track. `overlay`/`doc`/`whiteboard` items are composed on the VIEWER as
 *  interactive DOM/native layers OVER the video (crisp text, not baked in) — the
 *  brain still passes the full scene (the impl ignores the non-media items for
 *  painting), so a compositor has the complete layout if a platform ever bakes an
 *  overlay. Placement uses the shared `fitToBox`/`rectToPixels` geometry. */
export interface Compositor {
  /** Register / replace a scene the producer may make active. The compositor keeps
   *  the LATEST layout per scene id (rects/fit/z/items), so a layout edit is just a
   *  re-`setScene` of the same id; the next frame reflects it. Idempotent. */
  setScene(scene: Scene): void;
  /** Make `sceneId` the one painted into the output track. This is the HOT-SWAP —
   *  the published track is unchanged, only the composited content switches. A
   *  no-op if `sceneId` is unknown (the brain seeds it via `setScene` first). */
  setActiveScene(sceneId: string): void;
  /** Bind (or rebind) the platform media SOURCE for a scene item by item id — the
   *  live track the compositor draws into the item's box. `track` is the opaque
   *  platform handle (web: the item's `MediaStream` from the media registry; RN: a
   *  LiveKit local track); pass `undefined`/omit to register the item's geometry
   *  without a source yet (the box paints black until a track arrives). Mirrors the
   *  web impl's per-item-id offscreen `<video>` keyed by the live stream registry.
   *  Safe to call before or after `start()`. */
  upsertItem(item: LayoutItem, track?: MediaSourceHandle): void;
  /** Drop an item's source binding (its input was removed from the scene or its
   *  capture released) — the compositor tears down that item's offscreen
   *  video/tile so the next frame stops painting it. Idempotent. */
  removeItem(itemId: string): void;
  /** The single composited OUTPUT video track to publish — stable across scene
   *  switches + layout edits (only its CONTENT changes). Null before `start()` /
   *  after `stop()`, or when the platform can't produce a track. The web impl
   *  returns `canvas.captureStream(fps).getVideoTracks()[0]`. */
  getOutputTrack(): OutputVideoTrack | null;
  /** Begin compositing (web: kick the rAF draw loop + `captureStream`). After this,
   *  `getOutputTrack()` returns the live track. Idempotent — calling twice does not
   *  restart the loop or mint a second track. */
  start(): void;
  /** Stop compositing + RELEASE all resources: cancel the draw loop, detach every
   *  bound source, and stop the output track. Idempotent + safe to call mid-start.
   *  After `stop()`, `getOutputTrack()` returns null. The brain calls this on
   *  `endLive` (and on a go-live failure path), exactly as `store/live.ts` calls
   *  `compositor?.stop()`. */
  stop(): void;
  /** OPTIONAL (platforms whose output track is minted ASYNC, e.g. the RN native composite):
   *  register a callback fired when the output track first becomes available (and on any
   *  later output-track identity change), so the brain can re-publish + re-point the preview
   *  WITHOUT waiting for a scene switch. Returns an unsubscribe. Platforms with a synchronous
   *  output track (web canvas) omit it — the brain optional-chains the call, so it's a no-op. */
  onOutputTrackReady?(cb: () => void): () => void;
}

/** The platform FACTORY the producer brain is handed (DI), mirroring how
 *  `startCompositor()` is constructed in `store/live.ts`. The brain calls this once
 *  per go-live to obtain a fresh `Compositor`, then drives it through the interface
 *  above. Web binds this to `startCompositor` (canvas2d + rAF + captureStream); RN
 *  binds it to its native/GL compositor (§3.5). Keeping construction behind a
 *  factory means the brain never imports a platform compositor module. */
export type CompositorFactory = (config?: CompositorConfig) => Compositor;
