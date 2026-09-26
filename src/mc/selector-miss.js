/**
 * A test that landed red because the selection did not reach it.
 *
 * A merge round runs the test files the repository's selector says a change
 * reaches, and nothing else — which is the whole saving, and also the one way
 * a change can land and turn `main` red: the selector did not name a test the
 * change broke. #12106 did exactly that on 2026-09-25. It touched
 * `public/js/assistant/`, three whole-repository scanners went red, none of
 * them was in its selection, and the next pull request's round (#12107) was
 * the first thing to run them. It went red twice on tests it had nothing to
 * do with, and nothing said so.
 *
 * So when a round goes red, the red files are run once more on the base the
 * candidate was built on. Green there, and the change broke them: that is the
 * round doing its job and nothing more is asked. Red there too, and `main` is
 * red, and a pull request that already landed broke it without its round
 * running the test. The files are walked back along `main`'s first parents,
 * one landing at a time, to the first commit where they pass; the landing
 * after it is the one that broke them, and the round log says whether that
 * landing's selection named the file.
 *
 * ## Not a baseline
 *
 * The 2026-08-31 ruling took "was main already red?" off the round, and this
 * does not put it back: the verdict is decided before any of this runs and
 * nothing here can change it. What it adds is attribution, and only on a red
 * round, and only over the files that were red — seconds on a round that has
 * already failed, against a morning of guessing whose change it was.
 *
 * ## What is kept
 *
 * One line per break in `selector-misses.jsonl` under mc's home — the test
 * file, the landing that broke it, and whether that landing's selection named
 * it. `not-selected` is the selector miss; `selected` is a test that was run
 * and landed red anyway (a flake, or a tree that differed from the measured
 * one); `no-round` is a landing mc never gated. The same break found by a
 * second round is written once.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { mcHome } from './paths.js';
import { readRounds } from './repo-round-log.js';
import { redFiles, tapTotals } from './tap-red.js';

export const SELECTOR_MISS_SCHEMA = 'mc-selector-miss';
export const SELECTOR_MISS_VERSION = 1;

/**
 * How far back along `main` the walk goes before it gives up.
 *
 * Each step is one run of the red files, so this is a bound on cost as much
 * as on history. A test red for more than this many landings has a nightly
 * run that says so with a date, and does not need a round to find it.
 */
export const WALK_LIMIT = 12;

export function selectorMissPath(root = mcHome()) {
  return join(root, 'selector-misses.jsonl');
}

/**
 * Were the red files red on the base too, and if so, which landing broke each.
 *
 * `cwd` is the round's own worktree, already measured: it is moved to older
 * commits here, which is why this runs after the verdict and never before.
 * Everything that touches git or runs a test is the round's own, injected the
 * same way, so a test can answer for both.
 */
export async function probeMainRed({
  git, tests, cwd, baseCommit, files, flags = [], say = () => {}, limit = WALK_LIMIT, root = mcHome(), repo = null, foundBy = [],
}) {
  const probe = { base: baseCommit, red_on_main: [], breaks: [], unresolved: [] };
  if (!baseCommit || !files?.length) return probe;

  const onBase = await redAt({ git, tests, cwd, commit: baseCommit, files, flags });
  if (!onBase.ok) {
    say(`could not tell whether the red is main's: ${onBase.reason}`);
    return { ...probe, stopped: onBase.reason };
  }
  if (!onBase.red.length) {
    say('the red files pass on the base — this change broke them');
    return probe;
  }
  probe.red_on_main = onBase.red;
  say(`${onBase.red.length} of the red file${onBase.red.length === 1 ? ' is' : 's are'} red on the base too — looking for the landing that broke ${onBase.red.length === 1 ? 'it' : 'them'}`);

  const history = String(git(['rev-list', '--first-parent', `--max-count=${limit + 1}`, baseCommit], { cwd })?.stdout || '')
    .split('\n').map((line) => line.trim()).filter(Boolean);
  let still = onBase.red;
  for (let index = 1; index < history.length && still.length; index += 1) {
    const commit = history[index];
    const newer = history[index - 1];
    // A file that did not exist yet was added red by the landing after this
    // one. That landing's own tests would have run it; it is recorded all the
    // same, because it is still the landing that turned main red.
    const present = still.filter((file) => exists(git, cwd, commit, file));
    const absent = still.filter((file) => !present.includes(file));
    const run = present.length ? await redAt({ git, tests, cwd, commit, files: present, flags }) : { ok: true, red: [] };
    if (!run.ok) {
      say(`the walk stopped at ${commit.slice(0, 7)}: ${run.reason}`);
      break;
    }
    const passed = [...absent, ...present.filter((file) => !run.red.includes(file))];
    for (const file of passed) probe.breaks.push(landing({ git, cwd, commit: newer, file }));
    still = still.filter((file) => !passed.includes(file));
  }
  probe.unresolved = still;

  const rounds = readRounds({ root }).rounds;
  for (const found of probe.breaks) {
    Object.assign(found, classify(found, rounds));
    say(`${found.file} broke in ${found.pr ? `#${found.pr}` : found.commit.slice(0, 7)} — ${KIND_PHRASE[found.kind]}`);
    recordSelectorMiss({ repo, ...found, found_by: foundBy }, { root });
  }
  if (still.length) say(`${still.length} file${still.length === 1 ? ' has' : 's have'} been red on main for more than ${limit} landings — the nightly dates ${still.length === 1 ? 'it' : 'them'}`);
  return probe;
}

const KIND_PHRASE = {
  'not-selected': 'its round did not select it: a selector miss',
  selected: 'its round ran it green, and it landed red anyway',
  'no-selection': 'its round kept no selection to check against',
  'no-round': 'mc never gated that landing',
};

/** Check out one commit and run `files` there; which of them came back red. */
async function redAt({ git, tests, cwd, commit, files, flags }) {
  const moved = git(['checkout', '--detach', '--force', commit], { cwd });
  if (moved?.status !== 0) return { ok: false, reason: `could not check out ${commit.slice(0, 7)}` };
  const run = await tests({ cwd, files, flags });
  // A run that never summarised is not evidence either way, here as in the
  // round: red would blame a landing for a crash, green would clear one.
  if (!tapTotals(run.tap).finished) return { ok: false, reason: `the run at ${commit.slice(0, 7)} never reached its summary` };
  return { ok: true, red: redFiles(run.tap, files) };
}

function exists(git, cwd, commit, file) {
  return git(['cat-file', '-e', `${commit}:${file}`], { cwd })?.status === 0;
}

/** The landing a commit is: its subject, and the pull request a squash names. */
function landing({ git, cwd, commit, file }) {
  const subject = String(git(['log', '-1', '--format=%s', commit], { cwd })?.stdout || '').trim();
  const number = /\(#(\d+)\)\s*$/u.exec(subject);
  return { file, commit, pr: number ? Number(number[1]) : null, subject: subject.slice(0, 200) };
}

/**
 * Whether the landing's own round selected the file.
 *
 * Read from the round log: the end line of the round that merged it carries
 * the files its selection named (`selected`, since this module). A round from
 * before that carries none, and that is said rather than guessed.
 */
export function classify({ pr, file }, rounds) {
  if (!pr) return { kind: 'no-round' };
  const round = [...rounds].reverse().find((line) => (line.phase === 'end' || !line.phase)
    && Array.isArray(line.merged) && line.merged.includes(pr));
  if (!round) return { kind: 'no-round' };
  if (!Array.isArray(round.selected)) return { kind: 'no-selection' };
  return { kind: round.selected.includes(file) ? 'selected' : 'not-selected' };
}

/**
 * One line per break, written once.
 *
 * A red main makes every round that selects the test red, so the same break
 * is found again and again until it is fixed; the key is the file and the
 * commit that broke it. A line that cannot be written never fails the round.
 */
export function recordSelectorMiss(entry, { root = mcHome(), now = new Date() } = {}) {
  const repo = basename(String(entry.repo || ''));
  const known = readSelectorMisses({ root }).some((line) => line.repo === repo
    && line.file === entry.file && line.commit === entry.commit);
  if (known) return null;
  const line = {
    schema: SELECTOR_MISS_SCHEMA,
    version: SELECTOR_MISS_VERSION,
    at: now.toISOString(),
    repo,
    file: entry.file,
    commit: entry.commit,
    pr: entry.pr ?? null,
    subject: entry.subject || null,
    kind: entry.kind,
    found_by: entry.found_by ?? null,
  };
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    appendFileSync(selectorMissPath(root), `${JSON.stringify(line)}\n`, { mode: 0o600 });
    return line;
  } catch {
    return null;
  }
}

export function readSelectorMisses({ root = mcHome() } = {}) {
  let raw = '';
  try { raw = readFileSync(selectorMissPath(root), 'utf8'); } catch { return []; }
  const lines = [];
  for (const text of raw.split('\n')) {
    if (!text.trim()) continue;
    try {
      const value = JSON.parse(text);
      if (value?.schema === SELECTOR_MISS_SCHEMA) lines.push(value);
    } catch { /* a torn line is skipped */ }
  }
  return lines;
}

/**
 * What the repository page says: the misses of the last two weeks, newest
 * first. Only `not-selected` is a miss; the other kinds are landings that
 * turned main red for a reason the selector is not answerable for.
 */
export function selectorMissReading(repoPath, { root = mcHome(), now = Date.now(), days = 14 } = {}) {
  const repo = basename(String(repoPath || ''));
  const since = now - days * 24 * 60 * 60 * 1000;
  const recent = readSelectorMisses({ root })
    .filter((line) => line.repo === repo && line.kind === 'not-selected' && Date.parse(line.at) >= since)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { days, misses: recent.length, recent: recent.slice(0, 5) };
}
