/**
 * Where mc's own packaged canon lives on disk.
 *
 * `canon/` ships inside the mc package (`package.json` `files`), so what it
 * holds travels with every install — global, `npx`, or a cloned checkout —
 * and is resolvable even when the session's cwd is an unrelated, empty repo.
 * Today it holds one thing: `canon/roles/`, the verbs' own roles, read by
 * `roles.js`.
 *
 * It also held three flat files — the coding-agent protocol, the coordination
 * skill and the be-coordinator command — with a reader (`readPackageCanon`), a
 * manifest and a drift test guarding them against their authoring copies. The
 * two consumers that made that worth having, `buildRole`'s package-canon
 * awareness and `mc adapter materialise`, were both gone; the reader was left
 * being exercised only by its own tests, one of which had asserted a heading
 * that changed under it in #272 and had been red on main ever since.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Resolve the package `canon/` directory from mc's own install root. PURE.
 *
 * This module lives at `<root>/src/mc/canon.js`, so the package root is two
 * levels up from its dir and `canon/` sits beside `src/`. Resolving from the
 * module's own location (not `process.cwd()`) is what makes the canon
 * resolvable wherever mc runs, even when the session's cwd is an unrelated,
 * empty repo.
 *
 * @param {object} [arg]
 * @param {string} [arg.here] — the directory of this module; injected in
 *   tests. Defaults to the real `dirname(import.meta.url)`.
 * @returns {string} absolute path to the package `canon/` dir
 */
export function canonRoot({ here = dirname(fileURLToPath(import.meta.url)) } = {}) {
  // here = <root>/src/mc  →  <root>/canon
  return join(here, '..', '..', 'canon');
}
