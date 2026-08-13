// @paxpia/core/ads — the advertising domain.
//
// Types + pure rules for the whole ads platform: the four-level object model, the
// objective→goal→billing matrix, the feed weave, frequency capping, the targeting
// eligibility predicate (including the strict under-18 rule), ETB/VAT money, and the
// CTA destination gate (./link — the only thing that decides a URL may be handed to the
// viewer's operating system).
//
// Consumed by Paxpia-mobile (delivery + Boost), Paxpia-web (Ads Manager) and mirrored
// by the Go ads service. Nothing here touches transport, storage or UI — the platforms
// own those, this owns the RULES, exactly like ./overlays owns fold rules but not
// transport.
//
// Full path also reachable via `@paxpia/core/ads`.

export * from './types';
export * from './matrix';
export * from './weave';
export * from './frequencyCap';
export * from './targeting';
export * from './money';
export * from './contrast';
export * from './estimate';
export * from './boost';
export * from './link';
