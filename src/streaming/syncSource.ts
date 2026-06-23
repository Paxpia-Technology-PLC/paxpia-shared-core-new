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
import {
  initialViewerState,
  applyLiveSync,
  applySceneSync,
  applyOverlayChanged,
} from './viewer';
import { overlayModule } from '../overlays/registry';
import { emptyBoard, encodeWbMsg, type WbMsg } from '../overlays/whiteboard';
import { wbViewPersistKey } from './persist';
import type { DocPresenterState, LiveScene, LiveManifest, LiveSyncMsg } from './live';
import {
  LIVESYNC_WIRE_VERSION,
  encodeLiveSyncMsg,
  dedupeManifest,
} from './live';
import type { RenderedScene } from './scene';
import { encodeSceneSyncMsg, SCENE_WIRE_VERSION } from './scene';
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
  /** Broadcast a WHITEBOARD delta (stroke / erase / wipe / snapshot) for a board. The
   *  source folds it into the SAME converged `boards` map a viewer holds (so the producer
   *  paints from `getState()` too) and remembers the board so `onReconnect()` can replay
   *  its current snapshot — the wb wire is owned by the sync source, NOT an ad-hoc
   *  per-screen effect (Contract §8.1.3). */
  | { kind: 'wb'; msg: WbMsg }
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

// ─────────────────────────────────────────────────────────────────────────────
// TASK B — `LwwSyncSource`: the ship-first implementation. It WRAPS the existing
// pure reducers (`applyLiveSync` / `applySceneSync` / `applyOverlayChanged`) so
// its behaviour is IDENTICAL to today's forked consumption — zero new convergence
// logic, zero risk. The render-brain (`useOverlaySession`, Task C) consumes ONLY
// the `OverlaySyncSource` interface, so the day a `CrdtSyncSource` lands behind the
// same interface, NOTHING above changes.
//
// PURE: holds an in-memory `ViewerState` + a subscriber set; no DOM/RN/SDK, no
// `livekit-client`. The clock is injected via `ingest(ev, nowMs)` — the source
// never reads a wall clock. (LWW convergence is `nonce`-monotonic, so `nowMs` is
// carried for interface symmetry / a future CRDT's causal ordering but isn't read
// by the LWW fold today.)
// ─────────────────────────────────────────────────────────────────────────────

/** A live producer snapshot the source can re-broadcast on reconnect. The producer
 *  direction (studio / creator) feeds the source its current scene/doc/manifest via
 *  `localMutate`; the source remembers the latest of each so `onReconnect()` can
 *  replay them to a late joiner. A pure consumer never sets these → `replay` is
 *  empty. */
interface ProducerSnapshot {
  scene: RenderedScene | null;
  doc: OverlayInstance | null;
  docPresenter: DocPresenterState | null;
  liveScene: LiveScene | null;
  manifest: LiveManifest | null;
  /** Monotonic scene nonce the producer bumps on every `set-scene` so the viewer's
   *  `applyFullScene` (monotonic-by-`nonce`) accepts each replace + ignores a stale
   *  replay. */
  nonce: number;
}

function emptyProducerSnapshot(): ProducerSnapshot {
  return { scene: null, doc: null, docPresenter: null, liveScene: null, manifest: null, nonce: 0 };
}

/** Build the `live.sync` outbound that mirrors the producer's current doc-slot +
 *  selected scene + manifest (the produce-side `live.sync` the consumer folds via
 *  `applyLiveSync`). The manifest is deduped (`dedupeManifest`) so a re-granted
 *  presigned URL doesn't trigger the viewer's preload reload loop. */
function liveSyncOutbound(snap: ProducerSnapshot): WireOutbound {
  const msg: LiveSyncMsg = {
    t: 'live.sync',
    v: LIVESYNC_WIRE_VERSION,
    sceneId: snap.liveScene ? snap.liveScene.id : null,
    scene: snap.liveScene,
    doc: snap.doc,
    docPresenter: snap.docPresenter,
    manifest: dedupeManifest(snap.manifest),
  };
  return { bytes: encodeLiveSyncMsg(msg), reliable: true };
}

/** Build the `scene.sync` outbound carrying the producer's FULL-REPLACE rendered
 *  scene (the authoritative paint source the consumer folds via `applySceneSync` →
 *  `applyFullScene`). Reliable + ordered. */
function sceneSyncOutbound(scene: RenderedScene): WireOutbound {
  return { bytes: encodeSceneSyncMsg({ t: 'scene.sync', v: SCENE_WIRE_VERSION, scene }), reliable: true };
}

/** The LAST-WRITE-WINS-by-producer sync source (Task B). Wraps the existing pure
 *  reducers so it is behaviour-identical to today's consumption; swappable for a
 *  `CrdtSyncSource` (Task J) behind the same `OverlaySyncSource` interface. */
export class LwwSyncSource implements OverlaySyncSource {
  private state: ViewerState;
  private readonly subs = new Set<(s: ViewerState) => void>();
  private readonly producer: ProducerSnapshot = emptyProducerSnapshot();

  constructor(initial?: ViewerState) {
    this.state = initial ?? initialViewerState();
  }

  getState(): ViewerState {
    return this.state;
  }

  subscribe(cb: (s: ViewerState) => void): () => void {
    this.subs.add(cb);
    return () => {
      this.subs.delete(cb);
    };
  }

  /** Fold a decoded inbound channel event into convergence via the EXISTING pure
   *  reducers, then notify subscribers iff the converged state actually changed
   *  (the reducers are referentially-stable on a no-op / stale snapshot, so a
   *  duplicate/stale packet coalesces to zero notifications). */
  ingest(ev: OverlayChannelEvent, _nowMs: number): void {
    const prev = this.state;
    const next = foldEvent(prev, ev);
    if (next !== prev) {
      this.state = next;
      this.emit();
    }
  }

  /** Produce-side mutation: update the remembered producer snapshot, fold the change
   *  into the LOCAL converged state (so the producer paints from the same
   *  `getState()` a viewer does), and return the wire message(s) to broadcast. */
  localMutate(m: LocalOverlayMutation): WireOutbound[] {
    switch (m.kind) {
      case 'set-scene': {
        // Adopt the producer's full-replace scene, stamping the next monotonic nonce
        // so the viewer's `applyFullScene` accepts it (and ignores a stale replay).
        this.producer.nonce = Math.max(this.producer.nonce + 1, m.scene.nonce);
        const scene: RenderedScene = { ...m.scene, nonce: this.producer.nonce };
        this.producer.scene = scene;
        this.applyLocal((s) => applySceneSync(s, scene));
        return [sceneSyncOutbound(scene)];
      }
      case 'set-doc': {
        this.producer.doc = m.doc;
        return [this.broadcastLiveSync()];
      }
      case 'set-doc-presenter': {
        this.producer.docPresenter = m.presenter;
        return [this.broadcastLiveSync()];
      }
      case 'set-live-scene': {
        this.producer.liveScene = m.scene;
        return [this.broadcastLiveSync()];
      }
      case 'set-manifest': {
        this.producer.manifest = m.manifest;
        return [this.broadcastLiveSync()];
      }
      case 'wb': {
        // Fold the operator's own whiteboard delta into LOCAL convergence (the producer
        // paints its board from getState() too, and `onReconnect()` replays from
        // `this.state.boards`), then return the `overlay.wb.*` wire to broadcast.
        this.applyLocal((s) => foldEvent(s, { kind: 'overlay.wb', msg: m.msg }));
        return [{ bytes: encodeWbMsg(m.msg), reliable: true }];
      }
      case 'end-live': {
        // The stream-end wipe sentinel: {doc:null, scene:null}. Reset the producer
        // snapshot so a subsequent reconnect doesn't replay a dead scene.
        this.producer.doc = null;
        this.producer.docPresenter = null;
        this.producer.liveScene = null;
        this.producer.manifest = null;
        this.producer.scene = null;
        const out: WireOutbound = {
          bytes: encodeLiveSyncMsg({ t: 'live.sync', v: LIVESYNC_WIRE_VERSION, doc: null, scene: null }),
          reliable: true,
        };
        this.applyLocal((s) =>
          applyLiveSync(s, { t: 'live.sync', v: LIVESYNC_WIRE_VERSION, doc: null, scene: null }),
        );
        return [out];
      }
      default: {
        // Exhaustiveness guard — a new mutation verb without a handler is a compile
        // error here (the union stays the single source of truth).
        const _never: never = m;
        return _never;
      }
    }
  }

  /** Reconnect recovery (the ONE shared plan). A consumer always re-requests state
   *  (replay the active overlay + my vote + the latest live.sync/scene.sync). A
   *  PRODUCER additionally re-broadcasts its current scene/doc/manifest so a
   *  (re)joining participant reconstructs the surface — with the manifest already
   *  deduped so a re-grant can't reload-loop the viewer. */
  onReconnect(): ReconnectPlan {
    const replay: WireOutbound[] = [];
    if (this.producer.scene) replay.push(sceneSyncOutbound(this.producer.scene));
    if (this.producer.doc || this.producer.liveScene || this.producer.manifest) {
      replay.push(liveSyncOutbound(this.producer));
    }
    // WHITEBOARD snapshot replay folded into the ONE ReconnectPlan (Contract §4 / Task 5):
    // for every live board the producer holds (its strokes converged in `this.state.boards`),
    // re-broadcast the full `overlay.wb.snapshot` at its gen via the typed module's
    // `onReconnect`, so a (re)joining/late viewer gets current board state then live deltas —
    // unified with the doc path, NEVER an ad-hoc per-join effect. The boardId is stamped onto
    // the snapshot here (the module recovers it from the persist key).
    const wb = overlayModule('whiteboard');
    for (const [boardId, board] of Object.entries(this.state.boards)) {
      if (board.strokes.length === 0 && board.gen === 0) continue; // nothing to replay
      // The module recovers the boardId from the `wb:<boardId>` key and stamps it on the
      // snapshot, so the wire is already addressed to this board.
      for (const out of wb.onReconnect(board, wbViewPersistKey(boardId))) replay.push(out);
    }
    return { requestState: true, replay };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private broadcastLiveSync(): WireOutbound {
    const out = liveSyncOutbound(this.producer);
    // Fold the producer's own live.sync into local convergence so its render-brain
    // sees the same doc/scene/manifest a viewer would (the producer paints from
    // getState() too).
    this.applyLocal((s) =>
      applyLiveSync(s, {
        t: 'live.sync',
        v: LIVESYNC_WIRE_VERSION,
        sceneId: this.producer.liveScene ? this.producer.liveScene.id : null,
        scene: this.producer.liveScene,
        doc: this.producer.doc,
        docPresenter: this.producer.docPresenter,
        manifest: dedupeManifest(this.producer.manifest),
      }),
    );
    return out;
  }

  private applyLocal(fold: (s: ViewerState) => ViewerState): void {
    const next = fold(this.state);
    if (next !== this.state) {
      this.state = next;
      this.emit();
    }
  }

  private emit(): void {
    for (const cb of this.subs) cb(this.state);
  }
}

/** Construct a fresh `LwwSyncSource` (a thin factory mirroring the other core
 *  machines' `createX` ergonomics; the class is exported too for `instanceof`). */
export function createLwwSyncSource(initial?: ViewerState): LwwSyncSource {
  return new LwwSyncSource(initial);
}

/** Fold ONE decoded channel event into the viewer state via the EXISTING pure
 *  reducers — the single ingest routing table. EXPORTED so the render-brain (Task C)
 *  and tests can verify "decoded event → reducer" parity with the legacy hooks
 *  without a `LwwSyncSource` instance. PURE.
 *
 *  • `live.sync`      → `applyLiveSync`        (doc slot + scene + manifest + presenter)
 *  • `scene.sync`     → `applySceneSync`       (FULL-REPLACE rendered layer)
 *  • `overlay.changed`→ `applyOverlayChanged`  (server-bot participation slot)
 *  • `overlay.wb`     → `overlayModule('whiteboard').applyRemote` per-board (the SAME
 *    gen-aware fold `applyWb`/`applyWhiteboardMsg` ran — now EXPRESSED via the module,
 *    so the converged stroke set is driven through the enforced contract, Contract
 *    v2.4.2). The `whiteboard` overlay derives `strokes` from `state.boards[boardId]`.
 *  • everything else  → unchanged (results/response/control/svg/unsupported are NOT
 *    part of the converged ViewerState — votes/SVG/control fold elsewhere). */
export function foldEvent(state: ViewerState, ev: OverlayChannelEvent): ViewerState {
  switch (ev.kind) {
    case 'live.sync':
      return applyLiveSync(state, ev.msg);
    case 'scene.sync':
      return applySceneSync(state, ev.msg.scene);
    case 'overlay.changed':
      return applyOverlayChanged(state, ev.msg.overlay);
    case 'overlay.wb':
      return foldWhiteboardViaModule(state, ev.msg.boardId, ev.msg);
    default:
      return state;
  }
}

/** Fold one whiteboard delta into the converged per-board stroke set THROUGH the typed
 *  whiteboard module (`overlayModule('whiteboard').applyRemote`) — the registry-driven
 *  dispatch the contract requires, replacing the ad-hoc `applyWb` call. Manages the
 *  per-board map (lazy create, ref-stable no-op) exactly as `applyWhiteboardMsg` did,
 *  so behaviour is identical. Pure. */
function foldWhiteboardViaModule(
  state: ViewerState,
  boardId: string,
  msg: Parameters<ReturnType<typeof overlayModule<'whiteboard'>>['applyRemote']>[1],
): ViewerState {
  const wb = overlayModule('whiteboard');
  const prevBoard = state.boards[boardId] ?? emptyBoard();
  const nextBoard = wb.applyRemote(prevBoard, msg);
  if (nextBoard === prevBoard && state.boards[boardId]) return state; // no-op fold
  return { ...state, boards: { ...state.boards, [boardId]: nextBoard } };
}
