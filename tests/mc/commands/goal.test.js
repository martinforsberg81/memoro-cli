import assert from 'node:assert/strict';
import { test } from 'node:test';

import { run, usage } from '../../../src/mc/commands/goal.js';
import { parseGoal, parseLog } from '../../../src/mc/goals.js';
import { runModule } from '../../../src/mc-verbs.js';

const HOME = '/work/programs';
const DIR = `${HOME}/mc/goals/plain`;
/** The bare repositories `knownRepositories` would name: their basenames are the repository names. */
const KNOWN = ['/home/m/memoro-cli.git', '/home/m/memoro'];

const GOAL_TEXT = [
  '---', 'status: open', 'repos: memoro-cli', 'class: large', 'created: 2026-11-01T20:00:00Z', '---',
  '# Make the goal plain', '', '## Goal', '', 'Two files and a worktree.', '',
].join('\n');

const LOG_TEXT = [
  '## 2026-11-01T20:00Z · person · open', '', 'Gjort: skapat', '',
  '## 2026-11-01T21:30Z · claude claude-opus-5-5 · open', '', 'Gjort: the reader', 'Nästa: the verbs', '',
  '## 2026-11-01T22:00Z · claude claude-opus-5-5 · open', '', 'Gjort: the tests', 'Nästa: the page', '',
  '## 2026-11-01T23:00Z · runner · open', '', 'Kommentar: no session ran', '',
].join('\n');

const ok = (stdout = '') => ({ ok: true, stdout, stderr: '' });
const failed = (stderr = 'boom') => ({ ok: false, stdout: '', stderr });
/** Every git call succeeds, except that no goal branch exists yet: `show-ref` finds none. */
const allOk = (cwd, args = []) => (args[0] === 'show-ref' ? failed('') : ok());

/** The directories under `path` in `store`, as `list` names them. */
function listUnder(store, path) {
  const prefix = `${path}/`;
  const names = new Set();
  for (const key of Object.keys(store)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length).split('/');
    if (rest.length > 1) names.add(rest[0]);
  }
  return [...names].sort();
}

/**
 * The deps of one verb: a file model under HOME (`mc` is a programme there),
 * the repositories `KNOWN`, and a `git` fake that records each call and answers
 * with `git(cwd, args)`. No real file or git process is touched.
 */
function fixture({ files = {}, env = {}, git = allOk, known = KNOWN } = {}) {
  const store = { [`${HOME}/mc/PLAN.json`]: '{}', ...files };
  const calls = [];
  const out = [];
  const err = [];
  const deps = {
    home: HOME,
    env,
    now: () => new Date('2026-11-01T20:00:00Z'),
    stdout: { write: (text) => out.push(text) },
    stderr: { write: (text) => err.push(text) },
    read: (path) => store[path] ?? null,
    write: (path, text) => { store[path] = text; },
    list: (path) => listUnder(store, path),
    known: () => known,
    git: (cwd, args) => {
      calls.push({ cwd, args });
      return git(cwd, args);
    },
  };
  return { deps, store, calls, out: () => out.join(''), err: () => err.join('') };
}

/** A goal already made: GOAL.md and LOG.md under its directory. */
function seededGoal(extra = {}) {
  return { [`${DIR}/GOAL.md`]: GOAL_TEXT, [`${DIR}/LOG.md`]: LOG_TEXT, ...extra };
}

test('mc goal new writes GOAL.md, LOG.md and one worktree per repo from origin/main', async () => {
  const f = fixture();
  const code = await run(['new', 'mc/plain', '--repo', 'memoro-cli,memoro', '--class', 'large', '--title', 'Make the goal plain'], f.deps);
  assert.equal(code, 0, f.err());

  const goal = parseGoal(f.store[`${DIR}/GOAL.md`]);
  assert.equal(goal.status, 'open');
  assert.deepEqual(goal.repos, ['memoro-cli', 'memoro']);
  assert.equal(goal.class, 'large');
  assert.equal(goal.created, '2026-11-01T20:00:00Z');
  assert.equal(goal.title, 'Make the goal plain');
  assert.match(goal.body, /## Criteria\n\n## Out of scope\n$/u);
  assert.equal(f.store[`${DIR}/LOG.md`], '## 2026-11-01T20:00Z · person · open\n\nGjort: skapat\n');

  assert.deepEqual(f.calls, [
    { cwd: '/home/m/memoro-cli.git', args: ['fetch', '-q', 'origin'] },
    { cwd: '/home/m/memoro', args: ['fetch', '-q', 'origin'] },
    { cwd: '/home/m/memoro-cli.git', args: ['show-ref', '--verify', '--quiet', 'refs/heads/goal/plain'] },
    { cwd: '/home/m/memoro-cli.git', args: ['worktree', 'add', '-q', '-b', 'goal/plain', `${DIR}/memoro-cli`, 'origin/main'] },
    { cwd: '/home/m/memoro', args: ['show-ref', '--verify', '--quiet', 'refs/heads/goal/plain'] },
    { cwd: '/home/m/memoro', args: ['worktree', 'add', '-q', '-b', 'goal/plain', `${DIR}/memoro`, 'origin/main'] },
  ]);
  assert.match(f.out(), new RegExp(`mc: mc/plain — ${DIR}`, 'u'));
  assert.match(f.out(), /GOAL\.md is to be filled in/u);
});

test('mc goal new uses a goal/<goal> branch that already exists as it is', async () => {
  const f = fixture({ git: (cwd, args) => (args[0] === 'show-ref' ? ok() : allOk()) });
  assert.equal(await run(['new', 'mc/plain', '--repo', 'memoro', '--class', 'fast', '--title', 'Again'], f.deps), 0);
  assert.deepEqual(f.calls.at(-1), { cwd: '/home/m/memoro', args: ['worktree', 'add', '-q', `${DIR}/memoro`, 'goal/plain'] });
});

test('mc goal new refuses a programme with no directory, a goal that exists, a repository mc does not know, and a class that is neither fast nor large', async () => {
  const args = (programme, repo, cls) => ['new', programme, '--repo', repo, '--class', cls, '--title', 'T'];

  const nope = fixture();
  assert.equal(await run(args('nope/plain', 'memoro', 'fast'), nope.deps), 1);
  assert.match(nope.err(), /no programme nope/u);

  const exists = fixture({ files: seededGoal() });
  assert.equal(await run(args('mc/plain', 'memoro', 'fast'), exists.deps), 1);
  assert.match(exists.err(), /mc\/plain exists/u);

  const unknown = fixture();
  assert.equal(await run(args('mc/other', 'nowhere', 'fast'), unknown.deps), 2);
  assert.match(unknown.err(), /nowhere is not a repository mc knows/u);
  assert.equal(unknown.store[`${HOME}/mc/goals/other/GOAL.md`], undefined);

  const badClass = fixture();
  assert.equal(await run(args('mc/plain', 'memoro', 'huge'), badClass.deps), 2);
  assert.match(badClass.err(), /--class is fast or large, not huge/u);
  assert.deepEqual(badClass.calls, []);
});

test('mc goal new refuses without a title, a repository or a class, and a name that is not programme/goal', async () => {
  const f = fixture();
  assert.equal(await run(['new', 'mc/plain', '--repo', 'memoro', '--class', 'fast'], f.deps), 2);
  assert.match(f.err(), /new needs --title/u);

  const g = fixture();
  assert.equal(await run(['new', 'mc/plain', '--class', 'fast', '--title', 'T'], g.deps), 2);
  assert.match(g.err(), /new needs --repo/u);

  const h = fixture();
  assert.equal(await run(['new', 'plain', '--repo', 'memoro', '--class', 'fast', '--title', 'T'], h.deps), 2);
  assert.match(h.err(), /plain is not <programme>\/<goal>/u);
});

test('mc goal new leaves nothing behind when a repository cannot be fetched', async () => {
  const f = fixture({ git: (cwd, args) => (args[0] === 'fetch' ? failed('network down') : allOk()) });
  assert.equal(await run(['new', 'mc/plain', '--repo', 'memoro', '--class', 'fast', '--title', 'T'], f.deps), 1);
  assert.match(f.err(), /could not fetch memoro — network down/u);
  assert.equal(f.store[`${DIR}/GOAL.md`], undefined);
  assert.equal(f.store[`${DIR}/LOG.md`], undefined);
});

test('mc goal new says which worktree could not be made, and where the goal\'s files stand', async () => {
  const f = fixture({ git: (cwd, args) => (args[0] === 'worktree' ? failed('branch in use') : allOk()) });
  assert.equal(await run(['new', 'mc/plain', '--repo', 'memoro', '--class', 'fast', '--title', 'T'], f.deps), 1);
  assert.match(f.err(), /memoro's worktree is not made — branch in use; the goal's files stand in/u);
  assert.match(f.store[`${DIR}/GOAL.md`], /status: open/u);
});

test('mc goal log appends one entry, tagged with MC_TOOL and MC_MODEL, and the goal is MC_GOAL\'s when not named', async () => {
  const f = fixture({ files: seededGoal(), env: { MC_GOAL: 'mc/plain', MC_TOOL: 'claude', MC_MODEL: 'claude-haiku-5-5' } });
  assert.equal(await run(['log', '--done', 'the verb', '--next', 'the page'], f.deps), 0, f.err());
  const entries = parseLog(f.store[`${DIR}/LOG.md`]);
  assert.equal(entries.length, 5);
  assert.deepEqual(entries.at(-1), {
    at: '2026-11-01T20:00Z', tool: 'claude', model: 'claude-haiku-5-5', status: 'open', done: 'the verb', comment: null, next: 'the page',
  });
  assert.equal(f.store[`${DIR}/GOAL.md`], GOAL_TEXT, 'a log entry alone leaves the front matter as it is');
});

test('mc goal log with neither MC_TOOL nor MC_MODEL writes a person\'s entry', async () => {
  const f = fixture({ files: seededGoal() });
  assert.equal(await run(['log', 'mc/plain', '--comment', 'a note'], f.deps), 0, f.err());
  assert.deepEqual(parseLog(f.store[`${DIR}/LOG.md`]).at(-1), {
    at: '2026-11-01T20:00Z', tool: 'person', model: null, status: 'open', done: null, comment: 'a note', next: null,
  });
});

test('mc goal log refuses without a goal, without anything to log, and with a goal that is not one', async () => {
  const none = fixture({ files: seededGoal() });
  assert.equal(await run(['log', '--done', 'x'], none.deps), 2);
  assert.match(none.err(), /which goal\?/u);

  const empty = fixture({ files: seededGoal(), env: { MC_GOAL: 'mc/plain' } });
  assert.equal(await run(['log'], empty.deps), 2);
  assert.match(empty.err(), /log needs --done, --comment, --next or --status/u);

  const badName = fixture({ files: seededGoal() });
  assert.equal(await run(['log', 'plain', '--done', 'x'], badName.deps), 2);
  assert.match(badName.err(), /plain is not <programme>\/<goal>/u);

  const absent = fixture();
  assert.equal(await run(['log', 'mc/plain', '--done', 'x'], absent.deps), 1);
  assert.match(absent.err(), /no goal mc\/plain/u);

  const broken = fixture({ files: seededGoal({ [`${DIR}/GOAL.md`]: 'no front matter\n' }) });
  assert.equal(await run(['log', 'mc/plain', '--done', 'x'], broken.deps), 1);
  assert.match(broken.err(), /mc\/plain: GOAL\.md has no front matter/u);
  assert.equal(broken.store[`${DIR}/LOG.md`], LOG_TEXT, 'a goal that does not parse gets no entry');
});

test('mc goal log --status rewrites the status in the front matter and logs the entry with it', async () => {
  const f = fixture({ files: seededGoal() });
  assert.equal(await run(['log', 'mc/plain', '--status', 'blocked', '--comment', 'waits for Martin'], f.deps), 0, f.err());
  assert.equal(parseGoal(f.store[`${DIR}/GOAL.md`]).status, 'blocked');
  assert.equal(f.store[`${DIR}/GOAL.md`], GOAL_TEXT.replace('status: open', 'status: blocked'));
  assert.equal(parseLog(f.store[`${DIR}/LOG.md`]).at(-1).status, 'blocked');
  assert.equal(parseLog(f.store[`${DIR}/LOG.md`]).at(-1).comment, 'waits for Martin');

  const bad = fixture({ files: seededGoal() });
  assert.equal(await run(['log', 'mc/plain', '--status', 'started', '--comment', 'x'], bad.deps), 2);
  assert.match(bad.err(), /--status is open, blocked, done, not started/u);
});

test('mc goal open, blocked and done set the status and log the reason', async () => {
  for (const verb of ['open', 'blocked', 'done']) {
    const f = fixture({ files: seededGoal(), env: { MC_GOAL: 'mc/plain' } });
    assert.equal(await run([verb, '--reason', `because ${verb}`], f.deps), 0, f.err());
    assert.equal(parseGoal(f.store[`${DIR}/GOAL.md`]).status, verb);
    const last = parseLog(f.store[`${DIR}/LOG.md`]).at(-1);
    assert.equal(last.status, verb);
    assert.equal(last.comment, `because ${verb}`);
  }
});

test('mc goal open|blocked|done take only --reason', async () => {
  const f = fixture({ files: seededGoal(), env: { MC_GOAL: 'mc/plain' } });
  assert.equal(await run(['done', '--done', 'x'], f.deps), 2);
  assert.match(f.err(), /done takes no --done/u);
});

test('mc goal show prints the front matter, the body, the last three entries, and each worktree\'s state', async () => {
  const git = (cwd, args) => {
    if (cwd === `${DIR}/memoro` && args[0] === 'status') return failed('not a worktree');
    if (args[0] === 'status') return ok(' M src/a.js\n?? notes.md\n');
    if (args[0] === 'rev-list') return ok('2\n');
    if (args[0] === 'log') return ok('2026-11-01T21:00:00+01:00\n');
    return allOk();
  };
  const f = fixture({ files: seededGoal({ [`${DIR}/GOAL.md`]: GOAL_TEXT.replace('repos: memoro-cli', 'repos: memoro-cli, memoro') }), git });
  assert.equal(await run(['show', 'mc/plain'], f.deps), 0, f.err());
  const text = f.out();
  assert.match(text, /^mc\/plain · open · memoro-cli, memoro · large · created 2026-11-01T20:00:00Z\n/u);
  assert.match(text, /Two files and a worktree\./u);
  assert.doesNotMatch(text, /Gjort: skapat/u, 'only the last three entries');
  assert.match(text, /Gjort: the reader\nNästa: the verbs/u);
  assert.match(text, /Kommentar: no session ran/u);
  assert.match(text, new RegExp(`memoro-cli  ${DIR}/memoro-cli  2 changed · 2 commits past origin/main · last commit 2026-11-01T21:00:00\\+01:00`, 'u'));
  assert.match(text, new RegExp(`memoro  ${DIR}/memoro — no worktree`, 'u'));
  assert.deepEqual(f.calls.map((c) => c.args[0]), ['status', 'rev-list', 'log', 'status']);
});

test('mc goal show refuses a goal that does not parse, and says why', async () => {
  const f = fixture({ files: seededGoal({ [`${DIR}/GOAL.md`]: '---\nstatus: maybe\nrepos: memoro\nclass: fast\n---\n' }) });
  assert.equal(await run(['show', 'mc/plain'], f.deps), 1);
  assert.match(f.err(), /mc\/plain does not parse:/u);
  assert.match(f.err(), /status is open, blocked, done, not maybe/u);
});

test('mc goal list prints one line a goal: its name, repositories, status, sessions and what is next', async () => {
  const f = fixture({
    files: {
      ...seededGoal(),
      [`${HOME}/mc/goals/broken/GOAL.md`]: 'nothing here\n',
    },
  });
  assert.equal(await run(['list'], f.deps), 0);
  const lines = f.out().trim().split('\n');
  assert.equal(lines[0], 'mc/broken · does not parse — GOAL.md has no front matter between --- lines');
  // Two sessions wrote entries; the last entry is the runner's, and it sets no Nästa.
  assert.equal(lines[1], 'mc/plain · memoro-cli · open · 2 sessions · —');
});

test('mc goal list <programme> lists that programme alone, and says when it has no goals', async () => {
  const f = fixture({ files: seededGoal() });
  assert.equal(await run(['list', 'mc'], f.deps), 0);
  assert.equal(f.out(), 'mc/plain · memoro-cli · open · 2 sessions · —\n');

  const none = fixture();
  assert.equal(await run(['list', 'nope'], none.deps), 0);
  assert.equal(none.out(), 'mc: no goals\n');
});

test('usage names the five verbs, and mc goal --help prints it', async () => {
  const text = usage();
  for (const verb of ['mc goal new', 'mc goal log', 'mc goal open|blocked|done', 'mc goal show', 'mc goal list']) {
    assert.match(text, new RegExp(verb, 'u'));
  }
  const printed = [];
  const code = await runModule('./mc/commands/goal.js', ['--help'], { stdout: { write: (t) => printed.push(t) } });
  assert.equal(code, 0);
  assert.equal(printed.join(''), text);
});
