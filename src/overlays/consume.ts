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
import { decodeWbMsg, type WbMsg } from './whiteboard';
import { GIFT_WIRE_VERSION } from './kinds/gift';
import type { GiftDeltaMsg, GiftToast } from './module';
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
  /** A whiteboard stroke/erase/wipe/snapshot delta (retires the private live.data plane). */
  | { kind: 'overlay.wb'; msg: WbMsg }
  /** One gift toast to append to the append-only gift feed (`overlay.gift`). */
  | { kind: 'overlay.gift'; msg: GiftDeltaMsg }
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

/** Max bytes of ONE gift envelope we accept — a fire-and-forget toast is tiny, so an
 *  oversized payload is rejected at decode time (returns null) rather than parsed. 2 KiB. */
const GIFT_MAX_BYTES = 2 * 1024;

/** Serialize a gift delta to the bytes published on the `overlay` topic (the read-side
 *  pair of `decodeGiftMsg`). Mirrors the module's private encoder; surfaced here so a
 *  PRODUCER (the viewer's send-gift action / a demo) can put a toast on the wire without
 *  reaching into the kind module. Stamps the wire version when the caller omitted it. */
export function encodeGiftMsg(msg: GiftDeltaMsg): Uint8Array {
  const withV = { ...msg, v: msg.v ?? GIFT_WIRE_VERSION };
  const json = JSON.stringify(withV);
  const g = globalThis as unknown as { TextEncoder?: new () => { encode(s: string): Uint8Array } };
  if (g.TextEncoder) return new g.TextEncoder().encode(json);
  const out = new Uint8Array(json.length);
  for (let i = 0; i < json.length; i++) out[i] = json.charCodeAt(i) & 0xff;
  return out;
}

/** Decode bytes into a gift delta, or null when they aren't one (so a foreign packet on
 *  the shared topic is safely ignored, never throws). Mirrors `decodeWbMsg`: UTF-8 JSON,
 *  byte-capped, with the required `toast` fields validated. The encode side lives in the
 *  gift MODULE (`giftModule.applyLocal`); this is the read side the consume ladder owns. */
export function decodeGiftMsg(bytes: Uint8Array): GiftDeltaMsg | null {
  if (bytes.length > GIFT_MAX_BYTES) return null;
  let obj: unknown;
  const g = globalThis as unknown as { TextDecoder?: new () => { decode(b: Uint8Array): string } };
  let json: string;
  if (g.TextDecoder) json = new g.TextDecoder().decode(bytes);
  else {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    json = s;
  }
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as { t?: unknown; v?: unknown; toast?: unknown };
  if (o.t !== 'overlay.gift') return null;
  const to = o.toast as Partial<GiftToast> | undefined;
  if (!to || typeof to !== 'object') return null;
  if (typeof to.id !== 'string' || typeof to.from !== 'string' || typeof to.giftId !== 'string') return null;
  if (typeof to.atUnix !== 'number' || !Number.isFinite(to.atUnix)) return null;
  return {
    t: 'overlay.gift',
    v: typeof o.v === 'number' ? o.v : GIFT_WIRE_VERSION,
    toast: { id: to.id, from: to.from, giftId: to.giftId, atUnix: to.atUnix },
  };
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

  const wb = decodeWbMsg(bytes);
  if (wb) return { kind: 'overlay.wb', msg: wb };

  const gift = decodeGiftMsg(bytes);
  if (gift) return { kind: 'overlay.gift', msg: gift };

  return { kind: 'unsupported', t: peekType(bytes) };
}

/** A human label for an unsupported event, for the platform's "unsupported overlay
 *  event" log/telemetry. Kept here so web + RN word it identically. */
export function unsupportedOverlayLabel(ev: Extract<OverlayChannelEvent, { kind: 'unsupported' }>): string {
  return ev.t ? `unsupported overlay event: ${ev.t}` : 'unrecognized overlay channel payload';
}
