// UNIFIED OVERLAY-CHANNEL CONSUMPTION — the SINGLE place a raw LiveKit data-channel
// payload on the `overlay` topic is decoded + classified into a typed event that web
// AND mobile fold identically.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// The `overlay` topic is a MULTIPLEXED bus: the server bot's participation overlays
// (overlay.changed / overlay.results), the streamer's web-broadcast live.sync (doc
// slot + scene + manifest), the full-replace scene.sync, and the additive SVG-overlay
// envelopes (overlay.svg / overlay.svg.delete) ALL ride it. Each platform's channel
// used to re-implement the decode→route ladder (try overlay → try live-sync → try
// scene → try svg). They DRIFTED: the mobile channel never decoded `overlay.svg` at
// all, so SVG overlays the web viewer rendered were SILENTLY DROPPED on mobile.
//
// Consolidating the ladder here means:
//   1. Web + mobile decode the EXACT same bytes into the EXACT same event set —
//      a new overlay-channel kind is wired ONCE and both platforms get it.
//   2. A payload neither platform can classify becomes an explicit
//      `{ kind: 'unsupported' }` event (not a silent null), so a renderer that can't
//      handle an event surfaces a clear signal instead of differing quietly.
//
// PURE + platform-free: it only decodes bytes (the existing @paxpia/core decoders)
// and returns a tagged union. The channel binding (LiveKit Room transport) + the
// rendering stay per-platform.

import {
  decodeOverlayMsg,
  type OverlayResultsMsg,
  type OverlayStateMsg,
  type OverlayResponseMsg,
  type OverlayControlMsg,
} from './wire';
import { decodeSvgOverlayMsg, type SvgOverlayMsg } from './svg';
import { decodeLiveSyncMsg, type LiveSyncMsg } from '../streaming/live';
import { decodeSceneSyncMsg, type SceneSyncMsg } from '../streaming/scene';

/** A decoded, classified overlay-channel event. Every payload on the `overlay` topic
 *  resolves to exactly ONE of these. The `unsupported` arm is the load-bearing
 *  addition: a payload that decodes to a recognizable envelope a CONSUMER doesn't
 *  render (or a payload no decoder claims) is surfaced explicitly so the platform can
 *  log/telemetry it rather than differ from the other platform in silence. */
export type OverlayChannelEvent =
  /** Server-bot participation overlay changed (poll/quiz/vote/doc-as-overlay). */
  | { kind: 'overlay.changed'; msg: OverlayStateMsg }
  /** Server-bot live tallies for the active overlay. */
  | { kind: 'overlay.results'; msg: OverlayResultsMsg }
  /** A viewer's vote (only meaningful to a streamer/aggregator; viewers ignore). */
  | { kind: 'overlay.response'; msg: OverlayResponseMsg }
  /** A streamer control verb (create/activate/close/reveal/next/request_state). */
  | { kind: 'overlay.control'; msg: OverlayControlMsg }
  /** Streamer doc-slot + scene + manifest snapshot. */
  | { kind: 'live.sync'; msg: LiveSyncMsg }
  /** Full-replace rendered-scene snapshot. */
  | { kind: 'scene.sync'; msg: SceneSyncMsg }
  /** SET/REPLACE or DELETE a positioned SVG overlay. */
  | { kind: 'overlay.svg'; msg: SvgOverlayMsg }
  /** The payload was on-topic but no decoder claimed it (an unknown/newer `t`, or a
   *  malformed/oversized envelope a decoder rejected). `t` carries the raw type tag
   *  when one was present, so a consumer can log a precise "unsupported overlay
   *  event: <t>" rather than dropping it indistinguishably. */
  | { kind: 'unsupported'; t?: string };

/** Best-effort: pull the `t` discriminator out of a raw payload for diagnostics on
 *  the `unsupported` path (so the log says WHICH unknown event arrived). Never throws. */
function peekType(bytes: Uint8Array): string | undefined {
  let json: string;
  const g = globalThis as unknown as { TextDecoder?: new () => { decode(b: Uint8Array): string } };
  if (g.TextDecoder) json = new g.TextDecoder().decode(bytes);
  else {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    json = s;
  }
  try {
    const o = JSON.parse(json) as { t?: unknown };
    return typeof o.t === 'string' ? o.t : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decode + classify ONE raw `overlay`-topic payload into an {@link OverlayChannelEvent}.
 * The decode LADDER (overlay envelope → live.sync → scene.sync → svg) is the same one
 * both channels ran ad-hoc; centralizing it guarantees identical routing. A payload no
 * decoder claims returns `{ kind: 'unsupported', t }` — NEVER null — so the caller can
 * always tell "nothing matched" apart from "matched but I don't render it". PURE.
 */
export function decodeOverlayChannelMsg(bytes: Uint8Array): OverlayChannelEvent {
  const overlay = decodeOverlayMsg(bytes);
  if (overlay) {
    switch (overlay.t) {
      case 'overlay.changed':
        return { kind: 'overlay.changed', msg: overlay as OverlayStateMsg };
      case 'overlay.results':
        return { kind: 'overlay.results', msg: overlay as OverlayResultsMsg };
      case 'overlay.response':
        return { kind: 'overlay.response', msg: overlay as OverlayResponseMsg };
      case 'overlay.control':
        return { kind: 'overlay.control', msg: overlay as OverlayControlMsg };
      default:
        return { kind: 'unsupported', t: (overlay as { t?: string }).t };
    }
  }
  const sync = decodeLiveSyncMsg(bytes);
  if (sync && sync.t === 'live.sync') return { kind: 'live.sync', msg: sync as LiveSyncMsg };

  const scene = decodeSceneSyncMsg(bytes);
  if (scene && scene.t === 'scene.sync') return { kind: 'scene.sync', msg: scene as SceneSyncMsg };

  const svg = decodeSvgOverlayMsg(bytes);
  if (svg) return { kind: 'overlay.svg', msg: svg };

  return { kind: 'unsupported', t: peekType(bytes) };
}

/** A human label for an unsupported event, for the platform's "unsupported overlay
 *  event" log/telemetry. Kept here so web + RN word it identically. */
export function unsupportedOverlayLabel(ev: Extract<OverlayChannelEvent, { kind: 'unsupported' }>): string {
  return ev.t ? `unsupported overlay event: ${ev.t}` : 'unrecognized overlay channel payload';
}
