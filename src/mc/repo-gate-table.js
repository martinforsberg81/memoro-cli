/**
 * What each repository needs before its suite means anything.
 *
 * A gate worktree is a fresh checkout with no `node_modules` in it. For some
 * repositories that is fine and the suite runs; for others the suite cannot run
 * at all, or — far worse — runs a *subset* and reports a summary anyway. Two
 * such runs, one per side, produce two small red sets that match, and the gate
 * calls that green.
 *
 * The unfinished-run guard catches the first case and not the second, which is
 * why this file exists. It is a table of declarations, not a heuristic:
 *
 * The obvious heuristic — "it has dependencies, so install them" — is wrong in
 * both directions here. This very repository has three dependencies, one of
 * them native, and its suite runs perfectly from a clean worktree; treating
 * dependencies as proof of need would add an install to every round for no
 * reason. And a repository can need a build step that has nothing to do with
 * `npm install` at all. Neither can be read off a manifest.
 *
 * So the rule is: what a repository needs is written down, or the round stops.
 * Never guessed, never attempted in hope. A guess that works nine times and
 * quietly produces a green from an incomplete suite on the tenth is worse than
 * a stop, because the stop is visible and the green is not.
 *
 * The one thing that can be *proved* rather than declared is that no
 * preparation is needed: a repository with nothing to install has nothing that
 * could be missing. That carve-out is narrow on purpose.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { mcHome, workRoot } from './paths.js';

/**
 * The declarations mc ships with.
 *
 * Data, not logic. Each entry says three things: what has to happen before the
 * suite can be believed, which gates beyond the suite the repository requires,
 * and where its merges are written down. `prepare: null` is a claim — that the
 * suite runs from a clean worktree — and `prepare_why` is the evidence for it,
 * because an unexplained null is indistinguishable from a forgotten one.
 */
export const SHIPPED = Object.freeze({
  'memoro-cli': Object.freeze({
    prepare: null,
    prepare_why: 'the suite is node:test over source only; verified across every gate round '
      + 'since the verb existed, each of which ran it twice in a worktree with no node_modules',
    extra_gates: Object.freeze([]),
    merge_log: Object.freeze({ under: 'work-root', path: 'large-scale-llm-project/merge-log.md' }),
  }),
  memoro: Object.freeze({
    prepare: 'npm ci',
    prepare_why: 'declared by the PM; not yet exercised by a gate round here',
    extra_gates: Object.freeze([
      Object.freeze({ name: 'msr contract', command: 'npm run test:msr:contract' }),
    ]),
    // Open question with the PM: which log memoro's merges belong in. Until it
    // is answered the round writes no line and says so, rather than inventing
    // a file somewhere.
    merge_log: null,
  }),
});

/** Where an operator can add or override a declaration without a release. */
export function tablePath(root = mcHome()) {
  return join(root, 'repo-gates.json');
}

/**
 * The declaration for a repository, or the reason there is none.
 *
 * `ok: false` is a stop, and the round has to treat it as one. The caller is
 * not offered a default to fall back on, because a default is the guess this
 * whole file exists to refuse.
 */
export function declarationFor(repoPath, { root = mcHome(), env = process.env } = {}) {
  const name = basenameOf(repoPath);
  const table = { ...SHIPPED, ...readOverrides(root) };
  const declared = table[name];

  if (declared) {
    return { ok: true, name, declaration: normalise(declared, env), source: 'declared' };
  }

  // No entry. The only thing that lets a round proceed anyway is proof that
  // preparation could not have been needed.
  const nothing = nothingToInstall(repoPath);
  if (nothing.proven) {
    return {
      ok: true,
      name,
      source: 'nothing-to-install',
      declaration: normalise({ prepare: null, prepare_why: nothing.why, extra_gates: [], merge_log: null }, env),
    };
  }

  return {
    ok: false,
    name,
    reason: `${name} has no gate declaration, and ${nothing.why} — so mc cannot tell whether its suite `
      + `needs anything installed first. Declare it in ${tablePath(root)}: `
      + '{"' + name + '": {"prepare": "npm ci", "extra_gates": [], "merge_log": null}} '
      + '— or "prepare": null with a "prepare_why" if the suite runs from a clean checkout.',
  };
}

/**
 * Can it be proved that nothing needs installing?
 *
 * Only one shape proves it: a manifest that asks for nothing. Anything else —
 * dependencies present, no manifest at all, a manifest that will not parse — is
 * unproven, and unproven is not the same as fine.
 */
function nothingToInstall(repoPath) {
  const manifest = join(repoPath, 'package.json');
  if (!existsSync(manifest)) {
    return { proven: false, why: 'it has no package.json for mc to reason about' };
  }
  let parsed = null;
  try { parsed = JSON.parse(readFileSync(manifest, 'utf8')); } catch {
    return { proven: false, why: 'its package.json could not be read' };
  }
  const wanted = [
    ...Object.keys(parsed?.dependencies || {}),
    ...Object.keys(parsed?.devDependencies || {}),
  ];
  if (wanted.length) {
    return { proven: false, why: `it declares ${wanted.length} dependenc${wanted.length === 1 ? 'y' : 'ies'}` };
  }
  return { proven: true, why: 'its package.json declares no dependencies at all, so nothing can be missing' };
}

/** A declaration with every field present, and the log path resolved. */
function normalise(entry, env) {
  return {
    prepare: entry.prepare ?? null,
    prepare_why: entry.prepare_why ?? null,
    extra_gates: (entry.extra_gates || []).map((gate) => ({
      name: gate.name || gate.command,
      command: gate.command,
    })),
    merge_log: resolveLog(entry.merge_log, env),
  };
}

/**
 * Where the merge log lives, if anywhere.
 *
 * Written relative to the work root rather than absolutely, so a declaration
 * shipped in the source does not carry one machine's home directory in it.
 */
function resolveLog(log, env) {
  if (!log) return null;
  if (typeof log === 'string') return log;
  if (log.under === 'work-root') return join(workRoot(env), log.path);
  return log.path || null;
}

function readOverrides(root) {
  try { return JSON.parse(readFileSync(tablePath(root), 'utf8')) || {}; } catch { return {}; }
}

function basenameOf(path) {
  return String(path).replace(/\/+$/u, '').split('/').pop();
}
