import assert from 'node:assert/strict';
import { test } from 'node:test';
import { itemDirectory } from '../../src/mc/desk-items.js';
import {
  CURATION_CADENCE_MS, archivedFor, curationDue, curationPrompt, curationState, curationStatePath, horizonDue, horizonOutcome, horizonPrompt,
  horizonStatePath, managerReference, proposalBacklog, readCurationState, readHorizonState, recordHorizonFailure, setUpCurationWorktrees,
  setUpHorizonCheckouts, settleCurationWorktrees,
} from '../../src/mc/manager-pulse.js';

/**
 * The manager's two automatic turns, model-free (docs/technical/mc-run.md, "Manager turns"): what is due, what the
 * state files mean, what a horizon turn must leave, and what the second failure opens. The runner's own seam tests
 * live in run.test.js.
 */

const HOME = '/p';
const ROOT = '/w';
const ENV = { MC_WORK_ROOT: ROOT };
const record = (extra = {}) => JSON.stringify({ schema: 'mc-programme', version: 1, horizon: null, end: 'Done when it holds.', state: 'open', created: '2026-11-14T10:20:30Z', created_by: 'person', ...extra });
const horizons = (...entries) => entries.map(([slug, state = 'open']) => ({ slug, state }));

/** An in-memory store: `files` by path; `list` of a directory is its entry names. */
function store(files = {}) {
  const read = (path) => files[path] ?? null;
  const list = (dir) => [...new Set(Object.keys(files).filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1).split('/')[0]))];
  return { files, read, list, write: (path, text) => { files[path] = text; }, writeJson: (path, value) => { files[path] = JSON.stringify(value); }, lock: (root, fn) => fn() };
}
const due = (s, options = {}) => horizonDue({ root: ROOT, home: HOME, list: s.list, read: s.read, horizons: horizons(['alpha'], ['beta']), items: [], ...options });
const fail = (s, at, reason = 'the session ended with nothing (x)', slug = 'alpha') => recordHorizonFailure({ root: ROOT, slug, reason, log: `/l/${at}.jsonl`, at, read: s.read, write: s.write, writeJson: s.writeJson, lock: s.lock, env: ENV, itemDirectory });
const stateOf = (s, slug = 'alpha') => JSON.parse(s.files[horizonStatePath(ROOT, slug)]);

test('manager turn: the first open horizon, in position order, with no open record naming it is due', () => {
  const answer = due(store());
  assert.deepEqual([answer.slug, answer.reason, answer.notices], ['alpha', null, []]);
  // A valid open record naming the first passes the turn to the next; a record naming no horizon names none.
  const named = store({ [`${HOME}/one/PROGRAMME.json`]: record({ horizon: 'alpha' }), [`${HOME}/two/PROGRAMME.json`]: record() });
  assert.equal(due(named).slug, 'beta');
  // A done record names nothing now; a horizon that is not open is never due.
  assert.equal(due(store({ [`${HOME}/one/PROGRAMME.json`]: record({ horizon: 'alpha', state: 'done' }) })).slug, 'alpha');
  assert.equal(due(store(), { horizons: horizons(['alpha', 'reached'], ['beta', 'dropped']) }).slug, null);
  // Both named: nothing is due, and the reason says so.
  const both = store({ [`${HOME}/one/PROGRAMME.json`]: record({ horizon: 'alpha' }), [`${HOME}/two/PROGRAMME.json`]: record({ horizon: 'beta' }) });
  assert.deepEqual([due(both).slug, due(both).reason], [null, 'no open horizon needs a programme']);
});

test('manager turn: an open text item horizon:<slug> or manager item manager:<slug> holds that horizon, a closed one does not', () => {
  const text = (slug, state = 'for-martin') => ({ kind: 'text', text: `horizon:${slug}`, state });
  const manager = (slug, state = 'prepared') => ({ kind: 'manager', reference: managerReference(slug), state });
  assert.equal(due(store(), { items: [text('alpha')] }).slug, 'beta');
  assert.equal(due(store(), { items: [manager('alpha')] }).slug, 'beta');
  assert.equal(due(store(), { items: [text('alpha', 'closed'), manager('alpha', 'closed')] }).slug, 'alpha');
  assert.equal(due(store(), { items: [text('alpha'), manager('beta')] }).slug, null);
  // Another kind of item with the same words holds nothing.
  assert.equal(due(store(), { items: [{ kind: 'text', text: 'something else', state: 'for-martin' }, { kind: 'programme', reference: managerReference('alpha'), state: 'prepared' }] }).slug, 'alpha');
});

test('manager turn: an invalid record holds every horizon turn and says so once', () => {
  const s = store({ [`${HOME}/broken/PROGRAMME.json`]: '{ x', [`${HOME}/ok/PROGRAMME.json`]: record() });
  const answer = due(s);
  assert.deepEqual([answer.slug, answer.reason], [null, 'a programme record is invalid']);
  assert.equal(answer.notices.length, 1);
  assert.equal(answer.notices[0].key, 'records');
  assert.match(answer.notices[0].text, /the record of broken is invalid \(mc programs show broken\); it holds every horizon turn/u);
});

test('manager turn: a missing state file reads as no failures, an unreadable one skips its horizon and says so', () => {
  const s = store();
  assert.deepEqual(readHorizonState({ root: ROOT, slug: 'alpha', read: s.read }), { status: 'none' });
  for (const text of ['{ x', '[]', JSON.stringify({ schema: 'mc-programme-turn', version: 1, kind: 'horizon', horizon: 'alpha', failures: [], items: [] }),
    JSON.stringify({ schema: 'mc-manager-turn', version: 1, kind: 'horizon', horizon: 'other', failures: [], items: [] }),
    JSON.stringify({ schema: 'mc-manager-turn', version: 1, kind: 'horizon', horizon: 'alpha', failures: [{ at: 1 }], items: [] })]) {
    const bad = store({ [horizonStatePath(ROOT, 'alpha')]: text });
    assert.equal(readHorizonState({ root: ROOT, slug: 'alpha', read: bad.read }).status, 'unreadable', text);
    const answer = due(bad);
    assert.equal(answer.slug, 'beta', 'the horizon behind it is still served');
    assert.equal(answer.notices.length, 1);
    assert.equal(answer.notices[0].key, 'state:alpha');
    assert.match(answer.notices[0].text, /runner\/manager-turn\/horizon\/alpha\.json is unreadable \(/u);
    assert.throws(() => fail(bad, '2026-11-15T10:00:00Z'), /is unreadable/u, 'counting a failure on it is refused');
    assert.equal(bad.files[horizonStatePath(ROOT, 'alpha')], text, 'and nothing is rewritten');
  }
});

test('manager turn: the outcome is a record naming the horizon, the horizon no longer open, or the open text item — anything else fails', () => {
  const outcome = (s, extra = {}) => horizonOutcome({ slug: 'alpha', home: HOME, list: s.list, read: s.read, horizon: { state: 'open' }, items: [], ...extra });
  assert.deepEqual(outcome(store({ [`${HOME}/p/PROGRAMME.json`]: record({ horizon: 'alpha' }) })), { ok: true, how: 'programme' });
  assert.deepEqual(outcome(store(), { horizon: { state: 'reached' } }), { ok: true, how: 'reached' });
  assert.deepEqual(outcome(store(), { items: [{ kind: 'text', text: 'horizon:alpha', state: 'for-martin' }] }), { ok: true, how: 'text' });
  for (const [what, s, extra] of [
    ['nothing at all', store(), {}],
    ['a record naming another horizon', store({ [`${HOME}/p/PROGRAMME.json`]: record({ horizon: 'beta' }) }), {}],
    ['a record that is done', store({ [`${HOME}/p/PROGRAMME.json`]: record({ horizon: 'alpha', state: 'done' }) }), {}],
    ['a closed text item', store(), { items: [{ kind: 'text', text: 'horizon:alpha', state: 'closed' }] }],
    ['a text item for another horizon', store(), { items: [{ kind: 'text', text: 'horizon:beta', state: 'for-martin' }] }],
    ['a horizon that cannot be read', store(), { horizon: null }],
  ]) {
    const answer = outcome(s, extra);
    assert.equal(answer.ok, false, what);
    assert.match(answer.reason, /no open programme record naming alpha, the horizon still open and no open text item horizon:alpha/u, what);
  }
  const invalid = outcome(store({ [`${HOME}/bad/PROGRAMME.json`]: '{ x' }));
  assert.match(invalid.reason, /the record of bad is invalid/u);
});

test('manager turn: the first failure is kept, the second opens a prepared item, the next two a for-martin brief', () => {
  const s = store();
  const first = fail(s, '2026-11-15T10:00:00Z', 'reason one');
  assert.deepEqual([first.count, first.item], [1, null]);
  assert.equal(stateOf(s).failures.length, 1);
  assert.deepEqual(Object.keys(s.files).filter((path) => path.startsWith(`${ROOT}/martin/`)), [], 'the first opens nothing');

  const second = fail(s, '2026-11-15T10:05:00Z', 'reason two');
  assert.equal(second.count, 2);
  const item = second.item;
  assert.deepEqual([item.kind, item.reference, item.state, item.sort, item.reversible, item.due_at, item.outcome], ['manager', 'manager:alpha', 'prepared', 'mechanical', null, null, null]);
  const dir = itemDirectory(item, ENV);
  const prepared = s.files[`${dir}/prepared.md`];
  for (const text of ['reason one', 'reason two', '/l/2026-11-15T10:00:00Z.jsonl', '/l/2026-11-15T10:05:00Z.jsonl']) assert.ok(prepared.includes(text), text);
  assert.ok(`${dir}/item.json` in s.files);
  assert.equal(`${dir}/brief.md` in s.files, false);
  assert.deepEqual(stateOf(s).items, [{ id: item.id, opened_at: '2026-11-15T10:05:00Z' }]);

  // The item closed by decision: the failures that count again start after it.
  assert.equal(fail(s, '2026-11-15T11:00:00Z').item, null, 'one failure since the item opens nothing');
  const third = fail(s, '2026-11-15T11:05:00Z');
  assert.equal(third.count, 2);
  const later = third.item;
  assert.deepEqual([later.state, later.sort, later.reversible, later.due_at], ['for-martin', 'mechanical', false, null]);
  assert.notEqual(later.id, item.id);
  const brief = s.files[`${itemDirectory(later, ENV)}/brief.md`];
  for (const heading of ['Vad det gäller', 'Alternativ och konsekvenser', 'Rekommendation och skäl', 'Vad som står still', 'Kan valet ändras efteråt?']) assert.ok(brief.includes(`## ${heading}\n`), heading);
  assert.equal(`${itemDirectory(later, ENV)}/prepared.md` in s.files, false);
  assert.equal(stateOf(s).items.length, 2);
  // Another horizon's failures are its own.
  assert.equal(fail(s, '2026-11-15T12:00:00Z', 'x', 'beta').count, 1);
});

test('manager turn: the archived programmes of a horizon and the prompt name the playback, the pages, mc shot and the three endings', () => {
  const archive = store({
    '/a/old/PROGRAMME.json': record({ horizon: 'alpha', state: 'done' }),
    '/a/other/PROGRAMME.json': record({ horizon: 'beta', state: 'done' }),
    '/a/broken/PROGRAMME.json': '{ x',
    '/a/plain/README.md': '#',
  });
  const found = archivedFor({ archived: '/a', slug: 'alpha', list: archive.list, read: archive.read });
  assert.deepEqual(found, [{ programme: 'old', dir: '/a/old' }]);
  const prompt = horizonPrompt({ slug: 'alpha', env: ENV, pages: [{ repo: 'memoro', id: 'capture', path: '/w/co/memoro/docs/technical/areas/capture.md' }], archivedProgrammes: found, checkouts: { memoro: '/w/co/memoro' } });
  assert.match(prompt, /\/horizons\/alpha\/playback\.md/u);
  assert.ok(prompt.includes('/w/co/memoro/docs/technical/areas/capture.md'));
  assert.ok(prompt.includes('old (`/a/old`)'));
  assert.ok(prompt.includes('mc shot'));
  assert.ok(prompt.includes('mc programs create <name> --end'));
  assert.ok(prompt.includes('--horizon alpha --purpose'));
  assert.ok(prompt.includes('mc martin horizon reached alpha'));
  assert.ok(prompt.includes('horizon:alpha'));
  assert.ok(prompt.includes('Do not make a horizon or a goal'));
});

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

test('curation turn: the prompt lists every proposals folder, oldest first, and says what the turn may and may not write', () => {
  const s = store({ '/w/proposals/b.md': '#', '/w/proposals/.hidden': '#', [`${HOME}/one/proposals/a.md`]: '#', [`${HOME}/one/README.md`]: '#', [`${HOME}/two/proposals/c.md`]: '#' });
  const ages = { '/w/proposals/b.md': 300, [`${HOME}/one/proposals/a.md`]: 100, [`${HOME}/two/proposals/c.md`]: 200 };
  const backlog = proposalBacklog({ root: '/w', home: HOME, list: s.list, modified: (path) => ages[path] ?? null });
  assert.deepEqual(backlog.map((entry) => entry.path), [`${HOME}/one/proposals/a.md`, `${HOME}/two/proposals/c.md`, '/w/proposals/b.md']);
  const prompt = curationPrompt({ paths: { memoro: '/w/wt/memoro' }, branches: { memoro: 'manager/curation-x' }, pages: [{ repo: 'memoro', id: 'capture', path: '/w/wt/memoro/docs/technical/areas/capture.md' }], backlog, moved: ['memoro'] });
  assert.ok(prompt.indexOf(`${HOME}/one/proposals/a.md`) < prompt.indexOf(`${HOME}/two/proposals/c.md`));
  assert.ok(prompt.indexOf(`${HOME}/two/proposals/c.md`) < prompt.indexOf('/w/proposals/b.md'));
  for (const text of ['manager/curation-x', 'Main has moved since the last curation in: memoro', 'a turn that finds nothing to change is a success', '--from-proposal', 'do not make a horizon or a goal']) assert.ok(prompt.includes(text), text);
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

test('manager turn: the read checkouts are made at origin/main, a fetch failure counts nothing and a dirty leftover is never touched', () => {
  const repos = [{ name: 'memoro', path: '/r/memoro' }, { name: 'memoro-cli', path: '/r/memoro-cli' }];
  const ok = fakeGit();
  const made = setUpHorizonCheckouts({ git: ok.git, root: ROOT, slug: 'alpha', repos, exists: () => false });
  assert.deepEqual(made, { ok: true, paths: { memoro: `${ROOT}/runner/work/manager-horizon-alpha/memoro`, 'memoro-cli': `${ROOT}/runner/work/manager-horizon-alpha/memoro-cli` } });
  assert.ok(ok.calls.some((call) => call === `/r/memoro worktree add -q --detach ${ROOT}/runner/work/manager-horizon-alpha/memoro origin/main`));

  const offline = fakeGit({ '/r/memoro-cli fetch': { ok: false, stdout: '', stderr: 'could not resolve host\n' } });
  const refused = setUpHorizonCheckouts({ git: offline.git, root: ROOT, slug: 'alpha', repos, exists: () => false });
  assert.deepEqual([refused.ok, refused.fetch], [false, true]);
  assert.match(refused.reason, /^fetch memoro-cli: could not resolve host/u);
  assert.equal(offline.calls.some((call) => call.includes('worktree add')), false, 'nothing is made when a fetch fails');

  const dirty = fakeGit({ [`${ROOT}/runner/work/manager-horizon-alpha/memoro status --porcelain`]: { ok: true, stdout: ' M x\n', stderr: '' } });
  const kept = setUpHorizonCheckouts({ git: dirty.git, root: ROOT, slug: 'alpha', repos, exists: () => true });
  assert.equal(kept.ok, false);
  assert.equal(kept.retained, `${ROOT}/runner/work/manager-horizon-alpha/memoro`);
  assert.equal(dirty.calls.some((call) => call.includes('worktree remove')), false, 'a dirty checkout is not removed');
});

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
