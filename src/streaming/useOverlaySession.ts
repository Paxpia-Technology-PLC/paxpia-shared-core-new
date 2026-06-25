// THE SHARED RENDER-BRAIN (§4) — `useOverlaySession`, the ONE headless,
// platform-agnostic hook every viewer (web `StreamView`, mobile
// `LivestreamViewerScreen`, the studio preview/interactive, the coming
// mobile-creator dashboard) drives. It REPLACES the forked consumption logic:
// web's zustand `overlayState` store + the mobile 445-line `useLivestreamSync`
// hook collapse into THIS, so the slot folds, the optimistic vote, the doc
// takeover, and the scene fold exist ONCE and can never drift.
//
// ── Lifted from `Paxpia-mobile/src/hooks/useLivestreamSync.ts`, with the two
//    platform edges replaced by injected seams ───────────────────────────────
//   • The LiveKit `Room` + the `OverlayChannel` it created → an injected
//     `OverlayTransport` (respond/requestState/publish/onEvent) the platform binds
//     to the room's `overlay` data channel.
//   • The hand-rolled applyLiveSync/applyScene/foldParticipationOverlay state → an
//     injected `OverlaySyncSource` that owns the converged `ViewerState` (today
//     `LwwSyncSource` wrapping the same pure reducers; tomorrow a `CrdtSyncSource`
//     behind the SAME interface — this hook is UNCHANGED when it lands, hard rule
//     #5: it paints from `getState()`/`subscribe` ONLY).
//
// The viewer-LOCAL concerns the converged ViewerState does NOT own — the optimistic
// participation vote + the doc local-takeover overlay — live in `overlaySessionLogic`
// as PURE reducers (unit-testable with no React renderer); this hook is the thin
// `useState`/effect shell wiring them to the two seams.
//
// ── PURE REACT (hard rules #2/#3): no DOM, no RN, no `livekit-client`. ─────────
// The only import beyond `@paxpia/core` siblings is `react` (a PEER dependency the
// consuming app provides). Returns the SAME shape the mobile `useLivestreamSync`
// returned (minus the platform `channel` handle, which the transport now owns).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OverlayChannelEvent } from '../overlays/consume';
import { encodeOverlayMsg } from '../overlays/wire';
import type { OverlayInstance, OverlayViewProps } from '../overlays/types';
import {
  initialDocTakeover,
  isTakenOver,
  takeOverDoc,
  resyncDoc,
  type DocTakeoverState,
} from './docTakeover';
import { visibleOverlays, type RenderedScene, type SceneOverlay } from './scene';
import type { DocPresenterState, LiveManifest } from './live';
import type { DocAnnotationState } from '../overlays/annotation';
import type { ViewerState } from './viewer';
import { boardStrokes } from './viewer';
import type { GiftToast } from '../overlays/module';
import type { WbStroke } from '../overlays/whiteboard';
import { overlayModule } from '../overlays/registry';
import { wbViewPersistKey } from './persist';
import type { OverlaySyncSource } from './syncSource';
import type { OverlayTransport, WireOutbound } from './transport';
import {
  initialVoteState,
  applyVoteChanged,
  applyVoteResults,
  applyOptimisticVote,
  deriveVoteView,
  reconcileDocTakeover,
  sceneIdKey,
  type VoteState,
  type PresentedDoc,
} from './overlaySessionLogic';

// Re-export the pure reducers + their types from the hook module so a consumer can
// import the whole render-brain from one place (the barrel also surfaces them).
export {
  initialVoteState,
  applyVoteChanged,
  applyVoteResults,
  applyOptimisticVote,
  deriveVoteView,
  reconcileDocTakeover,
} from './overlaySessionLogic';
export type { VoteState, PresentedDoc } from './overlaySessionLogic';

/** The render-brain's output — every piece a viewer/studio screen needs, ONCE.
 *  Mirrors the mobile `LivestreamSync` shape (the platform `channel` handle is gone
 *  — the injected transport owns it). */
export interface OverlaySession {
  /** The FULL-REPLACE rendered overlay layer for the current scene (web's
   *  `vs.rendered`) — the authoritative paint source. */
  rendered: RenderedScene;
  /** The VISIBLE rendered entries (instance !== null) — the exact list to paint,
   *  each at `entry.rect` (web parity: `visibleOverlays(rendered)`). */
  renderOverlays: SceneOverlay[];
  /** True once ≥1 scene.sync has folded for this room (else fall back to legacy
   *  two-slot placement against an older streamer). */
  hasSceneSync: boolean;
  /** The document slot the viewer PRESENTS (streamer's, or the held doc while taken
   *  over). Null when no doc is shown. */
  activeDoc: OverlayInstance | null;
  /** The presenter pan/zoom the viewer PRESENTS (streamer's, or held while taken
   *  over). null → fit/no-pan. */
  docPresenter: DocPresenterState | null;
  /** True when the viewer has LOCALLY taken over the doc (out-of-sync banner). */
  docTakenOver: boolean;
  /** Enter local takeover (the viewer panned/zoomed the doc). */
  onDocTakeOver(): void;
  /** Resync: end takeover + snap to the streamer's current doc/page/presenter. */
  onDocResync(): void;
  /** The active participation overlay instance (poll/quiz/vote), or null. */
  activeOverlay: OverlayInstance | null;
  /** The canonical participation view-model (voted/mine/tallies/total/onVote). */
  view: OverlayViewProps;
  /** The room's material manifest (raw url + page count), forwarded to the doc
   *  renderer so a guest renders straight from the broadcast URL. */
  manifest: LiveManifest | null;
  /** True once the first live-sync snapshot has folded for this room (the gate
   *  holds the surface until this flips, so no stale page flashes). */
  firstSyncReceived: boolean;
  /** Read a WHITEBOARD board's converged stroke set by id (the `wbStrokes` a
   *  `whiteboard` overlay renders). The `overlay.wb.*` deltas have been folded into the
   *  source via `applyWhiteboardMsg`; this derives the live stroke list a viewer paints.
   *  Empty until the first stroke/snapshot for that board arrives (then converges). */
  boardStrokes(boardId: string): WbStroke[];
  /** The streamer's synced TRANSFORM (pan/zoom) for a board — the value a FOLLOWING
   *  viewer mirrors. Sourced from the board's keyed VIEW store (folded from the
   *  dedicated `live.sync.wbPresenter` wire), bumped to a fresh object on resync so the
   *  `WhiteboardOverlay` follow-effect re-snaps. Null when the board has no presenter yet
   *  (the board fits). DECOUPLED from `docPresenter` — co-active doc+board don't share a
   *  transform (Contract v2.3 / §8.1.4). */
  wbPresenter(boardId: string): DocPresenterState | null;
  /** True when THIS viewer has LOCALLY taken over the given board (its own pan/zoom).
   *  PER-BOARD (and per-kind: distinct from `docTakenOver`) so co-active doc + whiteboard
   *  — and two boards — never share one takeover flag (Contract §8.1.5 / task 4). */
  wbTakenOver(boardId: string): boolean;
  /** Enter local takeover for a board (the viewer panned/zoomed it). */
  onWbTakeOver(boardId: string): void;
  /** Resync a board: end its takeover + SNAP to the streamer's CURRENT transform from the
   *  converged store (`whiteboardModule.onResync` → the board's persisted `wb:<id>` view),
   *  NEVER a replayed desync backlog (fixes Bug 2 for the whiteboard). The follow-effect
   *  then re-applies the snapped transform. */
  onWbResync(boardId: string): void;
  /** WHITEBOARD-ON-DOC ANNOTATION presence (Message D item 2): the streamer's active
   *  annotation descriptor for the live doc (`on` + active `wbann:…` `boardId` + `mode`),
   *  folded from `live.sync.docAnn`. Null ⇒ no active annotation. The viewer renders the
   *  annotation layer over the doc ONLY when `docAnn.on`, painting
   *  `boardStrokes(docAnn.boardId)` — which SWAPS as the streamer flips the page / switches
   *  the doc (the descriptor's boardId changes), so per-page/per-doc strokes present + swap
   *  with no data loss (the strokes persist in the converged `boards` store). */
  docAnn: DocAnnotationState | null;
  /** The converged GIFT feed's toasts (Contract v2.4 / kinds/gift) — the append-only,
   *  id-deduped, capped ordered list a `GiftOverlayLayer` renders. `overlay.gift` deltas
   *  fold into `vs.gifts` through the gift module; this surfaces the toast list the UI
   *  paints (most recent last). The layer auto-expires its own visible window. */
  gifts: GiftToast[];
}

export interface UseOverlaySessionArgs {
  /** The converged-state seam (LwwSyncSource today; CrdtSyncSource later). */
  source: OverlaySyncSource;
  /** The channel binding (respond/requestState/publish/onEvent). */
  transport: OverlayTransport;
  /** Injectable clock (tests / RN). Defaults to `Date.now`. */
  now?: () => number;
}

/** Subscribe to a `ViewerState` from an `OverlaySyncSource`, re-rendering on every
 *  converged change. Seeds from `getState()` so the first render already paints the
 *  current snapshot (a late mount after replay doesn't miss it). */
function useConvergedState(source: OverlaySyncSource): ViewerState {
  const [state, setState] = useState<ViewerState>(() => source.getState());
  useEffect(() => {
    // Re-seed in case the source converged between the initial getState() and this
    // effect attaching (a replay that landed during mount).
    setState(source.getState());
    return source.subscribe(setState);
  }, [source]);
  return state;
}

export function useOverlaySession(args: UseOverlaySessionArgs): OverlaySession {
  const { source, transport } = args;
  const now = args.now ?? Date.now;

  // The converged streamer truth (doc/scene/manifest/rendered/presenter) — the hook
  // paints from this ONLY (hard rule #5).
  const vs = useConvergedState(source);

  // ── viewer-local participation vote ────────────────────────────────────────
  const activeOverlay = vs.slots.activeOverlay;
  const activeOverlayRef = useRef<OverlayInstance | null>(activeOverlay);
  activeOverlayRef.current = activeOverlay;

  const [vote, setVote] = useState<VoteState>(() => initialVoteState());
  const voteRef = useRef(vote);
  voteRef.current = vote;

  // ── Stream G3: reset the vote ROUND off the CONVERGED active overlay ─────────
  // On the WEB lane there is no server bot, so a RESET (gen-bump) reaches viewers ONLY
  // via the full-replace `scene.sync` (which folds into `vs.slots.activeOverlay` at the
  // new gen — see applySceneSync). That path does NOT emit an `overlay.changed` event, so
  // the explicit `applyVoteChanged` in the transport effect below never fires for a web
  // reset, and the viewer stayed "voted" at the OLD round (its next vote went out at the
  // stale gen → the aggregator dropped it → the dashboard never moved). This effect makes
  // the vote round track the CONVERGED instance: when the active (id, gen) changes, reset
  // the optimistic/committed vote so a reset re-opens participation and a fresh vote is
  // published at the CURRENT gen — the authoritative fix for "votes only show on the
  // viewer UI" after a Reset/scene-change.
  //
  // The `lastVoteRoundRef` is SHARED with the transport effect's `applyVoteChanged`: a
  // BACKEND-lane `overlay.changed` (which carries a targeted `mine`) stamps the round it
  // adopts, so this effect treats that round as already-handled and does NOT clobber the
  // committed `mine` it just adopted. So: the web lane resets here; the backend lane
  // resets-and-adopts-mine in the transport callback — never both for one round.
  const lastVoteRoundRef = useRef<string | null>(null);
  useEffect(() => {
    const roundKey = activeOverlay ? `${activeOverlay.id}#${activeOverlay.gen}` : null;
    if (roundKey === lastVoteRoundRef.current) return; // round already handled (or unchanged)
    lastVoteRoundRef.current = roundKey;
    // A new round (incl. a reset's gen bump, or the slot clearing) the transport callback
    // did NOT already adopt → drop the prior optimistic + committed choice + stale results
    // so the viewer can act again at the current gen.
    setVote(() => initialVoteState());
  }, [activeOverlay]);

  // ── viewer-local doc takeover overlay ──────────────────────────────────────
  const [takeover, setTakeover] = useState<DocTakeoverState>(() => initialDocTakeover());
  const [presented, setPresented] = useState<PresentedDoc>(() => ({
    doc: vs.slots.activeDoc,
    presenter: vs.docPresenter,
  }));
  const takeoverRef = useRef(takeover);
  takeoverRef.current = takeover;
  const presentedRef = useRef(presented);
  presentedRef.current = presented;
  const lastSceneIdRef = useRef<string | null | undefined>(undefined);
  const [firstSyncReceived, setFirstSyncReceived] = useState(false);

  // Re-derive the presented doc whenever the converged streamer truth changes,
  // routing it through the takeover overlay (defer the streamer's doc while the
  // viewer leans in; a scene change is absolute).
  useEffect(() => {
    if (vs.manifest !== null || vs.slots.activeDoc !== null || vs.scene !== null || vs.rendered.nonce > 0) {
      // The first meaningful snapshot has folded → the entry gate may lift.
      setFirstSyncReceived(true);
    }
    const { takeover: nextTakeover, presented: nextPresented } = reconcileDocTakeover(
      takeoverRef.current,
      lastSceneIdRef.current,
      vs,
      presentedRef.current,
    );
    lastSceneIdRef.current = sceneIdKey(vs);
    if (nextTakeover !== takeoverRef.current) setTakeover(nextTakeover);
    if (nextPresented !== presentedRef.current) setPresented(nextPresented);
    // vs identity changes on every converged fold; that's the intended trigger.
  }, [vs]);

  // ── bind the transport to the source + the vote state ──────────────────────
  useEffect(() => {
    const off = transport.onEvent((ev: OverlayChannelEvent) => {
      // Fold scene/doc/overlay-changed into the converged source.
      source.ingest(ev, now());
      // Mirror the participation-specific arms into the viewer-local vote state.
      if (ev.kind === 'overlay.changed') {
        // BACKEND lane: a server-bot `overlay.changed` carries a targeted `mine`. Stamp
        // the round it adopts so the converged-round reset effect (above) treats this
        // round as handled and does NOT wipe the `mine` we adopt here (Stream G3). The
        // WEB lane has no such event → that effect owns the reset there.
        const o = ev.msg.overlay;
        lastVoteRoundRef.current = o ? `${o.id}#${o.gen}` : null;
        setVote((v) => applyVoteChanged(v, activeOverlayRef.current, ev.msg.overlay, ev.msg.mine));
      } else if (ev.kind === 'overlay.results') {
        setVote((v) => applyVoteResults(v, activeOverlayRef.current, ev.msg));
      }
    });
    // Ask the bot to replay the active overlay + my prior vote (the streamer replays
    // the doc slot + scene to us on our join).
    transport.requestState();
    return off;
    // The transport/source pair is stable for a room; a room switch hands fresh ones.
  }, [transport, source, now]);

  // ── vote action (optimistic local feedback + server publish) ───────────────
  const onVote = useCallback(
    (choiceId: string) => {
      const active = activeOverlayRef.current;
      if (!active) return;
      const v = voteRef.current;
      if ((v.optimisticChoice ?? v.myChoice) === choiceId) return; // dup of current choice
      setVote((prev) => applyOptimisticVote(prev, choiceId));
      // The server moves/records the vote; it confirms `mine` back via overlay.changed.
      transport.respond(voteResponseOutbound(active, choiceId));
    },
    [transport],
  );

  // ── doc takeover actions ───────────────────────────────────────────────────
  const onDocTakeOver = useCallback(() => {
    setTakeover((s) => takeOverDoc(s));
  }, []);

  const onDocResync = useCallback(() => {
    setTakeover((s) => resyncDoc(s).state);
    // Snap to the streamer's CURRENT converged doc/presenter (the deferred path
    // withheld it; the source still holds the truth).
    const cur = source.getState();
    setPresented({ doc: cur.slots.activeDoc, presenter: cur.docPresenter });
  }, [source]);

  // ── WHITEBOARD takeover/resync (PER-KIND + per-board; Contract §v2.2 / task 4) ─
  // A board's STROKES are content (always converge in `vs.boards`); only its TRANSFORM
  // (zoom/pan) is view. Takeover is a per-board flag DISTINCT from the doc's (`docTakeover`
  // vs `wbTakeover`), so a co-active doc + whiteboard never share one banner. During
  // takeover the streamer's transform is INGESTED-WITHOUT-APPLY: it folds into the keyed
  // view store (`getState()` stays current) but the `WhiteboardOverlay` follow-effect skips
  // it (the board honours the viewer's own pan/zoom). On resync we SNAP to the board's
  // CURRENT converged transform via `whiteboardModule.onResync` — never a replayed backlog
  // (Bug 2). `wbResyncTick` bumps a per-board nonce so a fresh presenter OBJECT is handed to
  // the follow-effect even when the transform value is unchanged (forcing the re-snap the
  // value-keyed follow-effect would otherwise early-return on).
  const [wbTakenSet, setWbTakenSet] = useState<Record<string, boolean>>({});
  const [wbResyncTick, setWbResyncTick] = useState<Record<string, number>>({});

  const onWbTakeOver = useCallback((boardId: string) => {
    setWbTakenSet((s) => (s[boardId] ? s : { ...s, [boardId]: true }));
  }, []);

  const onWbResync = useCallback((boardId: string) => {
    // End this board's takeover. The presenter the follow-effect reads is recomputed
    // below from the snapped transform; the tick bump forces a fresh object so the
    // value-keyed follow-effect always re-applies it.
    setWbTakenSet((s) => {
      if (!s[boardId]) return s;
      const next = { ...s };
      delete next[boardId];
      return next;
    });
    setWbResyncTick((t) => ({ ...t, [boardId]: (t[boardId] ?? 0) + 1 }));
  }, []);

  const wbModule = useMemo(() => overlayModule('whiteboard'), []);
  const getWbTakenOver = useCallback((boardId: string): boolean => !!wbTakenSet[boardId], [wbTakenSet]);
  const getWbPresenter = useCallback(
    (boardId: string): DocPresenterState | null => {
      // SNAP target = the board's CURRENT converged transform (the `wb:<id>` view the
      // wb-presenter wire folded). `onResync` returns the transform to snap to; we shape it
      // into a `DocPresenterState` the shared `WhiteboardOverlay` follow-effect consumes.
      // A null snap (no presenter yet) → fit. The resync tick is woven into the object
      // identity so a re-snap re-applies even at an unchanged value (defeats the
      // follow-effect's value early-return). `vs`/`wbResyncTick` drive the re-derive.
      const snap = wbModule.onResync(vs, wbViewPersistKey(boardId));
      void wbResyncTick[boardId];
      if (!snap) return null;
      const tf = snap.transform;
      return { page: tf.page ?? 0, zoom: tf.zoom, panX: tf.panX, panY: tf.panY };
    },
    [wbModule, vs, wbResyncTick],
  );

  // ── derive the view-model + paint list ─────────────────────────────────────
  const view = useMemo(() => deriveVoteView(vote, onVote), [vote, onVote]);
  const renderOverlays = useMemo(() => visibleOverlays(vs.rendered), [vs.rendered]);
  const hasSceneSync = vs.rendered.nonce > 0 || vs.rendered.overlays.length > 0;

  // WHITEBOARD: derive a board's live stroke set from the converged `boards` map (folded
  // via applyWhiteboardMsg). Re-created whenever the boards map changes so a re-render is
  // driven by a new stroke folding in; the lookup itself is O(1). The `whiteboard`
  // overlay reads this by its payload.boardId to paint `wbStrokes`.
  const getBoardStrokes = useCallback(
    (boardId: string): WbStroke[] => boardStrokes(vs, boardId).strokes,
    [vs],
  );

  return {
    rendered: vs.rendered,
    renderOverlays,
    hasSceneSync,
    activeDoc: presented.doc,
    docPresenter: presented.presenter,
    docTakenOver: isTakenOver(takeover),
    onDocTakeOver,
    onDocResync,
    activeOverlay,
    view,
    manifest: vs.manifest,
    firstSyncReceived,
    boardStrokes: getBoardStrokes,
    wbPresenter: getWbPresenter,
    wbTakenOver: getWbTakenOver,
    onWbTakeOver,
    onWbResync,
    docAnn: vs.docAnn,
    // The converged gift feed's toasts (folded from `overlay.gift` into `vs.gifts`).
    gifts: vs.gifts.toasts,
  };
}

/** Build the `overlay.response` wire outbound for a vote (the produce-side of a
 *  viewer tap). Kept in core so the encode stays here; the transport only delivers
 *  bytes. */
function voteResponseOutbound(active: OverlayInstance, choice: string): WireOutbound {
  const bytes = encodeOverlayMsg({
    t: 'overlay.response',
    v: 1,
    overlayId: active.id,
    gen: active.gen,
    choice,
  });
  return { bytes, reliable: true };
}
