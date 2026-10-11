/**
 * Derived artifacts, regenerated on the tree that is about to be measured.
 *
 * Some files in a repository are a function of the whole tree rather than of
 * the change: memoro's SQL snapshot under `docs/plans/sql/` is computed from
 * every file under `scripts/` and `src/`, and a test compares the snapshot to
 * a fresh computation. The gate merges the current base into the candidate
 * before it measures, so the moment main gains a file the snapshot in the
 * candidate is wrong — even when the branch regenerated it a minute earlier.
 * The step cannot win that race from its side; five attempts at it in one
 * round proved as much.
 *
 * So the repository declares which commands produce which paths (`derived` in
 * its gate declaration), and whoever builds a merged tree — the gate's
 * candidate, and the branch freshened for its landing — runs them after the
 * merge. A clean tree afterwards means nothing happened. Dirt inside the
 * declared paths is committed, because it is exactly what the declaration said
 * the commands produce. Dirt anywhere else is named and stops the round: a
 * generator writing outside what it declared is not something to commit in
 * silence.
 */
import { runShell } from './child-async.js';

export const DERIVED_COMMIT_MESSAGE = 'Regenerate derived artifacts after merging the base';

/**
 * Run the declared commands in `cwd` and commit what they changed, if it is
 * all inside the declared paths.
 *
 * Returns `{ ok, regenerated, commit }` — `commit` null when the tree stayed
 * clean — or `{ ok: false, kind, reason, outside }`, where `kind` is `failed`
 * for a command that did not run and `outside` for dirt the declaration does
 * not cover.
 */
export async function regenerateDerived({ derived, cwd, env = process.env, git, shell = runShell, say = () => {} }) {
  const entries = Array.isArray(derived) ? derived : [];
  if (!entries.length) return { ok: true, regenerated: [], commit: null };
  for (const entry of entries) {
    say(`regenerating derived artifacts: ${entry.command}`);
    const ran = await shell(entry.command, { cwd, env });
    if (ran.status !== 0) {
      return { ok: false, kind: 'failed', reason: `${entry.command} failed — ${trim(ran.stderr) || trim(ran.stdout) || `exit ${ran.status}`}`, outside: [] };
    }
  }

  const status = await git(['status', '--porcelain', '--untracked-files=all'], { cwd });
  if (status.status !== 0) {
    return { ok: false, kind: 'failed', reason: `could not read the tree after regenerating — ${trim(status.stderr)}`, outside: [] };
  }
  const dirty = dirtyPaths(status.stdout);
  if (!dirty.length) return { ok: true, regenerated: [], commit: null };

  const allowed = entries.flatMap((entry) => entry.paths || []).map((path) => String(path).replace(/\/+$/u, ''));
  const covered = (file) => allowed.some((path) => file === path || file.startsWith(`${path}/`));
  const outside = dirty.filter((file) => !covered(file));
  if (outside.length) {
    return {
      ok: false,
      kind: 'outside',
      outside,
      reason: `regenerating derived artifacts changed ${outside.length} file${outside.length === 1 ? '' : 's'} outside the declared paths `
        + `(${allowed.join(', ') || 'none declared'}): ${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ` and ${outside.length - 5} more` : ''}`,
    };
  }

  const added = await git(['add', '-A', '--', ...allowed], { cwd });
  if (added.status !== 0) return { ok: false, kind: 'failed', reason: `git add failed — ${trim(added.stderr)}`, outside: [] };
  const committed = await git(['commit', '--no-verify', '-m', DERIVED_COMMIT_MESSAGE], { cwd });
  if (committed.status !== 0) {
    return { ok: false, kind: 'failed', reason: `could not commit the regenerated artifacts — ${trim(committed.stderr) || trim(committed.stdout)}`, outside: [] };
  }
  const commit = trim((await git(['rev-parse', 'HEAD'], { cwd })).stdout) || null;
  return { ok: true, regenerated: dirty, commit };
}

/** The paths `git status --porcelain` names, the destination for a rename. */
export function dirtyPaths(porcelain) {
  return String(porcelain ?? '')
    .split('\n')
    .filter((line) => line.length > 3)
    .map((line) => {
      const path = line.slice(3);
      const arrow = path.indexOf(' -> ');
      return (arrow === -1 ? path : path.slice(arrow + 4)).replace(/^"(.*)"$/u, '$1');
    });
}

function trim(value) {
  return String(value ?? '').trim();
}
