/**
 * Package-shipped canon (Grounding Phase 5 — Universal). Plan §13b.1.
 *
 * The orchestrator role + the coordination protocol are *tool-universal*
 * canon: true for every user in every project, regardless of codebase. They
 * must NOT be stranded in one repo's `.claude`/`docs`. So they ship INSIDE the
 * mc package — a checked-in `canon/` dir included in `package.json` `files` —
 * and travel everywhere mc is installed. A developer who `npm i -g`s mc and
 * runs `mc` in a fresh, empty repo still wakes with the full orchestrator
 * role, because mc shipped the canon, not the repo.
 *
 * This module is the runtime resolver for that bundled copy. Two concerns,
 * both pure / injectable so they test in-process (Pattern 4) and soft-degrade
 * on a broken install (Pattern 2 — never throw):
 *
 *   - `canonRoot({ here })`  — resolve the package `canon/` dir from mc's OWN
 *     install root, NOT from cwd. Derived from this module's location, so it
 *     works global-installed (`npm i -g`), via `npx`, AND from a cloned
 *     checkout. `here` is injectable for tests.
 *   - `readPackageCanon(..)` — read the three canon files off that dir,
 *     per-file soft-degrade (a missing / unreadable file → null), never
 *     throwing. A wholly-absent dir (broken install) → all-null.
 *
 * SOURCE-OF-TRUTH NOTE: the `canon/` files are a CHECKED-IN COPY of their
 * authoring homes (`docs/coding-agent-protocol.md`,
 * `.claude/skills/agent-coordination.md`, `.claude/commands/be-coordinator.md`).
 * A copy is the simplest no-build shipping mechanism, but can drift; the
 * divergence is guarded by `tests/mc/canon-drift.test.js`, which fails if the
 * copy and its source stop being byte-identical. (Considered: symlink — fragile
 * across npm pack on some platforms; a generate-on-build step — adds a build
 * the package otherwise doesn't need. The checked-in copy + drift test keeps
 * install trivial and the divergence self-watching.)
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Logical canon asset → its packaged filename under `canon/`. Single source
 * of truth, shared by the resolver, the role builder, and the drift test, so
 * the three never disagree about which files constitute the canon.
 */
export const CANON_MANIFEST = {
  protocol: 'coding-agent-protocol.md',
  coordination: 'agent-coordination.md',
  beCoordinator: 'be-coordinator.md',
};

/**
 * Resolve the package `canon/` directory from mc's own install root. PURE.
 *
 * This module lives at `<root>/src/mc/canon.js`, so the package root is two
 * levels up from its dir and `canon/` sits beside `src/`. Resolving from the
 * module's own location (not `process.cwd()`) is what makes the canon
 * resolvable wherever mc runs — a global install, an `npx` cache, or a cloned
 * checkout — even when the session's cwd is an unrelated, empty repo.
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

/**
 * Read the three packaged canon files. PURE-ish (I/O only through injected
 * impls) and soft-degrading: any file that is missing or unreadable resolves
 * to `null` rather than throwing, and a wholly-absent canon dir (broken
 * install) yields `{ protocol: null, coordination: null, beCoordinator: null }`.
 * NEVER throws — grounding must not block the launch on a broken install.
 *
 * @param {object} [arg]
 * @param {string}   [arg.root]         — canon dir (defaults to canonRoot()).
 * @param {Function} [arg.readFileImpl] — (absPath) => string; injected.
 * @param {Function} [arg.exists]       — (absPath) => boolean; injected.
 * @returns {{ protocol: string|null, coordination: string|null, beCoordinator: string|null }}
 */
export function readPackageCanon({
  root = safeRoot(),
  readFileImpl = (p) => readFileSync(p, 'utf8'),
  exists = existsSync,
} = {}) {
  const out = { protocol: null, coordination: null, beCoordinator: null };
  if (!root) return out;
  for (const [key, filename] of Object.entries(CANON_MANIFEST)) {
    out[key] = readOne(join(root, filename), { readFileImpl, exists });
  }
  return out;
}

function readOne(abs, { readFileImpl, exists }) {
  try {
    if (!exists(abs)) return null;
    const text = readFileImpl(abs);
    return typeof text === 'string' && text.trim().length ? text : null;
  } catch {
    return null;
  }
}

function safeRoot() {
  try {
    return canonRoot();
  } catch {
    return null;
  }
}
