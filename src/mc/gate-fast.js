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
import { repositoryDir } from './repos.js';

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
 * The gate declaration of the worktree at `root`, as the tree being measured
 * states it: the repository is named by its primary checkout (`primary`, the
 * common directory's repository — a bare `memoro.git` is `memoro`), and the
 * `.mc/test.json` read is the worktree's own (`contentDir: root`), never the
 * common directory's, which a bare repository does not have.
 *
 * Null when git cannot say or nothing is declared — the `test` script's
 * flags stand then. `{ stop }` when the worktree's declaration is present and
 * malformed, or a layer drops or loosens its timeout ambiguously: the gate
 * refuses before anything is spawned. Otherwise `{ primary, contentDir,
 * declaration, notice }`, `notice` the timeout-inheritance line to print.
 */
export function measuredDeclaration(io, { root, env }) {
  const common = io.git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common) return null;
  const primary = repositoryDir(common);
  let declared = null;
  try { declared = io.declaration(primary, { env, contentDir: root }); } catch { return null; }
  if (declared && !declared.ok && declared.kind) return { stop: declared.reason };
  return declared?.ok && declared.declaration
    ? { primary, contentDir: root, declaration: declared.declaration, notice: declared.notice ?? null } : null;
}

/** Kept for its callers: `measuredDeclaration` without the stop. */
export function primaryCheckoutDeclaration(io, options) {
  const measured = measuredDeclaration(io, options);
  return measured?.declaration ? measured : null;
}

/**
 * The `node --test` flags the measured worktree declares (`pr_tests_flags`), or null when it declares none — then the `test` script's own flags stand.
 */
export function declaredTestFlags(io, { root, env }) {
  return flagsOf(primaryCheckoutDeclaration(io, { root, env })?.declaration);
}

/** A declaration's nonempty `pr_tests_flags`, copied, or null. */
export function flagsOf(declaration) {
  const flags = declaration?.pr_tests_flags;
  return Array.isArray(flags) && flags.length ? [...flags] : null;
}

function nulList(text) {
  return text == null ? null : String(text).split('\0').filter(Boolean);
}
