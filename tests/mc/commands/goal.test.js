import assert from 'node:assert/strict';
import { test } from 'node:test';

import { refusedStatus, run, usage } from '../../../src/mc/commands/goal.js';
import { parseGoal, parseLog, PLAN_ROLE, REVIEW_ROLE, STATUSES } from '../../../src/mc/goals.js';
import { BUILD_ROLES } from '../../../src/mc/run-plan.js';
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
  assert.match(bad.err(), /--status is open, review, blocked, done, waiting, dropped, not started/u);
});

test('mc goal open, review, blocked and done set the status and log the reason', async () => {
  for (const verb of ['open', 'review', 'blocked', 'done']) {
    const f = fixture({ files: seededGoal(), env: { MC_GOAL: 'mc/plain' } });
    assert.equal(await run([verb, '--reason', `because ${verb}`], f.deps), 0, f.err());
    assert.equal(parseGoal(f.store[`${DIR}/GOAL.md`]).status, verb);
    const last = parseLog(f.store[`${DIR}/LOG.md`]).at(-1);
    assert.equal(last.status, verb);
    assert.equal(last.comment, `because ${verb}`);
  }
});

/**
 * A goal's branch is made when the goal can start: one written blocked got its
 * branch at `mc goal new`, before what it waited for landed.
 */
test('mc goal open remakes a branch with no commits of its own from origin/main, and leaves one with commits alone', async () => {
  const blocked = seededGoal({ [`${DIR}/GOAL.md`]: GOAL_TEXT.replace('status: open', 'status: blocked') });
  const counts = ({ own, behind }) => (cwd, args) => {
    if (args[0] === 'rev-list') return ok(`${args[2] === 'origin/main..HEAD' ? own : behind}\n`);
    return ok();
  };

  const fresh = fixture({ files: blocked, git: counts({ own: 0, behind: 7 }) });
  assert.equal(await run(['open', 'mc/plain', '--reason', 'what it waited for has landed'], fresh.deps), 0, fresh.err());
  const reset = fresh.calls.find((call) => call.args[0] === 'reset');
  assert.deepEqual(reset, { cwd: `${DIR}/memoro-cli`, args: ['reset', '-q', '--keep', 'origin/main'] });
  assert.ok(fresh.calls.findIndex((call) => call.args[0] === 'fetch') < fresh.calls.indexOf(reset), 'fetched first');
  assert.match(fresh.out(), /memoro-cli {2}goal\/plain remade from origin\/main — it had no commits of its own, and main has 7 more/u);

  const built = fixture({ files: blocked, git: counts({ own: 3, behind: 7 }) });
  assert.equal(await run(['open', 'mc/plain'], built.deps), 0, built.err());
  assert.equal(built.calls.some((call) => call.args[0] === 'reset'), false, 'a branch with commits is never moved');
  assert.match(built.out(), /goal\/plain left as it is — 3 commits of its own/u);

  const already = fixture({ files: seededGoal(), git: counts({ own: 0, behind: 7 }) });
  assert.equal(await run(['open', 'mc/plain'], already.deps), 0, already.err());
  assert.equal(already.calls.some((call) => call.args[0] === 'reset'), false, 'a goal already open is not a goal going open');
});

test('a goal session ends in review and may not set done; a person may', async () => {
  const session = { MC_GOAL: 'mc/plain', MC_TOOL: 'claude', MC_MODEL: 'opus' };
  const built = fixture({ files: seededGoal(), env: session });
  assert.equal(await run(['log', '--done', 'built', '--status', 'review'], built.deps), 0, built.err());
  assert.equal(parseGoal(built.store[`${DIR}/GOAL.md`]).status, 'review');

  for (const argv of [['log', '--done', 'x', '--status', 'done'], ['done', '--reason', 'x']]) {
    const f = fixture({ files: seededGoal(), env: session });
    assert.equal(await run(argv, f.deps), 2, argv.join(' '));
    assert.match(f.err(), /a session does not set done — end in review; the merger sets done/u);
    assert.equal(f.store[`${DIR}/GOAL.md`], GOAL_TEXT, 'nothing written');
    assert.equal(f.store[`${DIR}/LOG.md`], LOG_TEXT, 'no entry');
  }

  // MC_TOOL person, or no MC_TOOL at all, is a person, even with MC_GOAL set.
  for (const env of [{ MC_GOAL: 'mc/plain', MC_TOOL: 'person' }, { MC_GOAL: 'mc/plain' }, {}]) {
    const f = fixture({ files: seededGoal(), env });
    assert.equal(await run(['done', 'mc/plain', '--reason', 'landed by hand'], f.deps), 0, f.err());
    assert.equal(parseGoal(f.store[`${DIR}/GOAL.md`]).status, 'done');
  }
});

test('a review session may not set a goal open again', async () => {
  const f = fixture({ files: seededGoal(), env: { MC_GOAL: 'mc/plain', MC_TOOL: 'claude', MC_ROLE: REVIEW_ROLE } });
  assert.equal(await run(['log', '--done', 'red abc1234', '--status', 'open'], f.deps), 2);
  assert.match(f.err(), /a review does not set open/u);
  assert.equal(await run(['log', '--done', 'red abc1234', '--status', 'blocked'], f.deps), 0, f.err());
  assert.equal(parseGoal(f.store[`${DIR}/GOAL.md`]).status, 'blocked');
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
  assert.match(f.err(), /status is open, review, blocked, done, waiting, dropped, not maybe/u);
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

test('mc goal list shows review, and a goal blocked by a red review or a red merge as waiting on plan', async () => {
  const goal = (status) => GOAL_TEXT.replace('status: open', `status: ${status}`);
  const f = fixture({
    files: {
      [`${HOME}/mc/goals/a/GOAL.md`]: goal('review'),
      [`${HOME}/mc/goals/a/LOG.md`]: '## 2026-11-02T10:00Z · claude opus · review\n\nGjort: built\n',
      [`${HOME}/mc/goals/b/GOAL.md`]: goal('blocked'),
      [`${HOME}/mc/goals/b/LOG.md`]: '## 2026-11-02T10:00Z · codex gpt-6.1-sol · blocked\n\nGjort: red abc1234\n',
      [`${HOME}/mc/goals/c/GOAL.md`]: goal('blocked'),
      [`${HOME}/mc/goals/c/LOG.md`]: '## 2026-11-02T10:00Z · runner · blocked\n\nGjort: merger answered red on #12\n',
      [`${HOME}/mc/goals/d/GOAL.md`]: goal('blocked'),
      [`${HOME}/mc/goals/d/LOG.md`]: '## 2026-11-02T10:00Z · claude opus · blocked\n\nKommentar: which table?\n',
    },
  });
  assert.equal(await run(['list'], f.deps), 0, f.err());
  assert.deepEqual(f.out().trim().split('\n'), [
    'mc/a · memoro-cli · review · 1 sessions · —',
    'mc/b · memoro-cli · blocked, waits on plan · 1 sessions · —',
    'mc/c · memoro-cli · blocked, waits on plan · 0 sessions · —',
    'mc/d · memoro-cli · blocked, waits on a person · 1 sessions · —',
  ]);
});

test('a plan session may set every status; a build or review session never done or dropped', () => {
  const plan = { MC_GOAL: 'mc/a', MC_TOOL: 'claude', MC_ROLE: PLAN_ROLE };
  for (const status of STATUSES) assert.equal(refusedStatus(status, plan), null, status);
  const build = { MC_GOAL: 'mc/a', MC_TOOL: 'claude', MC_ROLE: BUILD_ROLES.goal };
  assert.match(refusedStatus('done', build), /does not set done/u);
  assert.match(refusedStatus('dropped', build), /only plan or a person drops/u);
  assert.equal(refusedStatus('review', build), null);
  const review = { MC_GOAL: 'mc/a', MC_TOOL: 'claude', MC_ROLE: REVIEW_ROLE };
  assert.match(refusedStatus('done', review), /does not set done/u);
  assert.match(refusedStatus('open', review), /a review does not set open/u);
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
  for (const verb of ['mc goal new', 'mc goal after', 'mc goal log', 'mc goal open\\|review\\|blocked\\|done', 'mc goal show', 'mc goal list']) {
    assert.match(text, new RegExp(verb, 'u'));
  }
  const printed = [];
  const code = await runModule('./mc/commands/goal.js', ['--help'], { stdout: { write: (t) => printed.push(t) } });
  assert.equal(code, 0);
  assert.equal(printed.join(''), text);
});

/* ------------------------------------------------------------- after, waiting */

/** A goal under `mc` with `status` and, when given, an `after` line. */
const goalAt = (name, status, after = null) => ({
  [`${HOME}/mc/goals/${name}/GOAL.md`]: GOAL_TEXT.replace('status: open', `status: ${status}`).replace('class: large\n', after ? `class: large\nafter: ${after}\n` : 'class: large\n'),
  [`${HOME}/mc/goals/${name}/LOG.md`]: '## 2026-11-01T20:00Z · person · open\n\nGjort: skapat\n',
});
const goalOf = (f, name) => parseGoal(f.store[`${HOME}/mc/goals/${name}/GOAL.md`]);
const newArgs = (name, ...more) => ['new', name, '--repo', 'memoro-cli', '--class', 'large', '--title', 'T', ...more];

test('mc goal new --after writes after, and the goal is waiting on what has not landed', async () => {
  const f = fixture({ files: { ...goalAt('first', 'open'), ...goalAt('landed', 'done') } });
  assert.equal(await run(newArgs('mc/second', '--after', 'mc/first,mc/landed'), f.deps), 0, f.err());
  const goal = goalOf(f, 'second');
  assert.equal(goal.status, 'waiting');
  assert.deepEqual(goal.after, ['mc/first', 'mc/landed']);
  assert.deepEqual(parseLog(f.store[`${HOME}/mc/goals/second/LOG.md`]).at(-1).comment, 'waits on mc/first');
  assert.match(f.out(), /mc\/second · waiting — waits on mc\/first/u);

  const all = fixture({ files: goalAt('landed', 'done') });
  assert.equal(await run(newArgs('mc/third', '--after', 'mc/landed'), all.deps), 0, all.err());
  assert.equal(goalOf(all, 'third').status, 'open', 'after all landed, it is open');
});

test('mc goal new --after refuses a name that is not a goal, and the goal itself, and writes nothing', async () => {
  const unknown = fixture({ files: goalAt('first', 'open') });
  assert.equal(await run(newArgs('mc/second', '--after', 'mc/first,mc/nowhere'), unknown.deps), 2);
  assert.match(unknown.err(), /after mc\/nowhere is not a goal/u);
  assert.equal(`${HOME}/mc/goals/second/GOAL.md` in unknown.store, false);
  assert.equal(unknown.calls.length, 0, 'nothing fetched');

  const malformed = fixture();
  assert.equal(await run(newArgs('mc/second', '--after', 'first'), malformed.deps), 2);
  assert.match(malformed.err(), /after first is not <programme>\/<goal>/u);

  const self = fixture();
  assert.equal(await run(newArgs('mc/second', '--after', 'mc/second'), self.deps), 2);
  assert.match(self.err(), /cannot wait on itself/u);
});

test('mc goal after replaces after: waiting while one has not landed, open again when none is left', async () => {
  const f = fixture({ files: { ...goalAt('plain', 'blocked'), ...goalAt('first', 'open'), ...goalAt('landed', 'done') } });
  assert.equal(await run(['after', 'mc/plain', 'mc/first', 'mc/landed'], f.deps), 0, f.err());
  assert.equal(goalOf(f, 'plain').status, 'waiting');
  assert.deepEqual(goalOf(f, 'plain').after, ['mc/first', 'mc/landed']);
  const entry = parseLog(f.store[`${DIR}/LOG.md`]).at(-1);
  assert.deepEqual([entry.tool, entry.status, entry.done, entry.comment], ['person', 'waiting', 'after mc/first, mc/landed', 'waits on mc/first']);
  assert.match(f.out(), /mc\/plain · waiting — waits on mc\/first/u);

  assert.equal(await run(['after', 'mc/plain', 'mc/landed'], f.deps), 0, f.err());
  assert.equal(goalOf(f, 'plain').status, 'open', 'waiting with nothing left is open');
  assert.ok(f.calls.some((call) => call.cwd === `${DIR}/memoro-cli` && call.args[0] === 'fetch'), 'its branch is looked at as mc goal open does');

  assert.equal(await run(['after', 'mc/plain'], f.deps), 0, f.err());
  assert.deepEqual(goalOf(f, 'plain').after, [], 'none given clears it');
  assert.doesNotMatch(f.store[`${DIR}/GOAL.md`], /^after:/mu);
  assert.equal(parseLog(f.store[`${DIR}/LOG.md`]).at(-1).done, 'after cleared');
});

test('mc goal after … none clears what a goal waits on, as the help says; none beside a goal name is refused', async () => {
  const f = fixture({ files: { ...goalAt('plain', 'waiting', 'mc/first'), ...goalAt('first', 'open') } });
  assert.equal(await run(['after', 'mc/plain', 'none'], f.deps), 0, f.err());
  assert.deepEqual(goalOf(f, 'plain').after, [], 'none clears it');
  assert.equal(goalOf(f, 'plain').status, 'open', 'waiting with nothing left is open');
  assert.equal(parseLog(f.store[`${DIR}/LOG.md`]).at(-1).done, 'after cleared');
  assert.equal(await run(['after', 'mc/plain', 'none', 'mc/first'], f.deps), 2);
  assert.match(f.err(), /none clears after and names no goal/u);
});

test('mc goal after refuses a name that is not a goal, a ring, and a goal in review or done', async () => {
  const f = fixture({ files: { ...goalAt('plain', 'open'), ...goalAt('first', 'waiting', 'mc/plain'), ...goalAt('judged', 'review'), ...goalAt('landed', 'done') } });
  const before = { ...f.store };
  assert.equal(await run(['after', 'mc/plain', 'mc/nowhere'], f.deps), 2);
  assert.match(f.err(), /after mc\/nowhere is not a goal/u);
  assert.equal(await run(['after', 'mc/plain', 'mc/first'], f.deps), 2);
  assert.match(f.err(), /mc\/first waits on mc\/plain already/u);
  assert.equal(await run(['after', 'mc/judged', 'mc/first'], f.deps), 1);
  assert.match(f.err(), /mc\/judged is review/u);
  assert.equal(await run(['after', 'mc/landed', 'mc/first'], f.deps), 1);
  assert.equal(await run(['after', 'nope'], f.deps), 2);
  assert.equal(await run(['after', 'mc/missing', 'mc/first'], f.deps), 1);
  assert.deepEqual(f.store, before, 'nothing is written');
});

test('mc goal open on a goal whose after has not landed is refused with what it waits on; landed, it opens', async () => {
  const f = fixture({ files: { ...goalAt('plain', 'waiting', 'mc/first, mc/landed'), ...goalAt('first', 'blocked'), ...goalAt('landed', 'done') } });
  const before = { ...f.store };
  assert.equal(await run(['open', 'mc/plain'], f.deps), 1);
  assert.match(f.err(), /mc\/plain is not opened — it waits on mc\/first, not landed/u);
  assert.equal(await run(['log', 'mc/plain', '--status', 'open', '--comment', 'go'], f.deps), 1);
  assert.deepEqual(f.store, before, 'nothing is written');

  const gone = fixture({ files: { ...goalAt('plain', 'blocked', 'mc/discarded') } });
  assert.equal(await run(['open', 'mc/plain'], gone.deps), 1);
  assert.match(gone.err(), /mc\/discarded gone without landing/u);

  const landed = fixture({ files: { ...goalAt('plain', 'waiting', 'mc/landed'), ...goalAt('landed', 'done') } });
  assert.equal(await run(['open', 'mc/plain'], landed.deps), 0, landed.err());
  assert.equal(goalOf(landed, 'plain').status, 'open');
});

test('mc goal after on a blocked goal: waiting while one has not landed; all landed, it stays blocked and says how it opens', async () => {
  // The migration of 2026-11-02: headless-plan blocked, after runner-sessions and goal-waiting, both done.
  const landed = fixture({ files: { ...goalAt('plain', 'blocked'), ...goalAt('landed', 'done'), ...goalAt('also', 'done') } });
  assert.equal(await run(['after', 'mc/plain', 'mc/landed', 'mc/also'], landed.deps), 0, landed.err());
  assert.equal(goalOf(landed, 'plain').status, 'blocked');
  assert.match(landed.out(), /mc\/plain · blocked — mc\/landed, mc\/also landed; it stays blocked, mc goal open mc\/plain opens it/u);
  assert.equal(await run(['open', 'mc/plain'], landed.deps), 0, landed.err());
  assert.equal(goalOf(landed, 'plain').status, 'open');

  const pending = fixture({ files: { ...goalAt('plain', 'blocked'), ...goalAt('first', 'open') } });
  assert.equal(await run(['after', 'mc/plain', 'mc/first'], pending.deps), 0, pending.err());
  assert.equal(goalOf(pending, 'plain').status, 'waiting', 'a blocked goal that names what it waits on is waiting');
});

test('mc goal open is refused on a goal already open whose after has not landed', async () => {
  const f = fixture({ files: { ...goalAt('early', 'open', 'mc/first'), ...goalAt('first', 'blocked') } });
  const before = { ...f.store };
  assert.equal(await run(['open', 'mc/early'], f.deps), 1);
  assert.match(f.err(), /mc\/early is not opened — it waits on mc\/first, not landed/u);
  assert.equal(await run(['log', 'mc/early', '--status', 'open', '--comment', 'go'], f.deps), 1);
  assert.deepEqual(f.store, before, 'nothing is written');
});

test('nobody sets waiting by --status: a goal waits by its after', async () => {
  const f = fixture({ files: seededGoal() });
  assert.equal(await run(['log', 'mc/plain', '--status', 'waiting'], f.deps), 2);
  assert.match(f.err(), /a goal waits by its after/u);
});

test('mc goal list and show say waiting and on what', async () => {
  const f = fixture({ files: { ...goalAt('plain', 'waiting', 'mc/first, mc/landed'), ...goalAt('first', 'open'), ...goalAt('landed', 'done') } });
  assert.equal(await run(['list'], f.deps), 0);
  assert.match(f.out(), /^mc\/plain · memoro-cli · waiting on mc\/first · 0 sessions · —$/mu);
  assert.equal(await run(['show', 'mc/plain'], f.deps), 0);
  assert.match(f.out(), /^mc\/plain · waiting · memoro-cli · large · created 2026-11-01T20:00:00Z · after mc\/first, mc\/landed$/mu);
});
