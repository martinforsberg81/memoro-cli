/**
 * Whose red a session gate's red is, before it is called the change's.
 *
 * A session's gate runs beside the runner's sessions and the merger. When their
 * load rises during the run, tests hit the 1 s per-test limit or cascade out of
 * a starved `before` hook, and the gate is red for the machine, not the change.
 * And a test that is red on main is red in every branch's gate. On 2026-11-07
 * text/shared-content-pipeline's affected gate went red with about 126
 * timeouts when the load rose from 6 to 40 mid-run. Its whole selection
 * then stayed red in 12 files the branch did not touch, and they failed the
 * same way on main in the same minute. Neither was the change's, and the
 * session had no way to say so but by hand.
 *
 * So a red that is only failed files (no crash, no cut, no unknown exit) is
 * settled in two steps, the way the merger's round settles its own
 * (`repo-gate.js`: red alone, `mainRedGoesOn`):
 *
 *  1. **Alone.** The red files run once more, by themselves, one file at a time,
 *     with the same flags and the same per-test limit. A file that passes there
 *     was red for the load. A test over its limit alone is still red: the 1 s
 *     rule is kept, only the contention is taken away.
 *  2. **On main.** A file still red, and not touched by the change, runs alone at
 *     the frozen base in a temporary worktree. When every test it failed on the
 *     candidate also fails there by name, the red is main's.
 *
 * What is left is the change's red. Nothing here makes an unattributed failure,
 * a crash, a cut file or a touched file green.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { runTool } from './child-async.js';
import { workRoot } from './paths.js';
import { attachRepoDepsAsync } from './shared-deps.js';
import { redFiles, redTests, tapTotals } from './tap-red.js';

/** More red files than this is not load or main's red worth a second run: it stays red. */
export const SETTLE_FILES_MAX = 60;

const gitAsync = (cwd, args, signal) => runTool('git', args, { cwd, signal, timeoutMs: 120_000 });

/** The paths the change touches against `base`: tracked edits in the worktree and untracked files. */
async function touchedPaths({ cwd, base, git }) {
  const diff = await git(cwd, ['diff', '--name-only', base]);
  const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard']);
  if (diff?.status !== 0 || untracked?.status !== 0) return null;
  const lines = (text) => String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  return new Set([...lines(diff.stdout), ...lines(untracked.stdout)]);
}

/**
 * Red test names by red file, from one finished run's TAP: every file with a
 * failing or cancelled entry (`redFiles`), with the names of its red tests.
 * Null when a red test or a failure count is not accounted for by a file.
 */
function redByFile(tap, files, cwd) {
  const byFile = new Map(redFiles(tap, files).map((file) => [file, []]));
  for (const test of redTests(tap, files, { cwd })) {
    if (!test.file || !byFile.has(test.file)) return null;
    byFile.get(test.file).push(test.name);
  }
  const totals = tapTotals(tap);
  if (((totals.fail || 0) > 0 || (totals.cancelled || 0) > 0) && !byFile.size) return null;
  return byFile;
}

/**
 * Settles a red run's failed files. `red` is the files the run saw fail and
 * `failing` their red tests (`redTests`). Returns `{ alone, main, red, base, notes }`:
 * the files green alone, the files red on main, the files still red, and lines
 * that say what was done. `red` holds every file when nothing could be settled.
 */
export async function settleRed({
  cwd, base, red, failing, flags = [], classes = {}, env = process.env, signal = null,
  tests, times = undefined, git = (dir, args) => gitAsync(dir, args, signal),
  attach = attachRepoDepsAsync, root = workRoot(env), id = `${Date.now()}-${process.pid}`,
}) {
  const unsettled = (note) => ({ alone: [], main: [], red: [...red], base: null, notes: note ? [note] : [] });
  if (!red.length) return unsettled(null);
  if (failing.some((test) => !test.file || !red.includes(test.file))) return unsettled('a red test outside the failed files: not settled');
  if (red.length > SETTLE_FILES_MAX) return unsettled(`${red.length} red files, more than ${SETTLE_FILES_MAX}: not settled`);
  const notes = [];

  // 1. Alone on the candidate, one file at a time.
  const again = await tests({ cwd, files: red, flags, classes, env, signal, lanes: 1, times });
  if (signal?.aborted) return unsettled('interrupted while running the red files alone');
  const totals = tapTotals(again.tap);
  if (again.error || again.timedOut || again.aborted || !totals.finished) return unsettled('the run of the red files alone did not finish: not settled');
  const aloneRed = redByFile(again.tap, red, cwd);
  if (!aloneRed) return unsettled('a red test alone outside the red files: not settled');
  const alone = red.filter((file) => !aloneRed.has(file));
  let still = red.filter((file) => aloneRed.has(file));
  if (alone.length) notes.push(`green alone — red in the round under load, passed run by themselves: ${alone.join(', ')}`);
  if (!still.length || !base) return { alone, main: [], red: still, base: null, notes };

  // 2. Still red and untouched by the change: alone at the frozen base.
  const touched = await touchedPaths({ cwd, base, git });
  if (!touched) return { alone, main: [], red: still, base: null, notes: [...notes, 'could not read what the change touches: the rest stays red'] };
  const untouched = still.filter((file) => !touched.has(file));
  if (!untouched.length) return { alone, main: [], red: still, base: null, notes };
  const dir = join(root, 'runner', 'gate-base', id);
  try {
    mkdirSync(join(root, 'runner', 'gate-base'), { recursive: true });
    const added = await git(cwd, ['worktree', 'add', '--detach', dir, base]);
    if (added?.status !== 0) return { alone, main: [], red: still, base: null, notes: [...notes, `could not check out ${base.slice(0, 7)}: the rest stays red`] };
    await attach(dir);
    const present = untouched.filter((file) => existsSync(join(dir, file)));
    if (!present.length) return { alone, main: [], red: still, base, notes };
    const atBase = await tests({ cwd: dir, files: present, flags, classes, env, signal, lanes: 1 });
    if (signal?.aborted) return { alone, main: [], red: still, base, notes: [...notes, 'interrupted at the base'] };
    if (atBase.error || atBase.timedOut || atBase.aborted || !tapTotals(atBase.tap).finished) {
      return { alone, main: [], red: still, base, notes: [...notes, `the run at ${base.slice(0, 7)} did not finish: the rest stays red`] };
    }
    const baseRed = redByFile(atBase.tap, present, dir) || new Map();
    // Main's only when the candidate's red tests have names and each one is red at the base too.
    const main = present.filter((file) => {
      const here = aloneRed.get(file);
      const there = new Set(baseRed.get(file) || []);
      return here.length > 0 && here.every((name) => there.has(name));
    });
    still = still.filter((file) => !main.includes(file));
    if (main.length) notes.push(`red on main too — the same tests red alone at ${base.slice(0, 7)}, files this change does not touch: ${main.join(', ')}`);
    return { alone, main, red: still, base, notes };
  } finally {
    await git(cwd, ['worktree', 'remove', '--force', dir]).catch(() => null);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
    await git(cwd, ['worktree', 'prune']).catch(() => null);
  }
}
