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
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) {
      const withTs = `${specifier}.ts`;
      const resolved = await nextResolve(withTs, context);
      if (existsSync(fileURLToPath(resolved.url))) return resolved;
    }
    throw err;
  }
}
