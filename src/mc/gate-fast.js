/**
 * What `mc gate` reads off the worktree before it runs anything: what the
 * branch changes against a merge-base, and the `node --test` flags the
 * primary checkout declares.
 *
 * The fast paths that lived here — nothing changed, docs only, unchanged
 * since a green, an incremental run after a red — were answers about the
 * whole gate, and a worktree runs no whole gate any more (2026-10-24,
 * `commands/gate.js`). The merger's round has its own versions of each.
 */
import { dirname } from 'node:path';

import { docsOnly } from './docs-merge.js';

export { docsOnly };

/**
 * What this worktree changes against a merge-base: tracked paths that differ
 * from it (committed, staged or not, renames as both sides) and untracked
 * files. Null when git cannot say.
 */
export function changedAgainst(io, root, mergeBase) {
  const diff = nulList(io.git(root, ['diff', '--name-only', '--no-renames', '-z', mergeBase]));
  const untracked = nulList(io.git(root, ['ls-files', '--others', '--exclude-standard', '-z']));
  if (!diff || !untracked) return null;
  return [...new Set([...diff, ...untracked])].sort();
}

/**
 * The primary checkout of the worktree at `root` and its gate declaration, or null when either cannot be read.
 */
export function primaryCheckoutDeclaration(io, { root, env }) {
  const common = io.git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common) return null;
  const primary = dirname(common);
  let declared = null;
  try { declared = io.declaration(primary, { env }); } catch { return null; }
  return declared?.ok && declared.declaration ? { primary, declaration: declared.declaration } : null;
}

/**
 * The `node --test` flags the primary checkout declares (`pr_tests_flags`), or null when it declares none — then the `test` script's own flags stand.
 */
export function declaredTestFlags(io, { root, env }) {
  const flags = primaryCheckoutDeclaration(io, { root, env })?.declaration?.pr_tests_flags;
  return Array.isArray(flags) && flags.length ? [...flags] : null;
}

function nulList(text) {
  return text == null ? null : String(text).split('\0').filter(Boolean);
}
