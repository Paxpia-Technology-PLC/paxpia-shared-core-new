# @paxpia/shared-core

The single source of truth for Paxpia's **domain model** — shared verbatim by
`Paxpia-web` and (later) `Paxpia-mobile`, and mirrored by the Go backend. Pure
TypeScript: **types + logic only, no platform UI**, so it imports cleanly under
both Vite (web) and Metro (React Native). Rendering is per-platform; the model
lives here, once, so the clients can't drift.

## Modules

### `accounts/` — who you are + what you may do
Three **orthogonal** dimensions:
- `tier`: `free | premium` — the account's own paid level.
- `grants`: `educator | moderator | admin` — explicitly-approved roles.
  `educator` is **manually approved** and is the gate for the course/dashboard
  surface (independent of `tier`).
- `badge`: `none | verified | educator` — the profile blue-check.

`capabilities.ts` resolves every gated action in **one place** (`can(account,
capability)`): baseline streaming + free overlays (games/gifts) for everyone;
education overlays (poll/quiz/doc/whiteboard), the dashboard, and private/paid
classes for **educators only**.

`subscriptions.ts` — `follow` vs **`super`** (paid, 30-day). Super-followers get
priority feed placement + enriched profile + access to private/paid classes.

### `streaming/` — one stream, rendered the same everywhere
Visibility × kind × monetization; `ConsumerLayout`/`composeTvLayout` letterbox a
TV-aspect source to the surface **width** at the **top** with an overlay zone
**below** (no crop); `Scene`/`SceneInput` model the web producer (webcam +
screen, Zoom/Meet-style).

### `overlays/` — the lifecycle-aware overlay framework
`OverlayInstance` (svg/poll/vote-button/quiz/doc/gift) with a `gen` generation
for resets and **per-user state that persists across logout/login** (you stay
"voted" within a round). `lifecycle.ts` has the cycling controller so each test
stream rotates overlay kind + flips its video/overlay arrangement on an interval.

## Consuming it
Web (Vite) and mobile (Metro) import the TS **source** directly (no build step):
`main`/`types` point at `src/index.ts`. Add a path alias (`@paxpia/core`) in each
consumer. Run `npm run typecheck` here to validate the model in isolation.
