// Generalized streaming model — shared by the web producer dashboard, the web
// consumer player, and the mobile app, so a stream described once renders the
// same everywhere.

export type StreamVisibility = 'public' | 'unlisted' | 'private';
/** Start simple: a standard stream or a class; a class may be free or paid. */
export type StreamKind = 'standard' | 'class';
export type Monetization = 'free' | 'paid';

export interface StreamMeta {
  id: string;
  roomName: string;
  title: string;
  creatorId: string;
  kind: StreamKind;
  visibility: StreamVisibility;
  monetization: Monetization;
  /** For scheduled classes (queue manager / calendar). */
  scheduledStartUnix?: number;
  startedAtUnix?: number;
}

// ── Consumer composition ─────────────────────────────────────────────────────
// Source aspect of the PUBLISHED video. Mobile streams are portrait; many test
// channels are TV (16:9). The consumer surface fits these without cropping.
export type SourceAspect = '16:9' | '9:16' | '4:3' | '1:1';

/** How the consumer surface composes video + overlay zone:
 *   tv-top       — video shrunk so its WIDTH matches the surface width, pinned
 *                  TOP (no crop); overlay zone fills the rest BELOW. The default
 *                  for TV-aspect sources on a phone.
 *   video-bottom — flipped: overlay zone on TOP, video BELOW.
 *   fill         — full-bleed video (portrait sources); overlays float on top. */
export type CompositionMode = 'tv-top' | 'video-bottom' | 'fill';

export interface ConsumerLayout {
  composition: CompositionMode;
  sourceAspect: SourceAspect;
}

/** Pick a sensible default composition for a source aspect on a portrait phone:
 *  portrait sources fill; non-portrait sources letterbox to the top with an
 *  overlay zone below (the requested representative layout). */
export function defaultComposition(aspect: SourceAspect): CompositionMode {
  return aspect === '9:16' ? 'fill' : 'tv-top';
}

/** Aspect ratio as width/height (e.g. 16:9 -> 1.777). */
export function aspectRatio(aspect: SourceAspect): number {
  switch (aspect) {
    case '16:9': return 16 / 9;
    case '9:16': return 9 / 16;
    case '4:3': return 4 / 3;
    case '1:1': return 1;
  }
}

/** Compute the video box (in px) for `tv-top`/`video-bottom`: video spans full
 *  surface width, height derived from aspect; the remainder is the overlay zone.
 *  Returns boxes in a top-left origin px space for both planes. */
export function composeTvLayout(
  surface: { width: number; height: number },
  aspect: SourceAspect,
  composition: CompositionMode,
): { video: Box; overlay: Box } {
  const videoH = Math.min(surface.height, Math.round(surface.width / aspectRatio(aspect)));
  const overlayH = Math.max(0, surface.height - videoH);
  if (composition === 'video-bottom') {
    return {
      overlay: { x: 0, y: 0, width: surface.width, height: overlayH },
      video: { x: 0, y: overlayH, width: surface.width, height: videoH },
    };
  }
  // tv-top (and fallback)
  return {
    video: { x: 0, y: 0, width: surface.width, height: videoH },
    overlay: { x: 0, y: videoH, width: surface.width, height: overlayH },
  };
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ── Dashboard: scenes + inputs (web producer, Zoom/Meet-style) ───────────────
export type InputKind = 'webcam' | 'screen' | 'mobile-wall' | 'media';

export interface SceneInput {
  id: string;
  kind: InputKind;
  /** Selected device (web getUserMedia / getDisplayMedia). */
  deviceId?: string;
  label?: string;
  /** Normalized placement in 0..1 scene space (top-left origin). */
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

export interface Scene {
  id: string;
  name: string;
  inputs: SceneInput[];
  /** Where poll/overlay widgets sit in the published frame (0..1 space). */
  overlaySlot?: { x: number; y: number; w: number; h: number };
}
