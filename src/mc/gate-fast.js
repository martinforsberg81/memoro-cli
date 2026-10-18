/**
 * `mc gate`'s fast paths — the answers it can give without running the whole
 * gate again, each from something it measured or can read for certain.
 *
 *  - **Nothing changed.** The diff from `git merge-base HEAD <base>` to the
 *    worktree — committed, staged, unstaged and untracked — is empty.
 *  - **Docs only.** Every path in that diff is under `docs/` and none is a
 *    script, the rule `mc merge --docs` lands by (`docs-merge.js`): there is
 *    no test for it to run. Nothing is recorded — nothing was measured.
 *  - **Unchanged since a green.** The last whole gate here (`mc-gate-last.json`
 *    beside the lock) measured this exact tree green against the same
 *    merge-base. The tree is `git write-tree` of the worktree as it stands,
 *    untracked files included, through a temporary index.
 *  - **Incremental.** The last whole gate was red and named its red test
 *    files: run those, plus what the primary checkout's declared `select`
 *    picks for the paths changed since that tree (`--changed-path`, once per
 *    path), plus the command gates it names. It is never the whole gate, says
 *    so, and is never recorded as a green for the merger (ruling 44).
 *
 * Any doubt — another base, no declaration, a selector that fails, a red with
 * no red files, a red command gate the selection does not name — and the
 * whole gate runs as it always did. `mc gate --full` always runs it.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { DOCS_PREFIX, docsOnly } from './docs-merge.js';
import { namedCommand, redFiles } from './gate-local.js';
import { mcHome } from './paths.js';
import { selectionStateDir } from './repo-gate.js';

export { docsOnly };

/** The last whole gate's measurement, beside the lock in the git directory. */
export const LAST_FILE = 'mc-gate-last.json';

/**
 * The tree the worktree stands at, untracked files included: the index copied
 * to a temporary file (so only what changed is hashed again), `git add -A`
 * into it, `git write-tree`. Null when any step fails. The worktree's own
 * index is never touched.
 */
export function snapshotTree(root, gitDir) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-gate-tree-'));
  const index = join(dir, 'index');
  try {
    try { copyFileSync(join(gitDir, 'index'), index); } catch { /* an empty index hashes everything, slower and the same */ }
    const env = { ...process.env, GIT_INDEX_FILE: index };
    const opts = { cwd: root, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 };
    if (spawnSync('git', ['add', '-A'], opts).status !== 0) return null;
    const written = spawnSync('git', ['write-tree'], opts);
    return written.status === 0 ? (written.stdout.trim() || null) : null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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
 * Decides before the gate starts. Returns one of:
 *   { answer: { text, json } }   — said at once, exit 0, no child
 *   { incremental }              — run this narrower command instead
 *   { snapshot }                 — the whole gate; write `mc-gate-last.json` after
 *   {}                           — the whole gate, as before
 */
export function planGate(io, { root, gitDir, base, full = false, env, manifest }) {
  const mergeBase = io.git(root, ['merge-base', 'HEAD', base]);
  if (!mergeBase) return {};
  const short = mergeBase.slice(0, 7);
  if (!full) {
    const changed = changedAgainst(io, root, mergeBase);
    if (changed && !changed.length) {
      return answer(`GREEN — nothing changed against ${base} (merge-base ${short}): no commit, no edit, no new file — nothing to run; mc gate --full runs the whole gate anyway`, { fast: 'unchanged-base', base, merge_base: mergeBase });
    }
    if (changed && docsOnly(changed)) {
      return answer(`GREEN — docs only, nothing to run — 0s\n${changed.length} path${changed.length === 1 ? '' : 's'} changed against ${base}, every one under ${DOCS_PREFIX} and none a script; nothing recorded — mc gate --full runs the whole gate anyway`, { fast: 'docs-only', base, merge_base: mergeBase, paths: changed });
    }
  }
  const tree = io.snapshotTree(root, gitDir);
  if (!tree) return {};
  const snapshot = { tree, base: mergeBase, ref: base };
  if (full) return { snapshot };
  const last = readLast(io, gitDir);
  if (!last?.tree || last.base !== mergeBase || last.ref !== base) return { snapshot };
  if (last.exit === 0) {
    if (last.tree !== tree) return { snapshot };
    return answer(`GREEN (unchanged since ${last.at}) — the whole gate measured this tree green against ${base}; nothing to run — log: ${last.log}`, { fast: 'unchanged-green', base, tree, since: last.at, log: last.log });
  }
  const incremental = incrementalPlan(io, { root, env, base, last, tree, manifest });
  return incremental ? { incremental } : { snapshot };
}

/**
 * The narrower run after a red: the red files, the selection for what changed
 * since the red tree, and the command gates it names. Null on any doubt.
 */
export function incrementalPlan(io, { root, env, base, last, tree, manifest }) {
  if (!Array.isArray(last.red) || !last.red.length) return null;
  const changed = last.tree === tree ? [] : nulList(io.git(root, ['diff', '--name-only', '--no-renames', '-z', last.tree, tree]));
  if (!changed) return null;
  const declared = primaryDeclaration(io, { root, env });
  if (!declared) return null;
  let selection = { files: [], commands: [] };
  if (changed.length) {
    const command = `${declared.select}${changed.map((path) => ` --changed-path ${shellQuote(path)}`).join('')}`;
    let parsed = null;
    try {
      const ran = io.select(command, { cwd: root, env: declared.env });
      parsed = ran?.status === 0 ? JSON.parse(ran.stdout) : null;
    } catch { parsed = null; }
    if (!Array.isArray(parsed?.files)) return null;
    selection = { files: parsed.files.map(String), commands: Array.isArray(parsed.commands) ? parsed.commands : [] };
  }
  const commands = selection.commands.filter((entry) => typeof entry?.packageScript === 'string' && /^[\w:.-]+$/u.test(entry.packageScript));
  const scripts = commands.map((entry) => entry.packageScript);
  // A red command gate is run again only as the selection says to run it.
  if ((last.red_commands || []).some((name) => !scripts.includes(name))) return null;
  const red = last.red.filter((file) => io.exists(join(root, file)));
  const selected = selection.files.filter((file) => !red.includes(file) && io.exists(join(root, file)));
  const files = [...red, ...selected];
  if (!files.length && !commands.length) return null;
  const parts = [];
  if (files.length) parts.push(namedCommand(manifest, files, { flags: declared.flags }).run);
  for (const entry of commands) parts.push(`npm run ${entry.packageScript}${entry.passBaseRef ? ` -- --base-ref ${base}` : ''}`);
  const run = parts.length === 1 ? parts[0] : `(rc=0; ${parts.map((part) => `${part} || rc=1`).join('; ')}; exit $rc)`;
  const shown = [
    files.length ? `node --test ${files.length} file${files.length === 1 ? '' : 's'}` : null,
    ...commands.map((entry) => `npm run ${entry.packageScript}`),
  ].filter(Boolean).join(' + ');
  const label = `INCREMENTAL — ${red.length} red file${red.length === 1 ? '' : 's'} from the gate at ${last.at}`
    + ` + ${selected.length} selected for ${changed.length} path${changed.length === 1 ? '' : 's'} changed since`
    + `${commands.length ? ` + command${commands.length === 1 ? '' : 's'} ${scripts.join(', ')}` : ''}`
    + '; not the whole gate (mc gate --full)';
  return {
    command: { run, script: null, source: 'incremental', files, shown, label },
    red, selected, changed, commands: scripts,
  };
}

/**
 * Written after a whole gate, only while the worktree is still the tree it
 * measured: that tree, the merge-base and ref, the exit code, the red files
 * and the red command gates. A tree that moved while it ran leaves the file
 * as it was.
 */
export function recordLast(io, { lock, lockPath, root, output, code, gates = [] }) {
  const gitDir = dirname(lockPath);
  const snapshot = lock.snapshot;
  if (!snapshot?.tree) return false;
  if (io.snapshotTree(root, gitDir) !== snapshot.tree) return false;
  const entry = {
    tree: snapshot.tree, base: snapshot.base, ref: snapshot.ref, exit: code,
    red: code === 0 ? [] : redFiles(output, { root }), red_commands: code === 0 ? [] : gates,
    at: lock.started, log: lock.log,
  };
  try { io.write(join(gitDir, LAST_FILE), `${JSON.stringify(entry, null, 2)}\n`); return true; } catch { return false; }
}

export function readLast(io, gitDir) {
  const path = join(gitDir, LAST_FILE);
  if (!io.exists(path)) return null;
  try { return JSON.parse(io.read(path, 'utf8')); } catch { return null; }
}

/**
 * The primary checkout's declared `select`, the environment the merger
 * selects with (its selection state, read-only) and the flags its tests take.
 * Null when there is no declaration or no `select`.
 */
function primaryDeclaration(io, { root, env }) {
  const common = io.git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common) return null;
  const primary = dirname(common);
  let declared = null;
  try { declared = io.declaration(primary, { env }); } catch { return null; }
  const select = declared?.ok ? declared.declaration?.select : null;
  if (!select) return null;
  const state = selectionStateDir({ root: mcHome(env), repoPath: primary });
  try { io.mkdir(state); } catch { /* a selector without it selects as before */ }
  const selectEnv = { ...env, MC_SELECTION_STATE: state };
  delete selectEnv.MC_SELECTION_STATE_WRITE;
  const flags = declared.declaration.pr_tests_flags;
  return { select, env: selectEnv, flags: Array.isArray(flags) && flags.length ? flags : null };
}

function answer(text, json) {
  return { answer: { text, json: { ok: true, ...json } } };
}

function nulList(text) {
  return text == null ? null : String(text).split('\0').filter(Boolean);
}

function shellQuote(text) {
  return /^[\w./:=@%+,-]+$/u.test(text) ? text : `'${String(text).replace(/'/gu, `'\\''`)}'`;
}
