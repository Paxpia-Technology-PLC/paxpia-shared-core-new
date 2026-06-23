// ESM loader `resolve` hook: append `.ts` to extensionless RELATIVE specifiers so the
// node test runner can load @paxpia/core modules whose sibling VALUE imports omit the
// extension (Bundler module resolution). Falls back to the default resolver, then
// retries with `.ts` appended on ERR_MODULE_NOT_FOUND. Test-only — see ts-resolve.mjs.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    // A RELATIVE extensionless specifier that didn't resolve: try `.ts` (a sibling
    // file), then `/index.ts` (a barrel directory import like `../layout`). Some
    // runtime modules import a package subdir by its barrel — handle both forms so a
    // test can import real runtime code, not only type-only-cross-import leaves.
    const relativeExtensionless = /^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier);
    if (!relativeExtensionless) throw err;
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      const resolved = await nextResolve(`${specifier}.ts`, context);
      if (existsSync(fileURLToPath(resolved.url))) return resolved;
    }
    if (err?.code === 'ERR_UNSUPPORTED_DIR_IMPORT') {
      const resolved = await nextResolve(`${specifier.replace(/\/$/, '')}/index.ts`, context);
      if (existsSync(fileURLToPath(resolved.url))) return resolved;
    }
    throw err;
  }
}
