import assert from 'node:assert/strict';
import { test } from 'node:test';

import { refusedStatus, run, usage } from '../../../src/mc/commands/goal.js';
import { parseGoal, parseLog, PLAN_ROLE, REVIEW_ROLE, STATUSES } from '../../../src/mc/goals.js';
import { BUILD_ROLES } from '../../../src/mc/run-plan.js';
import { runModule } from '../../../src/mc-verbs.js';
import { goalField, goalJson, withGoal } from '../_helpers/goal-file.js';

const HOME = '/work/programs';
const DIR = `${HOME}/mc/goals/plain`;
/** The bare repositories `knownRepositories` would name: their basenames are the repository names. */
const KNOWN = ['/home/m/memoro-cli.git', '/home/m/memoro'];

const GOAL_TEXT = goalJson();

const LOG_TEXT = [
  '## 2026-11-01T20:00Z · person · open', '', 'Done: created', '',
  '## 2026-11-01T21:30Z · claude claude-opus-5-5 · open', '', 'Done: the reader', 'Next: the verbs', '',
  '## 2026-11-01T22:00Z · claude claude-opus-5-5 · open', '', 'Done: the tests', 'Next: the page', '',
  '## 2026-11-01T23:00Z · runner · open', '', 'Comment: no session ran', '',
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

/** A goal already made: GOAL.json and LOG.md under its directory. */
function seededGoal(extra = {}) {
  return { [`${DIR}/GOAL.json`]: GOAL_TEXT, [`${DIR}/LOG.md`]: LOG_TEXT, ...extra };
}

test('mc goal new writes a GOAL.json skeleton, LOG.md and one worktree per repo from origin/main', async () => {
  const f = fixture();
  const code = await run(['new', 'mc/plain', '--repo', 'memoro-cli,memoro', '--class', 'large', '--title', 'Make the goal plain'], f.deps);
  assert.equal(code, 0, f.err());

  const goal = parseGoal(f.store[`${DIR}/GOAL.json`]);
  assert.equal(goal.status, 'open');
  assert.deepEqual(goal.repos, ['memoro-cli', 'memoro']);
  assert.equal(goal.class, 'large');
  assert.equal(goal.created, '2026-11-01T20:00:00Z');
  assert.equal(goal.title, 'Make the goal plain');
  assert.deepEqual([goal.goal, goal.contract, goal.out_of_scope, goal.success_criteria, goal.documents], [[], [], [], [], []]);
  assert.equal(goalField(f.store[`${DIR}/GOAL.json`], 'schema'), 'mc-goal');
  assert.equal(f.store[`${DIR}/LOG.md`], '## 2026-11-01T20:00Z · person · open\n\nDone: created\n');

  assert.deepEqual(f.calls, [
    { cwd: '/home/m/memoro-cli.git', args: ['fetch', '-q', 'origin'] },
    { cwd: '/home/m/memoro', args: ['fetch', '-q', 'origin'] },
    { cwd: '/home/m/memoro-cli.git', args: ['show-ref', '--verify', '--quiet', 'refs/heads/goal/plain'] },
    { cwd: '/home/m/memoro-cli.git', args: ['worktree', 'add', '-q', '-b', 'goal/plain', `${DIR}/memoro-cli`, 'origin/main'] },
    { cwd: '/home/m/memoro', args: ['show-ref', '--verify', '--quiet', 'refs/heads/goal/plain'] },
    { cwd: '/home/m/memoro', args: ['worktree', 'add', '-q', '-b', 'goal/plain', `${DIR}/memoro`, 'origin/main'] },
  ]);
  assert.match(f.out(), new RegExp(`mc: mc/plain · phase 1 — ${DIR}`, 'u'));
  assert.equal(goal.phase, 1, 'phase 1 when --phase is not given');
  assert.match(f.out(), /GOAL\.json is to be filled in by verbs: mc goal set mc\/plain/u);
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

test('mc goal new says which worktree could not be made, and where the goal\'s files stand', async () => {
  const f = fixture({ git: (cwd, args) => (args[0] === 'worktree' ? failed('branch in use') : allOk()) });
  assert.equal(await run(['new', 'mc/plain', '--repo', 'memoro', '--class', 'fast', '--title', 'T'], f.deps), 1);
  assert.match(f.err(), /memoro's worktree is not made — branch in use; the goal's files stand in/u);
  assert.equal(goalField(f.store[`${DIR}/GOAL.json`], 'status'), 'open');
});

test('mc goal log appends one entry, tagged with MC_TOOL and MC_MODEL, and the goal is MC_GOAL\'s when not named', async () => {
  const f = fixture({ files: seededGoal(), env: { MC_GOAL: 'mc/plain', MC_TOOL: 'claude', MC_MODEL: 'claude-haiku-5-5' } });
  assert.equal(await run(['log', '--done', 'the verb', '--next', 'the page'], f.deps), 0, f.err());
  const entries = parseLog(f.store[`${DIR}/LOG.md`]);
  assert.equal(entries.length, 5);
  assert.deepEqual(entries.at(-1), {
    at: '2026-11-01T20:00Z', tool: 'claude', model: 'claude-haiku-5-5', status: 'open', done: 'the verb', comment: null, next: 'the page',
  });
  assert.equal(f.store[`${DIR}/GOAL.json`], GOAL_TEXT, 'a log entry alone leaves GOAL.json as it is');
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

  const broken = fixture({ files: seededGoal({ [`${DIR}/GOAL.json`]: 'no json\n' }) });
  assert.equal(await run(['log', 'mc/plain', '--done', 'x'], broken.deps), 1);
  assert.match(broken.err(), /mc\/plain: GOAL\.json is not JSON/u);
  assert.equal(broken.store[`${DIR}/LOG.md`], LOG_TEXT, 'a goal that does not parse gets no entry');
});

test('mc goal log --status rewrites the status in GOAL.json and logs the entry with it', async () => {
  const f = fixture({ files: seededGoal() });
  assert.equal(await run(['log', 'mc/plain', '--status', 'blocked', '--comment', 'waits for Martin'], f.deps), 0, f.err());
  assert.equal(parseGoal(f.store[`${DIR}/GOAL.json`]).status, 'blocked');
  assert.equal(f.store[`${DIR}/GOAL.json`], withGoal(GOAL_TEXT, { status: 'blocked' }));
  assert.equal(parseLog(f.store[`${DIR}/LOG.md`]).at(-1).status, 'blocked');
  assert.equal(parseLog(f.store[`${DIR}/LOG.md`]).at(-1).comment, 'waits for Martin');

  const bad = fixture({ files: seededGoal() });
  assert.equal(await run(['log', 'mc/plain', '--status', 'started', '--comment', 'x'], bad.deps), 2);
  assert.match(bad.err(), /--status is open, review, blocked, done, dropped, not started/u);
});

test('mc goal open, review, blocked and done set the status and log the reason', async () => {
  for (const verb of ['open', 'review', 'blocked', 'done']) {
    const f = fixture({ files: seededGoal(), env: { MC_GOAL: 'mc/plain' } });
    assert.equal(await run([verb, '--reason', `because ${verb}`], f.deps), 0, f.err());
    assert.equal(parseGoal(f.store[`${DIR}/GOAL.json`]).status, verb);
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
  const blocked = seededGoal({ [`${DIR}/GOAL.json`]: withGoal(GOAL_TEXT, { status: 'blocked' }) });
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
  const built = fixture({ files: seededGoal({ [`${DIR}/GOAL.json`]: withGoal(GOAL_TEXT, { success_criteria: [{ criterion: 'it works', check: 'a test', met: true }] }) }), env: session });
  assert.equal(await run(['log', '--done', 'built', '--status', 'review'], built.deps), 0, built.err());
  assert.equal(parseGoal(built.store[`${DIR}/GOAL.json`]).status, 'review');

  for (const argv of [['log', '--done', 'x', '--status', 'done'], ['done', '--reason', 'x']]) {
    const f = fixture({ files: seededGoal(), env: session });
    assert.equal(await run(argv, f.deps), 2, argv.join(' '));
    assert.match(f.err(), /a session does not set done — end in review; the merger sets done/u);
    assert.equal(f.store[`${DIR}/GOAL.json`], GOAL_TEXT, 'nothing written');
    assert.equal(f.store[`${DIR}/LOG.md`], LOG_TEXT, 'no entry');
  }

  // MC_TOOL person, or no MC_TOOL at all, is a person, even with MC_GOAL set.
  for (const env of [{ MC_GOAL: 'mc/plain', MC_TOOL: 'person' }, { MC_GOAL: 'mc/plain' }, {}]) {
    const f = fixture({ files: seededGoal(), env });
    assert.equal(await run(['done', 'mc/plain', '--reason', 'landed by hand'], f.deps), 0, f.err());
    assert.equal(parseGoal(f.store[`${DIR}/GOAL.json`]).status, 'done');
  }
});

test('a build session cannot set review while a criterion is not met: the refusal names its number, and nothing is written', async () => {
  const session = { MC_GOAL: 'mc/plain', MC_TOOL: 'claude', MC_MODEL: 'opus', MC_ROLE: BUILD_ROLES.goal };
  const two = withGoal(GOAL_TEXT, { success_criteria: [{ criterion: 'a', check: 'x', met: true }, { criterion: 'b', check: 'y', met: false }] });
  for (const argv of [['log', '--done', 'built', '--status', 'review'], ['review', '--reason', 'built']]) {
    const f = fixture({ files: seededGoal({ [`${DIR}/GOAL.json`]: two }), env: session });
    assert.equal(await run(argv, f.deps), 1, argv.join(' '));
    assert.match(f.err(), /mc\/plain is not set review — criterion 2 is not met — run its check and record it with mc goal criterion met mc\/plain 2/u);
    assert.equal(f.store[`${DIR}/GOAL.json`], two, 'nothing written');
    assert.equal(f.store[`${DIR}/LOG.md`], LOG_TEXT, 'no entry');
  }
  const none = fixture({ files: seededGoal({ [`${DIR}/GOAL.json`]: withGoal(GOAL_TEXT, { success_criteria: [] }) }), env: session });
  assert.equal(await run(['review'], none.deps), 1);
  assert.match(none.err(), /mc\/plain has no criterion — mc goal criterion add/u);

  // Once it is met the same call goes through; a plan session or a person is not refused.
  const met = fixture({ files: seededGoal({ [`${DIR}/GOAL.json`]: two }), env: session });
  assert.equal(await run(['criterion', 'met', '2'], met.deps), 0, met.err());
  assert.equal(await run(['review', '--reason', 'built'], met.deps), 0, met.err());
  for (const env of [{ ...session, MC_ROLE: PLAN_ROLE }, {}]) {
    const f = fixture({ files: seededGoal({ [`${DIR}/GOAL.json`]: two }), env });
    assert.equal(await run(['review', 'mc/plain'], f.deps), 0, f.err());
  }
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

test('a review session may not set a goal open again', async () => {
  const f = fixture({ files: seededGoal(), env: { MC_GOAL: 'mc/plain', MC_TOOL: 'claude', MC_ROLE: REVIEW_ROLE } });
  assert.equal(await run(['log', '--done', 'red abc1234', '--status', 'open'], f.deps), 2);
  assert.match(f.err(), /a review does not set open/u);
  assert.equal(await run(['log', '--done', 'red abc1234', '--status', 'blocked'], f.deps), 0, f.err());
  assert.equal(parseGoal(f.store[`${DIR}/GOAL.json`]).status, 'blocked');
});

test('mc goal open|blocked|done take only --reason', async () => {
  const f = fixture({ files: seededGoal(), env: { MC_GOAL: 'mc/plain' } });
  assert.equal(await run(['done', '--done', 'x'], f.deps), 2);
  assert.match(f.err(), /done takes no --done/u);
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
  assert.match(text, /^mc\/plain · open · phase 1 · memoro-cli, memoro · large · criteria 1\/2 · created 2026-11-01T20:00:00Z\n/u);
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
  assert.match(f.err(), /status: one of open, review, blocked, done, dropped, not maybe/u);
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
  assert.equal(lines[1], '  mc/plain · memoro-cli · open · criteria 0/1 · 2 sessions · —');
  assert.match(lines[2], /^ {2}mc\/broken · does not parse — GOAL\.json is not JSON/u, 'a goal that does not parse has no phase, and comes last');
});

test('mc goal list says criteria 1/2 for a goal with one of two met, and an open goal with none is not started', async () => {
  const f = fixture({
    files: {
      ...seededGoal({ [`${DIR}/GOAL.json`]: withGoal(GOAL_TEXT, { success_criteria: [{ criterion: 'a', check: 'x', met: true }, { criterion: 'b', check: 'y', met: false }] }) }),
      [`${HOME}/mc/goals/skeleton/GOAL.json`]: withGoal(GOAL_TEXT, { success_criteria: [] }),
    },
  });
  assert.equal(await run(['list'], f.deps), 0, f.err());
  assert.deepEqual(f.out().trim().split('\n').slice(1), [
    '  mc/plain · memoro-cli · open · criteria 1/2 · 2 sessions · —',
    '  mc/skeleton · memoro-cli · open, no criteria — not started · criteria 0/0 · 0 sessions · —',
  ]);
});

test('mc goal list shows review, and a goal blocked by a red review or a red merge as waiting on plan', async () => {
  const goal = (status) => withGoal(GOAL_TEXT, { status });
  const f = fixture({
    files: {
      [`${HOME}/mc/goals/a/GOAL.json`]: goal('review'),
      [`${HOME}/mc/goals/a/LOG.md`]: '## 2026-11-02T10:00Z · claude opus · review\n\nDone: built\n',
      [`${HOME}/mc/goals/b/GOAL.json`]: goal('blocked'),
      [`${HOME}/mc/goals/b/LOG.md`]: '## 2026-11-02T10:00Z · codex gpt-6.1-sol · blocked\n\nDone: red abc1234\n',
      [`${HOME}/mc/goals/c/GOAL.json`]: goal('blocked'),
      [`${HOME}/mc/goals/c/LOG.md`]: '## 2026-11-02T10:00Z · runner · blocked\n\nDone: merger answered red on #12\n',
      [`${HOME}/mc/goals/d/GOAL.json`]: goal('blocked'),
      [`${HOME}/mc/goals/d/LOG.md`]: '## 2026-11-02T10:00Z · claude opus · blocked\n\nComment: which table?\n',
    },
  });
  assert.equal(await run(['list'], f.deps), 0, f.err());
  assert.deepEqual(f.out().trim().split('\n').slice(1), [
    '  mc/a · memoro-cli · review · criteria 0/1 · 1 sessions · —',
    '  mc/b · memoro-cli · blocked, waits on plan · criteria 0/1 · 1 sessions · —',
    '  mc/c · memoro-cli · blocked, waits on plan · criteria 0/1 · 0 sessions · —',
    '  mc/d · memoro-cli · blocked, waits on a person · criteria 0/1 · 1 sessions · —',
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
  assert.equal(f.out(), 'mc · phase 1 · in progress\n  mc/plain · memoro-cli · open · criteria 0/1 · 2 sessions · —\n');

  const none = fixture();
  assert.equal(await run(['list', 'nope'], none.deps), 0);
  assert.equal(none.out(), 'mc: no goals\n');
});

test('usage names the five verbs, and mc goal --help prints it', async () => {
  const text = usage();
  for (const verb of ['mc goal new', 'mc goal set', 'mc goal document add', 'mc goal criterion add', 'mc goal criterion met', 'mc goal criterion unmet', 'mc goal convert', 'mc goal phase', 'mc goal log', 'mc goal open\\|review\\|blocked\\|done', 'mc goal show', 'mc goal list']) {
    assert.match(text, new RegExp(verb, 'u'));
  }
  const printed = [];
  const code = await runModule('./mc/commands/goal.js', ['--help'], { stdout: { write: (t) => printed.push(t) } });
  assert.equal(code, 0);
  assert.equal(printed.join(''), text);
});

/* ------------------------------------------------------------- phases */

/** A goal under `mc` with `status` and `phase`; `after` (comma-separated) writes a GOAL.json from before phases. */
const goalAt = (name, status, phase = 1, after = null) => ({
  [`${HOME}/mc/goals/${name}/GOAL.json`]: after === null
    ? withGoal(GOAL_TEXT, { status, phase })
    : (() => { const { phase: _phase, ...rest } = JSON.parse(withGoal(GOAL_TEXT, { status })); return `${JSON.stringify({ ...rest, after: after ? after.split(',').map((one) => one.trim()) : [] }, null, 2)}\n`; })(),
  [`${HOME}/mc/goals/${name}/LOG.md`]: '',
});
const goalOf = (f, name) => parseGoal(f.store[`${HOME}/mc/goals/${name}/GOAL.json`]);
const newArgs = (name, ...extra) => ['new', name, '--repo', 'memoro-cli', '--class', 'large', '--title', 'T', ...extra];

test('mc goal new --phase puts the goal in that phase, and refuses one that would leave a hole', async () => {
  const f = fixture({ files: { ...goalAt('first', 'open') } });
  assert.equal(await run(newArgs('mc/second', '--phase', '2'), f.deps), 0, f.err());
  assert.equal(goalOf(f, 'second').phase, 2);
  assert.equal(goalOf(f, 'second').status, 'open', 'a later phase keeps the status: the phase holds it');
  assert.match(f.out(), /mc: mc\/second · phase 2 — /u);
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
  const f = fixture({ files: { ...goalAt('a', 'open', 1), ...goalAt('b', 'open', 2), ...goalAt('c', 'open', 3) } });
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
  const f = fixture({ files: { ...goalAt('landed', 'done', 1), ...goalAt('let-go', 'dropped', 1), ...goalAt('now', 'open', 2), ...goalAt('also', 'blocked', 2), ...goalAt('later', 'open', 3) } });
  assert.equal(await run(['list', 'mc'], f.deps), 0, f.err());
  assert.deepEqual(f.out().trim().split('\n').map((line) => line.split(' · ').slice(0, 3).join(' · ')), [
    'mc · phase 1 · done',
    '  mc/landed · memoro-cli · done',
    '  mc/let-go · memoro-cli · dropped',
    'mc · phase 2 · in progress',
    '  mc/also · memoro-cli · blocked, waits on a person',
    '  mc/now · memoro-cli · open',
    'mc · phase 3 · after phase 2',
    '  mc/later · memoro-cli · open',
  ]);
  const shown = fixture({ files: { ...goalAt('later', 'open', 3), ...goalAt('a', 'open', 1), ...goalAt('b', 'open', 2) } });
  assert.equal(await run(['show', 'mc/later'], shown.deps), 0, shown.err());
  assert.match(shown.out(), /^mc\/later · open · phase 3 · memoro-cli/u);
});

test('mc goal convert gives an after chain phases 1, 2, 3; waiting is open, a landed after holds nothing back', async () => {
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
  assert.deepEqual(['first', 'second', 'third', 'free', 'landed'].map((name) => [name, goalOf(f, name).phase, goalOf(f, name).status]), [
    ['first', 1, 'open'], ['second', 2, 'open'], ['third', 3, 'open'], ['free', 1, 'open'], ['landed', 1, 'done'],
  ]);
  for (const name of ['first', 'second', 'third']) assert.equal('after' in JSON.parse(f.store[`${HOME}/mc/goals/${name}/GOAL.json`]), false, `${name} has no after`);
  assert.deepEqual(parseLog(f.store[`${HOME}/mc/goals/third/LOG.md`]).map((entry) => [entry.tool, entry.status, entry.done]), [['person', 'open', 'phase 3, from after mc/second, mc/landed']]);
  assert.equal(f.store[`${HOME}/mc/goals/first/LOG.md`], '', 'nothing changed for it but the key: no entry');
  assert.match(f.out(), /mc: mc\/third · open, phase 3 \(was after mc\/second, mc\/landed\)/u);
  assert.equal(await run(['convert', 'mc'], f.deps), 0);
  assert.match(f.out(), /mc: nothing to convert\n$/u, 'a second run has nothing to do');
});

test('mc goal archive of the last goal in phase 1 makes phase 2 phase 1 and phase 3 phase 2', async () => {
  const f = fixture({ files: { ...goalAt('one', 'done', 1), ...goalAt('two', 'open', 2), ...goalAt('three', 'open', 3) } });
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
  assert.equal(open.status, 'open');
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
