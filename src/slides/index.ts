// SLIDES — a reusable presentation asset (ordered materials), shared once by web
// + mobile. Pure model + pure reducers only (no zustand, no DOM, no storage); a
// platform store supplies its own id generator + persistence and delegates each
// mutation to the collection-level reducers in `ops.ts`, exactly like `scheduling`.
export * from './types';
export * from './ops';
