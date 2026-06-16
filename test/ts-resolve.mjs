// Tiny ESM resolution hook for the `node --experimental-strip-types` test runner.
//
// A few @paxpia/core modules (overlays/consume.ts) import VALUES from sibling .ts
// files WITHOUT an extension — correct for the Bundler module resolution the package
// ships under (Metro/Vite + `tsc` verify it), but Node's ESM loader needs the explicit
// extension. We can't add `.ts` to the source imports (tsc rejects them unless
// `allowImportingTsExtensions` is on, which conflicts with the declaration emit), so
// this hook supplies the extension at RESOLUTION time for the TESTS only — production
// bundling is unaffected. Registered via:
//     node --import ./test/ts-resolve.mjs --experimental-strip-types <test>

import { register } from 'node:module';

register('./ts-resolve-hooks.mjs', import.meta.url);
