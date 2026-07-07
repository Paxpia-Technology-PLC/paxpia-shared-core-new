// SCHEDULING — the SCHEDULE-as-TIMELINE model (ordered timeline of materials +
// inline overlays, per-class scene assignment, live-run done-flags) + its pure
// reducers, shared once by web + mobile. Graduated out of `Paxpia-web/src/store/
// studio.ts` (which now keeps only its zustand persistence wrapper over these
// pure functions); the mobile `TeachingSession` fork retires onto THIS model.
//
// Pure model + pure reducers only — no zustand, no DOM, no storage. A store of any
// flavor supplies its own id generator and persistence and delegates each
// mutation to the collection-level reducers in `ops.ts`.
export * from './types';
export * from './ops';
export * from './preview';
export * from './eligibility';
