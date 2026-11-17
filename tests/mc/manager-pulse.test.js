import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CURATION_CADENCE_MS, curationDue, curationPrompt, curationState, curationStatePath, proposalBacklog, readCurationState, setUpCurationWorktrees,
  settleCurationWorktrees,
} from '../../src/mc/manager-pulse.js';

/**
 * The manager's automatic curation turn, model-free (docs/technical/mc-run.md, "Manager turns"): what is due, what
 * the state file means, the prompt and the worktrees. The runner's own seam tests live in run.test.js.
 */

const HOME = '/p';
const ROOT = '/w';

/** An in-memory store: `files` by path; `list` of a directory is its entry names. */
function store(files = {}) {
  const read = (path) => files[path] ?? null;
  const list = (dir) => [...new Set(Object.keys(files).filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1).split('/')[0]))];
  return { files, read, list, write: (path, text) => { files[path] = text; }, writeJson: (path, value) => { files[path] = JSON.stringify(value); }, lock: (root, fn) => fn() };
}
test('curation turn: the first one is due at once, and git is read only once the 24 hours have passed', () => {
  const now = new Date('2026-11-15T12:00:00Z');
  const repos = () => [{ name: 'memoro' }, { name: 'memoro-cli' }];
  let reads = 0;
  const heads = () => { reads += 1; return { memoro: 'a1', 'memoro-cli': 'b1' }; };
  const first = curationDue({ state: { status: 'none' }, now, repos, heads });
  assert.deepEqual([first.due, first.moved], [true, ['memoro', 'memoro-cli']]);
  assert.equal(reads, 0, 'the first turn needs no heads');

  const state = (started, bases) => ({ status: 'valid', state: curationState({ started, bases }) });
  const recent = curationDue({ state: state('2026-11-14T12:00:01Z', { memoro: 'old' }), now, repos, heads });
  assert.deepEqual([recent.due, recent.reason, recent.notice], [false, 'one started in the last 24 hours', null]);
  assert.equal(reads, 0, 'a tick inside the cadence costs no git');
  assert.equal(CURATION_CADENCE_MS, 86_400_000);

  const moved = curationDue({ state: state('2026-11-14T12:00:00Z', { memoro: 'a1', 'memoro-cli': 'old' }), now, repos, heads });
  assert.deepEqual([moved.due, moved.moved], [true, ['memoro-cli']]);
  const still = curationDue({ state: state('2026-11-10T00:00:00Z', { memoro: 'a1', 'memoro-cli': 'b1' }), now, repos, heads });
  assert.deepEqual([still.due, still.reason], [false, 'no area repository has moved since the last curation']);
  assert.equal(curationDue({ state: { status: 'none' }, now, repos: () => [], heads }).reason, 'no repository declares areas');
  // A repository whose head cannot be read has not moved.
  assert.equal(curationDue({ state: state('2026-11-10T00:00:00Z', { memoro: 'a1' }), now, repos: () => [{ name: 'memoro' }], heads: () => ({}) }).due, false);
});

test('curation turn: an unreadable state starts no turn and says so; a state file is read as the schema says', () => {
  const now = new Date('2026-11-15T12:00:00Z');
  const s = store();
  assert.deepEqual(readCurationState({ root: ROOT, read: s.read }), { status: 'none' });
  for (const text of ['{ x', '[]', JSON.stringify({ schema: 'mc-manager-turn', version: 1, kind: 'horizon', started: null, bases: {} }),
    JSON.stringify({ schema: 'mc-manager-turn', version: 1, kind: 'curation', started: 'tomorrow', bases: {} }),
    JSON.stringify({ schema: 'mc-manager-turn', version: 1, kind: 'curation', started: null, bases: { memoro: 1 } })]) {
    const bad = store({ [curationStatePath(ROOT)]: text });
    const found = readCurationState({ root: ROOT, read: bad.read });
    assert.equal(found.status, 'unreadable', text);
    const answer = curationDue({ state: found, now, repos: () => [{ name: 'memoro' }], heads: () => ({ memoro: 'x' }) });
    assert.deepEqual([answer.due, answer.reason], [false, 'its state is unreadable'], text);
    assert.match(answer.notice, /runner\/manager-turn\/curation\.json is unreadable \(/u);
  }
  const good = store({ [curationStatePath(ROOT)]: JSON.stringify(curationState({ started: '2026-11-14T00:00:00Z', bases: { memoro: 'a1' } })) });
  assert.equal(readCurationState({ root: ROOT, read: good.read }).status, 'valid');
});

test('curation turn: the prompt lists every area\'s proposals, oldest first, and says what the turn may and may not write', () => {
  const A = '/w/areas';
  const s = store({
    [`${A}/memoro/trust/proposals/b.md`]: '#', [`${A}/memoro/trust/proposals/.hidden.md`]: '#', [`${A}/memoro-cli/system/proposals/a.md`]: '#',
    [`${A}/memoro-cli/system/proposals/archive/old.md`]: '#', [`${A}/memoro/delivery/proposals/c.md`]: '#',
    // The old places are not read: the ownerless root and a programme's own proposals/.
    '/w/proposals/root.md': '#', [`${HOME}/one/proposals/programme.md`]: '#',
  });
  const ages = { [`${A}/memoro/trust/proposals/b.md`]: 300, [`${A}/memoro-cli/system/proposals/a.md`]: 100, [`${A}/memoro/delivery/proposals/c.md`]: 200 };
  const backlog = proposalBacklog({ areas: A, list: s.list, modified: (path) => ages[path] ?? null });
  assert.deepEqual(backlog.map((entry) => [entry.area, entry.path]), [
    ['memoro-cli/system', `${A}/memoro-cli/system/proposals/a.md`], ['memoro/delivery', `${A}/memoro/delivery/proposals/c.md`], ['memoro/trust', `${A}/memoro/trust/proposals/b.md`],
  ]);
  const prompt = curationPrompt({ paths: { memoro: '/w/wt/memoro' }, branches: { memoro: 'manager/curation-x' }, pages: [{ repo: 'memoro', id: 'capture', path: '/w/wt/memoro/docs/technical/areas/capture.md' }], backlog, moved: ['memoro'] });
  assert.ok(prompt.includes(`Proposals in the areas, oldest first — bring what waits on Martin to the desk with \`mc martin propose\`:\n- memoro-cli/system: ${A}/memoro-cli/system/proposals/a.md\n- memoro/delivery: ${A}/memoro/delivery/proposals/c.md\n- memoro/trust: ${A}/memoro/trust/proposals/b.md`), prompt);
  for (const text of ['manager/curation-x', 'Main has moved since the last curation in: memoro', 'a turn that finds nothing to change is a success', 'do not make a horizon or a goal']) assert.ok(prompt.includes(text), text);
  // D7: each changed repository is published with the form that queues it for the merger, whose docs form lands it;
  // `--no-merge` would open a pull request nothing ever queues.
  assert.ok(prompt.includes('Publish each worktree you changed with plain `mc publish` (never `--no-merge`): it opens the pull request and queues it for the merger'), prompt);
  assert.doesNotMatch(prompt, /with `mc publish --no-merge`/u);
});

/** A fake git: `answers` maps `<cwd> <args…>` prefixes to a result; everything else succeeds with no output. */
function fakeGit(answers = {}) {
  const calls = [];
  const git = (cwd, args) => {
    calls.push([cwd, ...args].join(' '));
    const key = Object.keys(answers).find((prefix) => [cwd, ...args].join(' ').startsWith(prefix));
    return key ? answers[key] : { ok: true, stdout: '', stderr: '' };
  };
  return { git, calls };
}

test('curation turn: a worktree holding nothing or a published branch is removed, an unpublished or dirty one is kept', () => {
  const repos = [{ name: 'a', path: '/r/a' }, { name: 'b', path: '/r/b' }, { name: 'c', path: '/r/c' }, { name: 'd', path: '/r/d' }];
  const paths = { a: '/wt/a', b: '/wt/b', c: '/wt/c', d: '/wt/d' };
  const branches = Object.fromEntries(repos.map((repo) => [repo.name, 'manager/curation-x']));
  const { git, calls } = fakeGit({
    '/wt/a rev-list': { ok: true, stdout: '0\n', stderr: '' },
    '/wt/b rev-list': { ok: true, stdout: '2\n', stderr: '' },
    '/wt/c status --porcelain': { ok: true, stdout: '?? notes\n', stderr: '' },
    '/wt/c rev-list': { ok: true, stdout: '0\n', stderr: '' },
    '/wt/d rev-list': { ok: true, stdout: '1\n', stderr: '' },
    '/wt/d rev-parse': { ok: false, stdout: '', stderr: '' },
  });
  const settled = settleCurationWorktrees({ git, repos, paths, branches });
  // b has commits and origin/<branch> exists and holds HEAD: published. d has commits and no remote branch: kept.
  assert.deepEqual(settled.removed, ['a', 'b']);
  assert.deepEqual(settled.kept.map((entry) => [entry.repo, entry.why]), [['c', 'it holds uncommitted work'], ['d', 'its branch manager/curation-x is not published']]);
  assert.ok(calls.includes('/r/a worktree remove /wt/a'));
  assert.ok(calls.includes('/r/a branch -D manager/curation-x'));
  assert.equal(calls.some((call) => call.startsWith('/r/c worktree remove') || call.startsWith('/r/d worktree remove')), false);

  const made = setUpCurationWorktrees({ git: fakeGit({ '/r/a rev-parse': { ok: true, stdout: 'abc\n', stderr: '' } }).git, root: ROOT, stamp: 'x', repos: [repos[0]] });
  assert.deepEqual([made.ok, made.paths, made.branches, made.heads], [true, { a: `${ROOT}/runner/work/manager-curation/x/a` }, { a: 'manager/curation-x' }, { a: 'abc' }]);
});
