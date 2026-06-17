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
import type { ViewerState } from './viewer';
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

  // ── derive the view-model + paint list ─────────────────────────────────────
  const view = useMemo(() => deriveVoteView(vote, onVote), [vote, onVote]);
  const renderOverlays = useMemo(() => visibleOverlays(vs.rendered), [vs.rendered]);
  const hasSceneSync = vs.rendered.nonce > 0 || vs.rendered.overlays.length > 0;

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
