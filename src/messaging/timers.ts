// Core's lib is ES2020 only (no DOM), so `setTimeout`/`setInterval` + their clears
// aren't in the type surface — but both the browser AND React Native expose them on
// `globalThis`. Read them off a typed view (the same pattern `studio/sync.ts` +
// `overlays/svgClock.ts` use). An opaque handle keeps the platform's real return
// type (number vs Timeout) neutral. Shared by the messaging socket + the messaging/
// search hooks so the timer access lives once.

export type TimerHandle = unknown;

export const timers = globalThis as unknown as {
  setTimeout: (cb: () => void, ms: number) => TimerHandle;
  clearTimeout: (h: TimerHandle) => void;
  setInterval: (cb: () => void, ms: number) => TimerHandle;
  clearInterval: (h: TimerHandle) => void;
};
