/**
 * Existing exact-base main-health evidence, plus historical attribution helpers.
 * PR rounds use readMainRed only: no reproduction or history walk. Identical
 * landings and completed full runs write coverage through recordMainRed. The older
 * probeMainRed algorithm remains an explicit diagnostic helper and its prior
 * selector-misses.jsonl records remain readable; runGate never calls it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
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
    // One quiet run on the base is not enough to blame the change: #891 (a
    // role text) and #872 (docs only) were red under load and green unchanged.
    // The round runs the same files alone on the candidate next (repo-gate.js).
    say('the red files pass on the base — running them alone on the candidate');
    return probe;
  }
  probe.red_on_main = onBase.red;
  say(`${onBase.red.length} of the red file${onBase.red.length === 1 ? ' is' : 's are'} red on the base too — looking for the landing that broke ${onBase.red.length === 1 ? 'it' : 'them'}`);

  const history = String((await git(['rev-list', '--first-parent', `--max-count=${limit + 1}`, baseCommit], { cwd }))?.stdout || '')
    .split('\n').map((line) => line.trim()).filter(Boolean);
  let still = onBase.red;
  const flaky = [];
  for (let index = 1; index < history.length && still.length; index += 1) {
    const commit = history[index];
    const newer = history[index - 1];
    // A file that did not exist yet was added red by the landing after this
    // one. That landing's own tests would have run it; it is recorded all the
    // same, because it is still the landing that turned main red.
    const present = [];
    for (const file of still) if (await exists(git, cwd, commit, file)) present.push(file);
    const absent = still.filter((file) => !present.includes(file));
    const run = present.length ? await redAt({ git, tests, cwd, commit, files: present, flags }) : { ok: true, red: [] };
    if (!run.ok) {
      say(`the walk stopped at ${commit.slice(0, 7)}: ${run.reason}`);
      break;
    }
    const passed = [...absent, ...present.filter((file) => !run.red.includes(file))];
    for (const file of passed) {
      const found = await landing({ git, cwd, commit: newer, file });
      if (docsOnly(found.paths)) {
        found.kind = await remeasure({ git, tests, cwd, newer, commit, file, flags, present: present.includes(file) });
        if (found.kind === 'flaky') flaky.push(file);
      }
      probe.breaks.push(found);
    }
    still = still.filter((file) => !passed.includes(file));
  }
  probe.unresolved = [...still, ...flaky];

  const rounds = readRounds({ root }).rounds;
  for (const found of probe.breaks) {
    if (!found.kind) Object.assign(found, classify(found, rounds));
    const where = found.pr ? `#${found.pr}` : found.commit.slice(0, 7);
    say(found.kind === 'flaky'
      ? `${found.file} passes before ${where} — ${KIND_PHRASE[found.kind]}`
      : `${found.file} broke in ${where} — ${KIND_PHRASE[found.kind]}`);
    if (found.kind !== 'flaky') recordSelectorMiss({ repo, ...found, found_by: foundBy }, { root });
  }
  if (still.length) say(`${still.length} file${still.length === 1 ? ' has' : 's have'} been red on main for more than ${limit} landings — the nightly dates ${still.length === 1 ? 'it' : 'them'}`);
  return probe;
}

const KIND_PHRASE = {
  'not-selected': 'its round did not select it: a selector miss',
  selected: 'its round ran it green, and it landed red anyway',
  'no-selection': 'its round kept no selection to check against',
  'no-round': 'mc never gated that landing',
  'docs-only-landing': 'it changed only docs/ and landed without the suite — a test reads what it changed',
  flaky: 'red and green at the same commits — not this landing\'s',
};

/**
 * A landing that changed only `docs/` is measured again before it is named.
 *
 * Both ways have happened. 2026-10-06, `mc merge memoro 12720`: the walk named
 * #12727 — six files under `docs/project/staff/` — for a wall-clock budget test
 * that was red under load at both commits and green alone; the walk had found
 * where a flaky test happened to pass. 2026-10-10: the walk reached #13310, an
 * archive that deleted files a test reads, and ruling it out by path left the
 * round's reds unexplained — a docs-only landing runs no suite, so nothing
 * stopped it. One more run at each commit tells the two apart: red at the
 * landing and green at its parent both times is the landing's; anything else
 * is the test's, and blames nobody.
 */
async function remeasure({ git, tests, cwd, newer, commit, file, flags, present }) {
  const atLanding = await redAt({ git, tests, cwd, commit: newer, files: [file], flags });
  if (!atLanding.ok || !atLanding.red.includes(file)) return 'flaky';
  if (!present) return 'docs-only-landing';
  const atParent = await redAt({ git, tests, cwd, commit, files: [file], flags });
  return atParent.ok && !atParent.red.includes(file) ? 'docs-only-landing' : 'flaky';
}

/**
 * Whether a landing changed nothing outside `docs/` — the landings the walk
 * measures again (`remeasure`). An empty list is a landing whose paths could
 * not be read, and is not called docs-only.
 */
export function docsOnly(paths) {
  return Array.isArray(paths) && paths.length > 0 && paths.every((path) => path.startsWith('docs/'));
}

/** Check out one commit and run `files` there; which of them came back red. */
export async function redAt({ git, tests, cwd, commit, files, flags }) {
  const moved = await git(['checkout', '--detach', '--force', commit], { cwd });
  if (moved?.status !== 0) return { ok: false, reason: `could not check out ${commit.slice(0, 7)}` };
  const run = await tests({ cwd, files, flags });
  // A run that never summarised is not evidence either way, here as in the
  // round: red would blame a landing for a crash, green would clear one.
  if (!tapTotals(run.tap).finished) return { ok: false, reason: `the run at ${commit.slice(0, 7)} never reached its summary` };
  return { ok: true, red: redFiles(run.tap, files) };
}

async function exists(git, cwd, commit, file) {
  return (await git(['cat-file', '-e', `${commit}:${file}`], { cwd }))?.status === 0;
}

/**
 * The landing a commit is: its subject, the pull request a squash names, and
 * the paths it changed — so a landing that could not have broken the file is
 * not blamed for it.
 */
async function landing({ git, cwd, commit, file }) {
  const subject = String((await git(['log', '-1', '--format=%s', commit], { cwd }))?.stdout || '').trim();
  const number = /\(#(\d+)\)\s*$/u.exec(subject);
  const changed = await git(['diff-tree', '--no-commit-id', '--name-only', '-r', commit], { cwd });
  const paths = changed?.status === 0
    ? String(changed.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean)
    : [];
  return { file, commit, pr: number ? Number(number[1]) : null, subject: subject.slice(0, 200), paths };
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

const MISS_KINDS = new Set(['not-selected', 'docs-only-landing']);

/**
 * What the repository page says: the misses of the last two weeks, newest
 * first. `not-selected` and `docs-only-landing` are misses — a test the change
 * reached and no round ran; the other kinds are landings that turned main red
 * for a reason the selector is not answerable for.
 */

export function selectorMissReading(repoPath, { root = mcHome(), now = Date.now(), days = 14 } = {}) {
  const repo = basename(String(repoPath || ''));
  const since = now - days * 24 * 60 * 60 * 1000;
  const recent = readSelectorMisses({ root })
    .filter((line) => line.repo === repo && MISS_KINDS.has(line.kind) && Date.parse(line.at) >= since)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { days, misses: recent.length, recent: recent.slice(0, 5) };
}

// The landing chain and completed full runs write exact-commit coverage.
// PR rounds only read it; they never reproduce or bisect main.
const mainRedDir = (root, repo) => join(root, 'main-red', basename(repo).replace(/\.git$/u, ''));
const mainRedPath = (root, repo, commit) => join(mainRedDir(root, repo), `${commit}.json`);

function mainRecord(root, repo, commit) {
  if (!commit || basename(commit) !== commit) return null;
  try {
    const path = mainRedPath(root, repo, commit);
    const modern = existsSync(path);
    const record = JSON.parse(readFileSync(modern ? path : `${mainRedDir(root, repo)}.json`, 'utf8'));
    const strings = value => Array.isArray(value) && value.every(file => typeof file === 'string');
    if (record.commit !== commit || !strings(record.files) || !Array.isArray(record.tests)
      || !record.tests.every(test => test && typeof test.file === 'string' && typeof test.name === 'string'
        && (test.error === undefined || strings(test.error))
        && (test.diagnostic === undefined || typeof test.diagnostic === 'string'))) return null;
    // Legacy evidence knows its red only, never which other files ran green.
    if (!modern) return { ...record, covered: record.files, from: 'full', inherited_from: null, at: null, legacy: true };
    if (!strings(record.covered) || !['landing', 'full'].includes(record.from)
      || !Number.isFinite(Date.parse(record.at))
      || !(record.inherited_from === null || typeof record.inherited_from === 'string')
      || !record.files.every(file => record.covered.includes(file))
      || !record.tests.every(test => record.files.includes(test.file))) return null;
    return record;
  } catch { return null; }
}

export function recordMainRed({ root = mcHome(), repo, commit, result, covered = result?.covered || [],
  from = 'full', baseCommit = null, at = new Date().toISOString() }) {
  if (!commit || basename(commit) !== commit || (from !== 'landing' && !result?.totals?.finished)) return false;
  try {
    const measured = new Set(covered);
    const base = from === 'landing' ? mainRecord(root, repo, baseCommit) : null;
    const tests = [...(base?.tests || []).filter(test => !measured.has(test.file)), ...(result?.red_tests || [])];
    const files = [...new Set([...(base?.files || []).filter(file => !measured.has(file)),
      ...(result?.red_files || []), ...tests.map(test => test.file).filter(Boolean)])];
    const record = { commit, covered: [...new Set([...(base?.covered || []), ...covered, ...files])], files, tests,
      from, inherited_from: base ? baseCommit : null, at };
    const dir = mainRedDir(root, repo);
    mkdirSync(dir, { recursive: true });
    writeJsonAtomic(mainRedPath(root, repo, commit), record, { mode: 0o600 });
    const records = readdirSync(dir).filter(file => file.endsWith('.json')).map(file => {
      try { return { file, at: Date.parse(JSON.parse(readFileSync(join(dir, file), 'utf8')).at) || 0 }; }
      catch { return { file, at: 0 }; }
    }).sort((a, b) => b.at - a.at || b.file.localeCompare(a.file));
    for (const old of records.slice(200)) unlinkSync(join(dir, old.file));
    return true;
  } catch { return false; }
}

/** Called only after the landed tree has been proved identical. */
export function recordLandingMainRed({ root = mcHome(), repo, commit, baseCommit, verdict, at }) {
  const tests = [...(verdict.candidate?.red_tests || []), ...(verdict.main_red?.tests || [])];
  return recordMainRed({ root, repo, commit, baseCommit, from: 'landing', at,
    covered: [...new Set([...(verdict.selection?.selected || []), ...(verdict.candidate?.covered || []),
      ...(verdict.reused?.covered || [])])],
    result: { red_tests: tests, red_files: [...new Set([...(verdict.candidate?.red_files || []), ...tests.map(test => test.file)])] },
  });
}

export function readMainRed({ root = mcHome(), repo, baseCommit, files }) {
  const evidence = mainRecord(root, repo, baseCommit);
  const states = Object.fromEntries(files.map(file => [file, !evidence?.covered.includes(file)
    ? { state: 'not_covered' } : evidence.files.includes(file)
      ? { state: 'covered_red', tests: evidence.tests.filter(test => test.file === file) }
      : { state: 'covered_green' }]));
  const red = files.filter(file => states[file].state === 'covered_red');
  const green = files.filter(file => states[file].state === 'covered_green');
  const unknown = files.filter(file => states[file].state === 'not_covered');
  return { base: baseCommit, states, red_on_main: red, green_on_main: green, not_covered: unknown,
    tests: (evidence?.tests || []).filter(test => red.includes(test.file)), breaks: [], cached: Boolean(evidence),
    from: evidence?.from ?? null, inherited_from: evidence?.inherited_from ?? null, at: evidence?.at ?? null,
    ...(unknown.length ? { stopped: 'no exact main evidence for not_covered files; no main replay in PR rounds' } : {}),
  };
}
