import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { refusedMove, run, usage } from '../../../src/mc/commands/goal.js';
import { addGoalWorktree, GOAL_FILE, parseGoal, parseLog, PLAN_ROLE, REVIEW_ROLE, STAGES } from '../../../src/mc/goals.js';
import { BUILD_ROLES } from '../../../src/mc/run-plan.js';
import { runModule } from '../../../src/mc-verbs.js';
import { goalField, goalJson, withGoal } from '../_helpers/goal-file.js';

const HOME = '/work/programs';
const DIR = `${HOME}/mc/goals/plain`;
/** The bare repositories `knownRepositories` would name: their basenames are the repository names. */
const KNOWN = ['/home/m/memoro-cli.git', '/home/m/memoro'];

const GOAL_TEXT = goalJson();

const LOG_TEXT = [
  '## 2026-11-01T20:00Z · person · plan · ready', '', 'Done: created', '',
  '## 2026-11-01T21:30Z · claude claude-opus-5-5 · build · ready', '', 'Done: the reader', 'Next: the verbs', '',
  '## 2026-11-01T22:00Z · claude claude-opus-5-5 · build · ready', '', 'Done: the tests', 'Next: the page', '',
  '## 2026-11-01T23:00Z · runner · build · ready', '', 'Comment: no session ran', '',
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
function fixture({ files = {}, env = {}, git = allOk, known = KNOWN, absent = [] } = {}) {
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
    mainCheck: () => ({ fetch: { ok: true, text: '' }, paths: [] }),
    exists: (path) => !absent.includes(path),
  };
  return { deps, store, calls, out: () => out.join(''), err: () => err.join('') };
}

/** A goal already made: GOAL.json and LOG.md under its directory. */
function seededGoal(extra = {}) {
  return { [`${DIR}/GOAL.json`]: GOAL_TEXT, [`${DIR}/LOG.md`]: LOG_TEXT, ...extra };
}

test('mc goal new writes a GOAL.json skeleton and LOG.md, fetches each repository, and makes no worktree', async () => {
  const f = fixture();
  const code = await run(['new', 'mc/plain', '--repo', 'memoro-cli,memoro', '--class', 'large', '--title', 'Make the goal plain'], f.deps);
  assert.equal(code, 0, f.err());

  const goal = parseGoal(f.store[`${DIR}/GOAL.json`]);
  assert.deepEqual([goal.stage, goal.status], ['plan', 'ready'], 'a new goal is in plan unless --stage build');
  assert.deepEqual(goal.repos, ['memoro-cli', 'memoro']);
  assert.equal(goal.class, 'large');
  assert.equal(goal.created, '2026-11-01T20:00:00Z');
  assert.equal(goal.title, 'Make the goal plain');
  assert.deepEqual([goal.goal, goal.contract, goal.out_of_scope, goal.success_criteria, goal.documents], [[], [], [], [], []]);
  assert.equal(goalField(f.store[`${DIR}/GOAL.json`], 'schema'), 'mc-goal');
  assert.equal(f.store[`${DIR}/LOG.md`], '## 2026-11-01T20:00Z · person · plan · ready\n\nDone: created\n');

  assert.deepEqual(f.calls, [
    { cwd: '/home/m/memoro-cli.git', args: ['fetch', '-q', 'origin'] },
    { cwd: '/home/m/memoro', args: ['fetch', '-q', 'origin'] },
  ], 'no worktree, and no branch looked at: nothing is added');
  assert.deepEqual(listUnder(f.store, DIR), [], 'no <goal>/<repo> directory');
  assert.match(f.out(), new RegExp(`mc: mc/plain · plan · ready · phase 1 — ${DIR}`, 'u'));
  assert.match(f.out(), /no worktree yet: the runner makes memoro-cli, memoro on goal\/plain at the goal's first session/u);
  assert.equal(goal.phase, 1, 'phase 1 when --phase is not given');
  assert.match(f.out(), /GOAL\.json is to be filled in by verbs: mc goal set mc\/plain/u);
});

test('mc goal new --stage build makes a goal ready to be built; no other stage is a new goal\'s', async () => {
  const f = fixture();
  assert.equal(await run(['new', 'mc/plain', '--repo', 'memoro', '--class', 'fast', '--title', 'T', '--stage', 'build'], f.deps), 0, f.err());
  assert.equal(parseGoal(f.store[`${DIR}/GOAL.json`]).stage, 'build');
  const g = fixture();
  assert.equal(await run(['new', 'mc/plain', '--repo', 'memoro', '--class', 'fast', '--title', 'T', '--stage', 'review'], g.deps), 2);
  assert.match(g.err(), /--stage is plan or build for a new goal, not review/u);
  assert.equal(g.store[`${DIR}/GOAL.json`], undefined);
});

test('mc goal new makes no worktree even when goal/<goal> already exists: the runner re-adds it at the first session', async () => {
  const f = fixture({ git: (cwd, args) => (args[0] === 'show-ref' ? ok() : allOk()) });
  assert.equal(await run(['new', 'mc/plain', '--repo', 'memoro', '--class', 'fast', '--title', 'Again'], f.deps), 0);
  assert.deepEqual(f.calls.map((call) => call.args[0]), ['fetch'], 'only the fetch');
});

test('addGoalWorktree adds an existing goal/<goal> as it is, after a prune, and makes a new one from origin/main', () => {
  const calls = [];
  const exists = { value: true };
  const git = (cwd, args) => {
    calls.push([cwd, ...args]);
    return args[0] === 'show-ref' ? { ok: exists.value, stdout: '', stderr: '' } : { ok: true, stdout: '', stderr: '' };
  };
  const again = addGoalWorktree({ git, bare: '/b/memoro', path: `${DIR}/memoro`, goal: 'plain' });
  assert.deepEqual([again.existed, again.branch], [true, 'goal/plain']);
  assert.deepEqual(calls.slice(1), [['/b/memoro', 'worktree', 'prune'], ['/b/memoro', 'worktree', 'add', '-q', `${DIR}/memoro`, 'goal/plain']]);
  calls.length = 0;
  exists.value = false;
  const fresh = addGoalWorktree({ git, bare: '/b/memoro', path: `${DIR}/memoro`, goal: 'plain' });
  assert.deepEqual([fresh.existed, fresh.ok], [false, true]);
  assert.deepEqual(calls.slice(1), [['/b/memoro', 'worktree', 'add', '-q', '-b', 'goal/plain', `${DIR}/memoro`, 'origin/main']]);
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
  assert.equal(unknown.store[`${HOME}/mc/goals/other/GOAL.json`], undefined);

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
  assert.equal(f.store[`${DIR}/GOAL.json`], undefined);
  assert.equal(f.store[`${DIR}/LOG.md`], undefined);
});

test('mc goal new cannot fail on a worktree, since it makes none: a git that refuses worktrees changes nothing', async () => {
  const f = fixture({ git: (cwd, args) => (args[0] === 'worktree' ? failed('branch in use') : allOk()) });
  assert.equal(await run(['new', 'mc/plain', '--repo', 'memoro', '--class', 'fast', '--title', 'T'], f.deps), 0, f.err());
  assert.equal(f.calls.some((call) => call.args[0] === 'worktree'), false);
  assert.equal(goalField(f.store[`${DIR}/GOAL.json`], 'stage'), 'plan');
});

test('mc goal log appends one entry, tagged with MC_TOOL and MC_MODEL, and the goal is MC_GOAL\'s when not named', async () => {
  const f = fixture({ files: seededGoal(), env: { MC_GOAL: 'mc/plain', MC_TOOL: 'claude', MC_MODEL: 'claude-haiku-5-5' } });
  assert.equal(await run(['log', '--done', 'the verb', '--next', 'the page'], f.deps), 0, f.err());
  const entries = parseLog(f.store[`${DIR}/LOG.md`]);
  assert.equal(entries.length, 5);
  assert.deepEqual(entries.at(-1), {
    at: '2026-11-01T20:00Z', tool: 'claude', model: 'claude-haiku-5-5', stage: 'build', status: 'ready', role: null, done: 'the verb', comment: null, next: 'the page',
  });
  assert.equal(f.store[`${DIR}/GOAL.json`], GOAL_TEXT, 'a log entry alone leaves GOAL.json as it is');
});

test('mc goal log with neither MC_TOOL nor MC_MODEL writes a person\'s entry', async () => {
  const f = fixture({ files: seededGoal() });
  assert.equal(await run(['log', 'mc/plain', '--comment', 'a note'], f.deps), 0, f.err());
  assert.deepEqual(parseLog(f.store[`${DIR}/LOG.md`]).at(-1), {
    at: '2026-11-01T20:00Z', tool: 'person', model: null, stage: 'build', status: 'ready', role: null, done: null, comment: 'a note', next: null,
  });
});

test('mc goal log refuses without a goal, without anything to log, and with a goal that is not one', async () => {
  const none = fixture({ files: seededGoal() });
  assert.equal(await run(['log', '--done', 'x'], none.deps), 2);
  assert.match(none.err(), /which goal\?/u);

  const empty = fixture({ files: seededGoal(), env: { MC_GOAL: 'mc/plain' } });
  assert.equal(await run(['log'], empty.deps), 2);
  assert.match(empty.err(), /log needs --done, --comment, --next, --stage or --status/u);

  const badName = fixture({ files: seededGoal() });
  assert.equal(await run(['log', 'plain', '--done', 'x'], badName.deps), 2);
  assert.match(badName.err(), /plain is not <programme>\/<goal>/u);

  const absent = fixture();
  assert.equal(await run(['log', 'mc/plain', '--done', 'x'], absent.deps), 1);
  assert.match(absent.err(), /no goal mc\/plain/u);

  const broken = fixture({ files: seededGoal({ [`${DIR}/GOAL.json`]: 'no json\n' }) });
  assert.equal(await run(['log', 'mc/plain', '--done', 'x'], broken.deps), 1);
  assert.match(broken.err(), /mc\/plain: GOAL\.json is not JSON/u);
  assert.equal(broken.store[`${DIR}/LOG.md`], LOG_TEXT, 'a goal that does not parse gets no entry');
});

test('mc goal log --done-file keeps a file\'s text verbatim, read by the real command in a temporary programme', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mc-goal-log-'));
  try {
    const dir = join(home, 'mc', 'goals', 'plain');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'GOAL.json'), GOAL_TEXT);
    writeFileSync(join(dir, 'LOG.md'), LOG_TEXT);
    const done = join(home, 'done.txt');
    writeFileSync(done, 'a `x` $(y) "q"\nline2\n');
    const comment = join(home, 'comment.txt');
    writeFileSync(comment, 'Comment with $HOME and `date`\n');
    const out = [];
    const err = [];
    const code = await run(['log', 'mc/plain', '--done-file', done, '--comment-file', comment, '--next', 'the page'], {
      home, env: { MC_TOOL: 'claude', MC_MODEL: 'claude-haiku-5-5' }, now: () => new Date('2026-11-01T20:00:00Z'),
      stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) },
    });
    assert.equal(code, 0, err.join(''));
    const log = readFileSync(join(dir, 'LOG.md'), 'utf8');
    assert.ok(log.endsWith('Done: a `x` $(y) "q"\nline2\nComment: Comment with $HOME and `date`\nNext: the page\n'), log);
    assert.deepEqual(parseLog(log).at(-1), {
      at: '2026-11-01T20:00Z', tool: 'claude', model: 'claude-haiku-5-5', stage: 'build', status: 'ready', role: null,
      done: 'a `x` $(y) "q"\nline2', comment: 'Comment with $HOME and `date`', next: 'the page',
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('mc goal log --done-file - reads stdin verbatim; a field given both ways, stdin twice, a missing or an empty file are refused and write nothing', async () => {
  const files = { '-': 'a `x` $(y) "q"\nline2\n', 'note.txt': 'the note $(z)\n', 'empty.txt': '\n' };
  const f = fixture({ files: seededGoal(), env: { MC_GOAL: 'mc/plain', MC_TOOL: 'claude' } });
  f.deps.readFile = (path) => {
    if (!Object.hasOwn(files, path)) throw new Error('ENOENT');
    return files[path];
  };
  const refusals = [
    [['log', '--done', 'x', '--done-file', 'note.txt'], 2, /--done and --done-file are one or the other, not both/u],
    [['log', '--next-file', 'note.txt', '--next', 'x'], 2, /--next and --next-file are one or the other, not both/u],
    [['log', '--done-file', '-', '--comment-file', '-'], 2, /stdin is read once/u],
    [['log', '--next-file', 'missing.txt'], 1, /--next-file missing\.txt cannot be read/u],
    [['log', '--comment-file', 'empty.txt'], 2, /--comment-file empty\.txt is empty/u],
  ];
  for (const [argv, code, message] of refusals) {
    assert.equal(await run(argv, f.deps), code, argv.join(' '));
    assert.match(f.err(), message);
    assert.equal(f.store[`${DIR}/LOG.md`], LOG_TEXT, `${argv.join(' ')} writes nothing`);
  }
  assert.equal(await run(['log', '--done-file', '-', '--comment-file', 'note.txt'], f.deps), 0, f.err());
  assert.deepEqual(parseLog(f.store[`${DIR}/LOG.md`]).at(-1), {
    at: '2026-11-01T20:00Z', tool: 'claude', model: null, stage: 'build', status: 'ready', role: null,
    done: 'a `x` $(y) "q"\nline2', comment: 'the note $(z)', next: null,
  });
});

test('mc goal log --status and --stage rewrite GOAL.json and log the entry with both; an unknown one is refused naming the field', async () => {
  const f = fixture({ files: seededGoal() });
  assert.equal(await run(['log', 'mc/plain', '--status', 'blocked', '--comment', 'waits for Martin'], f.deps), 0, f.err());
  assert.equal(f.store[`${DIR}/GOAL.json`], withGoal(GOAL_TEXT, { status: 'blocked' }), 'the stage stays');
  assert.deepEqual(['stage', 'status', 'comment'].map((key) => parseLog(f.store[`${DIR}/LOG.md`]).at(-1)[key]), ['build', 'blocked', 'waits for Martin']);
  assert.match(f.out(), /mc: mc\/plain · build · blocked\n/u);

  for (const [flag, value, said] of [['--status', 'open', /^mc: status is ready, blocked, Martin, not open\n$/u], ['--stage', 'started', /^mc: stage is plan, build, review, finish, merge, done, dropped, not started\n$/u]]) {
    const bad = fixture({ files: seededGoal() });
    assert.equal(await run(['log', 'mc/plain', flag, value, '--comment', 'x'], bad.deps), 2);
    assert.match(bad.err(), said);
    assert.equal(bad.store[`${DIR}/LOG.md`], LOG_TEXT, 'nothing written');
  }
});

test('mc goal blocked, ready, done and drop set their one field and log the reason; a blocked goal set ready keeps its stage', async () => {
  for (const [verb, stage, status] of [['martin', 'build', 'Martin'], ['blocked', 'build', 'blocked'], ['done', 'done', 'ready'], ['drop', 'dropped', 'ready']]) {
    const f = fixture({ files: seededGoal(), env: { MC_GOAL: 'mc/plain' } });
    assert.equal(await run([verb, '--reason', `because ${verb}`], f.deps), 0, f.err());
    const goal = parseGoal(f.store[`${DIR}/GOAL.json`]);
    assert.deepEqual([goal.stage, goal.status], [stage, status], verb);
    const last = parseLog(f.store[`${DIR}/LOG.md`]).at(-1);
    assert.deepEqual([last.stage, last.status, last.comment], [stage, status, `because ${verb}`]);
  }
  const held = fixture({ files: seededGoal({ [`${DIR}/GOAL.json`]: withGoal(GOAL_TEXT, { stage: 'merge', status: 'blocked' }) }) });
  assert.equal(await run(['ready', 'mc/plain', '--reason', 'answered'], held.deps), 0, held.err());
  assert.deepEqual(['stage', 'status'].map((key) => goalField(held.store[`${DIR}/GOAL.json`], key)), ['merge', 'ready']);
  const f = fixture({ files: seededGoal() });
  assert.equal(await run(['drop', 'mc/plain'], f.deps), 2);
  assert.match(f.err(), /drop needs --reason/u);
  assert.equal(await run(['blocked', '--done', 'x'], f.deps), 2);
  assert.match(f.err(), /blocked takes no --done/u);
});

/**
 * A goal's branch is made when the goal can start: one written in plan got its
 * branch at `mc goal new`, before the phases ahead of it landed.
 */
test('mc goal stage build remakes a branch with no commits of its own from origin/main, and leaves one with commits alone', async () => {
  const planned = seededGoal({ [`${DIR}/GOAL.json`]: withGoal(GOAL_TEXT, { stage: 'plan' }) });
  const counts = ({ own, behind }) => (cwd, args) => {
    if (args[0] === 'rev-list') return ok(`${args[2] === 'origin/main..HEAD' ? own : behind}\n`);
    return ok();
  };

  const fresh = fixture({ files: planned, git: counts({ own: 0, behind: 7 }) });
  assert.equal(await run(['stage', 'mc/plain', 'build', '--reason', 'the brief is written'], fresh.deps), 0, fresh.err());
  const reset = fresh.calls.find((call) => call.args[0] === 'reset');
  assert.deepEqual(reset, { cwd: `${DIR}/memoro-cli`, args: ['reset', '-q', '--keep', 'origin/main'] });
  assert.ok(fresh.calls.findIndex((call) => call.args[0] === 'fetch') < fresh.calls.indexOf(reset), 'fetched first');
  assert.match(fresh.out(), /memoro-cli {2}goal\/plain remade from origin\/main — it had no commits of its own, and main has 7 more/u);

  const built = fixture({ files: planned, git: counts({ own: 3, behind: 7 }) });
  assert.equal(await run(['stage', 'mc/plain', 'build'], built.deps), 0, built.err());
  assert.equal(built.calls.some((call) => call.args[0] === 'reset'), false, 'a branch with commits is never moved');
  assert.match(built.out(), /goal\/plain left as it is — 3 commits of its own/u);

  const already = fixture({ files: seededGoal(), git: counts({ own: 0, behind: 7 }) });
  assert.equal(await run(['stage', 'mc/plain', 'build'], already.deps), 0, already.err());
  assert.equal(already.calls.some((call) => call.args[0] === 'reset'), false, 'a goal already in build is not a goal going to build');
});

/* ------------------------------------------------- stages: forward only, by role */

const SESSION = { MC_GOAL: 'mc/plain', MC_TOOL: 'claude', MC_MODEL: 'opus' };
const BUILD = { ...SESSION, MC_ROLE: BUILD_ROLES.goal };
const REVIEW = { ...SESSION, MC_ROLE: REVIEW_ROLE, MC_REVIEW_HEAD: 'abc1234def' };
const PLAN = { ...SESSION, MC_ROLE: PLAN_ROLE };
const MET = [{ criterion: 'it works', check: 'a test', met: true }];
/** A goal in `stage`, with its one criterion met. */
const inStage = (stage, status = 'ready', extra = {}) => seededGoal({ [`${DIR}/GOAL.json`]: withGoal(GOAL_TEXT, { stage, status, success_criteria: MET }), ...extra });
const stateOf = (f) => ['stage', 'status'].map((key) => goalField(f.store[`${DIR}/GOAL.json`], key)).join(' · ');

/** A fixture whose `gh pr list --head` answers `pr` (null: none) and whose queue is recorded. */
function reviewed({ files, env = REVIEW, pr = { number: 31, headRefOid: 'fff0000' }, queue = null } = {}) {
  const f = fixture({ files, env });
  f.queued = [];
  f.gh = [];
  f.deps.gh = (cwd, args) => { f.gh.push({ cwd, args }); return ok(JSON.stringify(pr ? [pr] : [])); };
  f.deps.queue = queue ?? ((options) => { f.queued.push(options); return { place: 0 }; });
  return f;
}

test('every move of the order, by its owner: plan → build by plan, build → review by build, review → merge or finish by review, finish → merge by plan, merge → done by a person; dropped from any stage by plan', async () => {
  const moves = [
    ['plan', 'build', PLAN], ['build', 'review', BUILD], ['review', 'merge', REVIEW], ['review', 'finish', REVIEW],
    ['finish', 'merge', PLAN], ['merge', 'done', {}], ['plan', 'review', PLAN], ['finish', 'dropped', PLAN], ['build', 'dropped', PLAN],
  ];
  for (const [from, to, env] of moves) {
    const f = reviewed({ files: inStage(from, 'ready', { [`${DIR}/REVIEW.md`]: 'head abc1234def: the page is wrong\n' }), env });
    assert.equal(await run(['stage', ...(env.MC_GOAL ? [] : ['mc/plain']), to], f.deps), 0, `${from} → ${to}: ${f.err()}`);
    assert.equal(stateOf(f), `${to} · ready`, `${from} → ${to}`);
    assert.equal(parseLog(f.store[`${DIR}/LOG.md`]).at(-1).stage, to);
  }
});

test('a session\'s backward move is refused naming both stages, whatever its role; a person\'s is made and logged', async () => {
  for (const [from, to, env] of [['review', 'build', PLAN], ['merge', 'review', PLAN], ['finish', 'build', REVIEW], ['review', 'build', BUILD], ['done', 'merge', PLAN], ['finish', 'plan', SESSION]]) {
    const f = fixture({ files: inStage(from), env });
    assert.equal(await run(['stage', to], f.deps), 2, `${from} → ${to}`);
    assert.equal(f.err(), `mc: a session does not move a goal back — ${from} → ${to}; only a person does (mc goal stage <programme>/<goal> ${to}, MC_TOOL=person)\n`);
    assert.equal(f.store[`${DIR}/LOG.md`], LOG_TEXT, 'nothing written');
  }
  for (const env of [{}, { MC_GOAL: 'mc/plain', MC_TOOL: 'person' }]) {
    const f = fixture({ files: inStage('merge'), env });
    assert.equal(await run(['stage', 'mc/plain', 'build', '--reason', 'the plan was wrong'], f.deps), 0, f.err());
    assert.equal(stateOf(f), 'build · ready');
    const last = parseLog(f.store[`${DIR}/LOG.md`]).at(-1);
    assert.deepEqual([last.tool, last.stage, last.comment], ['person', 'build', 'the plan was wrong — moved back from merge to build by a person']);
    assert.match(f.out(), /mc: mc\/plain · build · ready — moved back from merge\n/u);
  }
});

test('mc goal log and new name the session that wrote the entry by its role in the heading: build, review, plan; a person, or no role, writes none', async () => {
  const cases = [
    [{ MC_GOAL: 'mc/plain', MC_TOOL: 'claude', MC_ROLE: BUILD_ROLES.goal }, ['--stage', 'review', '--done', 'x'], '· claude · review · ready · by build', 'review', 'build'],
    [{ MC_GOAL: 'mc/plain', MC_TOOL: 'claude', MC_ROLE: REVIEW_ROLE }, ['--done', 'x'], '· claude · build · ready · by review', 'build', 'review'],
    [{ MC_GOAL: 'mc/plain', MC_TOOL: 'claude', MC_ROLE: PLAN_ROLE }, ['--done', 'x'], '· claude · build · ready · by plan', 'build', 'plan'],
    [{ MC_GOAL: 'mc/plain', MC_TOOL: 'person', MC_ROLE: BUILD_ROLES.goal }, ['--done', 'x'], '· person · build · ready', 'build', null],
    [{ MC_GOAL: 'mc/plain', MC_TOOL: 'claude' }, ['--done', 'x'], '· claude · build · ready', 'build', null],
  ];
  for (const [env, args, heading, stage, role] of cases) {
    const f = fixture({ files: inStage('build'), env });
    assert.equal(await run(['log', ...args], f.deps), 0, `${heading}: ${f.err()}`);
    const last = f.store[`${DIR}/LOG.md`].match(/^## .*$/gmu).at(-1);
    assert.equal(last, `## 2026-11-01T20:00Z ${heading}`, JSON.stringify(env));
    const entry = parseLog(f.store[`${DIR}/LOG.md`]).at(-1);
    assert.deepEqual([entry.role, entry.stage], [role, stage]);
  }
  const created = fixture({ env: { MC_TOOL: 'claude', MC_ROLE: PLAN_ROLE } });
  assert.equal(await run(['new', 'mc/plain', '--repo', 'memoro', '--class', 'fast', '--title', 'T'], created.deps), 0, created.err());
  assert.equal(created.store[`${DIR}/LOG.md`], '## 2026-11-01T20:00Z · claude · plan · ready · by plan\n\nDone: created\n');
});

test('a build session moves build to review or sets blocked, and nothing else', async () => {
  const blocked = fixture({ files: inStage('build'), env: BUILD });
  assert.equal(await run(['log', '--comment', 'which table?', '--status', 'blocked'], blocked.deps), 0, blocked.err());
  assert.equal(stateOf(blocked), 'build · blocked');
  for (const [from, argv, said] of [
    ['build', ['stage', 'done'], /a session does not set done — move it to review; the merger sets done/u],
    ['build', ['drop', '--reason', 'x'], /only plan or a person drops a goal/u],
    ['build', ['stage', 'merge'], /a build session moves a goal only from build to review, not build → merge/u],
    ['plan', ['stage', 'build'], /a build session moves a goal only from build to review, not plan → build/u],
    ['build', ['ready'], /a build session does not set a goal ready — plan or a person does/u],
  ]) {
    const f = fixture({ files: inStage(from), env: BUILD });
    assert.equal(await run(argv, f.deps), 2, argv.join(' '));
    assert.match(f.err(), said);
    assert.equal(f.store[`${DIR}/LOG.md`], LOG_TEXT, 'nothing written');
  }
});

test('a build session cannot move to review while a criterion is not met: the refusal names its number, and nothing is written', async () => {
  const two = withGoal(GOAL_TEXT, { success_criteria: [{ criterion: 'a', check: 'x', met: true }, { criterion: 'b', check: 'y', met: false }] });
  for (const argv of [['log', '--done', 'built', '--stage', 'review'], ['stage', 'review', '--reason', 'built']]) {
    const f = fixture({ files: seededGoal({ [`${DIR}/GOAL.json`]: two }), env: BUILD });
    assert.equal(await run(argv, f.deps), 1, argv.join(' '));
    assert.match(f.err(), /mc\/plain is not moved to review — criterion 2 is not met — run its check and record it with mc goal criterion met mc\/plain 2/u);
    assert.equal(f.store[`${DIR}/GOAL.json`], two, 'nothing written');
    assert.equal(f.store[`${DIR}/LOG.md`], LOG_TEXT, 'no entry');
  }
  const none = fixture({ files: seededGoal({ [`${DIR}/GOAL.json`]: withGoal(GOAL_TEXT, { success_criteria: [] }) }), env: BUILD });
  assert.equal(await run(['stage', 'review'], none.deps), 1);
  assert.match(none.err(), /mc\/plain has no criterion — mc goal criterion add/u);

  // Once it is met the same call goes through; a plan session or a person is not refused.
  const met = fixture({ files: seededGoal({ [`${DIR}/GOAL.json`]: two }), env: BUILD });
  assert.equal(await run(['criterion', 'met', '2'], met.deps), 0, met.err());
  assert.equal(await run(['stage', 'review', '--reason', 'built'], met.deps), 0, met.err());
  for (const env of [PLAN, {}]) {
    const f = fixture({ files: seededGoal({ [`${DIR}/GOAL.json`]: two }), env });
    assert.equal(await run(['stage', 'mc/plain', 'review'], f.deps), 0, f.err());
  }
});

test('review and plan execute merge for every registered PR without head, criteria or GitHub checks', async () => {
  for (const env of [{ ...REVIEW, MC_REVIEW_HEAD: undefined }, PLAN]) {
    const files = inStage(env.MC_ROLE === PLAN_ROLE ? 'finish' : 'review');
    files[`${DIR}/GOAL.json`] = withGoal(files[`${DIR}/GOAL.json`], {
      repos: ['memoro-cli', 'memoro'], prs: ['memoro-cli#31', 'memoro#14804'], success_criteria: [],
    });
    const f = reviewed({ files, env });
    assert.equal(await run(['stage', 'merge'], f.deps), 0, f.err());
    assert.equal(stateOf(f), 'merge · ready');
    assert.deepEqual(f.gh, []);
    assert.deepEqual(f.queued.map(({ repo, pr, sha }) => ({ repo, pr, sha })), [
      { repo: 'memoro-cli', pr: 31, sha: undefined }, { repo: 'memoro', pr: 14804, sha: undefined },
    ]);
    assert.deepEqual(f.queued[1].goal, { programme: 'mc', goal: 'plain', dir: DIR });
  }
});

test('a queue failure preserves the merge decision so it can be retried', async () => {
  const files = inStage('review');
  files[`${DIR}/GOAL.json`] = withGoal(files[`${DIR}/GOAL.json`], { prs: ['memoro-cli#31'] });
  const f = reviewed({ files, queue: () => { throw new Error('register locked'); } });
  assert.equal(await run(['stage', 'merge'], f.deps), 1);
  assert.equal(stateOf(f), 'merge · ready');
  assert.match(f.err(), /memoro-cli#31 could not be queued/u);
  f.deps.queue = (job) => { f.queued.push(job); };
  assert.equal(await run(['stage', 'merge'], { ...f.deps, env: PLAN }), 0, f.err());
  assert.deepEqual(f.queued.map((job) => [job.repo, job.pr]), [['memoro-cli', 31]]);
});

test('a partial merge enqueue does not release its session before all PRs are handed off', async () => {
  const env = { ...REVIEW, MC_HEADLESS: '1', MC_SCRATCH: '/scratch' };
  const files = inStage('review');
  files[`${DIR}/GOAL.json`] = withGoal(files[`${DIR}/GOAL.json`], { prs: ['memoro-cli#31', 'memoro#32'] });
  const f = reviewed({ files, env, queue: (job) => {
    if (job.pr === 32) throw new Error('queue locked');
  } });
  assert.equal(await run(['stage', 'merge'], f.deps), 1);
  assert.equal(f.store['/scratch/.mc-merge-handoff.json'], undefined);
  f.deps.queue = () => {};
  assert.equal(await run(['stage', 'merge'], f.deps), 0);
  assert.deepEqual(JSON.parse(f.store['/scratch/.mc-merge-handoff.json']), { goal: 'mc/plain' });
});

describe('mc goal stage against a real origin/main', () => {
  // One origin, main at its first commit. Goal g's worktree edits shared.md, which main then edits: a conflict.
  // Goal h's worktree edits only other.md, so it is behind main and merges cleanly. Real git and real files.
  let root;
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const goalDir = (goal) => join(root, 'home', 'prog', 'goals', goal);
  const worktree = (goal) => join(goalDir(goal), 'memoro');
  const stageOf = (goal) => parseGoal(readFileSync(join(goalDir(goal), GOAL_FILE), 'utf8')).stage;
  const deps = (sink) => ({
    home: join(root, 'home'), env: {}, now: () => new Date('2026-11-01T20:00:00Z'),
    stdout: { write() {} }, stderr: { write: (text) => { sink.text += text; } },
  });

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'mc-goal-main-'));
    const origin = join(root, 'memoro.git');
    const seed = join(root, 'seed');
    git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
    git(root, ['init', '-q', '-b', 'main', seed]);
    writeFileSync(join(seed, 'shared.md'), 'one\ntwo\n');
    writeFileSync(join(seed, 'other.md'), 'x\n');
    git(seed, ['add', '.']);
    git(seed, ['commit', '-q', '-m', 'base']);
    git(seed, ['remote', 'add', 'origin', origin]);
    git(seed, ['push', '-q', 'origin', 'main']);
    for (const goal of ['g', 'h']) {
      mkdirSync(goalDir(goal), { recursive: true });
      writeFileSync(join(goalDir(goal), GOAL_FILE), goalJson({ repos: ['memoro'], stage: 'build', status: 'ready' }));
      git(goalDir(goal), ['clone', '-q', origin, 'memoro']);
      git(worktree(goal), ['checkout', '-q', '-b', `goal/${goal}`]);
    }
    writeFileSync(join(worktree('g'), 'shared.md'), 'BRANCH\ntwo\n');
    git(worktree('g'), ['commit', '-q', '-am', 'g edits the shared line']);
    writeFileSync(join(worktree('h'), 'other.md'), 'y\n');
    git(worktree('h'), ['commit', '-q', '-am', 'h edits another file']);
    writeFileSync(join(seed, 'shared.md'), 'MAIN\ntwo\n');
    git(seed, ['commit', '-q', '-am', 'main edits the shared line']);
    git(seed, ['push', '-q', 'origin', 'main']);
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  test('review is refused for a goal whose branch conflicts with origin/main, naming the path; the goal stays where it was', async () => {
    const review = { text: '' };
    assert.equal(await run(['stage', 'prog/g', 'review'], deps(review)), 1);
    assert.equal(review.text, 'mc: prog/g is not moved to review — the branch conflicts with origin/main in memoro/shared.md — rebase onto origin/main, then run this again\n');
    assert.equal(stageOf('g'), 'build');
  });

  test('merge is refused for the same conflicting goal, naming the path; the goal stays where it was', async () => {
    const merge = { text: '' };
    assert.equal(await run(['stage', 'prog/g', 'merge'], deps(merge)), 1);
    assert.match(merge.text, /^mc: prog\/g is not moved to merge — the branch conflicts with origin\/main in memoro\/shared\.md/u);
    assert.equal(stageOf('g'), 'build');
  });

  test('a branch only behind origin/main, with no conflict, moves to review', async () => {
    const sink = { text: '' };
    assert.equal(await run(['stage', 'prog/h', 'review'], deps(sink)), 0, sink.text);
    assert.equal(stageOf('h'), 'review');
    assert.equal(sink.text, '');
  });
});

test('a repository with no worktree is not checked: the goal moves to review on one line, and git is not asked of it', async () => {
  const asked = [];
  const f = fixture({ files: seededGoal(), absent: [`${DIR}/memoro-cli`] });
  f.deps.mainCheck = (dir) => { asked.push(dir); return { fetch: { ok: false, text: 'could not read from remote' }, paths: [] }; };
  assert.equal(await run(['stage', 'mc/plain', 'review'], f.deps), 0, f.err());
  assert.deepEqual(asked, [], 'the absent worktree is not checked');
  assert.equal(f.err(), 'mc: memoro-cli: no worktree — not checked against origin/main\n');
  assert.equal(goalField(f.store[`${DIR}/GOAL.json`], 'stage'), 'review');
});

test('a failed fetch before review is a warning: the goal moves, and its merge is checked against the origin/main it holds', async () => {
  const f = fixture({ files: seededGoal() });
  f.deps.mainCheck = () => ({ fetch: { ok: false, text: 'could not read from remote' }, paths: [] });
  assert.equal(await run(['stage', 'mc/plain', 'review'], f.deps), 0, f.err());
  assert.equal(f.err(), 'mc: warning: memoro-cli: git fetch origin failed (could not read from remote) — checked against the origin/main already held\n');
  assert.equal(goalField(f.store[`${DIR}/GOAL.json`], 'stage'), 'review');
});

test('a review\'s finish is refused until REVIEW.md is written; a review sets no status and moves only a goal in review, to merge or finish', async () => {
  const f = reviewed({ files: inStage('review') });
  assert.equal(await run(['stage', 'finish'], f.deps), 2);
  assert.equal(f.err(), `mc: a review sends a goal to finish with REVIEW.md — write ${DIR}/REVIEW.md first: the head judged, what is wrong and where\n`);
  f.store[`${DIR}/REVIEW.md`] = 'head abc1234def: criterion 2 fails\n';
  assert.equal(await run(['stage', 'finish'], f.deps), 0, f.err());
  assert.equal(stateOf(f), 'finish · ready');
  assert.equal(f.queued.length, 0, 'nothing queued for a finish');
  for (const [from, argv, said] of [
    ['review', ['ready', '--reason', 'x'], /a review sets no status — it ends with mc goal stage merge \(OK to land\) or finish/u],
    ['review', ['stage', 'done'], /a review ends in merge or finish, not done/u],
    ['build', ['stage', 'merge'], /a review moves only a goal in review, and this one is build/u],
  ]) {
    const g = reviewed({ files: inStage(from), env: REVIEW });
    assert.equal(await run(argv, g.deps), 2, argv.join(' '));
    assert.match(g.err(), said);
  }
});

test('refusedMove: a person may make any move; a plan session any forward one; nobody else more than their own', () => {
  for (const to of STAGES) assert.equal(refusedMove({ from: 'merge', to, env: {} }), null, `a person to ${to}`);
  for (const to of ['build', 'review', 'finish', 'merge', 'done', 'dropped']) assert.equal(refusedMove({ from: 'plan', to, env: PLAN }), null, `plan to ${to}`);
  assert.equal(refusedMove({ from: 'build', status: 'blocked', env: PLAN }), null);
  assert.equal(refusedMove({ from: 'build', to: 'review', env: BUILD }), null);
  assert.equal(refusedMove({ from: 'review', to: 'merge', env: REVIEW }), null);
  assert.equal(refusedMove({ from: 'review', to: 'finish', env: REVIEW, reviewWritten: true }), null);
  assert.equal(refusedMove({ from: 'build', env: BUILD }), null, 'an entry alone');
});

test('mc goal set, document add and criterion add fill a goal through verbs; criterion met and unmet record it', async () => {
  const f = fixture({ files: seededGoal({ [`${DIR}/GOAL.json`]: withGoal(GOAL_TEXT, { success_criteria: [] }) }) });
  assert.equal(await run(['set', 'mc/plain', 'goal', '--text', 'First paragraph.\n\nSecond\nparagraph.'], f.deps), 0, f.err());
  assert.equal(await run(['set', 'mc/plain', 'contract', '--text', 'No new dependency.'], f.deps), 0, f.err());
  assert.equal(await run(['set', 'mc/plain', 'out-of-scope', '--text', 'Phases.'], f.deps), 0, f.err());
  assert.equal(await run(['set', 'mc/plain', 'title', '--text', 'Plainer'], f.deps), 0, f.err());
  assert.equal(await run(['document', 'add', 'mc/plain', '--label', 'the doc', '--path', 'docs/technical/mc-goals.md'], f.deps), 0, f.err());
  assert.equal(await run(['criterion', 'add', 'mc/plain', '--criterion', 'it parses', '--check', 'mc gate tests/mc/goals.test.js'], f.deps), 0, f.err());
  assert.equal(await run(['criterion', 'add', 'mc/plain', '--criterion', 'it shows', '--check', 'a test'], f.deps), 0, f.err());
  assert.match(f.out(), /mc\/plain · criterion 2 added · criteria 0\/2/u);
  assert.equal(await run(['criterion', 'met', 'mc/plain', '1'], f.deps), 0, f.err());
  assert.match(f.out(), /mc\/plain · criterion 1 met · criteria 1\/2/u);
  const goal = parseGoal(f.store[`${DIR}/GOAL.json`]);
  assert.equal(goal.title, 'Plainer');
  assert.deepEqual(goal.goal, ['First paragraph.', 'Second\nparagraph.']);
  assert.deepEqual(goal.contract, ['No new dependency.']);
  assert.deepEqual(goal.out_of_scope, ['Phases.']);
  assert.deepEqual(goal.documents, [{ label: 'the doc', path: 'docs/technical/mc-goals.md' }]);
  assert.deepEqual(goal.success_criteria, [
    { criterion: 'it parses', check: 'mc gate tests/mc/goals.test.js', met: true },
    { criterion: 'it shows', check: 'a test', met: false },
  ]);
  assert.equal(await run(['criterion', 'unmet', 'mc/plain', '1'], f.deps), 0, f.err());
  assert.equal(parseGoal(f.store[`${DIR}/GOAL.json`]).success_criteria[0].met, false);
});

test('the goal verbs refuse what would not validate, and write nothing', async () => {
  const f = fixture({ files: seededGoal() });
  const before = f.store[`${DIR}/GOAL.json`];
  assert.equal(await run(['criterion', 'add', 'mc/plain', '--criterion', 'no check'], f.deps), 2);
  assert.match(f.err(), /criterion add needs --check/u);
  assert.equal(await run(['criterion', 'met', 'mc/plain', '3'], f.deps), 1);
  assert.match(f.err(), /it has 1 criteria, no criterion 3/u);
  assert.equal(await run(['criterion', 'met', 'mc/plain', 'x'], f.deps), 2);
  assert.equal(await run(['set', 'mc/plain', 'title', '--text', '  '], f.deps), 1);
  assert.match(f.err(), /title: what the goal is/u);
  assert.equal(await run(['set', 'mc/plain', 'steps', '--text', 'x'], f.deps), 2);
  assert.equal(await run(['document', 'add', 'mc/plain', '--label', 'x'], f.deps), 2);
  assert.equal(f.store[`${DIR}/GOAL.json`], before, 'nothing written');
});

test('mc goal show prints the status line, the goal as text with each criterion\'s ✓/✗ and check, the last three entries, and each worktree\'s state', async () => {
  const git = (cwd, args) => {
    if (cwd === `${DIR}/memoro` && args[0] === 'status') return failed('not a worktree');
    if (args[0] === 'status') return ok(' M src/a.js\n?? notes.md\n');
    if (args[0] === 'rev-list') return ok('2\n');
    if (args[0] === 'log') return ok('2026-11-01T21:00:00+01:00\n');
    return allOk();
  };
  const criteria = [{ criterion: 'it parses', check: 'mc gate tests/mc/goals.test.js', met: true }, { criterion: 'it shows', check: 'a test on the text', met: false }];
  const f = fixture({ files: seededGoal({ [`${DIR}/GOAL.json`]: withGoal(GOAL_TEXT, { repos: ['memoro-cli', 'memoro'], success_criteria: criteria }) }), git });
  assert.equal(await run(['show', 'mc/plain'], f.deps), 0, f.err());
  const text = f.out();
  assert.match(text, /^mc\/plain · build · ready · phase 1 · memoro-cli, memoro · large · criteria 1\/2 · created 2026-11-01T20:00:00Z\n/u);
  assert.match(text, /\n# Make the goal plain\n\nGOAL\n  Two files and a worktree\./u);
  assert.match(text, /\nCRITERIA 1\/2\n  1 ✓ it parses\n      check: mc gate tests\/mc\/goals\.test\.js\n  2 ✗ it shows\n      check: a test on the text\n/u);
  assert.doesNotMatch(text, /Done: created/u, 'only the last three entries');
  assert.match(text, /Done: the reader\nNext: the verbs/u);
  assert.match(text, /Comment: no session ran/u);
  assert.match(text, new RegExp(`memoro-cli  ${DIR}/memoro-cli  2 changed · 2 commits past origin/main · last commit 2026-11-01T21:00:00\\+01:00`, 'u'));
  assert.match(text, new RegExp(`memoro  ${DIR}/memoro — no worktree`, 'u'));
  assert.deepEqual(f.calls.map((c) => c.args[0]), ['status', 'rev-list', 'log', 'status']);
});

test('mc goal show refuses a goal that does not parse, and says why', async () => {
  const f = fixture({ files: seededGoal({ [`${DIR}/GOAL.json`]: withGoal(GOAL_TEXT, { status: 'maybe' }) }) });
  assert.equal(await run(['show', 'mc/plain'], f.deps), 1);
  assert.match(f.err(), /mc\/plain does not parse:/u);
  assert.match(f.err(), /status: one of ready, blocked, Martin, not maybe/u);
});

test('mc goal list prints one line a goal: its name, repositories, status, criteria, sessions and what is next', async () => {
  const f = fixture({
    files: {
      ...seededGoal(),
      [`${HOME}/mc/goals/broken/GOAL.json`]: 'nothing here\n',
    },
  });
  assert.equal(await run(['list'], f.deps), 0);
  const lines = f.out().trim().split('\n');
  assert.equal(lines[0], 'mc · phase 1 · in progress');
  // Two sessions wrote entries; the last entry is the runner's, and it sets no Next.
  assert.equal(lines[1], '  mc/plain · memoro-cli · build · ready · criteria 0/1 · 2 sessions · —');
  assert.match(lines[2], /^ {2}mc\/broken · does not parse — GOAL\.json is not JSON/u, 'a goal that does not parse has no phase, and comes last');
});

test('mc goal list says criteria 1/2 for a goal with one of two met, and a goal in build with none is not started', async () => {
  const f = fixture({
    files: {
      ...seededGoal({ [`${DIR}/GOAL.json`]: withGoal(GOAL_TEXT, { success_criteria: [{ criterion: 'a', check: 'x', met: true }, { criterion: 'b', check: 'y', met: false }] }) }),
      [`${HOME}/mc/goals/skeleton/GOAL.json`]: withGoal(GOAL_TEXT, { success_criteria: [] }),
    },
  });
  assert.equal(await run(['list'], f.deps), 0, f.err());
  assert.deepEqual(f.out().trim().split('\n').slice(1), [
    '  mc/plain · memoro-cli · build · ready · criteria 1/2 · 2 sessions · —',
    '  mc/skeleton · memoro-cli · build · ready, no criteria — not started · criteria 0/0 · 0 sessions · —',
  ]);
});

test('mc goal list shows each goal\'s stage · status, and a blocked one as waiting on a person', async () => {
  const goal = (stage, status = 'ready') => withGoal(GOAL_TEXT, { stage, status });
  const f = fixture({
    files: {
      [`${HOME}/mc/goals/a/GOAL.json`]: goal('review'),
      [`${HOME}/mc/goals/a/LOG.md`]: '## 2026-11-02T10:00Z · claude opus · review · ready\n\nDone: built\n',
      [`${HOME}/mc/goals/b/GOAL.json`]: goal('finish', 'blocked'),
      [`${HOME}/mc/goals/b/LOG.md`]: '## 2026-11-02T10:00Z · runner · finish · blocked\n\nComment: the finish session ended with the goal still in finish\n',
      [`${HOME}/mc/goals/c/GOAL.json`]: goal('merge'),
      [`${HOME}/mc/goals/c/LOG.md`]: '## 2026-11-02T10:00Z · runner · merge · ready\n\nDone: merger answered red on #12\n',
      [`${HOME}/mc/goals/d/GOAL.json`]: goal('plan'),
    },
  });
  assert.equal(await run(['list'], f.deps), 0, f.err());
  assert.deepEqual(f.out().trim().split('\n').slice(1), [
    '  mc/a · memoro-cli · review · ready · criteria 0/1 · 1 sessions · —',
    '  mc/b · memoro-cli · finish · blocked · criteria 0/1 · 0 sessions · —',
    '  mc/c · memoro-cli · merge · ready · criteria 0/1 · 0 sessions · —',
    '  mc/d · memoro-cli · plan · ready · criteria 0/1 · 0 sessions · —',
  ]);
});

test('mc goal list <programme> lists that programme alone, and says when it has no goals', async () => {
  const f = fixture({ files: seededGoal() });
  assert.equal(await run(['list', 'mc'], f.deps), 0);
  assert.equal(f.out(), 'mc · phase 1 · in progress\n  mc/plain · memoro-cli · build · ready · criteria 0/1 · 2 sessions · —\n');

  const none = fixture();
  assert.equal(await run(['list', 'nope'], none.deps), 0);
  assert.equal(none.out(), 'mc: no goals\n');
});

test('usage names the five verbs, and mc goal --help prints it', async () => {
  const text = usage();
  for (const verb of ['mc goal new', 'mc goal set', 'mc goal document add', 'mc goal criterion add', 'mc goal criterion met', 'mc goal criterion unmet', 'mc goal convert', 'mc goal phase', 'mc goal log', 'mc goal stage', 'mc goal blocked\\|martin\\|ready', 'mc goal done', 'mc goal drop', 'mc goal show', 'mc goal list']) {
    assert.match(text, new RegExp(verb, 'u'));
  }
  const printed = [];
  const code = await runModule('./mc/commands/goal.js', ['--help'], { stdout: { write: (t) => printed.push(t) } });
  assert.equal(code, 0);
  assert.equal(printed.join(''), text);
});

/* ------------------------------------------------------------- phases */

/**
 * A goal under `mc` in `stage` (`blocked` is `build · blocked`) and `phase`;
 * `after` (comma-separated) writes a GOAL.json from before phases and stages,
 * whose one status is `stage`.
 */
const goalAt = (name, stage, phase = 1, after = null) => ({
  [`${HOME}/mc/goals/${name}/GOAL.json`]: after === null
    ? withGoal(GOAL_TEXT, stage === 'blocked' ? { stage: 'build', status: 'blocked', phase } : { stage, phase })
    : (() => { const { phase: _phase, stage: _stage, ...rest } = JSON.parse(withGoal(GOAL_TEXT, { status: stage })); return `${JSON.stringify({ ...rest, after: after ? after.split(',').map((one) => one.trim()) : [] }, null, 2)}\n`; })(),
  [`${HOME}/mc/goals/${name}/LOG.md`]: '',
});
const goalOf = (f, name) => parseGoal(f.store[`${HOME}/mc/goals/${name}/GOAL.json`]);
const newArgs = (name, ...extra) => ['new', name, '--repo', 'memoro-cli', '--class', 'large', '--title', 'T', ...extra];

test('mc goal new --phase puts the goal in that phase, and refuses one that would leave a hole', async () => {
  const f = fixture({ files: { ...goalAt('first', 'build') } });
  assert.equal(await run(newArgs('mc/second', '--phase', '2'), f.deps), 0, f.err());
  assert.equal(goalOf(f, 'second').phase, 2);
  assert.equal(goalOf(f, 'second').stage, 'plan', 'a later phase keeps the stage: the phase holds it');
  assert.match(f.out(), /mc: mc\/second · plan · ready · phase 2 — /u);
  assert.equal(parseLog(f.store[`${HOME}/mc/goals/second/LOG.md`])[0].done, 'created, phase 2');
  assert.equal(await run(newArgs('mc/fourth', '--phase', '4'), f.deps), 2);
  assert.match(f.err(), /phase 4 would leave a hole — mc's phases run to 2, so 3 is the highest/u);
  assert.equal(`${HOME}/mc/goals/fourth/GOAL.json` in f.store, false, 'nothing written');
  for (const bad of ['0', 'two', '1.5']) {
    const g = fixture();
    assert.equal(await run(newArgs('mc/x', '--phase', bad), g.deps), 2, bad);
    assert.match(g.err(), /--phase is a whole number from 1/u);
  }
});

test('mc goal phase moves a goal, logs it, and renumbers a phase it left empty', async () => {
  const f = fixture({ files: { ...goalAt('a', 'build', 1), ...goalAt('b', 'build', 2), ...goalAt('c', 'build', 3) } });
  assert.equal(await run(['phase', 'mc/a', '3'], f.deps), 0, f.err());
  // a left phase 1 empty: b is phase 1, c and a phase 2.
  assert.deepEqual(['a', 'b', 'c'].map((name) => goalOf(f, name).phase), [2, 1, 2]);
  assert.match(f.out(), /mc: mc\/a · phase 2\n {2}mc\/b {2}phase 2 → 1\n {2}mc\/c {2}phase 3 → 2\n/u);
  assert.equal(parseLog(f.store[`${HOME}/mc/goals/a/LOG.md`]).at(-1).done, 'phase 3');
  assert.equal(await run(['phase', 'mc/a', '4'], f.deps), 2);
  assert.match(f.err(), /phase 4 would leave a hole/u);
  assert.equal(await run(['phase', 'mc/a', 'x'], f.deps), 2);
  assert.equal(await run(['phase', 'mc/missing', '1'], f.deps), 1);
});

test('mc goal list groups by phase and says which phase is in progress; show gives the phase', async () => {
  const f = fixture({ files: { ...goalAt('landed', 'done', 1), ...goalAt('let-go', 'dropped', 1), ...goalAt('now', 'build', 2), ...goalAt('also', 'blocked', 2), ...goalAt('later', 'review', 3) } });
  assert.equal(await run(['list', 'mc'], f.deps), 0, f.err());
  assert.deepEqual(f.out().trim().split('\n').map((line) => line.split(' · ').slice(0, 4).join(' · ')), [
    'mc · phase 1 · done',
    '  mc/landed · memoro-cli · done · ready',
    '  mc/let-go · memoro-cli · dropped · ready',
    'mc · phase 2 · in progress',
    '  mc/also · memoro-cli · build · blocked',
    '  mc/now · memoro-cli · build · ready',
    'mc · phase 3 · after phase 2',
    '  mc/later · memoro-cli · review · ready',
  ]);
  const shown = fixture({ files: { ...goalAt('later', 'build', 3), ...goalAt('a', 'build', 1), ...goalAt('b', 'build', 2) } });
  assert.equal(await run(['show', 'mc/later'], shown.deps), 0, shown.err());
  assert.match(shown.out(), /^mc\/later · build · ready · phase 3 · memoro-cli/u);
});

test('mc goal convert gives an after chain phases 1, 2, 3; waiting and open are build, a landed after holds nothing back', async () => {
  const f = fixture({
    files: {
      ...goalAt('first', 'open', 1, ''),
      ...goalAt('second', 'waiting', 1, 'mc/first'),
      ...goalAt('third', 'waiting', 1, 'mc/second, mc/landed'),
      ...goalAt('free', 'waiting', 1, 'mc/landed'),
      ...goalAt('landed', 'done', 1, ''),
    },
  });
  assert.equal(await run(['convert', 'mc'], f.deps), 0, f.err());
  assert.deepEqual(['first', 'second', 'third', 'free', 'landed'].map((name) => [name, goalOf(f, name).phase, goalOf(f, name).stage, goalOf(f, name).status]), [
    ['first', 1, 'build', 'ready'], ['second', 2, 'build', 'ready'], ['third', 3, 'build', 'ready'], ['free', 1, 'build', 'ready'], ['landed', 1, 'done', 'ready'],
  ]);
  for (const name of ['first', 'second', 'third']) assert.equal('after' in JSON.parse(f.store[`${HOME}/mc/goals/${name}/GOAL.json`]), false, `${name} has no after`);
  assert.deepEqual(parseLog(f.store[`${HOME}/mc/goals/third/LOG.md`]).map((entry) => [entry.tool, entry.stage, entry.status, entry.done]), [['person', 'build', 'ready', 'build · ready, from waiting; phase 3, from after mc/second, mc/landed']]);
  assert.deepEqual(parseLog(f.store[`${HOME}/mc/goals/first/LOG.md`]).map((entry) => entry.done), ['build · ready, from open; phase 1']);
  assert.match(f.out(), /mc: mc\/third · build · ready \(was waiting\), phase 3 \(was after mc\/second, mc\/landed\)/u);
  assert.equal(await run(['convert', 'mc'], f.deps), 0);
  assert.match(f.out(), /mc: nothing to convert\n$/u, 'a second run has nothing to do');
});

test('mc goal archive of the last goal in phase 1 makes phase 2 phase 1 and phase 3 phase 2', async () => {
  const f = fixture({ files: { ...goalAt('one', 'done', 1), ...goalAt('two', 'build', 2), ...goalAt('three', 'build', 3) } });
  f.deps.gh = () => ok('[]');
  f.deps.appendText = (path, text) => { f.store[path] = `${f.store[path] ?? ''}${text}`; };
  f.deps.move = (from, to) => {
    for (const key of Object.keys(f.store)) if (key.startsWith(`${from}/`)) { f.store[`${to}${key.slice(from.length)}`] = f.store[key]; delete f.store[key]; }
  };
  assert.equal(await run(['archive', 'mc/one'], f.deps), 0, f.err());
  assert.equal(`${HOME}/mc/goals/one/GOAL.json` in f.store, false, 'archived');
  assert.deepEqual([goalOf(f, 'two').phase, goalOf(f, 'three').phase], [1, 2]);
  assert.match(f.out(), /mc: mc\/one · archived — .*\n {2}mc\/three {2}phase 3 → 2\n {2}mc\/two {2}phase 2 → 1\n/u);
});

/* ------------------------------------------------------------- convert */

test('mc goal convert turns a programme\'s GOAL.md files into GOAL.json with the right met, removes each, and leaves .archive/ alone', async () => {
  const md = (status, extra = '') => [
    '---', `status: ${status}`, 'repos: memoro-cli, memoro', 'class: large', 'created: 2026-11-01T20:00:00Z', `prs: memoro#9${extra}`, '---',
    '# Make it so', '', '## Goal', '', 'Two files', 'and a worktree.', '', 'A second paragraph.', '',
    '## Criteria', '', '- **Schema.** It parses. *Check:* mc gate tests/mc/goals.test.js', '  and nothing else.', '- It shows.', '3. A numbered one.', '',
    '## Out of scope', '', '- Phases.', '', '## Notes', '', 'Kept.', '',
  ].join('\n');
  const archived = md('done');
  const removed = [];
  const f = fixture({
    files: {
      [`${HOME}/mc/goals/building/GOAL.md`]: md('open'),
      [`${HOME}/mc/goals/judged/GOAL.md`]: md('review'),
      [`${HOME}/mc/goals/.archive/old/GOAL.md`]: archived,
    },
  });
  // A real listing leaves dot-directories out (`listDirsOf`); the model does too.
  const list = f.deps.list;
  f.deps.list = (path) => list(path).filter((name) => !name.startsWith('.'));
  f.deps.remove = (path) => { removed.push(path); delete f.store[path]; };
  assert.equal(await run(['convert', 'mc'], f.deps), 0, f.err());
  assert.match(f.out(), /mc\/building · converted, 3 criteria\nmc: mc\/judged · converted, 3 criteria\n/u);

  const open = parseGoal(f.store[`${HOME}/mc/goals/building/GOAL.json`]);
  assert.deepEqual([open.stage, open.status], ['build', 'ready']);
  assert.deepEqual(open.repos, ['memoro-cli', 'memoro']);
  assert.deepEqual(open.prs, [{ repo: 'memoro', pr: 9 }]);
  assert.equal(open.title, 'Make it so');
  assert.deepEqual(open.goal, ['Two files\nand a worktree.', 'A second paragraph.', 'Notes:', 'Kept.']);
  assert.deepEqual(open.out_of_scope, ['- Phases.']);
  assert.deepEqual(open.success_criteria, [
    { criterion: '**Schema.** It parses.', check: 'mc gate tests/mc/goals.test.js and nothing else.', met: false },
    { criterion: 'It shows.', check: 'It shows.', met: false },
    { criterion: 'A numbered one.', check: 'A numbered one.', met: false },
  ]);
  assert.deepEqual(parseGoal(f.store[`${HOME}/mc/goals/judged/GOAL.json`]).success_criteria.map((item) => item.met), [true, true, true], 'a goal in review has been judged');
  assert.equal(parseGoal(f.store[`${HOME}/mc/goals/judged/GOAL.json`]).stage, 'review');
  assert.deepEqual(removed.sort(), [`${HOME}/mc/goals/building/GOAL.md`, `${HOME}/mc/goals/judged/GOAL.md`]);
  assert.equal(f.store[`${HOME}/mc/goals/.archive/old/GOAL.md`], archived, '.archive/ untouched');
  assert.equal(`${HOME}/mc/goals/.archive/old/GOAL.json` in f.store, false);

  // Run again, there is nothing left.
  assert.equal(await run(['convert'], f.deps), 0, f.err());
  assert.match(f.out(), /mc: nothing to convert\n$/u);
});

test('mc goal convert leaves a GOAL.md it cannot read, and one beside a GOAL.json, and says why', async () => {
  const f = fixture({
    files: {
      [`${HOME}/mc/goals/broken/GOAL.md`]: 'no front matter\n',
      [`${HOME}/mc/goals/both/GOAL.md`]: '---\nstatus: open\nrepos: memoro\nclass: fast\n---\n# Both\n',
      [`${HOME}/mc/goals/both/GOAL.json`]: GOAL_TEXT,
    },
  });
  f.deps.remove = () => assert.fail('nothing is removed');
  assert.equal(await run(['convert', 'mc'], f.deps), 1);
  assert.match(f.err(), /mc\/both is not converted — it has a GOAL\.json already/u);
  assert.match(f.err(), /mc\/broken is not converted — GOAL\.md has no front matter/u);
  assert.equal(f.store[`${HOME}/mc/goals/both/GOAL.json`], GOAL_TEXT);
});

test('mc goal convert gives every goal written with one status its stage: open is build, review is review or merge when queued, blocked its stage from the last entry, done and dropped as they are', async () => {
  /** A GOAL.json from before stages, with `status` and no stage, and its LOG.md. */
  const legacy = (name, status, log = '') => {
    const { stage: _stage, ...rest } = JSON.parse(withGoal(GOAL_TEXT, { status }));
    return { [`${HOME}/mc/goals/${name}/GOAL.json`]: `${JSON.stringify(rest, null, 2)}\n`, [`${HOME}/mc/goals/${name}/LOG.md`]: log };
  };
  const entry = (who, status, line) => `## 2026-11-02T10:00Z · ${who} · ${status}\n\n${line}\n`;
  const f = fixture({
    files: {
      ...legacy('open', 'open', entry('claude opus', 'open', 'Done: the reader')),
      ...legacy('judged', 'review', entry('claude opus', 'review', 'Done: built')),
      ...legacy('queued', 'review', `${entry('claude opus', 'review', 'Done: built')}\n${entry('runner', 'review', 'Done: queued #31 at abc1234 for the merger')}`),
      ...legacy('red-review', 'blocked', `${entry('claude opus', 'review', 'Done: built')}\n${entry('codex sol', 'blocked', 'Done: red abc1234')}\n${entry('runner', 'blocked', 'Done: plan session ended; the goal stays blocked — waits on Martin')}`),
      ...legacy('red-merge', 'blocked', entry('runner', 'blocked', 'Done: merger answered red on #31')),
      ...legacy('no-verdict', 'blocked', entry('runner', 'blocked', 'Comment: the review left no verdict (`green <sha>` or `red <sha>` in Done) — waits on plan')),
      ...legacy('asked', 'blocked', `${entry('claude opus', 'open', 'Done: half')}\n${entry('claude opus', 'blocked', 'Comment: which table?')}`),
      ...legacy('mute', 'blocked', entry('runner', 'blocked', 'Comment: three sessions ended without a word — see the logs under runner/log')),
      ...legacy('by-hand', 'blocked', `${entry('claude opus', 'review', 'Done: built')}\n${entry('person', 'blocked', 'Comment: hold it')}`),
      ...legacy('landed', 'done'),
      ...legacy('let-go', 'dropped'),
    },
  });
  assert.equal(await run(['convert', 'mc'], f.deps), 0, f.err());
  const where = (name) => { const goal = goalOf(f, name); return `${goal.stage} · ${goal.status}`; };
  assert.deepEqual(Object.fromEntries(['open', 'judged', 'queued', 'red-review', 'red-merge', 'no-verdict', 'asked', 'mute', 'by-hand', 'landed', 'let-go'].map((name) => [name, where(name)])), {
    open: 'build · ready',
    judged: 'review · ready',
    queued: 'merge · ready',
    'red-review': 'finish · blocked',
    'red-merge': 'merge · blocked',
    'no-verdict': 'review · blocked',
    asked: 'build · blocked',
    mute: 'build · blocked',
    'by-hand': 'review · blocked',
    landed: 'done · ready',
    'let-go': 'dropped · ready',
  });
  const last = parseLog(f.store[`${HOME}/mc/goals/red-merge/LOG.md`]).at(-1);
  assert.deepEqual([last.tool, last.stage, last.status, last.done], ['person', 'merge', 'blocked', 'merge · blocked, from blocked; phase 1']);
  assert.match(f.out(), /mc: mc\/queued · merge · ready \(was review\), phase 1\n/u);
  assert.equal(await run(['convert', 'mc'], f.deps), 0);
  assert.match(f.out(), /mc: nothing to convert\n$/u, 'once');
});


test('plan without MC_GOAL has session authority: it retries merge but cannot move stages backward', async () => {
  const env = { MC_ROLE: 'plan', MC_TOOL: 'codex', MC_PROGRAMME: 'mc' };
  const f = fixture({ files: { ...inStage('merge'), [`${DIR}/GOAL.json`]: withGoal(GOAL_TEXT, { stage: 'merge', status: 'blocked' }) }, env });
  assert.equal(await run(['stage', 'mc/plain', 'build'], f.deps), 2);
  assert.match(f.err(), /a session does not move a goal back/u);
  assert.equal(await run(['stage', 'mc/plain', 'merge'], f.deps), 0, f.err());
  assert.equal(stateOf(f), 'merge · ready');
  assert.equal(await run(['martin', 'mc/plain', '--reason', 'choose scope; recommend keeping it'], f.deps), 0, f.err());
  assert.equal(stateOf(f), 'merge · Martin');
  for (const role of ['build-session:goal', 'review-session:goal']) {
    const rejected = fixture({ files: inStage('build'), env: { MC_GOAL: 'mc/plain', MC_TOOL: 'codex', MC_ROLE: role } });
    assert.equal(await run(['martin', '--reason', 'question'], rejected.deps), 2);
    assert.match(rejected.err(), /only plan or a person sets Martin/u);
  }
});
