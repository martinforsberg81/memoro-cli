import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { jevContext, refusedMove, run, usage } from '../../../src/mc/commands/goal.js';
import { addGoalWorktree, GOAL_FILE, goalSession, MEND_ROLE, parseGoal, parseLog, PLAN_ROLE, renderGoalText, REVIEW_ROLE, STAGES } from '../../../src/mc/goals.js';
import { BUILD_ROLES, tsvHeader, tsvRow } from '../../../src/mc/run-plan.js';
import { seenAreas } from '../../../src/mc/review-verdict.js';
import { runModule } from '../../../src/mc-verbs.js';
import { phaseOpen, programmeOrder, programsGoals } from '../../../src/mc/goals.js';
import { goalField, goalJson, goalJsonV2, goalMinimalV2, withGoal } from '../_helpers/goal-file.js';

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
function fixture({ files = {}, env = {}, git = allOk, known = KNOWN, absent = [], keys = {}, replies = [], timer = () => new Promise(() => {}), alive = () => false } = {}) {
  const store = { [`${HOME}/mc/PLAN.json`]: '{}', ...files };
  const calls = [];
  const out = [];
  const err = [];
  // jev's boundary: the keys source, the transport (each request answered by the next of `replies`), its waits and the ledger.
  const requests = [];
  const sleeps = [];
  const ledger = [];
  const deps = {
    readKeys: () => keys,
    jev: {
      transport: (url, init) => {
        requests.push({ url, init });
        const next = replies.shift();
        if (!next) throw new Error('no jev reply left in the fixture');
        return typeof next === 'function' ? next(init) : next;
      },
      sleep: async (ms) => { sleeps.push(ms); },
      timer,
    },
    ledger: (line) => { ledger.push(line); },
    home: HOME,
    env,
    now: () => new Date('2026-11-01T20:00:00Z'),
    stdout: { write: (text) => out.push(text) },
    stderr: { write: (text) => err.push(text) },
    read: (path) => store[path] ?? null,
    realpath: (path) => path,
    write: (path, text) => { store[path] = text; },
    list: (path) => listUnder(store, path),
    listFiles: (path) => Object.keys(store).filter((key) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/')).map((key) => key.slice(path.length + 1)),
    alive,
    known: () => known,
    git: (cwd, args) => {
      calls.push({ cwd, args });
      return git(cwd, args);
    },
    mainCheck: () => ({ fetch: { ok: true, text: '' }, paths: [] }),
    exists: (path) => !absent.includes(path),
  };
  return { deps, store, calls, requests, sleeps, ledger: () => ledger.map((line) => JSON.parse(line)), out: () => out.join(''), err: () => err.join('') };
}

/** Boundary fakes for the drop finalizer; archive moves the fixture's files, never the real filesystem. */
function dropFixture(f) {
  f.deps.gh = (_cwd, args) => {
    assert.equal(goalField(f.store[`${DIR}/GOAL.json`], 'stage'), 'dropped', 'drop is durable before GitHub cleanup');
    return args[1] === 'list' ? ok('[]') : ok('{"state":"CLOSED"}');
  };
  f.deps.lock = (_root, fn) => fn();
  f.deps.appendText = (path, text) => { f.store[path] = `${f.store[path] ?? ''}${text}`; };
  f.deps.move = (from, to) => {
    for (const key of Object.keys(f.store)) if (key.startsWith(`${from}/`)) { f.store[`${to}${key.slice(from.length)}`] = f.store[key]; delete f.store[key]; }
  };
  return f;
}

/** A well-formed `mc goal martin` call: the question, two options, the first recommended. */
const KEYS = { TYPESAFE_API_KEY: 'ts-key-0123456789abcdef' };
const martinCall = (reason, ...goal) => ['martin', ...goal, '--kind', 'product', '--reason', reason, '--option', 'widen: widen the contract to allow the fix', '--option', 'keep: keep the contract and drop the criterion', '--recommend', 'widen'];

/** A goal already made: GOAL.json and LOG.md under its directory. */
function seededGoal(extra = {}) {
  return { [`${DIR}/GOAL.json`]: GOAL_TEXT, [`${DIR}/LOG.md`]: LOG_TEXT, ...extra };
}

/** Read the actual Next cell and goal detail from the same file/Git fixture. */
async function goalOutcomeViews(f) {
  const result = {};
  for (const args of [['list', 'mc'], ['show', 'mc/plain']]) {
    const before = f.out().length;
    assert.equal(await run(args, f.deps), 0, f.err());
    result[args[0]] = f.out().slice(before);
  }
  return result;
}

test('goal outcome: a later unmatched announcement retains the eligible build continuation in list and show', async () => {
  const logDir = '/work/runner/log';
  const completion = [
    '## 2026-11-01T20:00Z · runner · build · ready', '',
    `Comment: build session (1 of 5): met 0 of 1 criteria, heads memoro-cli ${HEADS['memoro-cli']}`, '',
  ].join('\n');
  const files = seededGoal({
    [`${DIR}/LOG.md`]: `## 2026-11-01T20:00Z · codex model · build · ready · by build\n\nNext: verify saved proposal\n\n${completion}`,
    [`${logDir}/runner.log`]: '2026-11-01T20:00:00Z goal:mc/plain: build starting (codex)\n2026-11-01T21:00:00Z goal:mc/plain: build starting (codex)\n',
    [`${logDir}/runs.tsv`]: 'ts\tname\tkind\tseconds\tsession\texit\n2026-11-01T20:00:10Z\tgoal:mc/plain\tbuild-goal\t10\tsession-1\t1\n',
    [`${logDir}/goal-mc-plain-20261101T200000Z.jsonl`]: '{"type":"thread.started","thread_id":"session-1"}\n',
  });
  const f = fixture({ files, env: { MC_WORK_ROOT: '/work' } });
  const announcements = f.store[`${logDir}/runner.log`];
  f.store[`${logDir}/runner.log`] = announcements.split('\n')[0] + '\n';
  for (const output of Object.values(await goalOutcomeViews(f))) {
    assert.match(output, /build started · build remains eligible · Next: verify saved proposal/u);
  }
  f.store[`${logDir}/runner.log`] = announcements;
  for (const output of Object.values(await goalOutcomeViews(f))) {
    assert.match(output, /build start unknown — no tool boundary recorded · build remains eligible · Next: verify saved proposal/u);
    assert.doesNotMatch(output, /technical desk/u);
  }
  f.store[`${DIR}/GOAL.json`] = withGoal(GOAL_TEXT, { phase: 2 });
  f.store[`${HOME}/mc/goals/prerequisite/GOAL.json`] = goalJson();
  for (const output of Object.values(await goalOutcomeViews(f))) {
    assert.match(output, /build start unknown — no tool boundary recorded · build phase not open · Next: verify saved proposal/u);
    assert.doesNotMatch(output, /build remains eligible|technical desk/u);
  }
  f.store[`${DIR}/GOAL.json`] = GOAL_TEXT;
  f.store[`${DIR}/LOG.md`] = `## 2026-11-01T20:00Z · codex model · build · ready · by build\n\nDone: work\n\n${completion}`;
  for (const output of Object.values(await goalOutcomeViews(f))) {
    assert.match(output, /no bounded continuation recorded/u);
  }
});

test('goal outcome: the same exit distinguishes a credits preflight refusal from a start or unknown', async () => {
  const logDir = '/work/runner/log';
  const stem = `${logDir}/goal-mc-plain-20261101T200000Z`;
  const f = fixture({ env: { MC_WORK_ROOT: '/work' }, files: seededGoal({
    [`${DIR}/LOG.md`]: '## 2026-11-01T20:00Z · codex model · build · ready · by build\n\nNext: verify saved proposal\n',
    [`${logDir}/runner.log`]: '2026-11-01T20:00:00Z goal:mc/plain: build starting (codex) · on credits (plan spent)\n',
    [`${logDir}/runs.tsv`]: 'ts\tname\tkind\tseconds\tsession\texit\n2026-11-01T20:00:10Z\tgoal:mc/plain\tbuild-goal\t10\t-\t1\n',
    [`${stem}.jsonl`]: '', [`${stem}.json.err`]: 'mc: codex API is off (mc run --billing codex on)\n',
  }) });
  for (const [trace, stderr, session, expected] of [
    ['', 'mc: codex API is off (mc run --billing codex on)\n', '-', /build not started — provider preflight refused/u],
    ['', 'disk offline\n', '-', /build start unknown — no tool boundary recorded/u],
    ['{"type":"thread.started","thread_id":"session-1"}\n', '', 'session-1', /build started/u],
  ]) {
    f.store[`${stem}.jsonl`] = trace;
    f.store[`${stem}.json.err`] = stderr;
    f.store[`${logDir}/runs.tsv`] = `ts\tname\tkind\tseconds\tsession\texit\n2026-11-01T20:00:10Z\tgoal:mc/plain\tbuild-goal\t10\t${session}\t1\n`;
    for (const args of [['list', 'mc'], ['show', 'mc/plain']]) {
      const before = f.out().length;
      assert.equal(await run(args, f.deps), 0, f.err());
      assert.match(f.out().slice(before), expected);
    }
  }
  f.store[`${stem}.jsonl`] = '';
  f.store[`${stem}.json.err`] = 'mc: codex API is off (mc run --billing codex on)\n';
  f.store[`${logDir}/runs.tsv`] = 'ts\tname\tkind\tseconds\tsession\texit\n2026-11-01T20:00:10Z\tgoal:mc/plain\tbuild-goal\t10\tsession-missing-trace\t1\n';
  for (const args of [['list', 'mc'], ['show', 'mc/plain']]) {
    const before = f.out().length;
    assert.equal(await run(args, f.deps), 0, f.err());
    assert.match(f.out().slice(before), /build start unknown — no tool boundary recorded/u);
  }
  f.store[`${logDir}/runs.tsv`] = 'ts\tname\tkind\tseconds\tsession\texit\n2026-11-01T20:00:10Z\tgoal:mc/plain\tbuild-goal\t10\t-\t1\n';
  f.store[`${logDir}/runner.log`] += '2026-11-01T20:00:00Z goal:mc/plain: review starting (codex)\n';
  for (const args of [['list', 'mc'], ['show', 'mc/plain']]) {
    const before = f.out().length;
    assert.equal(await run(args, f.deps), 0, f.err());
    assert.match(f.out().slice(before), /build start unknown — no tool boundary recorded/u);
  }
});

test('goal outcome: an Antigravity repair start needs a matching native init, not a result alone', async () => {
  const logDir = '/work/runner/log';
  const trace = `${logDir}/goal-mc-plain-20261101T200000Z.jsonl`;
  const f = fixture({ env: { MC_WORK_ROOT: '/work' }, files: seededGoal({
    [`${logDir}/runner.log`]: '2026-11-01T20:00:00Z goal:mc/plain: repair starting (agy gemini-4-argon-high)\n',
    [`${logDir}/runs.tsv`]: `${tsvHeader()}\n${tsvRow({ ts: '2026-11-01T20:00:10Z', name: 'goal:mc/plain', kind: 'repair', seconds: 10, session: 'conversation-1', exit: 1, tool: 'agy' })}\n`,
  }) });
  for (const [event, expected] of [
    [{ event: 'init', init: { conversation_id: 'conversation-1' } }, /build started/u],
    [{ event: 'init', init: { conversation_id: 'other-conversation' } }, /build start unknown — no tool boundary recorded/u],
    [{ event: 'result', result: { conversation_id: 'conversation-1', status: 'FAILURE' } }, /build start unknown — no tool boundary recorded/u],
  ]) {
    f.store[trace] = `${JSON.stringify(event)}\n`;
    for (const output of Object.values(await goalOutcomeViews(f))) assert.match(output, expected, JSON.stringify(event));
  }
});

test('goal outcome: an active main-red wait retains the attempt and Next, then releases', async () => {
  const logDir = '/work/runner/log';
  const mendFile = '/work/runner/main-mend/memoro-cli.json';
  const repair = (state) => JSON.stringify({ version: 1, entries: [{ id: 'm1', state, repo: 'memoro-cli', file: 'tests/red.test.js', branch: 'main-red/m1', owner: 'main-red:m1', base: 'main-head', worktree: null, pr: null }] });
  const continuation = '## 2026-11-01T20:00Z · codex model · build · ready · by build\n\nNext: verify saved proposal\n';
  const f = fixture({ env: { MC_WORK_ROOT: '/work' }, files: seededGoal({
    [`${DIR}/LOG.md`]: `${continuation}\n## 2026-11-01T20:01Z · runner · build · ready\n\nComment: session not counted for progress: main-red repair unfinished in memoro-cli (m1) — no session starts on this goal until it has ended\n`,
    [`${logDir}/runner.log`]: '2026-11-01T20:00:00Z goal:mc/plain: build starting (codex model)\n',
    [`${logDir}/runs.tsv`]: 'ts\tname\tkind\tseconds\tsession\texit\n2026-11-01T20:00:10Z\tgoal:mc/plain\tbuild-goal\t10\tsession-1\t1\n',
    [`${logDir}/goal-mc-plain-20261101T200000Z.jsonl`]: '{"type":"thread.started","thread_id":"session-1"}\n',
  }) });
  for (const state of ['queued', 'running', 'published']) {
    f.store[mendFile] = repair(state);
    for (const output of Object.values(await goalOutcomeViews(f))) {
      assert.match(output, /build started · runner waits for main-red repair in memoro-cli \(m1\) · Next: verify saved proposal/u, state);
      assert.doesNotMatch(output, /build remains eligible|technical desk/u, state);
    }
  }
  const announcements = f.store[`${logDir}/runner.log`];
  delete f.store[`${logDir}/runner.log`];
  for (const output of Object.values(await goalOutcomeViews(f))) {
    assert.match(output, /build start unknown — no tool boundary recorded · runner waits for main-red repair/u);
  }
  f.store[`${logDir}/runner.log`] = announcements;
  for (const state of ['landed', 'dropped', 'Martin', 'unreadable']) {
    f.store[mendFile] = state === 'unreadable' ? '{' : repair(state);
    for (const output of Object.values(await goalOutcomeViews(f))) {
      assert.match(output, /build started · build remains eligible · Next: verify saved proposal/u, state);
      assert.doesNotMatch(output, /runner waits for main-red repair|technical desk/u, state);
    }
  }
  f.store[mendFile] = repair('published');
  f.store[`${DIR}/LOG.md`] = continuation;
  for (const output of Object.values(await goalOutcomeViews(f))) {
    assert.match(output, /build started · build remains eligible · Next: verify saved proposal/u);
    assert.doesNotMatch(output, /runner waits for main-red repair/u);
  }
});

test('mc goal new writes a GOAL.json skeleton and LOG.md, fetches each repository, and makes no worktree', async () => {
  const f = fixture();
  const code = await run(['new', 'mc/plain', '--repo', 'memoro-cli,memoro', '--class', 'large', '--title', 'Make the goal plain', '--structure', '1'], f.deps);
  assert.equal(code, 0, f.err());

  const goal = parseGoal(f.store[`${DIR}/GOAL.json`]);
  assert.deepEqual([goal.stage, goal.status], ['draft', 'ready'], 'a new goal is in draft unless --stage build');
  assert.deepEqual(goal.repos, ['memoro-cli', 'memoro']);
  assert.equal(goal.class, 'large');
  assert.equal(goal.created, '2026-11-01T20:00:00Z');
  assert.equal(goal.title, 'Make the goal plain');
  assert.deepEqual([goal.goal, goal.contract, goal.out_of_scope, goal.success_criteria, goal.documents], [[], [], [], [], []]);
  assert.equal(goalField(f.store[`${DIR}/GOAL.json`], 'schema'), 'mc-goal');
  assert.equal(f.store[`${DIR}/LOG.md`], '## 2026-11-01T20:00Z · person · draft · ready\n\nDone: created\nComment: held from creation: draft being written by its author\n');

  assert.deepEqual(f.calls, [
    { cwd: '/home/m/memoro-cli.git', args: ['fetch', '-q', 'origin'] },
    { cwd: '/home/m/memoro', args: ['fetch', '-q', 'origin'] },
  ], 'no worktree, and no branch looked at: nothing is added');
  assert.deepEqual(listUnder(f.store, DIR), [], 'no <goal>/<repo> directory');
  assert.match(f.out(), new RegExp(`mc: mc/plain · draft · ready · phase 1 — ${DIR}`, 'u'));
  assert.match(f.out(), /no worktree yet: the runner makes memoro-cli, memoro on goal\/plain at the goal's first session/u);
  assert.equal(goal.phase, 1, 'phase 1 when --phase is not given');
  assert.match(f.out(), /GOAL\.json is to be filled in by verbs: mc goal set mc\/plain/u);
});

test('mc goal new accepts medium and reads it back from GOAL.json', async () => {
  const f = fixture();
  assert.equal(await run(['new', 'mc/plain', '--repo', 'memoro-cli', '--class', 'medium', '--title', 'Across chosen components'], f.deps), 0, f.err());
  const goal = parseGoal(f.store[`${DIR}/GOAL.json`]);
  assert.equal(goal.class, 'medium');
  assert.match(f.out(), /mc: mc\/plain · draft · ready/u);
  assert.equal(await run(['show', 'mc/plain'], f.deps), 0, f.err());
  assert.match(f.out(), /draft · ready · phase 1 · memoro-cli · medium/u, 'show exposes medium in the goal status line');
});

test('mc goal new --stage build is refused with exit 2 and creates nothing; --stage draft makes the goal; no other stage is a new goal\'s', async () => {
  const f = fixture();
  assert.equal(await run(['new', 'mc/plain', '--repo', 'memoro', '--class', 'fast', '--title', 'T', '--stage', 'build'], f.deps), 2);
  assert.match(f.err(), /written in draft.*mc goal stage <programme>\/<goal> build\n/u);
  assert.equal(f.store[`${DIR}/GOAL.json`], undefined);
  assert.equal(f.store[`${DIR}/LOG.md`], undefined);
  assert.deepEqual(f.calls, [], 'nothing was fetched');
  const d = fixture();
  assert.equal(await run(['new', 'mc/plain', '--repo', 'memoro', '--class', 'fast', '--title', 'T', '--stage', 'draft'], d.deps), 0, d.err());
  assert.equal(parseGoal(d.store[`${DIR}/GOAL.json`]).stage, 'draft');
  const g = fixture();
  assert.equal(await run(['new', 'mc/plain', '--repo', 'memoro', '--class', 'fast', '--title', 'T', '--stage', 'review'], g.deps), 2);
  assert.match(g.err(), /--stage is draft for a new goal, not review/u);
  const h = fixture();
  assert.equal(await run(['new', 'mc/plain', '--repo', 'memoro', '--class', 'fast', '--title', 'T', '--stage', 'plan'], h.deps), 2, 'the old word is not a new goal\'s stage');
  assert.match(h.err(), /--stage is draft for a new goal, not plan/u);
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

test('mc goal new refuses a programme with no directory, a goal that exists, a repository mc does not know, and an unknown class', async () => {
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
  assert.match(badClass.err(), /--class is fast or medium or large, not huge/u);
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
  assert.equal(goalField(f.store[`${DIR}/GOAL.json`], 'stage'), 'draft');
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

  for (const [flag, value, said] of [['--status', 'open', /^mc: status is ready, blocked, Martin, not open\n$/u], ['--stage', 'started', /^mc: stage is draft, build, review, finish, merge, done, dropped, not started\n$/u]]) {
    const bad = fixture({ files: seededGoal() });
    assert.equal(await run(['log', 'mc/plain', flag, value, '--comment', 'x'], bad.deps), 2);
    assert.match(bad.err(), said);
    assert.equal(bad.store[`${DIR}/LOG.md`], LOG_TEXT, 'nothing written');
  }
});

test('mc goal blocked, ready and done set their one field and log the reason; a blocked goal set ready keeps its stage', async () => {
  for (const [verb, stage, status] of [['blocked', 'build', 'blocked'], ['done', 'done', 'ready']]) {
    const f = fixture({ files: seededGoal(), env: { MC_GOAL: 'mc/plain' } });
    assert.equal(await run([verb, '--reason', `because ${verb}`], f.deps), 0, f.err());
    const goal = parseGoal(f.store[`${DIR}/GOAL.json`]);
    assert.deepEqual([goal.stage, goal.status], [stage, status], verb);
    const last = parseLog(f.store[`${DIR}/LOG.md`]).at(-1);
    assert.deepEqual([last.stage, last.status, last.comment], [stage, status, `because ${verb}`]);
  }
  const dropped = dropFixture(fixture({ files: seededGoal(), env: { MC_GOAL: 'mc/plain' } }));
  assert.equal(await run(['drop', '--reason', 'abandoned'], dropped.deps), 0, dropped.err());
  assert.equal(dropped.store[`${HOME}/mc/goals/plain/GOAL.json`], undefined, 'the active record is archived in the same call');
  assert.equal(goalField(dropped.store[`${HOME}/mc/goals/.archive/plain/GOAL.json`], 'stage'), 'dropped');
  assert.match(dropped.store[`${HOME}/mc/goals/goal_log.md`], /\| dropped \|/u);
  const viaLog = dropFixture(fixture({ files: seededGoal() }));
  assert.equal(await run(['log', 'mc/plain', '--stage', 'dropped', '--comment', 'abandoned'], viaLog.deps), 0, viaLog.err());
  assert.equal(goalField(viaLog.store[`${HOME}/mc/goals/.archive/plain/GOAL.json`], 'stage'), 'dropped', 'log --stage uses the same finalizer');
  const held = fixture({ files: seededGoal({ [`${DIR}/GOAL.json`]: withGoal(GOAL_TEXT, { stage: 'merge', status: 'blocked' }) }) });
  assert.equal(await run(['ready', 'mc/plain', '--reason', 'answered'], held.deps), 0, held.err());
  assert.deepEqual(['stage', 'status'].map((key) => goalField(held.store[`${DIR}/GOAL.json`], key)), ['merge', 'ready']);
  const f = fixture({ files: seededGoal() });
  assert.equal(await run(['drop', 'mc/plain'], f.deps), 2);
  assert.match(f.err(), /drop needs --reason/u);
  assert.equal(await run(['blocked', '--done', 'x'], f.deps), 2);
  assert.match(f.err(), /blocked takes no --done/u);
});

test('dropping refuses to archive while a live current-*.json owns the goal', async () => {
  const root = '/work';
  const f = dropFixture(fixture({
    files: { ...seededGoal(), [`${root}/runner/current-memoro.json`]: JSON.stringify({ name: 'mc/plain', pid: 777 }) },
    env: { MC_GOAL: 'mc/plain', MC_WORK_ROOT: root },
    alive: (pid) => pid === 777,
  }));
  assert.equal(await run(['drop', '--reason', 'abandoned'], f.deps), 1);
  assert.equal(goalField(f.store[`${DIR}/GOAL.json`], 'stage'), 'dropped', 'drop is persisted');
  assert.equal(f.store[`${HOME}/mc/goals/.archive/plain/GOAL.json`], undefined, 'live-owned work is not moved');
  assert.equal(f.store[`${HOME}/mc/goals/goal_log.md`], undefined, 'no archive success is recorded');
  assert.match(f.err(), /live session still owns mc\/plain/u);
});

/**
 * A goal's branch is made when the goal can start: one written in plan got its
 * branch at `mc goal new`, before the phases ahead of it landed.
 */
test('mc goal stage build remakes a branch with no commits of its own from origin/main, leaves one with commits alone, and says no worktree yet for a repository without one', async () => {
  const draftText = withGoal(GOAL_TEXT, { stage: 'draft' });
  const planned = seededGoal({ [`${DIR}/GOAL.json`]: draftText });
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

  const absent = fixture({
    files: planned,
    absent: [`${DIR}/memoro-cli`],
    git: (cwd) => ({ ok: false, stderr: `fatal: cannot change to '${cwd}': No such file or directory` }),
  });
  assert.equal(await run(['stage', 'mc/plain', 'build'], absent.deps), 0, absent.err());
  assert.equal(absent.calls.some((call) => call.cwd === `${DIR}/memoro-cli`), false, 'no git call for a missing worktree');
  assert.match(absent.out(), /memoro-cli {2}goal\/plain no worktree yet — the runner remakes the branch from origin\/main at the first session/u);
  assert.doesNotMatch(absent.out(), /could not fetch/u, 'a missing worktree is not reported as a fetch failure');

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

/* ------------------------------ evidence at the current head: the heads of the worktrees and the records of the marks */

const EVIDENCE_PATH = `${DIR}/.evidence.json`;
const sha = (char) => char.repeat(40);
const HEADS = { 'memoro-cli': sha('a') };
const TWO_HEADS = { 'memoro-cli': sha('a'), memoro: sha('b') };
/**
 * A git fake for the worktrees of a goal. `heads` maps a repository to the HEAD of its worktree, `published` to the sha of
 * refs/remotes/origin/<its branch> (default: the HEAD it has now; a repository missing there has not been published),
 * `branches` to the branch it is on (default goal/plain), `dirty` lists the repositories with an uncommitted change. Each
 * is kept on the fake (`git.heads` …), so a test makes a commit by writing there. Everything else is `allOk`.
 */
function worktreeGit({ heads = { ...HEADS }, published = { ...heads }, branches = {}, dirty = [] } = {}) {
  const git = (cwd, args) => {
    const repo = cwd.startsWith(`${DIR}/`) ? cwd.slice(DIR.length + 1) : null;
    if (!repo || !(repo in git.heads)) return allOk(cwd, args);
    const branch = git.branches[repo] ?? 'goal/plain';
    const line = args.join(' ');
    if (line === 'status --short') return ok(git.dirty.includes(repo) ? ' M src/x.js\n' : '');
    if (line === 'rev-parse HEAD') return ok(`${git.heads[repo]}\n`);
    if (line === 'rev-parse --abbrev-ref HEAD') return ok(`${branch}\n`);
    if (line === `rev-parse refs/remotes/origin/${branch}`) return git.published[repo] ? ok(`${git.published[repo]}\n`) : failed('unknown revision');
    return allOk(cwd, args);
  };
  return Object.assign(git, { heads, published, branches, dirty });
}
/** A commit in `repo`, published: its HEAD and the published ref both move. */
const commitIn = (git, repo, to = sha('c')) => { git.heads[repo] = to; git.published[repo] = to; };
/** A record as `mc goal criterion met` or `mc goal evidence` leaves it. */
const recordAt = (heads, extra = {}) => ({ at: '2026-11-01T19:00Z', tool: 'claude', model: 'opus', role: 'build', heads, text: 'ran the check and it held', ...extra });
/** `.evidence.json` holding `items`, as a file of the fixture. */
const evidenceFile = (items) => ({ [EVIDENCE_PATH]: `${JSON.stringify({ items }, null, 2)}\n` });
const evidenceOf = (f) => JSON.parse(f.store[EVIDENCE_PATH]).items;
/** The records of version 1 criteria `texts`, all at `heads`. */
const criterionRecords = (texts, heads = HEADS) => evidenceFile(Object.fromEntries(texts.map((text, index) => [`criterion ${index + 1}`, recordAt(heads, { criterion: text })])));

/** The version 2 goal of two repositories, two criteria met, a preserve item V1, a touched obligation Documentation and an untouched one, Operations. */
const TWO_CRITERIA = [{ criterion: 'first', check: 'x', met: true }, { criterion: 'second', check: 'y', met: true }];
const v2Goal = (fields = {}) => goalJsonV2({ repos: ['memoro-cli', 'memoro'], success_criteria: TWO_CRITERIA, ...fields });
/** Every item of `v2Goal` recorded at `heads`, except the ids in `without`. */
const fullEvidence = (heads = TWO_HEADS, without = []) => evidenceFile(Object.fromEntries(Object.entries({
  'criterion 1': recordAt(heads, { criterion: 'first' }),
  'criterion 2': recordAt(heads, { criterion: 'second' }),
  V1: recordAt(heads),
  'obligation Documentation': recordAt(heads),
}).filter(([id]) => !without.includes(id))));
/** The two ways a build session moves a goal to review. */
const MOVES_TO_REVIEW = [['stage', 'review', '--reason', 'built'], ['log', '--done', 'built', '--stage', 'review']];
/** `argv` run on `files` in a fixture of `env` (default: a build session) over `git`; the exit code is `f.code`. */
async function callWith(argv, files, { env = BUILD, git = worktreeGit({ heads: { ...TWO_HEADS } }), absent = [] } = {}) {
  const f = fixture({ files, env, git, absent });
  f.code = await run(argv, f.deps);
  return f;
}
const v2Files = (extra = {}, fields = {}) => seededGoal({ [`${DIR}/GOAL.json`]: v2Goal(fields), ...extra });

/** A fixture whose `gh pr list --head` answers `pr` (null: none) and whose queue is recorded. */
function reviewed({ files, env = REVIEW, pr = { number: 31, headRefOid: 'fff0000' }, queue = null, git = allOk } = {}) {
  const f = fixture({ files, env, git });
  f.queued = [];
  f.gh = [];
  f.deps.gh = (cwd, args) => { f.gh.push({ cwd, args }); return ok(JSON.stringify(pr ? [pr] : [])); };
  f.deps.queue = queue ?? ((options) => { f.queued.push(options); return { place: 0 }; });
  return f;
}

/** The head the review judged: MC_REVIEW_HEAD of `REVIEW`. */
const HEAD = 'abc1234def';
/** The ids of the verdict on the version 1 goal `GOAL_TEXT` (criteria only) and on `GOAL_BASE_V2` with its touched obligation. */
const V1_IDS = ['criterion 1'];
const V2_IDS = ['criterion 1', 'V1', 'obligation Documentation', 'change', 'out-of-scope', 'protection', 'bugs'];
/**
 * REVIEW.md in its fixed form: a `head:` line per repository, then a line per id — OK, `OK — carried from round 1` (those in
 * `carried`), or NOT OK with its reason (those in `notOk`). `without` drops lines; `tail` is free text after them.
 */
function verdictText({ ids = V1_IDS, repos = ['memoro-cli'], head = HEAD, notOk = {}, carried = [], without = [], tail = '' } = {}) {
  const lines = ids.filter((id) => !without.includes(id)).map((id) => {
    if (id in notOk) return `${id}: NOT OK — ${notOk[id]}`;
    return carried.includes(id) ? `${id}: OK — carried from round 1` : `${id}: OK`;
  });
  return `${[...repos.map((repo) => `head: ${repo} ${head}`), ...lines].join('\n')}\n${tail}`;
}
const REVIEW_FILE = `${DIR}/REVIEW.md`;
/** A goal in review whose REVIEW.md is `text` (`extra` files, and the goal's own text, may be added). */
const inReview = (text, extra = {}) => inStage('review', 'ready', { [REVIEW_FILE]: text, ...extra });
/** A review's log entries before this one: `n` rejections (review → build by a review session), each followed by a build session's move back to review. */
const rejectedLog = (n, { from = 2 } = {}) => Array.from({ length: n }, (_, index) => [
  `## 2026-11-0${from + index}T10:00Z · claude · build · ready · by review`, '', 'Done: rejected', '',
  `## 2026-11-0${from + index}T11:00Z · claude · review · ready · by build`, '', 'Done: repaired', '',
].join('\n')).join('\n');
/** The LOG.md of `inReview` with `before` appended; the goal's entries `LOG_TEXT` come first. */
const withLog = (before) => ({ [`${DIR}/LOG.md`]: `${LOG_TEXT}\n## 2026-11-01T23:30Z · claude · review · ready · by build\n\nDone: built\n\n${before}` });

test('stage moves by their owners, including recovery from historical finish', async () => {
  const moves = [
    ['draft', 'build', PLAN], ['build', 'review', BUILD], ['review', 'merge', REVIEW],
    ['finish', 'merge', PLAN], ['merge', 'done', {}], ['draft', 'review', PLAN], ['finish', 'dropped', PLAN], ['build', 'dropped', PLAN],
  ];
  for (const [from, to, env] of moves) {
    const reading = {};
    // A build session's move to review needs its mark's record at the head of the worktree, which is published (mc/evidence-at-current-head).
    const built = from === 'build' && to === 'review';
    let f = reviewed({ files: inStage(from, 'ready', { [REVIEW_FILE]: verdictText(), ...reading, ...(built ? criterionRecords(['it works']) : {}) }), env, git: built ? worktreeGit() : allOk });
    if (to === 'dropped') f = dropFixture(f);
    assert.equal(await run(['stage', ...(env.MC_GOAL ? [] : ['mc/plain']), to], f.deps), 0, `${from} → ${to}: ${f.err()}`);
    if (to === 'dropped') assert.equal(goalField(f.store[`${HOME}/mc/goals/.archive/plain/GOAL.json`], 'stage'), 'dropped');
    else {
      assert.equal(stateOf(f), `${to} · ready`, `${from} → ${to}`);
      assert.equal(parseLog(f.store[`${DIR}/LOG.md`]).at(-1).stage, to);
    }
  }
});

test('a session\'s backward move is refused naming both stages, whatever its role; a person\'s is made and logged', async () => {
  for (const [from, to, env] of [['review', 'build', PLAN], ['merge', 'review', PLAN], ['finish', 'build', REVIEW], ['review', 'build', BUILD], ['done', 'merge', PLAN], ['finish', 'draft', SESSION]]) {
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

test('interactive Martin can return, move backward/forward and drop with attribution; cannot mark done or use headless authority', async () => {
  const MARTIN = { MC_GOAL: 'mc/plain', MC_TOOL: 'claude', MC_ROLE: 'martin' };
  for (const [from, to, expected] of [['merge', 'build', 'build · ready'], ['build', 'review', 'review · ready'], ['build', 'build', 'build · ready']]) {
    const f = fixture({ files: inStage(from), env: MARTIN });
    assert.equal(await run(['stage', to], f.deps), 0, f.err());
    assert.equal(stateOf(f), expected);
    assert.equal(parseLog(f.store[`${DIR}/LOG.md`]).at(-1).role, 'martin');
    if (from === 'merge') assert.match(parseLog(f.store[`${DIR}/LOG.md`]).at(-1).comment, /moved back from merge to build by martin/u);
  }
  const drop = dropFixture(fixture({ files: inStage('build'), env: MARTIN }));
  assert.equal(await run(['drop', '--reason', 'superseded'], drop.deps), 0, drop.err());
  const archived = `${HOME}/mc/goals/.archive/plain`;
  assert.equal(drop.store[`${DIR}/GOAL.json`], undefined, 'the active goal is archived');
  assert.equal(goalField(drop.store[`${archived}/GOAL.json`], 'stage'), 'dropped');
  assert.equal(goalField(drop.store[`${archived}/GOAL.json`], 'status'), 'ready');
  assert.equal(parseLog(drop.store[`${archived}/LOG.md`]).at(-1).role, 'martin');
  const returned = fixture({ files: inStage('review', 'Martin'), env: MARTIN });
  assert.equal(await run(['ready'], returned.deps), 0, returned.err());
  assert.equal(stateOf(returned), 'review · ready'); assert.equal(parseLog(returned.store[`${DIR}/LOG.md`]).at(-1).role, 'martin');
  const done = fixture({ files: inStage('merge'), env: MARTIN });
  assert.equal(await run(['stage', 'done'], done.deps), 2); assert.match(done.err(), /does not mark a goal done administratively/u);
  const unattended = fixture({ files: inStage('build'), env: { ...MARTIN, MC_HEADLESS: '1' } });
  assert.equal(await run(['stage', 'review'], unattended.deps), 2); assert.match(unattended.err(), /interactive-only/u);
});

test('mc goal log and new name the session that wrote the entry by its role in the heading: build, review, plan; a person, or no role, writes none', async () => {
  const cases = [
    [{ MC_GOAL: 'mc/plain', MC_TOOL: 'claude', MC_ROLE: BUILD_ROLES.goal }, ['--stage', 'review', '--done', 'x'], '· claude · review · ready · by build', 'review', 'build'],
    [{ MC_GOAL: 'mc/plain', MC_TOOL: 'claude', MC_ROLE: REVIEW_ROLE }, ['--done', 'x'], '· claude · build · ready · by review', 'build', 'review'],
    [{ MC_GOAL: 'mc/plain', MC_TOOL: 'claude', MC_ROLE: PLAN_ROLE }, ['--done', 'x'], '· claude · build · ready · by plan', 'build', 'plan'],
    [{ MC_GOAL: 'mc/plain', MC_TOOL: 'person', MC_ROLE: BUILD_ROLES.goal }, ['--done', 'x'], '· person · build · ready · by build', 'build', 'build'],
    [{ MC_GOAL: 'mc/plain', MC_TOOL: 'claude' }, ['--done', 'x'], '· claude · build · ready', 'build', null],
    [{ MC_GOAL: 'mc/plain', MC_TOOL: 'claude', MC_ROLE: 'odd role:x' }, ['--done', 'x'], '· claude · build · ready', 'build', null],
    [{ MC_GOAL: 'mc/plain', MC_TOOL: 'claude', MC_ROLE: 'constructor' }, ['--done', 'x'], '· claude · build · ready · by constructor', 'build', 'constructor'],
  ];
  for (const [env, args, heading, stage, role] of cases) {
    // The build session's move to review needs its mark's record at the head of the worktree, which is published (mc/evidence-at-current-head).
    const toReview = args.includes('review');
    const f = fixture({ files: inStage('build', 'ready', toReview ? criterionRecords(['it works']) : {}), env, git: toReview ? worktreeGit() : allOk });
    const before = parseLog(f.store[`${DIR}/LOG.md`]).length;
    assert.equal(await run(['log', ...args], f.deps), 0, `${heading}: ${f.err()}`);
    const entries = parseLog(f.store[`${DIR}/LOG.md`]);
    assert.equal(entries.length, before + 1, `the entry is kept: ${JSON.stringify(env)}`);
    const entry = entries.at(-1);
    assert.equal(entry.done, 'x', JSON.stringify(env));
    assert.deepEqual([entry.role, entry.stage], [role, stage], JSON.stringify(env));
    const last = f.store[`${DIR}/LOG.md`].match(/^## .*$/gmu).at(-1);
    assert.equal(last, `## 2026-11-01T20:00Z ${heading}`, JSON.stringify(env));
  }
  const created = fixture({ env: { MC_TOOL: 'claude', MC_ROLE: PLAN_ROLE } });
  assert.equal(await run(['new', 'mc/plain', '--repo', 'memoro', '--class', 'fast', '--title', 'T'], created.deps), 0, created.err());
  assert.equal(created.store[`${DIR}/LOG.md`], '## 2026-11-01T20:00Z · claude · draft · ready · by plan\n\nDone: created\nComment: held from creation: draft being written by its author\n');
});

test('a build session moves build to review or sets blocked, and nothing else', async () => {
  const blocked = fixture({ files: inStage('build'), env: BUILD });
  assert.equal(await run(['log', '--comment', 'which table?', '--status', 'blocked'], blocked.deps), 0, blocked.err());
  assert.equal(stateOf(blocked), 'build · blocked');
  for (const [from, argv, said] of [
    ['build', ['stage', 'done'], /a session does not set done — move it to review; the merger sets done/u],
    ['build', ['drop', '--reason', 'x'], /only plan or a person drops a goal/u],
    ['build', ['stage', 'merge'], /a build session moves a goal only from build to review, not build → merge/u],
    ['draft', ['stage', 'build'], /a build session moves a goal only from build to review, not draft → build/u],
    ['build', ['ready'], /a build session does not set a goal ready — a person does/u],
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
  // A build session marks from its worktree and moves with every mark recorded at its head (mc/evidence-at-current-head).
  const met = fixture({ files: seededGoal({ [`${DIR}/GOAL.json`]: two, ...criterionRecords(['a']) }), env: BUILD, git: worktreeGit() });
  assert.equal(await run(['criterion', 'met', '2'], met.deps), 0, met.err());
  assert.equal(await run(['stage', 'review', '--reason', 'built'], met.deps), 0, met.err());
  for (const env of [PLAN, {}]) {
    const f = fixture({ files: seededGoal({ [`${DIR}/GOAL.json`]: two }), env });
    assert.equal(await run(['stage', 'mc/plain', 'review'], f.deps), 0, f.err());
  }
});

/* ------------------------------------------------- evidence at the current head: the marks (mc/evidence-at-current-head C1) */

test('a build session\'s mark records the head of each worktree of a two-repository goal, the evidence, the criterion\'s text, tool, model and time, and leaves LOG.md byte-identical', async () => {
  const f = await callWith(['criterion', 'met', '1', '--evidence', 'ran mc gate: 12 pass, 0 fail'], v2Files({}, { success_criteria: [{ criterion: 'first', check: 'x', met: false }, { criterion: 'second', check: 'y', met: false }] }));
  assert.equal(f.code, 0, f.err());
  assert.deepEqual(evidenceOf(f), { 'criterion 1': { at: '2026-11-01T20:00Z', tool: 'claude', model: 'opus', role: 'build', heads: TWO_HEADS, text: 'ran mc gate: 12 pass, 0 fail', criterion: 'first' } });
  assert.equal(parseGoal(f.store[`${DIR}/GOAL.json`]).success_criteria[0].met, true);
  assert.equal(f.store[`${DIR}/LOG.md`], LOG_TEXT, 'the runner counts LOG.md entries: a mark writes none');
  assert.equal(await run(['criterion', 'met', '2', '--evidence', 'second ran'], f.deps), 0, f.err());
  assert.deepEqual(Object.keys(evidenceOf(f)), ['criterion 1', 'criterion 2'], 'each criterion has its own record');
  assert.equal(f.store[`${DIR}/LOG.md`], LOG_TEXT);
});

test('--evidence-file - reads stdin verbatim, a file is read as it is, and both ways at once, a missing file and a blank text are refused and write nothing', async () => {
  const files = { '-': 'line one "q" $(x)\n`two`\n', 'note.txt': 'from a file\n' };
  const unmet = [{ criterion: 'first', check: 'x', met: false }];
  const make = async (argv) => {
    const f = fixture({ files: v2Files({}, { success_criteria: unmet }), env: BUILD, git: worktreeGit({ heads: { ...TWO_HEADS } }) });
    f.deps.readFile = (path) => { if (!Object.hasOwn(files, path)) throw new Error('ENOENT'); return files[path]; };
    f.code = await run(argv, f.deps);
    return f;
  };
  assert.equal(evidenceOf(await make(['criterion', 'met', '1', '--evidence-file', '-']))['criterion 1'].text, 'line one "q" $(x)\n`two`', 'stdin as it is, but for the one final newline');
  assert.equal(evidenceOf(await make(['criterion', 'met', '1', '--evidence-file', 'note.txt']))['criterion 1'].text, 'from a file');
  for (const [argv, code, said] of [
    [['criterion', 'met', '1', '--evidence', 'x', '--evidence-file', 'note.txt'], 2, /--evidence and --evidence-file are one or the other, not both/u],
    [['criterion', 'met', '1', '--evidence-file', 'missing.txt'], 1, /--evidence-file missing\.txt cannot be read/u],
    [['criterion', 'met', '1', '--evidence', '   '], 2, /criterion met needs --evidence/u],
  ]) {
    const f = await make(argv);
    assert.equal(f.code, code, argv.join(' '));
    assert.match(f.err(), said);
    assert.equal(f.store[EVIDENCE_PATH], undefined, 'no record');
    assert.equal(parseGoal(f.store[`${DIR}/GOAL.json`]).success_criteria[0].met, false, 'not marked');
  }
});

test('a build session\'s mark is refused on a dirty worktree and on an absent one, each repository named, and on a version 2 goal without evidence; nothing is written', async () => {
  const unmet = [{ criterion: 'first', check: 'x', met: false }];
  for (const [label, options, said] of [
    ['dirty', { git: worktreeGit({ heads: { ...TWO_HEADS }, dirty: ['memoro'] }) }, /memoro has uncommitted changes — commit them, run the check at that head, then record it/u],
    ['absent', { absent: [`${DIR}/memoro`] }, /memoro has no worktree at \/work\/programs\/mc\/goals\/plain\/memoro/u],
  ]) {
    const f = await callWith(['criterion', 'met', '1', '--evidence', 'ran it'], v2Files({}, { success_criteria: unmet }), options);
    assert.equal(f.code, 2, label);
    assert.match(f.err(), said, label);
    assert.doesNotMatch(f.err(), /memoro-cli has/u, `${label}: only the repository at fault`);
    assert.equal(f.store[EVIDENCE_PATH], undefined, `${label}: no record`);
    assert.equal(parseGoal(f.store[`${DIR}/GOAL.json`]).success_criteria[0].met, false, `${label}: not marked`);
    assert.equal(f.store[`${DIR}/LOG.md`], LOG_TEXT);
  }
  const bare = await callWith(['criterion', 'met', '1'], v2Files({}, { success_criteria: unmet }));
  assert.equal(bare.code, 2);
  assert.match(bare.err(), /criterion met needs --evidence "…" or --evidence-file <path\|-> — what the check ran and what it showed/u);
  assert.equal(bare.store[EVIDENCE_PATH], undefined);
  assert.equal(parseGoal(bare.store[`${DIR}/GOAL.json`]).success_criteria[0].met, false);
});

test('a version 1 goal is marked without evidence, with the heads recorded; a person and plan mark with no worktree and get none to record', async () => {
  const v1 = await callWith(['criterion', 'met', '1'], seededGoal(), { git: worktreeGit() });
  assert.equal(v1.code, 0, v1.err());
  assert.deepEqual(evidenceOf(v1)['criterion 1'], { at: '2026-11-01T20:00Z', tool: 'claude', model: 'opus', role: 'build', heads: HEADS, text: '', criterion: 'it works' });
  const dirty = await callWith(['criterion', 'met', '1'], seededGoal(), { git: worktreeGit({ dirty: ['memoro-cli'] }) });
  assert.equal(dirty.code, 2, 'a version 1 goal still needs a clean worktree');
  assert.match(dirty.err(), /memoro-cli has uncommitted changes/u);
  for (const env of [{}, PLAN]) {
    const f = await callWith(['criterion', 'met', 'mc/plain', '1'], v2Files({}, { success_criteria: [{ criterion: 'first', check: 'x', met: false }] }), { env, absent: [`${DIR}/memoro-cli`, `${DIR}/memoro`] });
    assert.equal(f.code, 0, `${JSON.stringify(env)}: ${f.err()}`);
    assert.equal(parseGoal(f.store[`${DIR}/GOAL.json`]).success_criteria[0].met, true);
    assert.deepEqual(evidenceOf(f)['criterion 1'].heads, {}, 'no worktree: no head');
    assert.equal(f.store[`${DIR}/LOG.md`], LOG_TEXT);
  }
  const person = await callWith(['criterion', 'met', 'mc/plain', '1', '--evidence', 'read it'], v2Files({}, { success_criteria: [{ criterion: 'first', check: 'x', met: false }] }), { env: {} });
  assert.deepEqual(evidenceOf(person)['criterion 1'], { at: '2026-11-01T20:00Z', tool: 'person', model: null, role: null, heads: TWO_HEADS, text: 'read it', criterion: 'first' }, 'a person with worktrees: their heads');
});

test('criterion unmet and criterion set remove the criterion\'s record, and nothing else', async () => {
  const items = evidenceOf({ store: { [EVIDENCE_PATH]: fullEvidence()[EVIDENCE_PATH] } });
  const unmet = await callWith(['criterion', 'unmet', 'mc/plain', '1'], v2Files(fullEvidence()), { env: {} });
  assert.equal(unmet.code, 0, unmet.err());
  assert.deepEqual(Object.keys(evidenceOf(unmet)), ['criterion 2', 'V1', 'obligation Documentation']);
  const set = await callWith(['criterion', 'set', 'mc/plain', '2', '--criterion', 'second, reworded'], v2Files(fullEvidence()), { env: PLAN });
  assert.equal(set.code, 0, set.err());
  assert.deepEqual(Object.keys(evidenceOf(set)), ['criterion 1', 'V1', 'obligation Documentation']);
  assert.deepEqual(evidenceOf(set).V1, items.V1);
  const checkOnly = await callWith(['criterion', 'set', 'mc/plain', '1', '--check', 'a new check'], v2Files(fullEvidence()), { env: {} });
  assert.deepEqual(Object.keys(evidenceOf(checkOnly)), ['criterion 2', 'V1', 'obligation Documentation'], 'a changed check is a mark to run again');
  const none = await callWith(['criterion', 'unmet', 'mc/plain', '1'], v2Files(), { env: {} });
  assert.equal(none.code, 0, none.err());
  assert.equal(none.store[EVIDENCE_PATH], undefined, 'no record, no file made');
});

test('criterion remove drops the removed criterion\'s record and the later records follow their criteria down one number', async () => {
  const three = [{ criterion: 'first', check: 'x', met: true }, { criterion: 'second', check: 'y', met: true }, { criterion: 'third', check: 'z', met: true }];
  const files = v2Files({ ...evidenceFile({
    'criterion 1': recordAt(TWO_HEADS, { criterion: 'first', text: 'one' }),
    'criterion 2': recordAt(TWO_HEADS, { criterion: 'second', text: 'two' }),
    'criterion 3': recordAt(TWO_HEADS, { criterion: 'third', text: 'three' }),
    V1: recordAt(TWO_HEADS, { text: 'preserved' }),
  }) }, { success_criteria: three });
  const f = await callWith(['criterion', 'remove', 'mc/plain', '2', '--reason', 'obsolete'], files, { env: {} });
  assert.equal(f.code, 0, f.err());
  const items = evidenceOf(f);
  assert.deepEqual(Object.keys(items).sort(), ['V1', 'criterion 1', 'criterion 2']);
  assert.deepEqual([items['criterion 1'].text, items['criterion 2'].text, items['criterion 2'].criterion, items.V1.text], ['one', 'three', 'third', 'preserved']);
  assert.deepEqual(parseGoal(f.store[`${DIR}/GOAL.json`]).success_criteria.map((item) => item.criterion), ['first', 'third']);
});

test('mc goal evidence records a preserve item or a touched obligation without a LOG.md entry, and refuses an id the goal has not, listing the ones it has', async () => {
  const f = await callWith(['evidence', 'V1', '--text', 'read src/mc/goals.js: version 1 is as before'], v2Files());
  assert.equal(f.code, 0, f.err());
  assert.equal(await run(['evidence', 'mc/plain', 'Documentation', '--text', 'mc-goals.md says both versions'], f.deps), 0, f.err());
  assert.deepEqual(evidenceOf(f), {
    V1: { at: '2026-11-01T20:00Z', tool: 'claude', model: 'opus', role: 'build', heads: TWO_HEADS, text: 'read src/mc/goals.js: version 1 is as before' },
    'obligation Documentation': { at: '2026-11-01T20:00Z', tool: 'claude', model: 'opus', role: 'build', heads: TWO_HEADS, text: 'mc-goals.md says both versions' },
  });
  assert.equal(f.store[`${DIR}/LOG.md`], LOG_TEXT, 'LOG.md byte-identical');
  assert.equal(f.store[`${DIR}/GOAL.json`], v2Goal(), 'the goal is not touched');
  f.deps.readFile = (path) => { if (path !== '-') throw new Error('ENOENT'); return 'from stdin\n'; };
  assert.equal(await run(['evidence', 'V1', '--file', '-'], f.deps), 0, f.err());
  assert.equal(evidenceOf(f).V1.text, 'from stdin');
  for (const [id, goalText] of [['V9', v2Goal()], ['Operations', v2Goal()], ['criterion 1', v2Goal()], ['V1', seededGoal()[`${DIR}/GOAL.json`]]]) {
    const g = await callWith(['evidence', id, '--text', 'x'], seededGoal({ [`${DIR}/GOAL.json`]: goalText }));
    assert.equal(g.code, 2, id);
    assert.match(g.err(), goalText === v2Goal() ? /is not a preserve item or a touched obligation — the ids are V1, Documentation/u : /it has none \(a version 1 goal has no preserve items or obligations\)/u, id);
    assert.equal(g.store[EVIDENCE_PATH], undefined);
  }
  for (const argv of [['evidence', 'V1'], ['evidence', 'V1', '--text', 'a', '--file', 'b'], ['evidence', 'V1', '--text', '  ']]) {
    assert.equal((await callWith(argv, v2Files())).code, 2, argv.join(' '));
  }
});

test('mc goal evidence is the build, a person, plan, the decision and interactive Martin\'s; a review, mend, desk-prepare and learning session is refused and writes nothing', async () => {
  const MARTIN = { MC_GOAL: 'mc/plain', MC_TOOL: 'claude', MC_ROLE: 'martin' };
  const DECISION = { MC_ROLE: 'decision', MC_HEADLESS: '1', MC_TOOL: 'codex', MC_GOAL: 'mc/plain' };
  for (const env of [BUILD, {}, PLAN, MARTIN, DECISION]) {
    const f = await callWith(['evidence', 'mc/plain', 'V1', '--text', 'read it'], v2Files(), { env });
    assert.equal(f.code, 0, `${JSON.stringify(env)}: ${f.err()}`);
    assert.equal(evidenceOf(f).V1.text, 'read it');
    assert.equal(f.store[`${DIR}/LOG.md`], LOG_TEXT);
  }
  for (const env of [REVIEW, MEND, { MC_ROLE: 'desk-prepare', MC_TOOL: 'person' }, LEARNING, { ...MARTIN, MC_HEADLESS: '1' }]) {
    const f = await callWith(['evidence', 'mc/plain', 'V1', '--text', 'read it'], v2Files(), { env });
    assert.equal(f.code, 2, `${JSON.stringify(env)}: ${f.err()}`);
    assert.equal(f.store[EVIDENCE_PATH], undefined, `${env.MC_ROLE}: no record`);
    assert.equal(f.store[`${DIR}/LOG.md`], LOG_TEXT);
  }
  assert.match((await callWith(['evidence', 'mc/plain', 'V1', '--text', 'x'], v2Files(), { env: REVIEW })).err(), /a review session does not record evidence — the build records it, and a review reads it with mc goal show/u);
});

/* ------------------------------------- evidence at the current head: the move to review (mc/evidence-at-current-head C2) */

test('a build session moves a version 2 goal to review when every mark is at the current, published head and every item has a record, through stage and through log', async () => {
  for (const argv of MOVES_TO_REVIEW) {
    const f = await callWith(argv, v2Files(fullEvidence(), { stage: 'build' }));
    assert.equal(f.code, 0, `${argv.join(' ')}: ${f.err()}`);
    assert.equal(stateOf(f), 'review · ready', argv.join(' '));
    assert.equal(parseLog(f.store[`${DIR}/LOG.md`]).at(-1).stage, 'review');
  }
});

test('a commit after the mark makes the move refused', async () => {
  for (const argv of MOVES_TO_REVIEW) {
    const git = worktreeGit({ heads: { ...TWO_HEADS } });
    const f = fixture({ files: v2Files(fullEvidence()), env: BUILD, git });
    commitIn(git, 'memoro');
    assert.equal(await run(argv, f.deps), 1, argv.join(' '));
    const said = f.err();
    assert.match(said, /mc\/plain is not moved to review — no evidence at the head it publishes —/u);
    assert.match(said, /criterion 1 was recorded at an earlier head \(memoro bbbbbbbbbbbb → cccccccccccc\) — run its check again at this head and record it: mc goal criterion met mc\/plain 1 --evidence "…"/u);
    assert.match(said, /criterion 2 was recorded at an earlier head \(memoro bbbbbbbbbbbb → cccccccccccc\) — run its check again at this head and record it: mc goal criterion met mc\/plain 2 --evidence "…"/u);
    assert.equal(stateOf(f), 'build · ready');
    assert.equal(f.store[`${DIR}/LOG.md`], LOG_TEXT, 'nothing written');
    // The check is run again at this head: both marks are made, and the move is made.
    assert.equal(await run(['criterion', 'met', '1', '--evidence', 'again, at the new head'], f.deps), 0, f.err());
    assert.equal(await run(['criterion', 'met', '2', '--evidence', 'again, at the new head'], f.deps), 0, f.err());
    assert.equal(await run(argv, f.deps), 0, f.err());
    assert.equal(stateOf(f), 'review · ready');
  }
});

test('goal outcome: only a committed handoff names review and a technical stop retains its work', async () => {
  const fields = { stage: 'build', prs: ['memoro-cli#31'] };
  const files = v2Files({
    ...fullEvidence(),
    [`${DIR}/LOG.md`]: '## 2026-11-01T19:59Z · codex model · build · ready · by build\n\nNext: old build task\n',
  }, fields);
  const accepted = fixture({ files, env: BUILD, git: worktreeGit({ heads: { ...TWO_HEADS } }) });
  const refusedGit = worktreeGit({ heads: { ...TWO_HEADS }, published: { 'memoro-cli': TWO_HEADS['memoro-cli'] } });
  const refused = fixture({ files, env: BUILD, git: refusedGit });
  assert.equal(await run(MOVES_TO_REVIEW[1], accepted.deps), 0, accepted.err());
  assert.equal(await run(MOVES_TO_REVIEW[1], refused.deps), 1);
  assert.deepEqual(goalField(refused.store[`${DIR}/GOAL.json`], 'prs'), fields.prs);
  for (const [f, handoff] of [[accepted, true], [refused, false]]) {
    for (const output of Object.values(await goalOutcomeViews(f))) {
      if (handoff) assert.match(output, /build handed to review · independent review/u);
      else assert.doesNotMatch(output, /independent review/u);
    }
  }
  const heldReview = fixture({ files: {
    ...accepted.store,
    [`${DIR}/GOAL.json`]: withGoal(accepted.store[`${DIR}/GOAL.json`], { status: 'Martin' }),
    [`${DIR}/LOG.md`]: accepted.store[`${DIR}/LOG.md`] + '\n## 2026-11-01T20:02Z · runner · review · Martin\n\n'
      + 'Comment: the review ended with the goal still in review, a second time — review recovery cannot continue\n',
  }, git: worktreeGit({ heads: { ...TWO_HEADS } }) });
  for (const output of Object.values(await goalOutcomeViews(heldReview))) {
    assert.match(output, /review · Martin/u);
    assert.match(output, /build handed to review · historical handoff/u);
    assert.doesNotMatch(output, /independent review|technical desk/u);
  }
  const verdict = verdictText({ ids: [...V2_IDS, 'criterion 2'], repos: ['memoro-cli'], notOk: { 'criterion 1': 'needs repair' } }) + `head: memoro ${TWO_HEADS.memoro}\n`;
  const returned = reviewed({ files: { ...accepted.store, [REVIEW_FILE]: verdict }, env: { ...REVIEW, MC_WORK_ROOT: '/work' }, git: worktreeGit({ heads: { ...TWO_HEADS } }) });
  assert.equal(await run(['stage', 'build'], returned.deps), 0, returned.err());
  const logDir = '/work/runner/log';
  returned.store[`${logDir}/runner.log`] = [
    '2026-11-01T19:59:40Z goal:mc/plain: build starting (codex model, no check-in, no stall guard) · class large: subscription (route ready)',
    '2026-11-01T20:01:00Z goal:mc/plain: repair starting (codex model, no check-in, no stall guard) · finish list: subscription (route ready)', '',
  ].join('\n');
  const completed = { name: 'goal:mc/plain', exit: 1, seconds: 10, model: 'model', tool: 'codex', billing: 'subscription' };
  returned.store[`${logDir}/runs.tsv`] = [
    tsvHeader(), tsvRow({ ...completed, ts: '2026-11-01T19:59:50Z', kind: 'build-goal', session: 'before-review' }), '',
  ].join('\n');
  returned.store[`${logDir}/goal-mc-plain-20261101T195940Z.jsonl`] = '{"type":"thread.started","thread_id":"before-review"}\n';
  const checkReturned = async (start) => {
    for (const [view, output] of Object.entries(await goalOutcomeViews(returned))) {
      assert.doesNotMatch(output, /independent review|technical desk/u);
      assert.ok(output.includes(`${start} · build remains eligible · Next: no bounded continuation recorded`), output);
      if (view === 'show') assert.match(output, /LOG\n[\s\S]*review · ready · by build/u);
    }
  };
  await checkReturned('build start unknown — no tool boundary recorded');
  returned.store[`${logDir}/runs.tsv`] += tsvRow({ ...completed, ts: '2026-11-01T20:01:10Z', kind: 'repair', session: 'after-review' }) + '\n';
  returned.store[`${logDir}/goal-mc-plain-20261101T200100Z.jsonl`] = '{"type":"thread.started","thread_id":"after-review"}\n';
  await checkReturned('build started');

  const stoppedFiles = v2Files({ [`${DIR}/LOG.md`]: '## 2026-11-01T20:00Z · codex model · build · Martin · by build\n\nComment: goal defect: criterion 1 — cannot run\n' }, { ...fields, status: 'Martin' });
  const stopped = fixture({ files: stoppedFiles, git: worktreeGit({ heads: { ...TWO_HEADS }, dirty: ['memoro-cli'] }) });
  for (const [view, output] of Object.entries(await goalOutcomeViews(stopped))) {
    assert.match(output, /build stopped — goal defect: criterion 1 — cannot run · technical desk · retained work: existing branch; registered PR: memoro-cli#31 · LOG\.md/u);
    assert.equal((output.match(/technical desk/gu) ?? []).length, 1);
    if (view === 'show') assert.match(output, /WORKTREES\n  memoro-cli +\/work\/programs\/mc\/goals\/plain\/memoro-cli +1 changed/u);
  }
  const noWorktrees = fixture({ files: stoppedFiles, git: () => failed('no worktree') });
  for (const [view, output] of Object.entries(await goalOutcomeViews(noWorktrees))) {
    assert.match(output, /build stopped — goal defect: criterion 1 — cannot run · technical desk · retained work: registered PR: memoro-cli#31 · LOG\.md/u);
    assert.equal((output.match(/technical desk/gu) ?? []).length, 1);
    assert.doesNotMatch(output, /existing branch|existing worktree/u);
    if (view === 'show') assert.match(output, /WORKTREES\n  memoro-cli +\/work\/programs\/mc\/goals\/plain\/memoro-cli — no worktree/u);
  }
  stopped.store[`${DIR}/LOG.md`] = '## 2026-11-01T20:00Z · runner · build · Martin\n\nComment: three sessions ended without a word — see the logs under runner/log\n';
  for (const args of [['list', 'mc'], ['show', 'mc/plain']]) {
    const before = stopped.out().length;
    assert.equal(await run(args, stopped.deps), 0, stopped.err());
    assert.match(stopped.out().slice(before), /build stopped — three sessions ended without a word[^\n]*technical desk/u);
  }
});

test('one mark at the current head and one older: only the older is named', async () => {
  const items = evidenceOf({ store: { [EVIDENCE_PATH]: fullEvidence()[EVIDENCE_PATH] } });
  items['criterion 2'].heads = { ...TWO_HEADS, 'memoro-cli': sha('0') };
  const f = await callWith(MOVES_TO_REVIEW[0], v2Files(evidenceFile(items)));
  assert.equal(f.code, 1, f.err());
  assert.match(f.err(), /criterion 2 was recorded at an earlier head \(memoro-cli 000000000000 → aaaaaaaaaaaa\)/u);
  assert.doesNotMatch(f.err(), /criterion 1/u);
});

test('a worktree whose HEAD is not refs/remotes/origin/<its branch> is refused naming mc publish --no-merge, whether the branch is behind or not published at all', async () => {
  const behind = worktreeGit({ heads: { ...TWO_HEADS } });
  const unpublished = worktreeGit({ heads: { ...TWO_HEADS } });
  delete unpublished.published.memoro;
  for (const [label, git, said] of [
    ['behind', behind, /memoro: HEAD cccccccccccc is not the published goal\/plain \(bbbbbbbbbbbb\) — publish it with mc publish --no-merge/u],
    ['unpublished', unpublished, /memoro: goal\/plain is not published \(no refs\/remotes\/origin\/goal\/plain\) — publish it with mc publish --no-merge/u],
  ]) {
    if (git === behind) git.heads.memoro = sha('c');
    const files = v2Files(git === behind ? fullEvidence({ ...TWO_HEADS, memoro: sha('c') }) : fullEvidence());
    for (const argv of MOVES_TO_REVIEW) {
      const f = await callWith(argv, files, { git });
      assert.equal(f.code, 1, `${label}: ${argv.join(' ')}`);
      assert.match(f.err(), said, label);
      assert.doesNotMatch(f.err(), /criterion \d/u, `${label}: the marks are at the head; only the publishing is missing`);
      assert.equal(stateOf(f), 'build · ready');
    }
  }
});

test('a goal whose worktree is on a branch that is not goal/<goal> and is published there is moved', async () => {
  const git = worktreeGit({ heads: { ...TWO_HEADS }, branches: { 'memoro-cli': 'project/the-goal' } });
  git.published['memoro-cli'] = TWO_HEADS['memoro-cli'];
  const f = await callWith(MOVES_TO_REVIEW[0], v2Files(fullEvidence()), { git });
  assert.equal(f.code, 0, f.err());
  assert.equal(stateOf(f), 'review · ready');
  assert.ok(f.calls.some((call) => call.cwd === `${DIR}/memoro-cli` && call.args.join(' ') === 'rev-parse refs/remotes/origin/project/the-goal'), 'the published ref is the worktree\'s own branch');
});

test('a repository of the goal with no worktree refuses a build session\'s move, and the repository is named', async () => {
  for (const argv of MOVES_TO_REVIEW) {
    const f = await callWith(argv, v2Files(fullEvidence()), { absent: [`${DIR}/memoro`] });
    assert.equal(f.code, 1, argv.join(' '));
    assert.match(f.err(), /memoro has no worktree at \/work\/programs\/mc\/goals\/plain\/memoro — a build session moves a goal to review from its worktrees, one per repository/u);
    assert.doesNotMatch(f.err(), /memoro-cli has/u);
    assert.equal(stateOf(f), 'build · ready');
  }
});

test('a preserve item or a touched obligation with no record is named; the untouched obligation is not asked', async () => {
  for (const [without, named] of [
    [['V1'], ['V1 has no evidence — mc goal evidence mc/plain V1 --text "…"']],
    [['obligation Documentation'], ['obligation Documentation has no evidence — mc goal evidence mc/plain Documentation --text "…"']],
    [['V1', 'obligation Documentation'], ['V1 has no evidence', 'obligation Documentation has no evidence']],
  ]) {
    const f = await callWith(MOVES_TO_REVIEW[1], v2Files(fullEvidence(TWO_HEADS, without)));
    assert.equal(f.code, 1, without.join(', '));
    for (const line of named) assert.ok(f.err().includes(line), `${line}: ${f.err()}`);
    assert.doesNotMatch(f.err(), /Operations/u, 'untouched: not asked');
    assert.doesNotMatch(f.err(), /criterion \d/u, 'the criteria are recorded');
    assert.equal(f.store[`${DIR}/LOG.md`], LOG_TEXT);
  }
});

test('marks with no record file: each criterion is named as having no record, on a version 1 goal too', async () => {
  const f = await callWith(MOVES_TO_REVIEW[0], v2Files());
  assert.equal(f.code, 1);
  assert.match(f.err(), /criterion 1 has no record — run its check and record it: mc goal criterion met mc\/plain 1 --evidence "…"/u);
  assert.match(f.err(), /criterion 2 has no record — run its check and record it: mc goal criterion met mc\/plain 2 --evidence "…"/u);
  const v1 = await callWith(MOVES_TO_REVIEW[1], seededGoal({ [`${DIR}/GOAL.json`]: withGoal(GOAL_TEXT, { success_criteria: MET }) }), { git: worktreeGit() });
  assert.equal(v1.code, 1);
  assert.match(v1.err(), /criterion 1 has no record/u);
  assert.doesNotMatch(v1.err(), /has no evidence/u, 'a version 1 goal has no preserve items or obligations');
});

test('a criterion rewritten after its mark: its record counts as none', async () => {
  const f = await callWith(MOVES_TO_REVIEW[0], v2Files(fullEvidence(), { success_criteria: [{ criterion: 'first, reworded', check: 'x', met: true }, TWO_CRITERIA[1]] }));
  assert.equal(f.code, 1);
  assert.match(f.err(), /criterion 1 has no record/u);
  assert.doesNotMatch(f.err(), /criterion 2/u);
});

test('a review session\'s move back removes the records of the NOT OK ids criterion <n>, a preserve id and obligation <area>, and no others, including in later rounds', async () => {
  const ids = ['criterion 1', 'criterion 2', 'V1', 'obligation Documentation', 'change', 'out-of-scope', 'protection', 'bugs'];
  const text = verdictText({ ids, repos: ['memoro-cli', 'memoro'], notOk: { 'criterion 1': 'the check does not hold', V1: 'goals.js:40', bugs: 'goal.js:12' }, carried: ['criterion 2'] });
  const inReviewFiles = (extra = {}) => seededGoal({ [`${DIR}/GOAL.json`]: v2Goal({ stage: 'review', prs: ['memoro-cli#31'] }), [REVIEW_FILE]: text, ...fullEvidence(), ...extra });
  const rejected = await moveOut('build', inReviewFiles());
  assert.equal(rejected.code, 0, rejected.err());
  assert.equal(stateOf(rejected), 'build · ready');
  assert.deepEqual(Object.keys(evidenceOf(rejected)), ['criterion 2', 'obligation Documentation'], 'criterion 1 and V1 are gone; bugs removes nothing');
  assert.equal(evidenceOf(rejected)['criterion 2'].text, 'ran the check and it held');

  const obligation = await moveOut('build', inReviewFiles({ [REVIEW_FILE]: verdictText({ ids, repos: ['memoro-cli', 'memoro'], notOk: { 'obligation Documentation': 'the page does not say it', change: 'x', protection: 'y' } }) }));
  assert.deepEqual(Object.keys(evidenceOf(obligation)), ['criterion 1', 'criterion 2', 'V1'], 'an area, and change and protection: only the area has a record');

  const person = fixture({ files: inReviewFiles(), env: {} });
  assert.equal(await run(['stage', 'mc/plain', 'build', '--reason', 'the plan was wrong'], person.deps), 0, person.err());
  assert.equal(stateOf(person), 'build · ready');
  assert.deepEqual(Object.keys(evidenceOf(person)), ['criterion 1', 'criterion 2', 'V1', 'obligation Documentation'], 'a person\'s move back removes none');

  const third = await moveOut('build', inReviewFiles({ [`${DIR}/LOG.md`]: withLog(rejectedLog(2))[`${DIR}/LOG.md`] }));
  assert.equal(stateOf(third), 'build · ready', 'the third rejection returns to repair');
  assert.deepEqual(Object.keys(evidenceOf(third)), ['criterion 2', 'obligation Documentation'], 'later rounds also clear only the rejected evidence');
});

test('a person and the plan role move a goal to review as they did, with no record and no worktree; martin and decision too, and all are still refused with a criterion not met', async () => {
  const MARTIN = { MC_GOAL: 'mc/plain', MC_TOOL: 'claude', MC_ROLE: 'martin' };
  const DECISION = { MC_ROLE: 'decision', MC_HEADLESS: '1', MC_TOOL: 'codex', MC_GOAL: 'mc/plain' };
  const unmet = [TWO_CRITERIA[0], { criterion: 'second', check: 'y', met: false }];
  for (const env of [{}, PLAN, MARTIN, DECISION]) {
    const f = await callWith(['stage', 'mc/plain', 'review', '--reason', 'built'], v2Files(), { env, absent: [`${DIR}/memoro-cli`, `${DIR}/memoro`] });
    assert.equal(f.code, 0, `${JSON.stringify(env)}: ${f.err()}`);
    assert.equal(stateOf(f), 'review · ready');
    if (env === MARTIN || env === DECISION) {
      const refused = await callWith(['stage', 'mc/plain', 'review', '--reason', 'built'], v2Files({}, { success_criteria: unmet }), { env });
      assert.equal(refused.code, 1, `${env.MC_ROLE}: a criterion not met`);
      assert.match(refused.err(), /criterion 2 is not met/u);
      assert.equal(stateOf(refused), 'build · ready');
    }
  }
});

/* ------------------------------- evidence at the current head: the records stay out of the goal's text (mc/evidence-at-current-head C3) */

test('the brief is the same with and without the records', async () => {
  const files = v2Files({}, { success_criteria: [{ criterion: 'first', check: 'x', met: false }, { criterion: 'second', check: 'y', met: false }] });
  const plain = await callWith(['criterion', 'met', 'mc/plain', '1'], files, { env: {} });
  const recorded = await callWith(['criterion', 'met', '1', '--evidence', 'ran it'], files);
  assert.equal(await run(['evidence', 'V1', '--text', 'read it'], recorded.deps), 0, recorded.err());
  assert.equal(await run(['evidence', 'Documentation', '--text', 'read it'], recorded.deps), 0, recorded.err());
  const goalOf = (f) => parseGoal(f.store[`${DIR}/GOAL.json`]);
  assert.equal(plain.store[EVIDENCE_PATH] !== undefined && recorded.store[EVIDENCE_PATH] !== undefined, true, 'both left a record file');
  assert.equal(recorded.store[`${DIR}/GOAL.json`], plain.store[`${DIR}/GOAL.json`], 'GOAL.json holds no record');
  assert.equal(renderGoalText(goalOf(recorded)), renderGoalText(goalOf(plain)), 'the brief after the records is the brief after a mark without evidence');
  assert.doesNotMatch(renderGoalText(goalOf(recorded)), /ran it|read it|aaaaaaaa/u, 'no record in the brief');
});

test('mc goal show prints the EVIDENCE part with each record, and stale beside a met criterion after a commit and not before', async () => {
  const git = worktreeGit({ heads: { ...TWO_HEADS } });
  const f = fixture({ files: v2Files(fullEvidence(TWO_HEADS)), git });
  assert.equal(await run(['show', 'mc/plain'], f.deps), 0, f.err());
  const before = f.out();
  assert.match(before, /\nEVIDENCE\n {2}criterion 1 · memoro-cli aaaaaaaaaaaa, memoro bbbbbbbbbbbb · 2026-11-01T19:00Z · claude opus\n {6}ran the check and it held\n/u);
  for (const id of ['criterion 2', 'V1', 'obligation Documentation']) assert.match(before, new RegExp(`\\n {2}${id} · memoro-cli aaaaaaaaaaaa, memoro bbbbbbbbbbbb · `, 'u'), id);
  assert.match(before, /\n {2}1 ✓ first\n/u);
  assert.doesNotMatch(before, /stale/u, 'at the heads of the records: none stale');
  commitIn(git, 'memoro-cli');
  const g = fixture({ files: v2Files(fullEvidence(TWO_HEADS)), git });
  assert.equal(await run(['show', 'mc/plain'], g.deps), 0, g.err());
  const after = g.out();
  assert.match(after, /\n {2}1 ✓ first {2}\[stale — its mark is at an earlier head\]\n/u);
  assert.match(after, /\n {2}2 ✓ second {2}\[stale — its mark is at an earlier head\]\n/u);
  assert.match(after, /\n {2}criterion 1 · memoro-cli aaaaaaaaaaaa, memoro bbbbbbbbbbbb · .* · stale: recorded at an earlier head\n/u);
  assert.doesNotMatch(after.replace(/^.*(?:stale).*$/gmu, ''), /stale/u);
  const marked = fixture({ files: v2Files(), git });
  assert.equal(await run(['show', 'mc/plain'], marked.deps), 0, marked.err());
  assert.match(marked.out(), /\nEVIDENCE\n {2}criterion 1 · met, no record\n {2}criterion 2 · met, no record\n/u, 'a mark with no record is said so');
  const none = fixture({ files: v2Files({}, { success_criteria: [{ criterion: 'first', check: 'x', met: false }] }), git });
  assert.equal(await run(['show', 'mc/plain'], none.deps), 0, none.err());
  assert.doesNotMatch(none.out(), /\nEVIDENCE\n/u, 'no record and no mark: no EVIDENCE part');
  assert.equal(none.calls.some((call) => call.args[0] === 'rev-parse'), false, 'and no worktree is asked for a head');
});

test('review and plan execute merge for every registered PR, reading only each PR\'s state; plan from historical finish needs no REVIEW.md', async () => {
  for (const env of [REVIEW, PLAN]) {
    const files = env.MC_ROLE === PLAN_ROLE ? inStage('finish') : inReview(verdictText({ ids: [], repos: ['memoro-cli', 'memoro'] }));
    files[`${DIR}/GOAL.json`] = withGoal(files[`${DIR}/GOAL.json`], {
      repos: ['memoro-cli', 'memoro'], prs: ['memoro-cli#31', 'memoro#14804'], success_criteria: [],
    });
    const f = reviewed({ files, env });
    assert.equal(await run(['stage', 'merge'], f.deps), 0, f.err());
    assert.equal(stateOf(f), 'merge · ready');
    assert.deepEqual(f.gh.map(({ args }) => args.slice(0, 3)), [['pr', 'view', '31'], ['pr', 'view', '14804']], 'the only GitHub read is each PR\'s state');
    assert.deepEqual(f.queued.map(({ repo, pr, sha }) => ({ repo, pr, sha })), [
      { repo: 'memoro-cli', pr: 31, sha: undefined }, { repo: 'memoro', pr: 14804, sha: undefined },
    ]);
    assert.deepEqual(f.queued[1].goal, { programme: 'mc', goal: 'plain', dir: DIR });
  }
});

test('a queue failure preserves the merge decision so it can be retried', async () => {
  const files = inReview(verdictText());
  files[`${DIR}/GOAL.json`] = withGoal(files[`${DIR}/GOAL.json`], { prs: ['memoro-cli#31'] });
  const f = reviewed({ files, queue: () => { throw new Error('register locked'); } });
  assert.equal(await run(['stage', 'merge'], f.deps), 1);
  assert.equal(stateOf(f), 'merge · ready');
  assert.match(f.err(), /memoro-cli#31 could not be queued/u);
  f.deps.queue = (job) => { f.queued.push(job); };
  assert.equal(await run(['stage', 'merge'], { ...f.deps, env: PLAN }), 0, f.err());
  assert.deepEqual(f.queued.map((job) => [job.repo, job.pr]), [['memoro-cli', 31]]);
});

test('mc goal stage merge queues the pull request GitHub says is open, and names the one it says is closed without queueing it, and the one already merged', async () => {
  const files = inReview(verdictText({ repos: ['memoro-cli', 'memoro'] }));
  files[`${DIR}/GOAL.json`] = withGoal(files[`${DIR}/GOAL.json`], { prs: ['memoro-cli#31', 'memoro#32', 'memoro-cli#33'] });
  const f = reviewed({ files });
  f.deps.gh = (cwd, args) => { f.gh.push({ cwd, args }); return ok(JSON.stringify({ state: { 31: 'OPEN', 32: 'CLOSED', 33: 'MERGED' }[args[2]] })); };
  assert.equal(await run(['stage', 'merge'], f.deps), 0, f.err());
  assert.deepEqual(f.queued.map(({ repo, pr }) => [repo, pr]), [['memoro-cli', 31]]);
  assert.equal(f.out(), 'mc: mc/plain · merge · ready\nmc: queued memoro-cli#31 for the merger; memoro#32 closed without merging — not queued; memoro-cli#33 already merged — not queued\n');
  assert.equal(stateOf(f), 'merge · ready');
});

test('a partial merge enqueue does not release its session before all PRs are handed off', async () => {
  const env = { ...REVIEW, MC_HEADLESS: '1', MC_SCRATCH: '/scratch' };
  const files = inReview(verdictText());
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

describe('mc goal stage against a modelled origin/main', () => {
  // One origin, main at its first commit. Goal g's worktree edits shared.md, which main then edits: a conflict.
  // Goal h's worktree edits only other.md, so it is behind main and merges cleanly. Modelled history and real files.
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

test('a review sets no status and moves only a goal in review', async () => {
  for (const [from, argv, said] of [
    ['review', ['ready', '--reason', 'x'], /a review sets Martin for an unrecoverable in-role obstacle, or ends with mc goal stage merge \(every item OK\) or mc goal stage build \(a NOT OK item, with REVIEW\.md\)/u],
    ['review', ['stage', 'done'], /a review ends in merge or build, not done/u],
    ['build', ['stage', 'merge'], /a review moves only a goal in review, and this one is build/u],
  ]) {
    const g = reviewed({ files: inStage(from), env: REVIEW });
    assert.equal(await run(argv, g.deps), 2, argv.join(' '));
    assert.match(g.err(), said);
  }
});

test('refusedMove: a person may make other moves; a plan session other forward ones; nobody else more than their own', () => {
  for (const to of STAGES.filter(x => x !== 'finish')) assert.equal(refusedMove({ from: 'merge', to, env: {} }), null, `a person to ${to}`);
  for (const to of ['build', 'review', 'merge', 'done', 'dropped']) assert.equal(refusedMove({ from: 'draft', to, env: PLAN }), null, `draft to ${to}`);
  assert.equal(refusedMove({ from: 'build', status: 'blocked', env: PLAN }), null);
  assert.equal(refusedMove({ from: 'build', to: 'review', env: BUILD }), null);
  assert.equal(refusedMove({ from: 'review', to: 'merge', env: REVIEW }), null);
  assert.equal(refusedMove({ from: 'review', to: 'build', env: REVIEW }), null, 'a review rejects: review → build is its move');
  assert.match(refusedMove({ from: 'review', to: 'build', env: BUILD }), /does not move a goal back/u, 'a build session does not');
  assert.match(refusedMove({ from: 'merge', to: 'build', env: REVIEW }), /does not move a goal back/u, 'a review moves nothing back from merge');
  assert.equal(refusedMove({ from: 'build', env: BUILD }), null, 'an entry alone');
});

/* ------------------------------------------------- the review's verdict: REVIEW.md in its fixed form (D4, D5) */

/** A goal in review with the PR registered, REVIEW.md `text` (null: none) and `log` (null: LOG_TEXT); `v2` makes it a version 2 goal. */
function reviewFiles(text, { v2 = false, goal = {}, log = null, extra = {} } = {}) {
  const goalText = v2
    ? goalJsonV2({ stage: 'review', success_criteria: [{ criterion: 'it works', check: 'a test', evidence: 'the log', met: true }], prs: ['memoro-cli#31'], ...goal })
    : withGoal(GOAL_TEXT, { stage: 'review', success_criteria: MET, prs: ['memoro-cli#31'], ...goal });
  return seededGoal({ [`${DIR}/GOAL.json`]: goalText, [REVIEW_FILE]: text, ...(log ? { [`${DIR}/LOG.md`]: log } : {}), ...extra });
}
/** The review's `mc goal stage <to>` on `files`: the fixture, with its exit code as `code`. */
async function moveOut(to, files, env = REVIEW, git = allOk) {
  const f = reviewed({ files, env, git });
  f.code = await run(['stage', to], f.deps);
  return f;
}
/** What a refused move leaves: exit 2, the goal in review and ready, nothing queued, no round copy, the log as it was. */
function assertRefused(f, said, label, log = LOG_TEXT) {
  assert.equal(f.code, 2, `${label}: ${f.err()}`);
  assert.match(f.err(), said, label);
  assert.equal(stateOf(f), 'review · ready', label);
  assert.deepEqual(f.queued, [], `${label}: nothing queued`);
  assert.equal(f.store[`${DIR}/LOG.md`], log, `${label}: no entry`);
  assert.equal(Object.keys(f.store).some((key) => /REVIEW-\d+\.md$/u.test(key)), false, `${label}: no round copy`);
}

test('a review session moves a goal out of review to neither merge nor build without REVIEW.md', async () => {
  for (const to of ['merge', 'build']) {
    assertRefused(await moveOut(to, reviewFiles(null)), /REVIEW\.md/u, `to ${to}`);
  }
});

test('a REVIEW.md whose head line is not MC_REVIEW_HEAD, or has none, is refused for merge and for build, and a missing MC_REVIEW_HEAD too', async () => {
  for (const [to, notOk] of [['merge', {}], ['build', { 'criterion 1': 'the page does not say it' }]]) {
    const wrong = await moveOut(to, reviewFiles(verdictText({ head: 'fff0000aaa', notOk })));
    assertRefused(wrong, /`head: memoro-cli fff0000aaa` is not the head judged, abc1234def/u, `${to}: another head`);
    const none = await moveOut(to, reviewFiles(verdictText({ notOk }).replace(/^head:.*\n/u, '')));
    assertRefused(none, /no `head: memoro-cli <sha>` line/u, `${to}: no head line`);
    const unnamed = await moveOut(to, reviewFiles(verdictText({ notOk })), { ...REVIEW, MC_REVIEW_HEAD: undefined });
    assertRefused(unnamed, /MC_REVIEW_HEAD is not set/u, `${to}: the runner named no head`);
  }
});

test('a goal of two repositories needs a head line for the second as well', async () => {
  const goal = { repos: ['memoro-cli', 'memoro'] };
  for (const [to, notOk] of [['merge', {}], ['build', { 'criterion 1': 'x' }]]) {
    assertRefused(await moveOut(to, reviewFiles(verdictText({ notOk }), { goal })), /no `head: memoro <sha>` line/u, to);
  }
  const both = await moveOut('merge', reviewFiles(verdictText({ repos: ['memoro-cli', 'memoro'] }), { goal }));
  assert.equal(both.code, 0, both.err());
  assert.equal(stateOf(both), 'merge · ready');
});

test('a missing line for a criterion, a preserve item or a touched obligation is refused naming every missing id; a version 1 goal needs the criteria lines only', async () => {
  const missing = ['criterion 1', 'V1', 'obligation Documentation', 'bugs'];
  for (const to of ['merge', 'build']) {
    const f = await moveOut(to, reviewFiles(verdictText({ ids: V2_IDS, without: missing, notOk: to === 'build' ? { change: 'x' } : {} }), { v2: true }));
    assert.equal(f.code, 2, f.err());
    for (const id of missing) assert.match(f.err(), new RegExp(`no line for ${id}\\b`, 'u'), `${to}: ${id} is named`);
    assert.doesNotMatch(f.err(), /no line for (change|out-of-scope|protection)/u, 'only the missing ones');
    assert.equal(stateOf(f), 'review · ready');
    assert.deepEqual(f.queued, []);
  }
  const whole = await moveOut('merge', reviewFiles(verdictText({ ids: V2_IDS }), { v2: true }));
  assert.equal(whole.code, 0, whole.err());
  assert.equal((await moveOut('merge', reviewFiles(verdictText({ ids: ['criterion 1'] })))).code, 0, 'a version 1 goal: the criteria lines');
  assertRefused(await moveOut('merge', reviewFiles(verdictText({ ids: V2_IDS }))), /V1 is not an item of this goal's verdict/u, 'a version 1 goal has no preserve line');
  assertRefused(await moveOut('merge', reviewFiles(verdictText({ ids: [] }))), /no line for criterion 1/u, 'a version 1 goal without its criteria line');
});

test('a malformed line is refused with the line, and so is a NOT OK with no reason, a repeated line and an id the goal does not have', async () => {
  for (const [line, said] of [
    ['criterion 1: fine', /not in form: "criterion 1: fine"/u],
    ['criterion 1: NOT OK', /not in form: "criterion 1: NOT OK"/u],
    ['criterion 1: NOT OK — ', /not in form: "criterion 1: NOT OK —/u],
    ['criterion 1: OK, I think', /not in form: "criterion 1: OK, I think"/u],
    ['head: memoro-cli', /not in form: "head: memoro-cli"/u],
    ['criterion 1: OK', /more than one line for criterion 1/u],
    ['criterion 2: OK', /criterion 2 is not an item of this goal's verdict/u],
  ]) {
    const text = line.startsWith('criterion 1: OK') || line === 'criterion 2: OK' || line.startsWith('head:')
      ? `${verdictText()}${line}\n`
      : `${verdictText({ without: ['criterion 1'] })}${line}\n`;
    const f = await moveOut('merge', reviewFiles(text));
    assertRefused(f, said, line);
  }
});

test('every item OK: merge moves and the PR is queued; build is refused; REVIEW.md stays and REVIEW-1.md is its copy', async () => {
  const text = verdictText({ ids: V2_IDS });
  const merged = await moveOut('merge', reviewFiles(text, { v2: true }));
  assert.equal(merged.code, 0, merged.err());
  assert.equal(stateOf(merged), 'merge · ready');
  assert.deepEqual(merged.queued.map((job) => [job.repo, job.pr]), [['memoro-cli', 31]]);
  assert.equal(merged.store[REVIEW_FILE], text, 'REVIEW.md is still there');
  assert.equal(merged.store[`${DIR}/REVIEW-1.md`], text, 'the copy under its round');
  const last = parseLog(merged.store[`${DIR}/LOG.md`]).at(-1);
  assert.deepEqual([last.stage, last.role], ['merge', 'review']);
  const build = await moveOut('build', reviewFiles(text, { v2: true }));
  assertRefused(build, /REVIEW\.md has no NOT OK line — every item is OK, so the goal is moved to merge: mc goal stage merge/u, 'build on all OK');
});

test('a NOT OK line cannot move to merge: the refusal names the failed ids, the goal stays in review and nothing is queued', async () => {
  const text = verdictText({ ids: V2_IDS, notOk: { 'criterion 1': 'tests/x.test.js is not green', bugs: 'goal.js:12 drops the entry' } });
  const f = await moveOut('merge', reviewFiles(text, { v2: true }));
  assertRefused(f, /REVIEW\.md has NOT OK lines \(criterion 1, bugs\) — a goal with a rejected item does not merge: mc goal stage build/u, 'merge with NOT OK');
});

test('one NOT OK line moves the goal to build with nothing queued; REVIEW.md stays, REVIEW-1.md is its copy, and merge is refused', async () => {
  const text = verdictText({ ids: V2_IDS, notOk: { V1: 'goal.js:40 changes the version 1 reader' } });
  const f = await moveOut('build', reviewFiles(text, { v2: true }));
  assert.equal(f.code, 0, f.err());
  assert.equal(stateOf(f), 'build · ready');
  assert.deepEqual(f.queued, [], 'nothing queued');
  assert.equal(f.gh.length, 0, 'GitHub is not asked');
  assert.equal(f.store[REVIEW_FILE], text);
  assert.equal(f.store[`${DIR}/REVIEW-1.md`], text);
  const last = parseLog(f.store[`${DIR}/LOG.md`]).at(-1);
  assert.deepEqual([last.stage, last.role, last.status], ['build', 'review', 'ready']);
  assert.match(f.out(), /mc: mc\/plain · build · ready/u);
});

test('`OK — carried from round 1` counts as OK, a NOT OK among carried lines still rejects, and free text after the lines is accepted', async () => {
  const carried = await moveOut('merge', reviewFiles(verdictText({ ids: V2_IDS, carried: ['V1', 'obligation Documentation', 'change'] }), { v2: true }));
  assert.equal(carried.code, 0, carried.err());
  assert.equal(stateOf(carried), 'merge · ready');
  const rejected = await moveOut('build', reviewFiles(verdictText({ ids: V2_IDS, carried: ['V1', 'change'], notOk: { bugs: 'goal.js:12 drops it' } }), { v2: true }));
  assert.equal(rejected.code, 0, rejected.err());
  assert.equal(stateOf(rejected), 'build · ready');
  const tail = '\nWhat I read: the page and the tests.\n\nOK is the verdict.\nbugs are listed above.\n';
  const free = await moveOut('merge', reviewFiles(verdictText({ ids: V2_IDS, tail }), { v2: true }));
  assert.equal(free.code, 0, free.err());
  assert.equal(free.store[`${DIR}/REVIEW-1.md`], verdictText({ ids: V2_IDS, tail }), 'the copy keeps the free text');
});

test('the first and second rejection move review to build, each leaving REVIEW.md and a copy of its round', async () => {
  for (const [prior, round] of [[0, 1], [1, 2]]) {
    const text = verdictText({ notOk: { 'criterion 1': `round ${round} failed` } });
    const log = withLog(rejectedLog(prior))[`${DIR}/LOG.md`];
    const f = await moveOut('build', reviewFiles(text, { log }));
    assert.equal(f.code, 0, f.err());
    assert.equal(stateOf(f), 'build · ready', `rejection ${round}`);
    assert.equal(f.store[REVIEW_FILE], text);
    assert.equal(f.store[`${DIR}/REVIEW-${round}.md`], text, `REVIEW-${round}.md`);
    assert.equal(parseLog(f.store[`${DIR}/LOG.md`]).at(-1).stage, 'build');
    assert.deepEqual(f.queued, []);
  }
});

test('later rejections still dispatch repair and keep past verdicts', async () => {
  const text = verdictText({ ids: V2_IDS, notOk: { 'criterion 1': 'still red', bugs: 'goal.js:12' } });
  const logPath = `${DIR}/LOG.md`;
  const oldThird = `${DIR}/REVIEW-3.md`;
  const previousVerdict = verdictText({ ids: V2_IDS, notOk: { bugs: 'earlier failure' } });
  for (const { prior, extra, archived } of [
    { prior: 2, extra: {}, archived: 3 },
    { prior: 3, extra: {}, archived: 4 },
    { prior: 2, extra: { [oldThird]: previousVerdict }, archived: 4 },
  ]) {
    const log = withLog(rejectedLog(prior))[logPath];
    const f = await moveOut('build', reviewFiles(text, { v2: true, log, extra }));
    assert.equal(f.code, 0, f.err());
    assert.equal(stateOf(f), 'build · ready');
    assert.deepEqual(f.queued, []);
    const entries = parseLog(f.store[logPath]);
    const last = entries.at(-1);
    assert.deepEqual([last.stage, last.status, last.role], ['build', 'ready', 'review']);
    assert.equal(f.store[REVIEW_FILE], text);
    assert.equal(f.store[`${DIR}/REVIEW-${archived}.md`], text);
    if (extra[oldThird]) assert.equal(f.store[oldThird], previousVerdict);
    const goal = parseGoal(f.store[`${DIR}/GOAL.json`]);
    assert.equal(goalSession({ ...goal, log: entries, verdict: f.store[REVIEW_FILE] }), 'repair');
  }
});

test('a move to finish in the log from before, and rejections before the goal\'s latest move into draft, are not counted', async () => {
  const oldFinish = ['2026-11-02T10:00Z', '2026-11-03T10:00Z'].map((at) => `## ${at} · claude · finish · ready · by review\n\nDone: sent to finish\n\n## ${at.replace('10:00', '11:00')} · claude · review · ready · by build\n\nDone: back\n`).join('\n');
  const redraft = `${rejectedLog(2)}\n## 2026-11-05T09:00Z · person · draft · ready\n\nDone: redrafted\n\n## 2026-11-05T10:00Z · person · build · ready\n\nDone: planned\n\n## 2026-11-05T11:00Z · claude · review · ready · by build\n\nDone: built\n`;
  for (const [label, log] of [['old finish', `${withLog(oldFinish)[`${DIR}/LOG.md`]}`], ['before the latest draft', `${LOG_TEXT}\n## 2026-11-01T23:30Z · claude · review · ready · by build\n\nDone: built\n\n${redraft}`]]) {
    const f = await moveOut('build', reviewFiles(verdictText({ notOk: { 'criterion 1': 'x' } }), { log }));
    assert.equal(f.code, 0, `${label}: ${f.err()}`);
    assert.equal(stateOf(f), 'build · ready', `${label}: a first rejection, which moves`);
    assert.ok(f.store[`${DIR}/REVIEW-1.md`], `${label}: round 1`);
  }
});

/** The goal's worktree: where the review's tripwire reads the repository's areas and the branch's diff. */
const WORKTREE = `${DIR}/memoro-cli`;
const TRIPWIRE = { obligations: [
  { area: 'memoro-cli/documentation', stand: 'touched', text: 'mc-goals.md says it.', standard: 'memoro-cli/docs/technical/mc-goals.md#GOAL.json' },
  { area: 'memoro-cli/operations', stand: 'untouched', text: 'Nothing deploys.' },
] };
const TRIPWIRE_IDS = ['criterion 1', 'V1', 'obligation memoro-cli/documentation', 'untouched memoro-cli/operations', 'change', 'out-of-scope', 'protection', 'bugs'];
/** A git that declares the areas `documentation` and `operations` at origin/main in the worktree and diffs `changed` against it. */
const branchGit = (changed) => (cwd, args = []) => (args[0] === 'diff' ? ok(changed.join('\n')) : areasGit({ [WORKTREE]: DECLARATION('documentation', 'operations') })(cwd, args));

test('an untouched area the branch changed needs its `untouched <area>` line: without it merge and build are refused naming it; with it the move is made', async () => {
  const git = branchGit(['src/operations/deploy.js', 'src/documentation.js']);
  const without = (notOk) => verdictText({ ids: TRIPWIRE_IDS, without: ['untouched memoro-cli/operations'], notOk });
  for (const [to, notOk] of [['merge', {}], ['build', { bugs: 'x' }]]) {
    const f = await moveOut(to, reviewFiles(without(notOk), { v2: true, goal: TRIPWIRE }), REVIEW, git);
    assertRefused(f, /no line for untouched memoro-cli\/operations/u, to);
  }
  const merged = await moveOut('merge', reviewFiles(verdictText({ ids: TRIPWIRE_IDS }), { v2: true, goal: TRIPWIRE }), REVIEW, git);
  assert.equal(merged.code, 0, merged.err());
  const rejected = await moveOut('build', reviewFiles(verdictText({ ids: TRIPWIRE_IDS, notOk: { 'untouched memoro-cli/operations': 'src/operations/deploy.js changes what the goal said it would not' } }), { v2: true, goal: TRIPWIRE }), REVIEW, git);
  assert.equal(rejected.code, 0, rejected.err());
  assert.equal(stateOf(rejected), 'build · ready');
});

test('an untouched area the branch did not change has no line: a diff of other paths, and a file only under a touched area\'s paths, trip nothing', async () => {
  for (const changed of [['src/other.js', 'README.md'], ['src/documentation.js'], []]) {
    const ids = TRIPWIRE_IDS.filter((id) => id !== 'untouched memoro-cli/operations');
    const f = await moveOut('merge', reviewFiles(verdictText({ ids }), { v2: true, goal: TRIPWIRE }), REVIEW, branchGit(changed));
    assert.equal(f.code, 0, `${JSON.stringify(changed)}: ${f.err()}`);
    const extra = await moveOut('merge', reviewFiles(verdictText({ ids: TRIPWIRE_IDS }), { v2: true, goal: TRIPWIRE }), REVIEW, branchGit(changed));
    assertRefused(extra, /untouched memoro-cli\/operations is not an item of this goal's verdict/u, `a line for an area not tripped: ${JSON.stringify(changed)}`);
  }
});

test('the diff is read against origin/main at the head judged, and a git that cannot read the areas or the diff refuses the move with the reason', async () => {
  const seen = [];
  const git = (cwd, args = []) => { seen.push({ cwd, args }); return branchGit(['src/operations.js'])(cwd, args); };
  const f = await moveOut('merge', reviewFiles(verdictText({ ids: TRIPWIRE_IDS }), { v2: true, goal: TRIPWIRE }), REVIEW, git);
  assert.equal(f.code, 0, f.err());
  assert.deepEqual(seen.filter((call) => call.args[0] === 'diff'), [{ cwd: WORKTREE, args: ['diff', '--name-only', `origin/main...${HEAD}`] }]);
  const noDiff = (cwd, args = []) => (args[0] === 'diff' ? failed('fatal: bad revision') : branchGit([])(cwd, args));
  assertRefused(await moveOut('merge', reviewFiles(verdictText({ ids: TRIPWIRE_IDS }), { v2: true, goal: TRIPWIRE }), REVIEW, noDiff), /could not list what memoro-cli changed against origin\/main — fatal: bad revision/u, 'a diff git cannot make');
  const noAreas = (cwd, args = []) => (args[0] === 'show' ? failed('fatal: bad object') : ok(''));
  assertRefused(await moveOut('merge', reviewFiles(verdictText({ ids: TRIPWIRE_IDS }), { v2: true, goal: TRIPWIRE }), REVIEW, noAreas), /could not read memoro-cli's \.mc\/areas\.json/u, 'areas git cannot read');
});

/* ---- Areas judged as the user sees it: `seen <area>` in REVIEW.md, asked only of the areas MC_REVIEW_SEEN names ---- */

const SEEN_ID = 'seen memoro-cli/documentation';
const SEEN_IDS = [...TRIPWIRE_IDS.filter((id) => id !== 'untouched memoro-cli/operations'), SEEN_ID];
/** The goal of `TRIPWIRE` without its untouched area, standing touched on `documentation`, which declares `seen`. */
const SEEN_GOAL = { obligations: [TRIPWIRE.obligations[0]] };
const seenDeclaration = () => JSON.stringify({ schema_version: 1, areas: [AREA('documentation', { seen: true }), AREA('operations')] });
const seenGit = (changed = []) => (cwd, args = []) => (args[0] === 'diff' ? ok(changed.join('\n')) : areasGit({ [WORKTREE]: seenDeclaration() })(cwd, args));
/** The seen line `line` after the other lines of the verdict. */
const seenVerdict = (line, ids = SEEN_IDS.filter((id) => id !== SEEN_ID)) => verdictText({ ids, tail: line === null ? '' : `${line}\n` });
const SEEN_ENV = { ...REVIEW, MC_REVIEW_SEEN: 'memoro-cli/documentation' };
/** `to` with `files` under `env`; the shots in `missing` are not files. */
async function moveSeen(to, files, { env = SEEN_ENV, git = seenGit(), missing = [] } = {}) {
  const f = reviewed({ files, env, git });
  const base = f.deps.exists;
  f.deps.exists = (path) => !missing.includes(path) && base(path);
  f.code = await run(['stage', to], f.deps);
  return f;
}
const seenFiles = (text) => reviewFiles(text, { v2: true, goal: SEEN_GOAL });

test('a review told of a seen area is refused for merge and for build without its seen line, naming the id, and moves with it in either form', async () => {
  for (const to of ['merge', 'build']) {
    const notOk = to === 'build' ? { bugs: 'x' } : {};
    const text = (line) => verdictText({ ids: SEEN_IDS.filter((id) => id !== SEEN_ID), notOk, tail: line ? `${line}\n` : '' });
    assertRefused(await moveSeen(to, seenFiles(text(null))), /no line for seen memoro-cli\/documentation/u, `${to}: no line`);
    for (const line of [`${SEEN_ID}: OK — shots/a.png`, `${SEEN_ID}: OK — shots/a.png, shots/b.png — both viewports read`, `${SEEN_ID}: OK — none — the diff changes a comment and nothing that is drawn`, `${SEEN_ID}: NOT OK — shots/a.png — the title is cut off at 390 px`]) {
      const rejects = line.includes('NOT OK');
      const f = await moveSeen(rejects ? 'build' : to, seenFiles(rejects ? verdictText({ ids: SEEN_IDS.filter((id) => id !== SEEN_ID), tail: `${line}\n` }) : text(line)));
      assert.equal(f.code, 0, `${to}: ${line}: ${f.err()}`);
      assert.equal(stateOf(f), rejects ? 'build · ready' : `${to} · ready`, line);
    }
  }
});

test('a seen line that is not in its form is refused naming the fault: a bare OK, none without a reason, carried, a path outside shots or not a png, and a line twice', async () => {
  const cases = [
    [`${SEEN_ID}: OK`, /not in form/u],
    [`${SEEN_ID}: OK — none`, /`none` needs its reason/u],
    [`${SEEN_ID}: OK — none — `, /not in form|needs its reason/u],
    [`${SEEN_ID}: OK — carried from round 1`, /not carried from an earlier round/u],
    [`${SEEN_ID}: OK — /tmp/a.png`, /not in form/u],
    [`${SEEN_ID}: OK — shots/a.jpg`, /not in form/u],
    [`${SEEN_ID}: OK — shots/../GOAL.json`, /not in form/u],
    [`${SEEN_ID}: OK — shots/a b.png`, /not in form/u],
    [`${SEEN_ID}: NOT OK — shots/a.png`, /says what and where/u],
    [`${SEEN_ID}: OK — shots/a.png\n${SEEN_ID}: OK — shots/a.png`, /more than one line for seen memoro-cli\/documentation/u],
  ];
  for (const [line, said] of cases) assertRefused(await moveSeen('merge', seenFiles(seenVerdict(line))), said, line);
});

test('a seen line naming a screenshot that is not a file in the goal\'s directory is refused with its path; every named file must be there', async () => {
  const line = `${SEEN_ID}: OK — shots/a.png, shots/b.png`;
  const f = await moveSeen('merge', seenFiles(seenVerdict(line)), { missing: [`${DIR}/shots/b.png`] });
  assertRefused(f, /seen memoro-cli\/documentation: shots\/b\.png is not a file in the goal's directory/u, 'one missing');
  assert.doesNotMatch(f.err(), /shots\/a\.png is not a file/u);
  const none = await moveSeen('merge', seenFiles(seenVerdict(line)), { missing: [`${DIR}/shots/a.png`, `${DIR}/shots/b.png`] });
  assertRefused(none, /shots\/a\.png is not a file[\s\S]*shots\/b\.png is not a file/u, 'both missing');
  const present = await moveSeen('merge', seenFiles(seenVerdict(line)));
  assert.equal(present.code, 0, present.err());
  const nothing = await moveSeen('merge', seenFiles(seenVerdict(`${SEEN_ID}: OK — none — a comment changed`)), { missing: [`${DIR}/shots/a.png`] });
  assert.equal(nothing.code, 0, `none names no file: ${nothing.err()}`);
});

test('the move asks seen lines for exactly the areas MC_REVIEW_SEEN names and never reads the declaration for it: without the variable none, and a line for an area not named is refused', async () => {
  const bare = await moveSeen('merge', seenFiles(seenVerdict(null)), { env: REVIEW });
  assert.equal(bare.code, 0, `a review started without the list is asked none: ${bare.err()}`);
  const extra = await moveSeen('merge', seenFiles(seenVerdict(`${SEEN_ID}: OK — none — a comment changed`)), { env: REVIEW });
  assertRefused(extra, /seen memoro-cli\/documentation is not an item of this goal's verdict/u, 'a line for an area the review was not told of');
  const other = await moveSeen('merge', seenFiles(seenVerdict(null)), { env: { ...REVIEW, MC_REVIEW_SEEN: 'memoro-cli/operations' } });
  assertRefused(other, /no line for seen memoro-cli\/operations/u, 'the list is the variable\'s, whatever the goal stands on');
  const two = await moveSeen('merge', seenFiles(seenVerdict(`${SEEN_ID}: OK — none — a\nseen memoro-cli/operations: OK — none — b`)), { env: { ...REVIEW, MC_REVIEW_SEEN: 'memoro-cli/documentation  memoro-cli/operations' } });
  assert.equal(two.code, 0, two.err());
  const seen = [];
  const git = (cwd, args = []) => { seen.push(args[0]); return seenGit()(cwd, args); };
  assert.equal((await moveSeen('merge', seenFiles(seenVerdict(`${SEEN_ID}: OK — none — a`)), { git })).code, 0);
  assert.equal(seen.filter((one) => one === 'show').length, 0, 'the declarations are not read for the seen list (no untouched obligation either)');
});

/* ---- The write-back line: asked only of a review the runner launched with MC_REVIEW_WRITE_BACK=1 ---- */

const WB_ENV = { ...REVIEW, MC_REVIEW_WRITE_BACK: '1' };
/** The v2 verdict with `line` (null: none) as its write-back line, before `change`. */
const wbVerdict = (line, notOk = {}) => verdictText({ ids: V2_IDS, notOk, tail: '' }).replace('change: ', `${line === null ? '' : `${line}\n`}change: `);
const wbFiles = (text) => reviewFiles(text, { v2: true });

test('a review launched with MC_REVIEW_WRITE_BACK is refused for merge and for build without its write-back line, naming the id, and moves with it in either form', async () => {
  for (const to of ['merge', 'build']) {
    const notOk = to === 'build' ? { bugs: 'x' } : {};
    assertRefused(await moveOut(to, wbFiles(wbVerdict(null, notOk)), WB_ENV), /no line for write-back/u, `${to}: no line`);
    for (const line of ['write-back: OK — memoro-cli/docs/technical/mc-run.md § Programme archive turn', 'write-back: OK — memoro-cli/docs/technical/mc-run.md § Programme archive turn, memoro-cli/docs/technical/areas/system.md § Decisions', 'write-back: OK — memoro-cli/docs/technical/mc-goals.md § The verdict, the line, and more', 'write-back: OK — none — the goal changed no behaviour a page describes']) {
      const f = await moveOut(to, wbFiles(wbVerdict(line, notOk)), WB_ENV);
      assert.equal(f.code, 0, `${to}: ${line}: ${f.err()}`);
    }
  }
});

test('a write-back line that says NOT OK sends the goal to build and keeps a move to merge from happening', async () => {
  const line = 'write-back: NOT OK — the archive turn is true and no page in docs/technical says it';
  const toBuild = await moveOut('build', wbFiles(wbVerdict(line)), WB_ENV);
  assert.equal(toBuild.code, 0, toBuild.err());
  assert.equal(stateOf(toBuild), 'build · ready');
  assertRefused(await moveOut('merge', wbFiles(wbVerdict(line)), WB_ENV), /NOT OK lines \(write-back\)/u, 'merge with a NOT OK write-back');
});

test('a write-back line that is not in its form is refused naming the fault: a bare OK, none without a reason, carried, a page outside docs/technical, a missing section, and a line twice', async () => {
  const cases = [
    ['write-back: OK', /an OK line names the pages or says why none/u],
    ['write-back: OK — none', /`none` needs its reason/u],
    ['write-back: OK — none — ', /not in form|needs its reason/u],
    ['write-back: OK — carried from round 1', /not carried from an earlier round/u],
    ['write-back: OK — memoro-cli/src/mc/run.js § Review', /write-back: not in form/u],
    ['write-back: OK — memoro-cli/docs/technical/mc-run.md', /write-back: not in form/u],
    ['write-back: OK — the docs say it', /write-back: not in form/u],
    ['write-back: OK — none — a\nwrite-back: OK — none — b', /more than one line for write-back/u],
  ];
  for (const [line, said] of cases) assertRefused(await moveOut('merge', wbFiles(wbVerdict(line)), WB_ENV), said, line);
});

test('a review launched without MC_REVIEW_WRITE_BACK is held to no write-back line, and a line written anyway is not an item of its verdict', async () => {
  const bare = await moveOut('merge', wbFiles(wbVerdict(null)), REVIEW);
  assert.equal(bare.code, 0, `a review started without the variable is asked none: ${bare.err()}`);
  assertRefused(await moveOut('merge', wbFiles(wbVerdict('write-back: OK — none — a reason')), REVIEW), /write-back is not an item of this goal's verdict/u, 'a line nobody asked for');
  const off = await moveOut('merge', wbFiles(wbVerdict(null)), { ...REVIEW, MC_REVIEW_WRITE_BACK: '0' });
  assert.equal(off.code, 0, off.err());
});

test('a version 1 goal is held to no write-back line even when the variable is set', async () => {
  const f = await moveOut('merge', reviewFiles(verdictText()), WB_ENV);
  assert.equal(f.code, 0, f.err());
});

test('seenAreas lists the rule areas that declare seen which the goal stands touched on or trips, in the goal\'s order, and nothing for a version 1 goal, an untouched area not tripped or a source area', () => {
  const games = { ...AREA('games', { seen: true }), standards: [], questions: [], page: 'docs/areas/games.md' };
  const text = JSON.stringify({ schema_version: 1, areas: [AREA('ui', { seen: true }), AREA('ops', { seen: true }), AREA('data'), games] });
  const git = (cwd, args = []) => (args[0] === 'show' ? ok(text) : allOk(cwd, args));
  const list = (obligations, tripped = [], repos = ['memoro-cli']) => seenAreas({ goal: parseGoal(goalJsonV2({ repos, obligations })), dir: DIR, tripped, git, exists: () => true });
  const stand = (area, kind) => ({ area, stand: kind, text: 't', ...(kind === 'touched' ? { standard: 'memoro-cli/docs/technical/ui.md#Rule' } : {}) });
  assert.deepEqual(list([stand('memoro-cli/ui', 'touched'), stand('memoro-cli/data', 'touched')]), { seen: ['memoro-cli/ui'] }, 'touched, and not one that does not declare it');
  assert.deepEqual(list([stand('memoro-cli/ops', 'untouched')], [{ area: 'memoro-cli/ops', repo: 'memoro-cli', files: ['src/ops/a.js'] }]), { seen: ['memoro-cli/ops'] }, 'tripped');
  assert.deepEqual(list([stand('memoro-cli/ops', 'untouched')]), { seen: [] }, 'untouched and not tripped');
  assert.deepEqual(list([stand('memoro-cli/ui', 'touched'), stand('memoro-cli/ops', 'touched')]), { seen: ['memoro-cli/ui', 'memoro-cli/ops'] }, 'the declaration\'s order');
  assert.deepEqual(list([stand('memoro-cli/games', 'untouched')]), { seen: [] }, 'a source area is no stand\'s');
  assert.deepEqual(list([stand('memoro-cli/ui', 'touched')], [], ['memoro-cli', 'memoro']), { seen: ['memoro-cli/ui'] });
  assert.deepEqual(seenAreas({ goal: parseGoal(goalJson()), dir: DIR, tripped: [], git: () => assert.fail('a version 1 goal reads no git'), exists: () => true }), { seen: [] });
  assert.match(seenAreas({ goal: parseGoal(goalJsonV2({ obligations: [stand('memoro-cli/ui', 'touched')] })), dir: DIR, tripped: [], git: () => failed('fatal: bad object'), exists: () => true }).error, /\.mc\/areas\.json/u);
});

test('mc goal areas prints a seen: line for an area that declares seen, for a repository and for a goal, and for no other', async () => {
  const text = JSON.stringify({ schema_version: 1, areas: [AREA('documentation', { seen: true }), AREA('operations')] });
  const declarations = { [CLI_PATH]: text, [APP_PATH]: DECLARATION('security') };
  const repo = fixture({ git: areasGit(declarations) });
  assert.equal(await run(['areas', 'memoro-cli'], repo.deps), 0, repo.err());
  const [first, second] = repo.out().split('\n\n');
  assert.match(first, /^memoro-cli\/documentation — The documentation\n  covers: [^\n]*\n  seen: work on it is judged as the user sees it/u);
  assert.doesNotMatch(second, /seen:/u);
  const goal = fixture({ git: areasGit(declarations), files: TWO_REPOS(STANDS_OF) });
  assert.equal(await run(['areas', 'mc/plain'], goal.deps), 0, goal.err());
  assert.equal(goal.out().match(/^  seen: /gmu).length, 1, 'one area in the goal\'s two repositories declares it');
  assert.match(goal.out(), /memoro-cli\/documentation — The documentation\n  stand: touched[^\n]*\n  covers: [^\n]*\n  seen: /u);
});

test('only a review session in review is held to REVIEW.md: plan and a person move merge without one', async () => {
  for (const env of [PLAN, {}]) {
    const f = reviewed({ files: reviewFiles(null), env });
    assert.equal(await run(['stage', ...(env.MC_GOAL ? [] : ['mc/plain']), 'merge'], f.deps), 0, f.err());
    assert.equal(stateOf(f), 'merge · ready');
    assert.equal(f.store[`${DIR}/REVIEW-1.md`], undefined, 'no round copy: no review wrote it');
  }
});

test('no caller can move a goal to finish', async () => {
  for (const env of [{}, PLAN, { ...SESSION, MC_ROLE: 'martin' }, REVIEW, BUILD]) {
    const f = fixture({ files: inStage('review'), env });
    assert.equal(await run(['stage', 'mc/plain', 'finish'], f.deps), 2, env.MC_ROLE || 'person');
    assert.match(f.err(), /mc goal stage build/u);
    assert.equal(stateOf(f), 'review · ready');
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

test('headless goal sessions cannot rewrite the brief or acceptance criteria; interactive Martin may', async () => {
  for (const [env, role] of [[BUILD, 'build'], [REVIEW, 'review'], [MEND, 'mend']]) {
    for (const [argv, refusal] of [
      [['set', 'mc/plain', 'contract', '--text', 'new rule'], /does not rewrite goal text/u],
      [['document', 'add', 'mc/plain', '--label', 'A doc', '--path', 'docs/design.md'], /does not change goal documents/u],
      [['criterion', 'add', 'mc/plain', '--criterion', 'new outcome', '--check', 'a test'], /does not add a criterion/u],
    ]) {
      const f = fixture({ files: inStage(role === 'mend' ? 'merge' : role), env });
      const beforeGoal = f.store[`${DIR}/GOAL.json`];
      const beforeLog = f.store[`${DIR}/LOG.md`];
      assert.equal(await run(argv, f.deps), 2, `${role}: ${argv.join(' ')}`);
      assert.match(f.err(), refusal);
      assert.equal(f.store[`${DIR}/GOAL.json`], beforeGoal);
      assert.equal(f.store[`${DIR}/LOG.md`], beforeLog);
    }
  }
  const martin = fixture({ files: inStage('build'), env: { MC_ROLE: 'martin', MC_TOOL: 'claude' } });
  assert.equal(await run(['set', 'mc/plain', 'title', '--text', 'Martin revised title'], martin.deps), 0, martin.err());
  assert.equal(await run(['set', 'mc/plain', 'contract', '--text', 'Martin revised contract'], martin.deps), 0, martin.err());
  assert.equal(await run(['criterion', 'add', 'mc/plain', '--criterion', 'new outcome', '--check', 'a test'], martin.deps), 0, martin.err());
  assert.equal(await run(['criterion', 'set', 'mc/plain', '1', '--criterion', 'rewritten outcome', '--check', 'revised check'], martin.deps), 0, martin.err());
  const rewritten = parseGoal(martin.store[`${DIR}/GOAL.json`]);
  assert.equal(rewritten.title, 'Martin revised title');
  assert.deepEqual(rewritten.contract, ['Martin revised contract']);
  assert.equal(rewritten.success_criteria.length, 2);
  assert.deepEqual(rewritten.success_criteria[0], { criterion: 'rewritten outcome', check: 'revised check', met: false });
  assert.equal(parseLog(martin.store[`${DIR}/LOG.md`]).at(-1).role, 'martin');
});

test('the goal verbs refuse what would not validate, and write nothing', async () => {
  const f = fixture({ files: seededGoal() });
  const before = f.store[`${DIR}/GOAL.json`];
  assert.equal(await run(['criterion', 'add', 'mc/plain', '--criterion', 'no check'], f.deps), 2);
  assert.match(f.err(), /criterion add needs --check/u);
  assert.equal(await run(['criterion', 'met', 'mc/plain', '3'], f.deps), 2);
  assert.match(f.err(), /it has 1 criteria, no criterion 3/u);
  assert.equal(await run(['criterion', 'met', 'mc/plain', 'x'], f.deps), 2);
  assert.equal(await run(['set', 'mc/plain', 'title', '--text', '  '], f.deps), 1);
  assert.match(f.err(), /title: what the goal is/u);
  assert.equal(await run(['set', 'mc/plain', 'steps', '--text', 'x'], f.deps), 2);
  assert.equal(await run(['document', 'add', 'mc/plain', '--label', 'x'], f.deps), 2);
  assert.equal(f.store[`${DIR}/GOAL.json`], before, 'nothing written');
});

const TWO = [{ criterion: 'first', check: 'a test', met: true }, { criterion: 'second', check: 'another test', met: true }];
const twoCriteria = () => seededGoal({ [`${DIR}/GOAL.json`]: withGoal(GOAL_TEXT, { stage: 'build', status: 'ready', success_criteria: TWO }) });

test('mc goal criterion set rewrites criterion 2 unmet, keeps the others, logs the old and new text, and keeps stage and status', async () => {
  const f = fixture({ files: twoCriteria() });
  assert.equal(await run(['criterion', 'set', 'mc/plain', '2', '--criterion', 'the second, reworded', '--check', 'mc gate tests/mc/commands/goal.test.js'], f.deps), 0, f.err());
  assert.match(f.out(), /mc\/plain · criterion 2 rewritten, unmet · criteria 1\/2/u);
  assert.deepEqual(parseGoal(f.store[`${DIR}/GOAL.json`]).success_criteria, [
    { criterion: 'first', check: 'a test', met: true },
    { criterion: 'the second, reworded', check: 'mc gate tests/mc/commands/goal.test.js', met: false },
  ]);
  assert.equal(stateOf(f), 'build · ready');
  assert.ok(f.store[`${DIR}/LOG.md`].endsWith('## 2026-11-01T20:00Z · person · build · ready\n\nComment: criterion 2 rewritten, unmet — criterion was "second", now "the second, reworded"; check was "another test", now "mc gate tests/mc/commands/goal.test.js"\n'), f.store[`${DIR}/LOG.md`]);
  assert.equal(await run(['criterion', 'set', 'mc/plain', '1', '--check', 'a new check'], f.deps), 0, f.err());
  assert.deepEqual(parseGoal(f.store[`${DIR}/GOAL.json`]).success_criteria.slice(0, 1), [{ criterion: 'first', check: 'a new check', met: false }]);
});

test('mc goal criterion set refuses no flag, a blank text, a criterion that is not there and a bad number, and writes nothing', async () => {
  const f = fixture({ files: twoCriteria() });
  const before = f.store[`${DIR}/GOAL.json`];
  assert.equal(await run(['criterion', 'set', 'mc/plain', '2'], f.deps), 2);
  assert.match(f.err(), /criterion set needs --criterion "…", --check "…" or --evidence "…"/u);
  assert.equal(await run(['criterion', 'set', 'mc/plain', '2', '--check', '  '], f.deps), 2);
  assert.match(f.err(), /criterion set needs --check with text in it/u);
  assert.equal(await run(['criterion', 'set', 'mc/plain', '9', '--check', 'x'], f.deps), 2);
  assert.match(f.err(), /it has 2 criteria, no criterion 9/u);
  assert.equal(await run(['criterion', 'set', 'mc/plain', 'x', '--check', 'x'], f.deps), 2);
  assert.equal(f.store[`${DIR}/GOAL.json`], before, 'GOAL.json byte-identical');
  assert.equal(f.store[`${DIR}/LOG.md`], LOG_TEXT, 'no entry either');
});

test('mc goal criterion set is refused for a build session and a review session, with or without MC_TOOL, and a plan session may rewrite', async () => {
  for (const [env, word] of [[BUILD, 'build'], [REVIEW, 'review']]) {
    const f = fixture({ files: twoCriteria(), env });
    const before = f.store[`${DIR}/GOAL.json`];
    assert.equal(await run(['criterion', 'set', 'mc/plain', '1', '--check', 'x'], f.deps), 2);
    assert.match(f.err(), new RegExp(`a ${word} session does not rewrite a criterion`, 'u'));
    assert.equal(f.store[`${DIR}/GOAL.json`], before, `${word}: file unchanged`);
    assert.equal(f.store[`${DIR}/LOG.md`], LOG_TEXT, `${word}: no entry`);
  }
  const halfSet = fixture({ files: twoCriteria(), env: { MC_GOAL: 'mc/plain', MC_ROLE: BUILD_ROLES.goal } });
  const before = halfSet.store[`${DIR}/GOAL.json`];
  assert.equal(await run(['criterion', 'set', 'mc/plain', '1', '--check', 'x'], halfSet.deps), 2);
  assert.match(halfSet.err(), /a build session does not rewrite a criterion/u);
  assert.equal(halfSet.store[`${DIR}/GOAL.json`], before, 'without MC_TOOL: GOAL.json byte-identical');
  assert.equal(halfSet.store[`${DIR}/LOG.md`], LOG_TEXT, 'without MC_TOOL: no entry');
  const plan = fixture({ files: twoCriteria(), env: PLAN });
  assert.equal(await run(['criterion', 'set', 'mc/plain', '1', '--check', 'x'], plan.deps), 0, plan.err());
  const martin = fixture({ files: twoCriteria(), env: { MC_ROLE: 'martin', MC_TOOL: 'claude' } });
  assert.equal(await run(['set', 'mc/plain', 'contract', '--text', 'A general rule.'], martin.deps), 0, martin.err());
  assert.equal(await run(['criterion', 'set', 'mc/plain', '1', '--check', 'a new check'], martin.deps), 0, martin.err());
  assert.equal(parseGoal(martin.store[`${DIR}/GOAL.json`]).success_criteria[0].met, false, 'rewrite makes it unmet');
  assert.ok(parseLog(martin.store[`${DIR}/LOG.md`]).slice(-2).every(entry => entry.role === 'martin'));
  const stillUnmet = fixture({ files: seededGoal(), env: { MC_ROLE: 'martin', MC_TOOL: 'claude' } });
  assert.equal(await run(['stage', 'mc/plain', 'review'], stillUnmet.deps), 1, 'authority does not manufacture acceptance evidence');
  assert.match(stillUnmet.err(), /criterion 1 is not met/u);
  assert.equal(parseGoal(stillUnmet.store[`${DIR}/GOAL.json`]).success_criteria[0].met, false);
  assert.equal(stateOf(stillUnmet), 'build · ready');
  assert.equal(await run(['criterion', 'remove', 'mc/plain', '1', '--reason', 'obsolete'], halfSet.deps), 2);
  assert.match(halfSet.err(), /a build session does not remove a criterion/u);
  assert.equal(halfSet.store[`${DIR}/GOAL.json`], before, 'without MC_TOOL: GOAL.json byte-identical');
  assert.equal(halfSet.store[`${DIR}/LOG.md`], LOG_TEXT, 'without MC_TOOL: no entry');
});

const THREE = [{ criterion: 'first', check: 'a test', met: true }, { criterion: 'second', check: 'another test', met: false }, { criterion: 'third', check: 'a third test', met: true }];
const threeCriteria = () => seededGoal({ [`${DIR}/GOAL.json`]: withGoal(GOAL_TEXT, { stage: 'build', status: 'ready', success_criteria: THREE }) });

test('mc goal criterion remove takes criterion 2 out, renumbers the rest with their met state, logs the removed text, check, met and reason, and keeps stage and status', async () => {
  const f = fixture({ files: threeCriteria() });
  assert.equal(await run(['criterion', 'remove', 'mc/plain', '2', '--reason', 'the decision made it obsolete'], f.deps), 0, f.err());
  assert.equal(f.out(), 'mc: mc/plain · criterion 2 removed · criteria 2/2\n');
  assert.deepEqual(parseGoal(f.store[`${DIR}/GOAL.json`]).success_criteria, [
    { criterion: 'first', check: 'a test', met: true },
    { criterion: 'third', check: 'a third test', met: true },
  ]);
  assert.equal(stateOf(f), 'build · ready');
  assert.ok(f.store[`${DIR}/LOG.md`].endsWith('## 2026-11-01T20:00Z · person · build · ready\n\nComment: criterion 2 removed — "second", check "another test", was not met; reason: the decision made it obsolete\n'), f.store[`${DIR}/LOG.md`]);
});

test('mc goal criterion remove refuses a build or review session, no reason or a blank one, a bad number and a number past the criteria, and writes nothing', async () => {
  const refusals = [
    [{}, ['criterion', 'remove', 'mc/plain', '2'], /criterion remove needs --reason/u],
    [{}, ['criterion', 'remove', 'mc/plain', '2', '--reason', '  '], /criterion remove needs --reason/u],
    [{}, ['criterion', 'remove', 'mc/plain', '0', '--reason', 'r'], /0 is not a criterion's number/u],
    [{}, ['criterion', 'remove', 'mc/plain', 'x', '--reason', 'r'], /x is not a criterion's number/u],
    [{}, ['criterion', 'remove', 'mc/plain', '9', '--reason', 'r'], /mc\/plain: it has 3 criteria, no criterion 9/u],
    [BUILD, ['criterion', 'remove', 'mc/plain', '2', '--reason', 'r'], /a build session does not remove a criterion/u],
    [REVIEW, ['criterion', 'remove', 'mc/plain', '2', '--reason', 'r'], /a review session does not remove a criterion/u],
  ];
  for (const [env, argv, words] of refusals) {
    const f = fixture({ files: threeCriteria(), env });
    const before = f.store[`${DIR}/GOAL.json`];
    assert.equal(await run(argv, f.deps), 2, argv.join(' '));
    assert.match(f.err(), words, argv.join(' '));
    assert.equal(f.store[`${DIR}/GOAL.json`], before, `${argv.join(' ')}: GOAL.json byte-identical`);
    assert.equal(f.store[`${DIR}/LOG.md`], LOG_TEXT, `${argv.join(' ')}: no entry`);
  }
});

test('mc goal criterion remove refuses the only criterion, naming its replacement, and writes nothing', async () => {
  const f = fixture({ files: seededGoal({ [`${DIR}/GOAL.json`]: withGoal(GOAL_TEXT, { stage: 'build', status: 'ready', success_criteria: MET }) }) });
  const before = f.store[`${DIR}/GOAL.json`];
  assert.equal(await run(['criterion', 'remove', 'mc/plain', '1', '--reason', 'r'], f.deps), 2);
  assert.equal(f.err(), 'mc: criterion 1 is the goal\'s only criterion — add its replacement first, or drop the goal\n');
  assert.equal(f.store[`${DIR}/GOAL.json`], before, 'GOAL.json byte-identical');
  assert.equal(f.store[`${DIR}/LOG.md`], LOG_TEXT, 'no entry');
});

test('mc goal criterion remove by a plan session removes the criterion and logs it with the plan role', async () => {
  const f = fixture({ files: threeCriteria(), env: PLAN });
  assert.equal(await run(['criterion', 'remove', 'mc/plain', '1', '--reason', 'superseded'], f.deps), 0, f.err());
  assert.deepEqual(parseGoal(f.store[`${DIR}/GOAL.json`]).success_criteria.map((c) => c.criterion), ['second', 'third']);
  assert.ok(f.store[`${DIR}/LOG.md`].endsWith('## 2026-11-01T20:00Z · claude opus · build · ready · by plan\n\nComment: criterion 1 removed — "first", check "a test", was met; reason: superseded\n'), f.store[`${DIR}/LOG.md`]);
});

/** `git cat-file -e origin/main:<path>` answers for `ON_MAIN` only; any other path gets git's own "does not exist in"; `gitFails` makes every answer a git failure. */
const ON_MAIN = ['tests/mc/present.test.js'];
const onMain = (gitFails = false) => (cwd, args) => {
  if (args[0] === 'show-ref') return failed('');
  if (args[0] !== 'cat-file') return ok();
  if (gitFails) return failed('fatal: not a git repository');
  const path = args[2].replace('origin/main:', '');
  return ON_MAIN.includes(path) ? ok() : failed(`fatal: path '${path}' does not exist in 'origin/main'`);
};
const ABSENT_WARNING = 'mc: warning: tests/mc/absent.test.js is not on origin/main of memoro-cli — a new file the build creates, or a wrong name?\n';

test('criterion add warns once for a test file its check names that is not on origin/main, and writes and exits as before', async () => {
  const f = fixture({ files: seededGoal({ [`${DIR}/GOAL.json`]: withGoal(GOAL_TEXT, { success_criteria: [] }) }), git: onMain() });
  const check = 'mc gate tests/mc/absent.test.js tests/mc/present.test.js tests/mc/absent.test.js';
  assert.equal(await run(['criterion', 'add', 'mc/plain', '--criterion', 'it runs', '--check', check], f.deps), 0, f.err());
  assert.equal(f.err(), ABSENT_WARNING, 'exactly one warning line, naming the absent file and the repositories');
  const goal = parseGoal(f.store[`${DIR}/GOAL.json`]);
  assert.deepEqual(goal.success_criteria, [{ criterion: 'it runs', check, met: false }]);
});

test('criterion set warns once for a test file its check names that is not on origin/main, and writes and exits as before', async () => {
  const f = fixture({ files: twoCriteria(), git: onMain() });
  assert.equal(await run(['criterion', 'set', 'mc/plain', '1', '--check', 'mc gate tests/mc/absent.test.js tests/mc/present.test.js'], f.deps), 0, f.err());
  assert.equal(f.err(), ABSENT_WARNING, 'exactly one warning line');
  assert.equal(parseGoal(f.store[`${DIR}/GOAL.json`]).success_criteria[0].check, 'mc gate tests/mc/absent.test.js tests/mc/present.test.js');
});

test('a git failure asking after a test file warns nothing, and the add and the set write and exit 0', async () => {
  const add = fixture({ files: seededGoal({ [`${DIR}/GOAL.json`]: withGoal(GOAL_TEXT, { success_criteria: [] }) }), git: onMain(true) });
  assert.equal(await run(['criterion', 'add', 'mc/plain', '--criterion', 'it runs', '--check', 'mc gate tests/mc/absent.test.js'], add.deps), 0, add.err());
  assert.equal(add.err(), '');
  assert.equal(parseGoal(add.store[`${DIR}/GOAL.json`]).success_criteria.length, 1);
  const set = fixture({ files: twoCriteria(), git: onMain(true) });
  assert.equal(await run(['criterion', 'set', 'mc/plain', '1', '--check', 'mc gate tests/mc/absent.test.js'], set.deps), 0, set.err());
  assert.equal(set.err(), '');
  assert.equal(parseGoal(set.store[`${DIR}/GOAL.json`]).success_criteria[0].check, 'mc gate tests/mc/absent.test.js');
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

/* ------------------------------------------------- hold and release */

const HOLD_REASON = 'the fix is taken over here';
/** The hold file `mc goal hold` writes, as an earlier takeover left it. */
const HELD = JSON.stringify({ by: 'plan', tool: 'claude', at: '2026-11-01T19:00Z', reason: HOLD_REASON });
const heldGoal = (extra = {}) => seededGoal({ [`${DIR}/.hold.json`]: HELD, ...extra });
/** Two repositories: one with three changes and two commits past origin/main, one without a worktree. */
const gitState = (cwd, args) => {
  if (cwd === `${DIR}/memoro` && args[0] === 'status') return failed('not a worktree');
  if (args[0] === 'status') return ok(' M src/a.js\n M src/b.js\n?? notes.md\n');
  if (args[0] === 'rev-list') return ok('2\n');
  if (args[0] === 'log') return ok('2026-11-01T21:00:00+01:00\n');
  return allOk();
};
const RELEASE_REPOS = withGoal(GOAL_TEXT, { repos: ['memoro-cli', 'memoro'], success_criteria: MET });

test('mc goal hold writes .hold.json and one log entry, and leaves the stage and status as they are', async () => {
  const f = fixture({ files: inStage('build'), env: PLAN });
  assert.equal(await run(['hold', 'mc/plain', '--reason', HOLD_REASON], f.deps), 0, f.err());
  assert.deepEqual(JSON.parse(f.store[`${DIR}/.hold.json`]), { by: 'plan', tool: 'claude', at: '2026-11-01T20:00Z', reason: HOLD_REASON });
  assert.equal(stateOf(f), 'build · ready');
  const entries = parseLog(f.store[`${DIR}/LOG.md`]);
  assert.equal(entries.length, 5, 'one entry added to the four the goal had');
  assert.deepEqual([entries.at(-1).stage, entries.at(-1).status, entries.at(-1).role], ['build', 'ready', 'plan']);
  assert.equal(entries.at(-1).comment, `held: ${HOLD_REASON}`);
  assert.match(f.out(), /^mc: mc\/plain held — the runner starts no session on it until mc goal release mc\/plain\n$/u);
});

test('mc goal hold refuses a headless caller, another goal\'s session, no reason, a finished goal, and a goal already held, and writes nothing', async () => {
  const cases = [
    ['a headless session', { ...PLAN, MC_HEADLESS: '1' }, ['hold', 'mc/plain', '--reason', HOLD_REASON], inStage('build'), /a hold is set by a person or an interactive session/u],
    ['another goal\'s session', { ...BUILD, MC_GOAL: 'mc/other' }, ['hold', 'mc/plain', '--reason', HOLD_REASON], inStage('build'), /goal session mc\/other cannot change mc\/plain/u],
    ['no reason', PLAN, ['hold', 'mc/plain'], inStage('build'), /hold needs --reason/u],
    ['a finished goal', PLAN, ['hold', 'mc/plain', '--reason', HOLD_REASON], inStage('done'), /mc\/plain is done — a finished goal is not held/u],
    ['a goal already held', PLAN, ['hold', 'mc/plain', '--reason', HOLD_REASON], heldGoal(), /mc\/plain is already held by plan since 2026-11-01T19:00Z/u],
  ];
  for (const [why, env, argv, files, message] of cases) {
    const f = fixture({ files, env });
    const before = { ...f.store };
    assert.equal(await run(argv, f.deps), 2, `${why}: exit 2`);
    assert.match(f.err(), message, why);
    assert.deepEqual(f.store, before, `${why}: nothing written`);
  }
});

test('mc goal release removes the hold, and logs who held it, since when, and each worktree\'s state', async () => {
  const f = fixture({ files: heldGoal({ [`${DIR}/GOAL.json`]: RELEASE_REPOS }), env: PLAN, git: gitState });
  f.deps.remove = (path) => { delete f.store[path]; };
  const before = parseLog(f.store[`${DIR}/LOG.md`]).length;
  assert.equal(await run(['release', 'mc/plain'], f.deps), 0, f.err());
  assert.equal(f.store[`${DIR}/.hold.json`], undefined, 'the hold file is gone');
  assert.equal(stateOf(f), 'build · ready');
  const entries = parseLog(f.store[`${DIR}/LOG.md`]);
  assert.equal(entries.length, before + 1, 'exactly one entry added');
  const last = entries.at(-1);
  assert.equal(last.role, 'plan');
  assert.equal(last.comment, [
    `released: held by plan since 2026-11-01T19:00Z (${HOLD_REASON})`,
    'memoro-cli: 3 changed · 2 commits past origin/main · last commit 2026-11-01T21:00:00+01:00',
    'memoro: no worktree',
  ].join('\n'));
  assert.match(f.out(), /^mc: mc\/plain released\nmemoro-cli: 3 changed · 2 commits past origin\/main · last commit 2026-11-01T21:00:00\+01:00\nmemoro: no worktree\n$/u);
});

test('mc goal release refuses a goal that is not held, and a headless caller, and removes nothing', async () => {
  const cases = [
    ['a goal not held', PLAN, inStage('build'), /mc\/plain is not held/u],
    ['a headless session', { ...PLAN, MC_HEADLESS: '1' }, heldGoal(), /a hold is set by a person or an interactive session/u],
  ];
  for (const [why, env, files, message] of cases) {
    const f = fixture({ files, env });
    f.deps.remove = (path) => { delete f.store[path]; };
    const before = { ...f.store };
    assert.equal(await run(['release', 'mc/plain'], f.deps), 2, `${why}: exit 2`);
    assert.match(f.err(), message, why);
    assert.deepEqual(f.store, before, `${why}: nothing written or removed`);
  }
});

/* ------------------------------------------------- a creation hold: made by new, freed by a stage move or release */

const CREATION = JSON.stringify({ by: 'person', tool: 'person', at: '2026-11-01T19:00Z', reason: 'draft being written by its author', created: true });
/** A draft that is complete and read OK, with `hold` (a hold file's text) beside it, if given. */
const draftFiles = (hold = null) => {
  const text = withGoal(GOAL_TEXT, { stage: 'draft' });
  return seededGoal({ [`${DIR}/GOAL.json`]: text, ...(hold ? { [`${DIR}/.hold.json`]: hold } : {}) });
};
/** Every git call answers: origin/main is seven commits ahead and the goal has none of its own, so a stage move remakes nothing. */
const behindMain = (cwd, args) => (args[0] === 'rev-list' ? ok(`${args[2] === 'origin/main..HEAD' ? 0 : 7}\n`) : ok());

test('mc goal new without MC_HEADLESS holds the draft from creation: the hold is written first, its one entry says so, and a line names the goal', async () => {
  const f = fixture();
  const written = [];
  const { write } = f.deps;
  f.deps.write = (path, text) => { written.push(path); write(path, text); };
  assert.equal(await run(['new', 'mc/plain', '--repo', 'memoro', '--class', 'fast', '--title', 'T'], f.deps), 0, f.err());
  assert.deepEqual(JSON.parse(f.store[`${DIR}/.hold.json`]), { by: 'person', tool: 'person', at: '2026-11-01T20:00Z', reason: 'draft being written by its author', created: true });
  assert.ok(written.indexOf(`${DIR}/.hold.json`) >= 0 && written.indexOf(`${DIR}/.hold.json`) < written.indexOf(`${DIR}/GOAL.json`), `the hold first: ${written.join(', ')}`);
  const entries = parseLog(f.store[`${DIR}/LOG.md`]);
  assert.equal(entries.length, 1, 'one entry');
  assert.match(entries[0].comment, /^held from creation/u);
  assert.match(f.out(), /^  held from creation: mc goal stage mc\/plain build moves it on and frees it; mc goal release mc\/plain hands the draft to headless planning$/mu);
  assert.equal(stateOf(f), 'draft · ready');
});

test('mc goal new with MC_HEADLESS=1 writes no hold, and its entry and stdout carry no held line', async () => {
  const f = fixture({ files: { [`${HOME}/mc/PROGRAMME.json`]: legacyRecord() }, env: { MC_HEADLESS: '1' } });
  assert.equal(await run(['new', 'mc/plain', '--repo', 'memoro', '--class', 'fast', '--title', 'T'], f.deps), 0, f.err());
  assert.equal(f.store[`${DIR}/.hold.json`], undefined, 'no hold file');
  assert.equal(parseLog(f.store[`${DIR}/LOG.md`])[0].comment, null, 'no held comment');
  assert.doesNotMatch(f.out(), /held from creation/u);
  assert.equal(stateOf(f), 'draft · ready');
});

test('mc goal new --stage build without MC_HEADLESS is refused and writes no hold', async () => {
  const f = fixture();
  assert.equal(await run(['new', 'mc/plain', '--repo', 'memoro', '--class', 'fast', '--title', 'T', '--stage', 'build'], f.deps), 2);
  assert.deepEqual(Object.keys(f.store).filter((key) => key.startsWith(DIR)), [], 'no hold, no GOAL.json, no LOG.md');
});

test('a stage move out of draft by a caller without MC_HEADLESS frees a creation hold: the hold goes, the move says so, and the log gains one entry', async () => {
  const f = fixture({ files: draftFiles(CREATION), git: behindMain });
  const removed = [];
  f.deps.remove = (path) => { removed.push(path); delete f.store[path]; };
  const before = parseLog(f.store[`${DIR}/LOG.md`]).length;
  assert.equal(await run(['stage', 'mc/plain', 'build'], f.deps), 0, f.err());
  assert.deepEqual(removed, [`${DIR}/.hold.json`], 'the hold file is the only thing removed');
  assert.equal(f.store[`${DIR}/.hold.json`], undefined);
  assert.match(f.out(), /^  creation hold released$/mu);
  assert.equal(parseLog(f.store[`${DIR}/LOG.md`]).length, before + 1, 'no extra entry for the release');
  assert.equal(stateOf(f), 'build · ready');
});

test('a takeover hold, not made by new, survives a stage move out of draft, and the move does not mention it', async () => {
  const f = fixture({ files: draftFiles(HELD), git: behindMain });
  f.deps.remove = () => { throw new Error('a takeover hold is not removed by a stage move'); };
  assert.equal(await run(['stage', 'mc/plain', 'build'], f.deps), 0, f.err());
  assert.equal(f.store[`${DIR}/.hold.json`], HELD);
  assert.doesNotMatch(f.out(), /creation hold released/u);
});

test('a headless stage move keeps a creation hold: only a caller without MC_HEADLESS frees one', async () => {
  const f = fixture({ files: draftFiles(CREATION), env: { ...PLAN, MC_HEADLESS: '1' }, git: behindMain });
  f.deps.remove = () => { throw new Error('a headless move removes nothing'); };
  assert.equal(await run(['stage', 'mc/plain', 'build'], f.deps), 0, f.err());
  assert.equal(f.store[`${DIR}/.hold.json`], CREATION);
  assert.doesNotMatch(f.out(), /creation hold released/u);
});

test('mc goal release removes a creation hold and logs it as released, as it does any hold', async () => {
  const f = fixture({ files: draftFiles(CREATION), env: PLAN, git: gitState });
  f.deps.remove = (path) => { delete f.store[path]; };
  assert.equal(await run(['release', 'mc/plain'], f.deps), 0, f.err());
  assert.equal(f.store[`${DIR}/.hold.json`], undefined, 'the hold file is gone');
  assert.equal(stateOf(f), 'draft · ready');
  assert.match(parseLog(f.store[`${DIR}/LOG.md`]).at(-1).comment, /^released: held by person since 2026-11-01T19:00Z \(draft being written by its author\)/u);
});

test('a held goal shows its hold on the list line and in show, and a hold on a goal with a session running says the hold does not stop it', async () => {
  const running = fixture({
    files: { ...inStage('build'), '/w/runner/current-x.json': JSON.stringify({ name: 'mc/plain', pid: 4242 }) },
    env: { ...PLAN, MC_WORK_ROOT: '/w' },
    alive: () => true,
  });
  assert.equal(await run(['hold', 'mc/plain', '--reason', HOLD_REASON], running.deps), 0, running.err());
  assert.match(running.out(), /a session is running on mc\/plain now; the hold does not stop it\n$/u);
  const entries = parseLog(running.store[`${DIR}/LOG.md`]);
  assert.equal(entries.length, 5, 'one entry added to the four the goal had');
  assert.equal(entries.at(-1).comment, `held: ${HOLD_REASON} — a session is running on it now; the hold does not stop it`);

  const held = fixture({ files: heldGoal() });
  assert.equal(await run(['list'], held.deps), 0, held.err());
  assert.match(held.out(), /^  mc\/plain · memoro-cli · build · ready, held by plan · criteria 0\/1 · 2 sessions · —$/mu);

  assert.equal(await run(['show', 'mc/plain'], held.deps), 0, held.err());
  assert.match(held.out(), /\nheld by plan since 2026-11-01T19:00Z: the fix is taken over here\n/u);

  const unheld = fixture({ files: inStage('build') });
  assert.equal(await run(['list'], unheld.deps), 0, unheld.err());
  assert.match(unheld.out(), /^  mc\/plain · memoro-cli · build · ready · /mu);
  assert.doesNotMatch(unheld.out(), /held by/u, 'list: an unheld goal says nothing of a hold');
  assert.equal(await run(['show', 'mc/plain'], unheld.deps), 0, unheld.err());
  assert.doesNotMatch(unheld.out(), /held by/u, 'show: an unheld goal says nothing of a hold');
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
      [`${HOME}/mc/goals/d/GOAL.json`]: goal('draft'),
    },
  });
  assert.equal(await run(['list'], f.deps), 0, f.err());
  assert.deepEqual(f.out().trim().split('\n').slice(1), [
    '  mc/a · memoro-cli · review · ready · criteria 0/1 · 1 sessions · —',
    '  mc/b · memoro-cli · finish · blocked · criteria 0/1 · 0 sessions · —',
    '  mc/c · memoro-cli · merge · ready · criteria 0/1 · 0 sessions · —',
    '  mc/d · memoro-cli · draft · ready · criteria 0/1 · 0 sessions · —',
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
  for (const verb of ['mc goal new', 'mc goal set', 'mc goal document add', 'mc goal criterion add', 'mc goal criterion met', 'mc goal criterion unmet', 'mc goal criterion set', 'mc goal convert', 'mc goal phase', 'mc goal log', 'mc goal stage', 'mc goal blocked\\|ready', 'mc goal done', 'mc goal drop', 'mc goal show', 'mc goal list']) {
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
  assert.equal(goalOf(f, 'second').stage, 'draft', 'a later phase keeps the stage: the phase holds it');
  assert.match(f.out(), /mc: mc\/second · draft · ready · phase 2 — /u);
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

/** An archive fixture: `[name, stage, phase]` goals of `mc`, and the moves the archive makes recorded in the store. */
function archiveFixture(goals, { files = {}, ...options } = {}) {
  const f = fixture({ files: Object.assign({}, ...goals.map(([name, stage, phase]) => goalAt(name, stage, phase)), files), ...options });
  f.deps.gh = () => ok('[]');
  f.deps.appendText = (path, text) => { f.store[path] = `${f.store[path] ?? ''}${text}`; };
  f.deps.move = (from, to) => {
    for (const key of Object.keys(f.store)) if (key.startsWith(`${from}/`)) { f.store[`${to}${key.slice(from.length)}`] = f.store[key]; delete f.store[key]; }
  };
  return f;
}
const inStore = (f, name, programme = 'mc') => `${HOME}/${programme}/goals/${name}/${GOAL_FILE}` in f.store;

test('mc goal archive --all archives every done and dropped goal of every programme and nothing else', async () => {
  const f = archiveFixture([['one', 'done', 1], ['two', 'dropped', 1], ['three', 'build', 2]]);
  f.store[`${HOME}/other/PLAN.json`] = '{}';
  for (const [path, text] of Object.entries(goalAt('four', 'done'))) f.store[path.replace('/mc/', '/other/')] = text;
  assert.equal(await run(['archive', '--all'], f.deps), 0, f.err());
  assert.deepEqual(['one', 'two', 'three'].map((name) => inStore(f, name)), [false, false, true], 'only the finished ones moved');
  assert.equal(inStore(f, 'four', 'other'), false, "another programme's too");
  assert.equal(goalField(f.store[`${HOME}/mc/goals/.archive/two/${GOAL_FILE}`], 'stage'), 'dropped');
  assert.match(f.out(), /mc: mc\/one · archived — /u);
  assert.match(f.out(), /mc: mc\/two · archived — /u);
  assert.match(f.out(), /mc: other\/four · archived — /u);
  assert.doesNotMatch(f.out(), /three · archived/u);
  assert.doesNotMatch(f.err(), /three/u);
});

test('mc goal archive --all names each refusal and exits 1, archiving the rest', async () => {
  const f = archiveFixture([['clean', 'done', 1], ['dirty', 'done', 1]], {
    git: (cwd, args) => (args.includes('status') && cwd.includes('/dirty/') ? ok(' M a.js\n') : allOk(cwd, args)),
  });
  const code = await run(['archive', '--all'], f.deps);
  assert.equal(code, 1, f.err());
  assert.equal(inStore(f, 'clean'), false, 'the safe one is archived');
  assert.equal(inStore(f, 'dirty'), true, 'the refused one stays');
  assert.match(f.err(), /mc: mc\/dirty is not archived — /u);
  assert.match(f.out(), /mc: mc\/clean · archived — /u);
});

test('mc goal archive refuses a goal a live session owns in every form, --all included, and archives the others', async () => {
  const root = '/work';
  const live = { [`${root}/runner/current-memoro.json`]: JSON.stringify({ name: 'goal:mc/busy', pid: 777, lane: 0 }) };
  const make = (alive) => archiveFixture([['busy', 'done', 1], ['idle', 'done', 1]], { files: live, env: { MC_WORK_ROOT: root }, alive });
  for (const argv of [['archive', 'mc/busy'], ['archive', 'mc'], ['archive', '--all']]) {
    const f = make((pid) => pid === 777);
    const code = await run(argv, f.deps);
    assert.equal(code, 1, `${argv.join(' ')}: ${f.err()}`);
    assert.equal(inStore(f, 'busy'), true, `${argv.join(' ')}: the owned goal stays`);
    assert.match(f.err(), /mc\/busy is not archived — .*live session/u, argv.join(' '));
    assert.equal(inStore(f, 'idle'), argv[1] === 'mc/busy', `${argv.join(' ')}: the other goal is archived unless it was not asked for`);
  }
  const dead = make(() => false);
  assert.equal(await run(['archive', '--all'], dead.deps), 0, dead.err());
  assert.equal(inStore(dead, 'busy'), false, 'a session that is no longer alive owns nothing');
});

test('mc goal archive --all says so when nothing is finished, and takes no name', async () => {
  const f = archiveFixture([['work', 'build', 1]]);
  assert.equal(await run(['archive', '--all'], f.deps), 0);
  assert.equal(f.out(), 'mc: no done or dropped goal\n');
  assert.equal(await run(['archive', '--all', 'mc/work'], f.deps), 2);
  assert.match(f.err(), /archive --all takes no name/u);
  assert.equal(await run(['archive'], f.deps), 2, 'no name and no --all is usage');
  assert.equal(await run(['status', '--all'], f.deps), 2, '--all belongs to archive alone');
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
      // A goal written while the first stage was named `plan` (until 2026-11-07): rewritten once as `draft`.
      [`${HOME}/mc/goals/drafted/GOAL.json`]: withGoal(GOAL_TEXT, { stage: 'plan', status: 'ready' }),
      [`${HOME}/mc/goals/drafted/LOG.md`]: '## 2026-11-02T10:00Z · person · plan · ready\n\nDone: created\n',
    },
  });
  assert.equal(await run(['convert', 'mc'], f.deps), 0, f.err());
  const where = (name) => { const goal = goalOf(f, name); return `${goal.stage} · ${goal.status}`; };
  assert.equal(goalField(f.store[`${HOME}/mc/goals/drafted/GOAL.json`], 'stage'), 'draft', 'GOAL.json is rewritten');
  const drafted = parseLog(f.store[`${HOME}/mc/goals/drafted/LOG.md`]);
  assert.deepEqual(drafted.map((entry) => [entry.stage, entry.done]), [['draft', 'created'], ['draft', 'stage draft, from plan (the stage was renamed 2026-11-07); phase 1']], 'the old heading reads as draft and stays as written; the rename is one entry');
  assert.match(f.store[`${HOME}/mc/goals/drafted/LOG.md`], /^## 2026-11-02T10:00Z · person · plan · ready$/mu, 'history is not rewritten');
  assert.match(f.out(), /mc: mc\/drafted · draft · ready \(was plan\), phase 1\n/u);
  assert.deepEqual(Object.fromEntries(['open', 'judged', 'queued', 'red-review', 'red-merge', 'no-verdict', 'asked', 'mute', 'by-hand', 'landed', 'let-go'].map((name) => [name, where(name)])), {
    open: 'build · ready',
    judged: 'review · ready',
    queued: 'merge · ready',
    'red-review': 'build · blocked',
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
  assert.equal(await run(martinCall('choose scope; recommend keeping it', 'mc/plain'), f.deps), 2, f.err());
  assert.equal(stateOf(f), 'merge · ready', 'mc goal martin is gone: it moves nothing');
});

/**
 * The headless mend role (Martin, 2026-11-07): a mend session sets a status and
 * requeues a goal in `merge`, and moves no stage; it writes no goal acceptance.
 * The finish session it was once paired with is gone: a rejected review returns
 * the goal to build (retired case `a finish session moves finish to merge…` →
 * the review verdict cases below, `a repair build session…` in run.test.js).
 */
const MEND = { ...SESSION, MC_ROLE: MEND_ROLE };

test('a mend session repairs and requeues only a merge failure, and is refused every other stage and the goal\'s text', async () => {
  const red = inStage('merge', 'blocked');
  red[`${DIR}/GOAL.json`] = withGoal(red[`${DIR}/GOAL.json`], { prs: ['memoro-cli#31'] });
  const requeued = reviewed({ files: red, env: MEND });
  assert.equal(await run(['stage', 'merge'], requeued.deps), 0, requeued.err());
  assert.equal(stateOf(requeued), 'merge · ready', 'the requeue is no stage move');
  assert.deepEqual(requeued.queued.map((job) => [job.repo, job.pr]), [['memoro-cli', 31]], 'every registered pull request is queued again');
  for (const [from, argv, said] of [
    ['build', ['ready', '--reason', 'fixture repaired'], /mend session is only for merge/u],
    ['review', ['blocked', '--reason', 'the contract forbids the fix'], /mend session is only for merge/u],
    ['finish', ['blocked', '--reason', 'still red'], /mend session is only for merge/u],
    ['build', ['stage', 'review'], /a mend session is only for merge failures/u],
    ['finish', ['stage', 'merge'], /a mend session is only for merge failures/u],
    ['build', ['drop', '--reason', 'x'], /a mend session is only for merge failures/u],
    ['merge', ['stage', 'build'], /a session does not move a goal back — merge → build/u],
    ['build', ['criterion', 'set', '1', '--check', 'y'], /a mend session does not rewrite a criterion/u],
  ]) {
    const f = fixture({ files: inStage(from, 'blocked'), env: MEND });
    assert.equal(await run(argv, f.deps), 2, argv.join(' '));
    assert.match(f.err(), said);
    assert.equal(f.store[`${DIR}/LOG.md`], LOG_TEXT, 'nothing written');
  }
});

/*
 * `mc goal defect`: a session that finds its goal wrong reports it, in its own stage, and the goal stops
 * (docs/technical/mc-goals.md, § The verbs). No jev, no options, no ledger row.
 */
const DEFECT = ['defect', '--part', 'criterion 2', '--found', 'its check names tests/x.test.js, which is not on main'];
const DEFECT_LINE = 'goal defect: criterion 2 — its check names tests/x.test.js, which is not on main';

test('goal defect: a build and a review session report the goal in their own stage, which then stops and gets no session', async () => {
  for (const [stage, env, role] of [['build', BUILD, 'build'], ['review', REVIEW, 'review']]) {
    const f = fixture({ files: inStage(stage), env, keys: KEYS });
    assert.equal(await run([...DEFECT, '--evidence', 'tests/x.test.js: no such file, key ts-key-0123456789abcdef', '--next', 'amend criterion 2 with its real check'], f.deps), 0, f.err());
    assert.equal(stateOf(f), `${stage} · Martin`, `${role}: the stage is kept, the status is Martin`);
    const written = parseLog(f.store[`${DIR}/LOG.md`]);
    assert.equal(written.length, 5, `${role}: one entry`);
    const entry = written.at(-1);
    assert.deepEqual([entry.status, entry.stage, entry.role, entry.tool, entry.done], ['Martin', stage, role, 'claude', null]);
    assert.equal(entry.comment.split('\n')[0], DEFECT_LINE, `${role}: the first line is the defect`);
    assert.match(entry.comment, /^Evidence: tests\/x\.test\.js: no such file, key /mu);
    assert.doesNotMatch(f.store[`${DIR}/LOG.md`], /ts-key-0123456789abcdef/u, 'a key in the evidence is redacted');
    assert.equal(entry.next, 'amend criterion 2 with its real check');
    assert.doesNotMatch(entry.comment, /Martin is asked:|^Option /mu, 'no question and no options');
    assert.deepEqual([f.requests.length, f.ledger().length], [0, 0], 'jev is not asked and nothing is ledgered');
    assert.equal(goalSession(parseGoal(f.store[`${DIR}/GOAL.json`])), null, `${role}: the runner starts nothing on it`);
    assert.equal(f.store[`${DIR}/GOAL.json`], withGoal(inStage(stage)[`${DIR}/GOAL.json`], { status: 'Martin' }), 'nothing else of GOAL.json changed');
  }
});

test('goal defect: a person, and the plan role, may report any unfinished goal by name', async () => {
  for (const env of [{}, PLAN]) {
    const f = fixture({ files: inStage('review'), env });
    assert.equal(await run(['defect', 'mc/plain', ...DEFECT.slice(1)], f.deps), 0, f.err());
    assert.equal(stateOf(f), 'review · Martin');
    assert.equal(parseLog(f.store[`${DIR}/LOG.md`]).at(-1).comment, DEFECT_LINE);
  }
});

test('goal defect is refused for a finished goal, a build session on a goal not in build, and a mend session, and writes nothing', async () => {
  for (const [from, env, status, code, said] of [
    ['done', BUILD, 'ready', 1, /is done — a finished goal has no defect to report/u],
    ['dropped', REVIEW, 'ready', 1, /is dropped — a finished goal has no defect to report/u],
    ['review', BUILD, 'ready', 2, /build-session:goal cannot set Martin for a goal in review/u],
    ['finish', BUILD, 'ready', 2, /build-session:goal cannot set Martin for a goal in finish/u],
    ['build', REVIEW, 'ready', 2, /review-session:goal cannot set Martin for a goal in build/u],
    ['merge', MEND, 'blocked', 2, /a mend session does not report a goal defect/u],
    ['build', MEND, 'blocked', 2, /a mend session is only for merge failures, and this goal is in build/u],
  ]) {
    const f = fixture({ files: inStage(from, status), env });
    assert.equal(await run(DEFECT, f.deps), code, `${from} by ${env.MC_ROLE}: ${f.err()}`);
    assert.match(f.err(), said);
    assert.equal(f.store[`${DIR}/LOG.md`], LOG_TEXT, 'nothing written');
    assert.equal(f.store[`${DIR}/GOAL.json`], inStage(from, status)[`${DIR}/GOAL.json`], 'GOAL.json untouched');
  }
});

test('goal defect without --part or --found, or with a blank one, exits 2 and says how to call it, and writes nothing', async () => {
  for (const argv of [
    ['defect'],
    ['defect', '--found', 'it cannot run'],
    ['defect', '--part', 'criterion 2'],
    ['defect', '--part', '   ', '--found', 'it cannot run'],
    ['defect', '--part', 'criterion 2', '--found', ''],
    [...DEFECT, '--evidence', 'a', '--evidence-file', '-'],
    [...DEFECT, '--next', 'a', '--next-file', '-'],
  ]) {
    const f = fixture({ files: inStage('build'), env: BUILD });
    assert.equal(await run(argv, f.deps), 2, argv.join(' '));
    assert.match(f.err(), /goal defect is not reported/u);
    assert.match(f.err(), /Call it again as: mc goal defect mc\/plain --part "/u);
    assert.equal(f.store[`${DIR}/LOG.md`], LOG_TEXT, 'nothing written');
    assert.equal(stateOf(f), 'build · ready');
  }
});

test('goal defect is in the usage and in mc goal --help', async () => {
  assert.match(usage(), /mc goal defect \[<programme>\/<goal>\] --part "<[^"]*>" --found "</u);
  const printed = [];
  assert.equal(await runModule('./mc/commands/goal.js', ['--help'], { stdout: { write: (text) => printed.push(text) } }), 0);
  assert.match(printed.join(''), /mc goal defect /u);
});

for (const [name, args] of [
  ['log', ['log', 'mc/plain', '--done', 'Unauthorized']],
  ['stage', ['stage', 'mc/plain', 'review']],
  ['ready', ['ready', 'mc/plain']],
  ['set', ['set', 'mc/plain', 'title', '--text', 'Unauthorized']],
  ['criterion met', ['criterion', 'met', 'mc/plain', '1']],
  ['new', ['new', 'mc/other', '--repo', 'memoro-cli', '--class', 'medium', '--title', 'Unauthorized']],
  ['pr', ['pr', 'mc/plain', 'memoro-cli#1']],
  ['archive', ['archive', 'mc/plain']],
]) test(`desk-prepare refuses goal ${name} before any file, Git or ledger effect`, async () => {
  const f = fixture({ files: seededGoal(), env: { MC_ROLE: 'desk-prepare', MC_TOOL: 'person' } });
  const before = structuredClone(f.store);
  f.deps.readKeys = () => assert.fail('preparation read question credentials');
  assert.equal(await run(args, f.deps), 2);
  assert.match(f.err(), /desk-prepare cannot write goals/u);
  assert.deepEqual(f.store, before);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.requests, []); assert.deepEqual(f.ledger(), []);
});


test('decision alone gains unattended desk moves, acceptance rewrites and attribution, never done', async () => {
  const env = { MC_ROLE: 'decision', MC_HEADLESS: '1', MC_TOOL: 'codex', MC_GOAL: 'mc/plain' };
  const f = fixture({ files: inStage('merge'), env });
  assert.equal(await run(['stage', 'mc/plain', 'build'], f.deps), 0, f.err());
  assert.equal(await run(['ready','mc/plain'], f.deps), 0, f.err());
  assert.equal(await run(['criterion','set','mc/plain','1','--criterion','A truthful check'], f.deps), 0, f.err());
  assert.equal(parseGoal(f.store[`${DIR}/GOAL.json`]).success_criteria[0].met,false);
  assert.ok(parseLog(f.store[`${DIR}/LOG.md`]).some(x=>x.role === 'decision' && x.comment?.includes('moved back')));
  assert.equal(await run(['stage','mc/plain','done'], f.deps), 2);
  assert.equal(await run(['done','mc/plain'], f.deps), 2);
  assert.equal(stateOf(f),'build · ready');
  dropFixture(f);
  assert.equal(await run(['drop','mc/plain','--reason','Obsolete scope'], f.deps),0,f.err());
  for (const from of STAGES) {
    for (const to of STAGES.filter(x=>x!=='done' && x!=='finish')) assert.equal(refusedMove({ from,to,env }),null,`${from} to ${to}`);
    for (const status of ['ready','blocked','Martin']) assert.equal(refusedMove({ from,status,env }),null);
    assert.match(refusedMove({ from,to:'done',env }),/does not mark/u);
  }
});

test('headless Martin still cannot move, rewrite criteria or drop', async () => {
  const env = { MC_ROLE:'martin', MC_HEADLESS:'1', MC_TOOL:'codex', MC_GOAL:'mc/plain' };
  for (const args of [['stage','build'],['ready'],['criterion','set','1','--criterion','Changed'],['drop','--reason','Obsolete']]) {
    const f = fixture({ files:inStage('merge'), env });
    assert.equal(await run(args,f.deps),2,args.join(' '));
    assert.equal(stateOf(f),'merge · ready');
    assert.match(f.err(),/interactive-only/u);
  }
});

// ---- The learning role can only read goals ----

const LEARNING = { MC_ROLE: 'learning', MC_HEADLESS: '1', MC_TOOL: 'claude', MC_SESSION_STARTED: '2026-11-01T20:00:00.000Z' };
const snapshot = (f) => JSON.stringify(f.store);

test('the learning role cannot create or mutate goals, including ones an older session created', async () => {
  const further = [
    ['new', 'mc/fresh', '--repo', 'memoro-cli', '--class', 'fast', '--title', 'Learned'],
    ['stage', 'mc/plain', 'build'], ['stage', 'mc/plain', 'review'], ['ready', 'mc/plain', '--reason', 'x'], ['drop', 'mc/plain', '--reason', 'x'],
    ['criterion', 'set', 'mc/plain', '1', '--criterion', 'Changed'], ['log', 'mc/plain', '--comment', 'x'], ['set', 'mc/plain', 'goal', '--text', 'Changed'],
    ['criterion', 'add', 'mc/plain', '--criterion', 'Extra', '--check', 'x'], ['criterion', 'met', 'mc/plain', '1'],
  ];
  for (const argv of further) {
    // Even an entry stamped as its own creation by an older version conveys no authority.
    for (const files of [inStage('draft'), inStage('draft', 'ready', { [`${DIR}/LOG.md`]: '## 2026-11-01T20:00Z · claude · draft · ready · by learning\n\nDone: created\n' })]) {
      const f = fixture({ files, env: LEARNING });
      const before = snapshot(f);
      assert.equal(await run(argv, f.deps), 2, argv.join(' '));
      assert.match(f.err(), /learning role/u, argv.join(' '));
      assert.equal(snapshot(f), before, `${argv.join(' ')}: nothing written`);
      assert.deepEqual(f.calls, [], `${argv.join(' ')}: no git`);
    }
  }
});

test('the learning role cannot change a goal stage through the shared guard', () => {
  assert.match(refusedMove({ from: 'build', to: 'review', env: LEARNING }), /learning role/u);
  assert.match(refusedMove({ from: 'draft', to: 'build', env: LEARNING }), /learning role/u);
});

// ---- Version 2: numbered parts, written by item, obligation, set and criterion verbs ----

const V2_FILES = (text = goalJsonV2()) => seededGoal({ [`${DIR}/GOAL.json`]: text });
const V2_PERSON = { MC_TOOL: 'person' };
const v2At = (f) => parseGoal(f.store[`${DIR}/GOAL.json`]);
const lastLog = (f) => parseLog(f.store[`${DIR}/LOG.md`]).at(-1);
const jevCtx = (f) => ({ read: f.deps.read, env: f.deps.env, home: HOME, stderr: f.deps.stderr, realpath: (path) => path });

test('mc goal new writes a version 2 goal by default, with empty parts and no id given, and its hint names version 2\'s verbs; --structure 1 writes version 1 and its hint; --structure 3 is refused', async () => {
  const f = fixture();
  assert.equal(await run(['new', 'mc/plain', '--repo', 'memoro-cli', '--class', 'large', '--title', 'Plain', '--structure', '2'], f.deps), 0, f.err());
  const goal = parseGoal(f.store[`${DIR}/GOAL.json`]);
  assert.equal(goal.problems, undefined, String(goal.problems));
  assert.equal(goal.version, 2);
  assert.deepEqual(goal.ids, { B: 0, P: 0, D: 0, C: 0, V: 0, R: 0, X: 0 });
  assert.deepEqual([goal.outcome, goal.problem, goal.obligations, goal.success_criteria], [[], [], [], []]);
  assert.equal(goal.goal, undefined);
  assert.match(f.out(), /\(version 2\) is to be filled in by verbs: mc goal set mc\/plain aim\|outcome\|latitude\|protection --text "…", mc goal item add mc\/plain problem\|premise\|decision\|change\|preserve\|risk\|out-of-scope --text/u);
  assert.doesNotMatch(f.out(), /contract/u, 'no version 1 verb in a version 2 hint');

  const one = fixture();
  assert.equal(await run(['new', 'mc/plain', '--repo', 'memoro-cli', '--class', 'large', '--title', 'Plain', '--structure', '1'], one.deps), 0, one.err());
  assert.equal(parseGoal(one.store[`${DIR}/GOAL.json`]).version, 1, '--structure 1 writes version 1');
  assert.match(one.out(), /GOAL\.json is to be filled in by verbs: mc goal set mc\/plain goal\|contract\|out-of-scope --text "…"/u);
  assert.doesNotMatch(one.out(), /version 2/u);
  const plain = fixture();
  assert.equal(await run(['new', 'mc/plain', '--repo', 'memoro-cli', '--class', 'large', '--title', 'Plain'], plain.deps), 0, plain.err());
  assert.equal(plain.store[`${DIR}/GOAL.json`], f.store[`${DIR}/GOAL.json`], '--structure 2 is the default');
  assert.equal(parseGoal(plain.store[`${DIR}/GOAL.json`]).version, 2);
  assert.equal(plain.out(), f.out(), 'and its hint is the version 2 hint');

  const bad = fixture();
  assert.equal(await run(['new', 'mc/plain', '--repo', 'memoro-cli', '--class', 'large', '--title', 'Plain', '--structure', '3'], bad.deps), 2);
  assert.match(bad.err(), /--structure is 1 or 2, not 3/u);
  assert.deepEqual(bad.store, { [`${HOME}/mc/PLAN.json`]: '{}' }, 'nothing written');
});

test('mc goal item add writes each of the seven parts and prints the id; an id is the highest present plus one, and a removed highest is not given again', async () => {
  const f = fixture({ files: V2_FILES(goalMinimalV2()), env: V2_PERSON });
  const adds = [
    [['problem', '--text', 'It is slow.', '--basis', 'inferred'], 'B1'],
    [['premise', '--text', 'It is one file.', '--source', 'goals.js', '--basis', 'read', '--at', 'abc'], 'P1'],
    [['decision', '--text', 'Numbered.', '--by', 'Martin', '--on', '2026-11-14'], 'D1'],
    [['change', '--text', 'Add a verb.', '--where', 'src/mc'], 'C2'],
    [['preserve', '--text', 'Version 1.', '--upheld-by', 'criterion 1'], 'V1'],
    [['risk', '--text', 'Data loss.', '--settled-by', 'criterion 1'], 'R1'],
    [['out-of-scope', '--text', 'Conversion.', '--owner', 'nobody'], 'X1'],
  ];
  for (const [argv, id] of adds) {
    const printed = f.out().length;
    assert.equal(await run(['item', 'add', 'mc/plain', ...argv], f.deps), 0, `${argv[0]}: ${f.err()}`);
    assert.ok(f.out().slice(printed).includes(id), `${argv[0]} prints ${id}: ${f.out().slice(printed)}`);
  }
  const goal = v2At(f);
  assert.deepEqual(goal.change.map((item) => item.id), ['C1', 'C2']);
  assert.deepEqual(goal.problem[0], { id: 'B1', text: 'It is slow.', basis: 'inferred' });
  assert.deepEqual(goal.premises[0], { id: 'P1', claim: 'It is one file.', source: 'goals.js', basis: 'read', at: 'abc' });
  assert.deepEqual(goal.out_of_scope[0], { id: 'X1', text: 'Conversion.', owner: 'nobody' });
  assert.deepEqual(goal.ids, { B: 1, P: 1, D: 1, C: 2, V: 1, R: 1, X: 1 });

  assert.equal(await run(['item', 'remove', 'mc/plain', 'C2', '--reason', 'wrong place'], f.deps), 0, f.err());
  assert.deepEqual(v2At(f).change.map((item) => item.id), ['C1']);
  const printed = f.out().length;
  assert.equal(await run(['item', 'add', 'mc/plain', 'change', '--text', 'Again.', '--where', 'src'], f.deps), 0);
  assert.deepEqual(v2At(f).change.map((item) => item.id), ['C1', 'C3'], 'C2 is not given again');
  assert.ok(f.out().slice(printed).includes('C3'));
  assert.equal(await run(['item', 'remove', 'mc/plain', 'C1', '--reason', 'gone'], f.deps), 0);
  assert.equal(await run(['item', 'add', 'mc/plain', 'change', '--text', 'Next.', '--where', 'src'], f.deps), 0);
  assert.deepEqual(v2At(f).change.map((item) => item.id), ['C3', 'C4'], 'the highest present plus one');
});

test('mc goal item set logs what each field was and is now and keeps the rest; item remove logs the item and the reason', async () => {
  const f = fixture({ files: V2_FILES(), env: V2_PERSON });
  assert.equal(await run(['item', 'set', 'mc/plain', 'D1', '--text', 'Parts are numbered and stable.'], f.deps), 0, f.err());
  assert.deepEqual(v2At(f).decisions[0], { id: 'D1', text: 'Parts are numbered and stable.', by: 'Martin', on: '2026-11-14' });
  assert.match(lastLog(f).comment, /^D1 rewritten — text was "Parts are numbered\.", now "Parts are numbered and stable\."$/u);
  assert.equal(await run(['item', 'set', 'mc/plain', 'P1', '--basis', 'measured', '--at', 'def'], f.deps), 0, f.err());
  assert.match(lastLog(f).comment, /^P1 rewritten — basis was "read", now "measured"; at was "4daf75f3", now "def"$/u);
  assert.equal(await run(['item', 'set', 'mc/plain', 'V1', '--upheld-by', 'criterion 2'], f.deps), 0, f.err());
  assert.match(lastLog(f).comment, /^V1 rewritten — upheld-by was "criterion 1", now "criterion 2"$/u);
  assert.doesNotMatch(lastLog(f).comment, /upheld_by/u);
  assert.equal(await run(['item', 'remove', 'mc/plain', 'R1', '--reason', 'no longer a risk'], f.deps), 0, f.err());
  assert.deepEqual(v2At(f).risks, []);
  assert.match(lastLog(f).comment, /^R1 removed — .*A writer drops the parts\..*; reason: no longer a risk$/u);
  assert.equal(v2At(f).ids.R, 1, 'ids keeps R1\'s number');
});

test('mc goal obligation set replaces the area\'s obligation and logs it; obligation remove takes it out with its reason', async () => {
  const f = fixture({ files: V2_FILES(), env: V2_PERSON });
  assert.equal(await run(['obligation', 'set', 'mc/plain', 'Security', '--stand', 'untouched', '--text', 'No data moves.'], f.deps), 0, f.err());
  assert.equal(v2At(f).obligations.length, 3);
  assert.equal(await run(['obligation', 'set', 'mc/plain', 'Documentation', '--stand', 'untouched', '--text', 'No words change.'], f.deps), 0, f.err());
  assert.deepEqual(v2At(f).obligations[0], { area: 'Documentation', stand: 'untouched', text: 'No words change.' }, 'replaced in place, its standard gone');
  assert.equal(v2At(f).obligations.length, 3);
  assert.match(lastLog(f).comment, /^obligation "Documentation" replaced — it was /u);
  assert.equal(await run(['obligation', 'remove', 'mc/plain', 'Security', '--reason', 'not an area here'], f.deps), 0, f.err());
  assert.deepEqual(v2At(f).obligations.map((item) => item.area), ['Documentation', 'Operations']);
  assert.match(lastLog(f).comment, /^obligation "Security" removed — .*; reason: not an area here$/u);
  const before = snapshot(f);
  assert.equal(await run(['obligation', 'remove', 'mc/plain', 'Nowhere', '--reason', 'x'], f.deps), 2);
  assert.match(f.err(), /it has no obligation for "Nowhere"/u);
  assert.equal(snapshot(f), before);
});

test('mc goal criterion add and set take --evidence on version 2; set --check alone keeps the evidence; version 1 refuses it', async () => {
  const f = fixture({ files: V2_FILES(), env: V2_PERSON });
  assert.equal(await run(['criterion', 'add', 'mc/plain', '--criterion', 'it shows', '--check', 'a test', '--evidence', 'the log'], f.deps), 0, f.err());
  assert.equal(v2At(f).success_criteria[1].evidence, 'the log');
  assert.equal(await run(['criterion', 'set', 'mc/plain', '2', '--check', 'a better test'], f.deps), 0, f.err());
  assert.deepEqual(v2At(f).success_criteria[1], { criterion: 'it shows', check: 'a better test', evidence: 'the log', met: false });
  assert.equal(await run(['criterion', 'set', 'mc/plain', '2', '--evidence', 'the gate'], f.deps), 0, f.err());
  assert.equal(v2At(f).success_criteria[1].evidence, 'the gate');
  assert.match(lastLog(f).comment, /evidence/u);

  const v1 = fixture({ files: seededGoal(), env: V2_PERSON });
  const before = snapshot(v1);
  assert.equal(await run(['criterion', 'add', 'mc/plain', '--criterion', 'x', '--check', 'y', '--evidence', 'z'], v1.deps), 2);
  assert.match(v1.err(), /version 1 goal — --evidence is for version 2/u);
  assert.equal(await run(['criterion', 'set', 'mc/plain', '1', '--evidence', 'z'], v1.deps), 2);
  assert.equal(snapshot(v1), before, 'nothing written');
});

test('mc goal set writes a version 2 goal\'s prose parts as paragraphs, and refuses goal, contract and out-of-scope on it, naming the version', async () => {
  const f = fixture({ files: V2_FILES(), env: V2_PERSON });
  assert.equal(await run(['set', 'mc/plain', 'latitude', '--text', 'One.\n\nTwo.'], f.deps), 0, f.err());
  assert.deepEqual(v2At(f).latitude, ['One.', 'Two.']);
  assert.equal(await run(['set', 'mc/plain', 'aim', '--text', 'Why.'], f.deps), 0);
  const before = snapshot(f);
  for (const field of ['goal', 'contract', 'out-of-scope']) {
    assert.equal(await run(['set', 'mc/plain', field, '--text', 'x'], f.deps), 2, field);
    assert.match(f.err(), new RegExp(`version 2 goal — set ${field} is for version 1`, 'u'));
  }
  assert.equal(snapshot(f), before, 'nothing written');
  const v1 = fixture({ files: seededGoal(), env: V2_PERSON });
  assert.equal(await run(['set', 'mc/plain', 'outcome', '--text', 'x'], v1.deps), 2);
  assert.match(v1.err(), /version 1 goal — set outcome is for version 2/u);
});

test('the version 2 verbs refuse a version 1 goal and bad flags with exit 2, write nothing, and name the version and the verb', async () => {
  const v1 = fixture({ files: seededGoal(), env: V2_PERSON });
  const before = snapshot(v1);
  for (const argv of [
    ['item', 'add', 'mc/plain', 'decision', '--text', 'x', '--by', 'm', '--on', 'd'],
    ['item', 'set', 'mc/plain', 'D1', '--text', 'x'],
    ['item', 'remove', 'mc/plain', 'D1', '--reason', 'x'],
    ['obligation', 'set', 'mc/plain', 'Docs', '--stand', 'touched', '--text', 'x'],
    ['obligation', 'remove', 'mc/plain', 'Docs', '--reason', 'x'],
  ]) {
    assert.equal(await run(argv, v1.deps), 2, argv.join(' '));
    assert.match(v1.err(), new RegExp(`version 1 goal — ${argv[0]} ${argv[1]} is for version 2`, 'u'));
  }
  assert.equal(snapshot(v1), before);

  const f = fixture({ files: V2_FILES(), env: V2_PERSON });
  const kept = snapshot(f);
  for (const [argv, words] of [
    [['item', 'add', 'mc/plain', 'decision', '--text', 'x', '--by', 'm'], /needs --on/u],
    [['item', 'add', 'mc/plain', 'decision', '--text', 'x', '--by', 'm', '--on', 'd', '--where', 'src'], /takes no --where/u],
    [['item', 'add', 'mc/plain', 'problem', '--text', 'x', '--basis', 'guessed'], /--basis is measured, reported, inferred, not guessed/u],
    [['item', 'add', 'mc/plain', 'idea', '--text', 'x'], /item add <programme>\/<goal>/u],
    [['item', 'set', 'mc/plain', 'D1'], /item set needs --text/u],
    [['item', 'set', 'mc/plain', 'D9', '--text', 'x'], /it has no item D9/u],
    [['item', 'set', 'mc/plain', 'Q1', '--text', 'x'], /item set <programme>\/<goal> <id>/u],
    [['item', 'remove', 'mc/plain', 'D1'], /item remove needs --reason/u],
    [['obligation', 'set', 'mc/plain', 'Docs', '--text', 'x'], /obligation set needs --stand/u],
    [['obligation', 'set', 'mc/plain', 'Docs', '--stand', 'maybe', '--text', 'x'], /--stand is touched or untouched, not maybe/u],
    [['obligation', 'set', 'mc/plain', 'Docs', '--stand', 'touched', '--text', 'x', '--standard', 'nowhere'], /--standard is <repo>\/<path>#<section>/u],
  ]) {
    assert.equal(await run(argv, f.deps), 2, argv.join(' '));
    assert.match(f.err(), words, argv.join(' '));
  }
  assert.equal(snapshot(f), kept, 'nothing written');
});

test('every new writing verb is refused a build, review and mend session, and writes nothing', async () => {
  const roles = { build: BUILD_ROLES.goal, review: REVIEW_ROLE, mend: MEND_ROLE };
  for (const [word, role] of Object.entries(roles)) {
    const f = fixture({ files: V2_FILES(), env: { ...SESSION, MC_ROLE: role, MC_REVIEW_HEAD: 'abc1234def' } });
    const before = snapshot(f);
    for (const argv of [
      ['item', 'add', 'mc/plain', 'decision', '--text', 'x', '--by', 'm', '--on', 'd'],
      ['item', 'set', 'mc/plain', 'D1', '--text', 'x'],
      ['item', 'remove', 'mc/plain', 'D1', '--reason', 'x'],
      ['obligation', 'set', 'mc/plain', 'Docs', '--stand', 'touched', '--text', 'x'],
      ['obligation', 'remove', 'mc/plain', 'Documentation', '--reason', 'x'],
      ['criterion', 'add', 'mc/plain', '--criterion', 'x', '--check', 'y', '--evidence', 'z'],
      ['set', 'mc/plain', 'outcome', '--text', 'x'],
    ]) {
      assert.equal(await run(argv, f.deps), 2, `${word}: ${argv.join(' ')}`);
      assert.match(f.err(), new RegExp(`a ${word} session does not`, 'u'), `${word}: ${argv.slice(0, 2).join(' ')}`);
    }
    assert.equal(snapshot(f), before, `${word} wrote nothing`);
  }
});

test('the learning role cannot mutate version 2 goal items or obligations', async () => {
  const git = areasGit({ [CLI_PATH]: DECLARATION('documentation') });
  const others = [inStage('draft'), inStage('draft', 'ready', { [`${DIR}/LOG.md`]: '## 2026-11-01T20:00Z · claude · draft · ready · by learning\n\nDone: created\n' })];
  for (const files of others) {
    for (const argv of [
      ['item', 'add', 'mc/plain', 'decision', '--text', 'x', '--by', 'm', '--on', 'd'], ['item', 'set', 'mc/plain', 'D1', '--text', 'y'], ['item', 'remove', 'mc/plain', 'D1', '--reason', 'x'],
      ['obligation', 'set', 'mc/plain', 'Docs', '--stand', 'touched', '--text', 'x'], ['obligation', 'remove', 'mc/plain', 'Documentation', '--reason', 'x'],
    ]) {
      const g = fixture({ files: { ...files, [`${DIR}/GOAL.json`]: goalJsonV2() }, env: LEARNING, git });
      const before = snapshot(g);
      assert.equal(await run(argv, g.deps), 2, argv.join(' '));
      assert.match(g.err(), /learning role cannot use mc goal/u, argv.join(' '));
      assert.equal(snapshot(g), before, `${argv.join(' ')}: nothing written`);
      assert.deepEqual(showCalls(g), [], `${argv.join(' ')}: no declaration read`);
    }
  }
  // It gains no other verb.
  for (const argv of [['item', 'frobnicate', 'mc/plain'], ['drop', 'mc/plain', '--reason', 'x'], ['convert', 'mc'], ['phase', 'mc/plain', '2']]) {
    const g = fixture({ files: { [`${HOME}/mc/PROGRAMME.json`]: legacyRecord() }, env: LEARNING });
    assert.notEqual(await run(argv, g.deps), 0, argv.join(' '));
  }
});

test('mc goal convert writes a version 2 goal in the legacy stage plan with every part', async () => {
  const f = fixture({ files: V2_FILES(goalJsonV2({ stage: 'plan' })), env: V2_PERSON });
  assert.equal(await run(['convert', 'mc'], f.deps), 0, f.err());
  assert.doesNotMatch(f.out(), /nothing to convert/u, 'a write happened');
  assert.equal(f.store[`${DIR}/GOAL.json`], goalJsonV2({ stage: 'draft' }));
});

test('jevContext gives jev a version 2 goal\'s outcome, decisions, preserve, criteria and what is out of scope; version 1 as before', () => {
  const f = fixture({ files: V2_FILES(), env: V2_PERSON });
  const target = { dir: DIR, programme: 'mc' };
  const context = jevContext(target, parseGoal(f.store[`${DIR}/GOAL.json`]), [], jevCtx(f));
  assert.deepEqual(context.goal, {
    title: 'Make the goal plain',
    outcome: 'Two files and a worktree.\n\nAnd nothing else.',
    decisions: ['D1 Parts are numbered.'],
    preserve: ['V1 Version 1 is as before.'],
    criteria: [{ criterion: 'it works', check: 'a test', met: false }],
    out_of_scope: ['Converting version 1 goals.'],
    stage: 'build', status: 'ready',
  });
  const one = jevContext(target, parseGoal(GOAL_TEXT), [], jevCtx(f));
  assert.deepEqual(Object.keys(one.goal), ['title', 'goal', 'contract', 'out_of_scope', 'criteria', 'stage', 'status']);
});

// ---- Rule areas: `mc goal areas` and what `obligation set` takes (`.mc/areas.json` read from the repository's origin/main) ----

const AREA = (id, extra = {}) => ({ id, name: `The ${id}`, covers: `What ${id} covers.`, standards: [`docs/technical/${id}.md`], paths: [`src/${id}/`, `src/${id}.js`], questions: [{ when: `${id} changes`, ask: `Is ${id} still true?` }], ...extra });
const DECLARATION = (...ids) => JSON.stringify({ schema_version: 1, areas: ids.map((id) => AREA(id)) });
const CLI_PATH = '/home/m/memoro-cli.git';
const APP_PATH = '/home/m/memoro';
const NOT_THERE = "fatal: path '.mc/areas.json' does not exist in 'origin/main'";
/** A git that shows `declarations[cwd]` for `show <rev>:.mc/areas.json` (failing as git does when there is none), and `cat-file -e` for every path but `missing`. */
const areasGit = (declarations, { missing = [], broken = {} } = {}) => (cwd, args = []) => {
  if (args[0] === 'show' && args[1].endsWith(':.mc/areas.json')) {
    if (broken[cwd]) return failed(broken[cwd]);
    return declarations[cwd] === undefined ? failed(NOT_THERE) : ok(declarations[cwd]);
  }
  if (args[0] === 'cat-file') return missing.some((path) => args[2].endsWith(`:${path}`)) ? failed('fatal: not a valid object name') : ok();
  return allOk(cwd, args);
};
const TWO_REPOS = (obligations) => V2_FILES(goalJsonV2({ repos: ['memoro-cli', 'memoro'], obligations }));
const BOTH = { [CLI_PATH]: DECLARATION('documentation', 'operations'), [APP_PATH]: DECLARATION('security', 'documentation') };
const STANDS_OF = [{ area: 'memoro-cli/documentation', stand: 'touched', text: 'The page says it.', standard: 'memoro-cli/docs/technical/mc-goals.md#Rule areas' }, { area: 'memoro/security', stand: 'untouched', text: 'No code.' }, { area: 'Whatever', stand: 'untouched', text: 'An old word.' }];
const showCalls = (f) => f.calls.filter((call) => call.args[0] === 'show');

test('mc goal areas <repo> reads origin/main of the repository mc knows and prints each area with its questions, marking a standard or path not in the revision', async () => {
  const f = fixture({ git: areasGit(BOTH, { missing: ['docs/technical/documentation.md', 'src/documentation.js'] }) });
  assert.equal(await run(['areas', 'memoro-cli'], f.deps), 0, f.err());
  assert.deepEqual(showCalls(f), [{ cwd: CLI_PATH, args: ['show', 'origin/main:.mc/areas.json'] }], 'the arguments and the directory the git received');
  assert.match(f.out(), /^memoro-cli\/documentation — The documentation\n  covers: What documentation covers\.\n  standards: docs\/technical\/documentation\.md \(missing\)\n  paths: src\/documentation\/, src\/documentation\.js \(missing\)\n  questions:\n    when documentation changes\n      ask Is documentation still true\?\n\nmemoro-cli\/operations — /u);
  assert.doesNotMatch(f.out().split('memoro-cli/operations')[1], /missing/u, 'only the entries git does not find');
  assert.deepEqual(f.calls.filter((call) => call.args[0] === 'cat-file').map((call) => call.args.slice(1).join(' ')).slice(0, 2), ['-e origin/main:docs/technical/documentation.md', '-e origin/main:src/documentation/']);

  const at = fixture({ git: areasGit(BOTH) });
  assert.equal(await run(['areas', 'memoro', '--at', 'goal/rule-areas'], at.deps), 0, at.err());
  assert.deepEqual(showCalls(at), [{ cwd: APP_PATH, args: ['show', 'goal/rule-areas:.mc/areas.json'] }], '--at is the revision read');
  assert.match(at.out(), /^memoro\/security — /u);
  assert.ok(at.calls.filter((call) => call.args[0] === 'cat-file').every((call) => call.args[2].startsWith('goal/rule-areas:')), 'the paths are looked up at the same revision');
});

test('mc goal areas <repo> says a repository declares none when git has no file at the revision or shows it empty, and a name that is not a repository is refused with exit 2', async () => {
  for (const git of [areasGit({}), areasGit({ [CLI_PATH]: '' }), areasGit({ [CLI_PATH]: '  \n' }), areasGit({}, { broken: { [CLI_PATH]: "fatal: path '.mc/areas.json' exists on disk, but not in 'origin/main'" } })]) {
    const f = fixture({ git });
    assert.equal(await run(['areas', 'memoro-cli'], f.deps), 0, f.err());
    assert.equal(f.out(), 'memoro-cli declares no rule areas (no .mc/areas.json at origin/main)\n');
  }
  const f = fixture({ git: areasGit(BOTH) });
  assert.equal(await run(['areas', 'nonesuch'], f.deps), 2);
  assert.match(f.err(), /nonesuch is not a repository mc knows — memoro-cli, memoro/u);
  assert.equal(await run(['areas'], f.deps), 2, 'no argument and no MC_GOAL');
  assert.equal(await run(['areas', 'memoro', 'memoro-cli'], f.deps), 2);
  assert.deepEqual(f.calls, [], 'nothing was asked of git');
});

test('mc goal areas never reads a git failure as no declaration, nor a declaration that does not validate: exit 1 with the reason, for a repository and for a goal', async () => {
  for (const [git, reason] of [
    [areasGit({}, { broken: { [CLI_PATH]: "fatal: invalid object name 'origin/main'." } }), /could not read memoro-cli's \.mc\/areas\.json at origin\/main in \/home\/m\/memoro-cli\.git — fatal: invalid object name/u],
    [areasGit({}, { broken: { [CLI_PATH]: 'fatal: not a git repository' } }), /not a git repository/u],
    [areasGit({ [CLI_PATH]: '{ not json' }), /memoro-cli's \.mc\/areas\.json at origin\/main is not JSON/u],
    [areasGit({ [CLI_PATH]: JSON.stringify({ schema_version: 1, areas: [] }) }), /areas must be a non-empty array/u],
  ]) {
    const f = fixture({ git, files: V2_FILES(), env: V2_PERSON });
    assert.equal(await run(['areas', 'memoro-cli'], f.deps), 1);
    assert.match(f.err(), reason);
    assert.equal(f.out(), '');
    const g = fixture({ git, files: V2_FILES(), env: V2_PERSON });
    assert.equal(await run(['areas', 'mc/plain'], g.deps), 1);
    assert.match(g.err(), reason);
    assert.equal(g.out(), '');
  }
});

test('mc goal areas <programme>/<goal> prints each area of the goal\'s repositories with its stand or no stand, the obligations no repository declares, and the count', async () => {
  const f = fixture({ git: areasGit(BOTH), files: TWO_REPOS(STANDS_OF) });
  assert.equal(await run(['areas', 'mc/plain'], f.deps), 0, f.err());
  assert.deepEqual(showCalls(f), [{ cwd: CLI_PATH, args: ['show', 'origin/main:.mc/areas.json'] }, { cwd: APP_PATH, args: ['show', 'origin/main:.mc/areas.json'] }], 'one read per repository, in the goal\'s order');
  const out = f.out();
  const order = ['memoro-cli/documentation', 'memoro-cli/operations', 'memoro/security', 'memoro/documentation'].map((id) => out.indexOf(`${id} — `));
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), `every area once, repositories in order: ${order}`);
  assert.match(out, /memoro-cli\/documentation — The documentation\n  stand: touched — The page says it\. \[memoro-cli\/docs\/technical\/mc-goals\.md#Rule areas\]\n  covers:/u);
  assert.match(out, /memoro-cli\/operations — The operations\n  no stand\n/u);
  assert.match(out, /memoro\/security — The security\n  stand: untouched — No code\.\n/u);
  assert.match(out, /Obligations whose area no repository declares:\n  Whatever — untouched — An old word\.\n/u);
  assert.match(out, /\n2 of 4 areas have a stand\n$/u);

  const all = fixture({ git: areasGit(BOTH), files: TWO_REPOS([...STANDS_OF.slice(0, 2), { area: 'memoro-cli/operations', stand: 'untouched', text: 'x' }, { area: 'memoro/documentation', stand: 'untouched', text: 'y' }]) });
  assert.equal(await run(['areas', 'mc/plain'], all.deps), 0);
  assert.doesNotMatch(all.out(), /no stand|no repository declares/u);
  assert.match(all.out(), /\n4 of 4 areas have a stand\n$/u);

  const some = fixture({ git: areasGit({ [CLI_PATH]: DECLARATION('documentation') }), files: TWO_REPOS(STANDS_OF.slice(0, 1)) });
  assert.equal(await run(['areas', 'mc/plain', '--at', 'goal/x'], some.deps), 0);
  assert.match(some.out(), /memoro declares no rule areas \(no \.mc\/areas\.json at goal\/x\)\n/u, 'a repository that declares none is one line');
  assert.match(some.out(), /\n1 of 1 areas have a stand\n$/u);
  assert.ok(showCalls(some).every((call) => call.args[1] === 'goal/x:.mc/areas.json'));
});

test('mc goal areas refuses a version 1 goal and a name that is no repository with exit 2, and exits 1 for a goal that is missing or does not parse and for a repository of the goal mc does not know', async () => {
  const v1 = fixture({ git: areasGit(BOTH), files: seededGoal() });
  assert.equal(await run(['areas', 'mc/plain'], v1.deps), 2);
  assert.match(v1.err(), /version 1 goal/u);
  assert.equal(await run(['areas', 'mc/none'], v1.deps), 1);
  assert.match(v1.err(), /no goal mc\/none/u);
  const broken = fixture({ git: areasGit(BOTH), files: seededGoal({ [`${DIR}/GOAL.json`]: '{' }) });
  assert.equal(await run(['areas', 'mc/plain'], broken.deps), 1);
  assert.match(broken.err(), /does not parse/u);
  const alien = fixture({ git: areasGit(BOTH), files: V2_FILES(goalJsonV2({ repos: ['memoro-cli', 'elsewhere'] })) });
  assert.equal(await run(['areas', 'mc/plain'], alien.deps), 1);
  assert.match(alien.err(), /elsewhere is not a repository mc knows/u);
  assert.equal(alien.out(), '', 'nothing printed before the refusal');
  const env = fixture({ git: areasGit(BOTH), files: V2_FILES(), env: { MC_GOAL: 'mc/plain' } });
  assert.equal(await run(['areas'], env.deps), 0, env.err());
  assert.match(env.out(), /areas have a stand\n$/u, 'MC_GOAL is the goal when none is named');
  for (const f of [v1, broken, alien, env]) assert.deepEqual(f.calls.filter((call) => !['show', 'cat-file'].includes(call.args[0])), [], 'only reads');
});

test('mc goal areas is let through for desk-prepare and the learning role, for a repository and for a goal, and writes nothing', async () => {
  for (const env of [{ MC_ROLE: 'desk-prepare', MC_TOOL: 'person' }, LEARNING, { ...SESSION, MC_ROLE: BUILD_ROLES.goal }]) {
    for (const argv of [['areas', 'memoro-cli'], ['areas', 'mc/plain']]) {
      const f = fixture({ git: areasGit(BOTH), files: V2_FILES(), env });
      const before = snapshot(f);
      assert.equal(await run(argv, f.deps), 0, `${env.MC_ROLE} ${argv.join(' ')}: ${f.err()}`);
      assert.equal(snapshot(f), before);
    }
  }
});

test('mc goal obligation set takes a declared <repo>/<id> and says which declared areas still have no stand, then that every one has', async () => {
  const f = fixture({ git: areasGit(BOTH), files: TWO_REPOS([]), env: V2_PERSON });
  assert.equal(await run(['obligation', 'set', 'mc/plain', 'memoro-cli/documentation', '--stand', 'touched', '--text', 'The page.'], f.deps), 0, f.err());
  assert.deepEqual(showCalls(f), [{ cwd: CLI_PATH, args: ['show', 'origin/main:.mc/areas.json'] }, { cwd: APP_PATH, args: ['show', 'origin/main:.mc/areas.json'] }]);
  assert.deepEqual(v2At(f).obligations.map((one) => one.area), ['memoro-cli/documentation']);
  assert.match(f.out(), /^mc: mc\/plain · obligation "memoro-cli\/documentation" set\n  no stand yet: memoro-cli\/operations, memoro\/security, memoro\/documentation\n$/u);
  for (const area of ['memoro-cli/operations', 'memoro/security']) assert.equal(await run(['obligation', 'set', 'mc/plain', area, '--stand', 'untouched', '--text', 'Nothing.'], f.deps), 0, f.err());
  const last = fixture({ git: areasGit(BOTH), files: TWO_REPOS(STANDS_OF.slice(0, 2).concat([{ area: 'memoro-cli/operations', stand: 'untouched', text: 'x' }])), env: V2_PERSON });
  assert.equal(await run(['obligation', 'set', 'mc/plain', 'memoro/documentation', '--stand', 'untouched', '--text', 'Nothing.'], last.deps), 0, last.err());
  assert.match(last.out(), /\n  every declared area has a stand\n$/u);
  const again = fixture({ git: areasGit(BOTH), files: TWO_REPOS(STANDS_OF.slice(0, 2)), env: V2_PERSON });
  assert.equal(await run(['obligation', 'set', 'mc/plain', 'memoro/security', '--stand', 'touched', '--text', 'Replaced.'], again.deps), 0, again.err());
  assert.match(again.out(), /obligation "memoro\/security" replaced\n  no stand yet: memoro-cli\/operations, memoro\/documentation\n$/u);
});

test('mc goal obligation set refuses an area no repository of the goal declares with exit 2, writes nothing and lists the declared areas', async () => {
  for (const area of ['Security', 'security', 'memoro/nonesuch', 'memoro-cli/security', 'elsewhere/documentation', 'memoro/', '/documentation']) {
    const f = fixture({ git: areasGit(BOTH), files: TWO_REPOS(STANDS_OF), env: V2_PERSON });
    const before = snapshot(f);
    assert.equal(await run(['obligation', 'set', 'mc/plain', area, '--stand', 'touched', '--text', 'x'], f.deps), 2, area);
    assert.match(f.err(), new RegExp(`"${area.replace('/', '\\/')}" is not a rule area of the goal's repositories — an area is <repo>/<id>\\n  memoro-cli: memoro-cli/documentation, memoro-cli/operations\\n  memoro: memoro/security, memoro/documentation`, 'u'), area);
    assert.equal(snapshot(f), before, `${area}: nothing written`);
    assert.equal(f.out(), '');
  }
});

test('mc goal obligation set takes any word where no repository of the goal declares areas, and <repo>/… for a repository of the goal that declares none', async () => {
  const none = fixture({ git: areasGit({}), files: V2_FILES(), env: V2_PERSON });
  assert.equal(await run(['obligation', 'set', 'mc/plain', 'Security', '--stand', 'untouched', '--text', 'No data.'], none.deps), 0, none.err());
  assert.equal(await run(['obligation', 'set', 'mc/plain', 'memoro-cli/security', '--stand', 'untouched', '--text', 'No data.'], none.deps), 0, none.err());
  assert.doesNotMatch(none.out(), /no stand yet|every declared/u, 'nothing is said where nothing is declared');
  const half = fixture({ git: areasGit({ [CLI_PATH]: DECLARATION('documentation') }), files: TWO_REPOS([]), env: V2_PERSON });
  assert.equal(await run(['obligation', 'set', 'mc/plain', 'memoro/anything', '--stand', 'untouched', '--text', 'x'], half.deps), 0, half.err());
  assert.match(half.out(), /\n  no stand yet: memoro-cli\/documentation\n$/u);
  assert.equal(await run(['obligation', 'set', 'mc/plain', 'Anything', '--stand', 'untouched', '--text', 'x'], half.deps), 2, 'a bare word is refused once any repository declares areas');
  assert.match(half.err(), /memoro: declares none, any <memoro\/…> is taken/u);
});

test('mc goal obligation set exits 1 and writes nothing on a git failure, on a declaration that does not validate and on a repository of the goal that mc does not know', async () => {
  for (const [git, files, reason] of [
    [areasGit({}, { broken: { [APP_PATH]: "fatal: invalid object name 'origin/main'." } }), TWO_REPOS([]), /could not read memoro's \.mc\/areas\.json at origin\/main.*invalid object name/u],
    [areasGit({ [CLI_PATH]: JSON.stringify({ schema_version: 1, areas: [{ ...AREA('x'), extra: 1 }] }) }), TWO_REPOS([]), /memoro-cli's \.mc\/areas\.json at origin\/main: areas\[0\]\.extra is an unknown key/u],
    [areasGit(BOTH), V2_FILES(goalJsonV2({ repos: ['memoro-cli', 'elsewhere'] })), /elsewhere is not a repository mc knows/u],
  ]) {
    const f = fixture({ git, files, env: V2_PERSON });
    const before = snapshot(f);
    assert.equal(await run(['obligation', 'set', 'mc/plain', 'memoro-cli/documentation', '--stand', 'touched', '--text', 'x'], f.deps), 1);
    assert.match(f.err(), reason);
    assert.equal(snapshot(f), before, 'nothing written');
  }
});

test('obligation set stays refused for a build, review and mend session and for the learning role, before any declaration is read; obligation remove is unchanged', async () => {
  for (const env of [{ ...SESSION, MC_ROLE: BUILD_ROLES.goal }, { ...SESSION, MC_ROLE: REVIEW_ROLE, MC_REVIEW_HEAD: 'abc1234def' }, { ...SESSION, MC_ROLE: MEND_ROLE }, LEARNING]) {
    const f = fixture({ git: areasGit(BOTH), files: TWO_REPOS([]), env });
    const before = snapshot(f);
    assert.equal(await run(['obligation', 'set', 'mc/plain', 'memoro/security', '--stand', 'touched', '--text', 'x'], f.deps), 2, env.MC_ROLE);
    assert.equal(snapshot(f), before);
    assert.deepEqual(showCalls(f), [], 'no declaration read');
  }
  const f = fixture({ git: areasGit(BOTH), files: TWO_REPOS(STANDS_OF), env: V2_PERSON });
  assert.equal(await run(['obligation', 'remove', 'mc/plain', 'Whatever', '--reason', 'old'], f.deps), 0, f.err());
  assert.deepEqual(showCalls(f), [], 'remove reads no declaration');
  assert.equal(f.out(), 'mc: mc/plain · obligation "Whatever" removed\n');
});

// ---- Source areas: an area with no question asks no stand, and an area may name its page ----

const SOURCE_AREA = (id, extra = {}) => AREA(id, { standards: [], questions: [], page: `docs/areas/${id}.md`, ...extra });
const SOURCE_DECLARATION = (...areas) => JSON.stringify({ schema_version: 1, areas });
const PAGED_DECL = SOURCE_DECLARATION(AREA('documentation', { page: 'docs/areas/documentation.md' }), SOURCE_AREA('games'));
const SOURCES_ONLY = SOURCE_DECLARATION(SOURCE_AREA('games'));
const stand = (area, kind = 'untouched', text = 'x') => ({ area, stand: kind, text });

test('mc goal areas <repo> shows a rule area\'s page and questions, and a source area as a source that asks no stand with its page marked (missing) and no questions', async () => {
  const f = fixture({ git: areasGit({ [CLI_PATH]: PAGED_DECL }, { missing: ['docs/areas/games.md'] }) });
  assert.equal(await run(['areas', 'memoro-cli'], f.deps), 0, f.err());
  const [rule, source] = f.out().split('\n\n');
  assert.match(rule, /^memoro-cli\/documentation — The documentation\n  covers: What documentation covers\.\n  page: docs\/areas\/documentation\.md\n  standards: docs\/technical\/documentation\.md\n  paths: .*\n  questions:\n    when documentation changes\n      ask Is documentation still true\?$/u);
  assert.match(source, /^memoro-cli\/games — The games\n  source area: it asks no stand of a goal\n  covers: What games covers\.\n  page: docs\/areas\/games\.md \(missing\)\n  standards: none\n/u);
  assert.doesNotMatch(source, /questions|when |ask /u);
});

test('mc goal obligation set refuses a source area with exit 2 and nothing written, naming its page; the closing line and the refusal list count rule areas alone', async () => {
  const f = fixture({ git: areasGit({ [CLI_PATH]: PAGED_DECL }), files: V2_FILES(), env: V2_PERSON });
  const before = snapshot(f);
  assert.equal(await run(['obligation', 'set', 'mc/plain', 'memoro-cli/games', '--stand', 'untouched', '--text', 'x'], f.deps), 2);
  assert.match(f.err(), /memoro-cli\/games" is a source area that asks no stand — read its page docs\/areas\/games\.md/u);
  assert.equal(snapshot(f), before, 'nothing written');
  assert.equal(f.out(), '');
  assert.equal(await run(['obligation', 'set', 'mc/plain', 'Elsewhere', '--stand', 'untouched', '--text', 'x'], f.deps), 2);
  assert.match(f.err(), /memoro-cli: memoro-cli\/documentation\n/u);
  assert.doesNotMatch(f.err(), /memoro-cli\/documentation, memoro-cli\/games/u, 'the list names rule areas alone');
  assert.equal(await run(['obligation', 'set', 'mc/plain', 'memoro-cli/documentation', '--stand', 'untouched', '--text', 'x'], f.deps), 0, f.err());
  assert.match(f.out(), /\n  every declared area has a stand\n$/u, 'the source area is not one that lacks a stand');
});

test('mc goal obligation set on a repository that declares source areas alone takes any other word without a closing line, and refuses the source area\'s id', async () => {
  const f = fixture({ git: areasGit({ [CLI_PATH]: SOURCES_ONLY }), files: V2_FILES(), env: V2_PERSON });
  assert.equal(await run(['obligation', 'set', 'mc/plain', 'memoro-cli/anything', '--stand', 'untouched', '--text', 'x'], f.deps), 0, f.err());
  assert.doesNotMatch(f.out(), /no stand yet|every declared/u, 'no closing line where no repository declares a rule area');
  assert.equal(await run(['obligation', 'set', 'mc/plain', 'Anything', '--stand', 'untouched', '--text', 'x'], f.deps), 0, f.err());
  const before = snapshot(f);
  assert.equal(await run(['obligation', 'set', 'mc/plain', 'memoro-cli/games', '--stand', 'untouched', '--text', 'x'], f.deps), 2);
  assert.match(f.err(), /is a source area that asks no stand/u);
  assert.equal(snapshot(f), before);
});

test('mc goal areas <programme>/<goal> shows a source area with neither no stand nor a proposed stand, shows a stand the goal already holds on one, and counts rule areas alone', async () => {
  const bare = fixture({ git: areasGit({ [CLI_PATH]: PAGED_DECL }), files: V2_FILES() });
  assert.equal(await run(['areas', 'mc/plain'], bare.deps), 0, bare.err());
  const games = bare.out().split('\n\n').find((block) => block.startsWith('memoro-cli/games'));
  assert.doesNotMatch(games, /^  no stand$|proposed/mu);
  assert.match(bare.out(), /memoro-cli\/documentation — The documentation\n  no stand\n/u);
  assert.match(bare.out(), /\n0 of 1 areas have a stand\n$/u);
  const held = fixture({ git: areasGit({ [CLI_PATH]: PAGED_DECL }), files: V2_FILES(goalJsonV2({ obligations: [stand('memoro-cli/games', 'untouched', 'An older stand.'), stand('memoro-cli/documentation')] })) });
  assert.equal(await run(['areas', 'mc/plain'], held.deps), 0, held.err());
  assert.match(held.out().split('\n\n').find((block) => block.startsWith('memoro-cli/games')), /^memoro-cli\/games — The games\n  source area: it asks no stand of a goal\n  stand: untouched — An older stand\.\n/u);
  assert.doesNotMatch(held.out(), /Obligations whose area no repository declares/u);
  assert.match(held.out(), /\n1 of 1 areas have a stand\n$/u, 'the stand on the source area is not counted');
});

test('a goal without a stand on a declared source area is moved out of draft, and one whose source area\'s page is not on main is refused with exit 1 and nothing written', async () => {
  const text = DRAFT_V2({ obligations: [{ area: 'memoro-cli/documentation', stand: 'touched', text: 'The page says it.', standard: 'memoro-cli/docs/technical/mc-goals.md#Rule areas' }] });
  const declared = { [CLI_PATH]: PAGED_DECL };
  const moved = gateFixture({ text, git: areasGit(declared) });
  assert.equal(await run(['stage', 'mc/plain', 'build'], moved.deps), 0, moved.err());
  for (const page of ['docs/areas/games.md', 'docs/areas/documentation.md']) {
    const f = gateFixture({ text, git: areasGit(declared, { missing: [page] }) });
    const before = filesOf(f);
    assert.equal(await run(['stage', 'mc/plain', 'build'], f.deps), 1, page);
    assert.match(f.err(), new RegExp(`${page.replace(/[./]/gu, '\\$&')}.*origin/main of memoro-cli`, 'u'));
    assert.deepEqual(filesOf(f), before, 'nothing written');
  }
});

// ---- The plan review's gate: a goal leaves draft only when it is complete and has been read (D3, D5, D6) ----

const READ = (goalText, ...verdicts) => JSON.stringify({
  records: verdicts.map((verdict, i) => ({ kind: 'reading', verdict, hash: goalHash(parseGoal(goalText)), round: i + 1, tool: 'codex', model: 'gpt-5', at: '2026-11-01T19:00:00.000Z' })),
});
/** Version 2 goal in draft that is complete: standards on main, an area with a stand, an outcome, a change, a criterion. */
const DRAFT_V2 = (fields = {}) => goalJsonV2({
  stage: 'draft', repos: ['memoro-cli'],
  obligations: [{ area: 'memoro-cli/documentation', stand: 'touched', text: 'The page says it.', standard: 'memoro-cli/docs/technical/mc-goals.md#Rule areas' }, { area: 'memoro-cli/operations', stand: 'untouched', text: 'Nothing deploys.' }],
  change: [{ id: 'C1', where: 'src/documentation/page.js', what: 'Say it.' }],
  ...fields,
});
const CLI_ONLY = { [CLI_PATH]: DECLARATION('documentation', 'operations') };
const READ_FILES = (text) => V2_FILES(text);
const gateFixture = ({ text = DRAFT_V2(), env = {}, git = areasGit(CLI_ONLY), known = KNOWN } = {}) => {
  const f = fixture({ files: READ_FILES(text), env, git, known });
  f.deps.remove = () => {};
  f.deps.lock = (_root, fn) => fn();
  return f;
};
const filesOf = (f) => [f.store[`${DIR}/GOAL.json`], f.store[`${DIR}/LOG.md`]];

test('a version 2 goal is refused out of draft for each lack the parts check names, exit 1, the goal file and LOG.md byte-identical', async () => {
  const goodGit = areasGit(CLI_ONLY);
  const cases = [
    ['an empty outcome', { text: DRAFT_V2({ outcome: [] }) }, /the outcome is empty/u],
    ['no change item', { text: DRAFT_V2({ change: [] }) }, /there is no change item/u],
    ['no criterion', { text: DRAFT_V2({ success_criteria: [] }) }, /there is no criterion/u],
    ['a declared area without a stand', { text: DRAFT_V2({ obligations: [] }) }, /memoro-cli\/documentation/u],
    ['a standard path that is not on main', { git: areasGit(CLI_ONLY, { missing: ['docs/technical/mc-goals.md'] }) }, /docs\/technical\/mc-goals\.md/u],
    ['a standard path git cannot be asked about', { git: (cwd, args = []) => (args[0] === 'cat-file' ? failed('fatal: unable to access') : goodGit(cwd, args)) }, /git gave no answer/u],
    ['a repository mc does not know', { known: ['/home/m/memoro'] }, /memoro-cli is not a repository mc knows/u],
    ['a declarations read that fails', { git: areasGit(CLI_ONLY, { broken: { [CLI_PATH]: 'fatal: bad object' } }) }, /could not read memoro-cli's \.mc\/areas\.json/u],
  ];
  for (const [why, options, pattern] of cases) {
    const f = gateFixture(options);
    const before = filesOf(f);
    assert.equal(await run(['stage', 'mc/plain', 'build'], f.deps), 1, why);
    assert.match(f.err(), pattern, why);
    assert.deepEqual(filesOf(f), before, `${why}: nothing written`);
  }
});

test('several lacks are one refusal, in the order of the parts; the same through log --stage build and the plan role\'s stage review', async () => {
  const text = DRAFT_V2({ outcome: [], change: [], success_criteria: [] });
  const f = gateFixture({ text });
  assert.equal(await run(['stage', 'mc/plain', 'build'], f.deps), 1);
  const lines = f.err().trim().split('\n');
  assert.match(lines[0], /3 things to repair/u);
  assert.deepEqual(lines.slice(1).map((line) => line.replace(/^ {2}- /u, '').split(' — ')[0]), ['the outcome is empty', 'there is no change item', 'there is no criterion']);
  assert.equal(f.err().match(/is not moved to/gu).length, 1, 'one refusal');

  const log = gateFixture({ text });
  const before = filesOf(log);
  assert.equal(await run(['log', 'mc/plain', '--comment', 'ready', '--stage', 'build'], log.deps), 1);
  assert.match(log.err(), /3 things to repair/u);
  assert.deepEqual(filesOf(log), before);

  const plan = gateFixture({ text, env: PLAN });
  assert.equal(await run(['stage', 'mc/plain', 'review'], plan.deps), 1, 'a move to review is held too');
  assert.match(plan.err(), /3 things to repair/u);
  assert.equal(stateOf(plan), 'draft · ready');
});

test('draft → dropped is not checked; a build session still gets refusedMove\'s exit 2; a version 1 goal is asked for neither parts nor a reading', async () => {
  const dropped = dropFixture(gateFixture({ text: DRAFT_V2({ outcome: [], change: [], success_criteria: [] }), env: PLAN }));
  assert.equal(await run(['stage', 'mc/plain', 'dropped'], dropped.deps), 0, dropped.err());
  assert.deepEqual(dropped.calls.filter((call) => ['show', 'cat-file'].includes(call.args[0])), [], 'no question was asked');

  const build = gateFixture({ env: BUILD });
  assert.equal(await run(['stage', 'mc/plain', 'build'], build.deps), 2);
  assert.match(build.err(), /build session/u);

  const v1Text = withGoal(GOAL_TEXT, { stage: 'draft', success_criteria: [] });
  const bare = fixture({ files: seededGoal({ [`${DIR}/GOAL.json`]: v1Text }) });
  assert.equal(await run(['stage', 'mc/plain', 'build'], bare.deps), 0, bare.err());
  assert.deepEqual(bare.calls.filter((call) => ['show', 'cat-file'].includes(call.args[0])), [], 'a version 1 goal is asked nothing of the repositories');
});

test('no reading is asked for: a complete goal moves to build, and the move remakes the branch', async () => {
  const f = gateFixture();
  assert.equal(await run(['stage', 'mc/plain', 'build'], f.deps), 0, f.err());
  assert.equal(stateOf(f), 'build · ready');
  const read = gateFixture({ git: (cwd, args = []) => (args[0] === 'rev-list' ? ok('0\n') : areasGit(CLI_ONLY)(cwd, args)) });
  assert.equal(await run(['stage', 'mc/plain', 'build'], read.deps), 0, read.err());
  assert.equal(stateOf(read), 'build · ready');
  assert.ok(read.calls.some((call) => call.args[0] === 'fetch'), 'remakeBranches ran on entering build');
});

test('an edit of the text does not hold the move; neither do a criterion mark, the phase, a hold and its release', async () => {
  const edits = [
    ['set', 'mc/plain', 'aim', '--text', 'Another aim.'],
    ['item', 'add', 'mc/plain', 'risk', '--text', 'A new risk.', '--settled-by', 'criterion 1'],
    ['item', 'set', 'mc/plain', 'C1', '--text', 'Say it differently.'],
    ['item', 'remove', 'mc/plain', 'V1', '--reason', 'not needed'],
    ['obligation', 'set', 'mc/plain', 'memoro-cli/operations', '--stand', 'untouched', '--text', 'Still nothing.'],
    ['criterion', 'add', 'mc/plain', '--criterion', 'More', '--check', 'mc gate x'],
    ['criterion', 'set', 'mc/plain', '1', '--check', 'mc gate y'],
  ];
  for (const argv of edits) {
    const f = gateFixture();
    assert.equal(await run(argv, f.deps), 0, `${argv.join(' ')}: ${f.err()}`);
    assert.equal(await run(['stage', 'mc/plain', 'build'], f.deps), 0, `${argv.join(' ')}: ${f.err()}`);
  }
  for (const argv of [['set', 'mc/plain', 'goal', '--text', 'Other.'], ['set', 'mc/plain', 'contract', '--text', 'Other.']]) {
    const text = withGoal(GOAL_TEXT, { stage: 'draft' });
    const f = fixture({ files: seededGoal({ [`${DIR}/GOAL.json`]: text }) });
    assert.equal(await run(argv, f.deps), 0, f.err());
    assert.equal(await run(['stage', 'mc/plain', 'build'], f.deps), 0, `version 1 ${argv[2]}: ${f.err()}`);
  }
  const kept = gateFixture();
  for (const argv of [['criterion', 'met', 'mc/plain', '1'], ['criterion', 'unmet', 'mc/plain', '1'], ['phase', 'mc/plain', '1'], ['hold', 'mc/plain', '--reason', 'looking'], ['release', 'mc/plain']]) {
    assert.equal(await run(argv, kept.deps), 0, `${argv.join(' ')}: ${kept.err()}`);
  }
  assert.equal(await run(['stage', 'mc/plain', 'build'], kept.deps), 0, kept.err());
});

test('a person\'s move back to draft moves the stage; a goal in build is not asked', async () => {
  const text = withGoal(GOAL_TEXT, { stage: 'build' });
  const f = fixture({ files: seededGoal({ [`${DIR}/GOAL.json`]: text }) });
  assert.equal(await run(['stage', 'mc/plain', 'draft'], f.deps), 0, f.err());
  assert.equal(stateOf(f), 'draft · ready');
  assert.equal(await run(['stage', 'mc/plain', 'build'], f.deps), 0, f.err());

  const building = fixture({ files: seededGoal({ [`${DIR}/GOAL.json`]: withGoal(GOAL_TEXT, { stage: 'build', success_criteria: MET }) }), env: PLAN });
  assert.equal(await run(['stage', 'mc/plain', 'review'], building.deps), 0, building.err());
});

test('mc goal areas proposes a stand for each area without one', async () => {
  const f = fixture({ files: V2_FILES(DRAFT_V2({ obligations: [] })), git: areasGit(CLI_ONLY) });
  assert.equal(await run(['areas', 'mc/plain'], f.deps), 0, f.err());
  assert.match(f.out(), /memoro-cli\/documentation — The documentation\n  no stand\n  proposed stand: touched — C1 changes a path of the area \(advisory\)\n/u);
  assert.match(f.out(), /memoro-cli\/operations — The operations\n  no stand\n  proposed stand: untouched — no change item names a path of the area \(advisory\)\n/u);
});

/* ------------------------------ phases stated in the programme's record */

const STATED_RECORD = { schema: 'mc-programme', version: 1, horizon: null, end: 'Done when it holds.', state: 'open', created: '2026-11-14T10:20:30Z', created_by: 'person' };
const PROG_RECORD_PATH = `${HOME}/prog/PROGRAMME.json`;
const statedRecord = (after) => `${JSON.stringify({ ...STATED_RECORD, phases: after === undefined ? { order: 'stated' } : { order: 'stated', after } }, null, 2)}\n`;
const plainRecord = () => `${JSON.stringify(STATED_RECORD, null, 2)}\n`;
/** A goal of programme `prog` in `stage` and `phase`. */
const progGoal = (name, stage, phase) => ({
  [`${HOME}/prog/goals/${name}/GOAL.json`]: withGoal(GOAL_TEXT, { stage, phase }),
  [`${HOME}/prog/goals/${name}/LOG.md`]: '',
});
const progRecordOf = (f) => JSON.parse(f.store[PROG_RECORD_PATH]);
const phaseLines = (text) => text.trim().split('\n').filter((line) => !line.startsWith(' ')).map((line) => line.split(' · ').slice(0, 5).join(' · '));

/** The arrangement of criterion 5: phases 1 and 2 in build, 3 in build after 1 and 2, 4 done, 5 in build after 4. */
const arranged = (record = statedRecord({ 3: [1, 2], 5: [4] })) => fixture({
  files: { ...progGoal('one', 'build', 1), ...progGoal('two', 'build', 2), ...progGoal('three', 'build', 3), ...progGoal('four', 'done', 4), ...progGoal('five', 'build', 5), [PROG_RECORD_PATH]: record },
});

test('mc goal list says what a stated phase waits for, in the words of the stated rule', async () => {
  const f = arranged();
  assert.equal(await run(['list', 'prog'], f.deps), 0, f.err());
  assert.deepEqual(phaseLines(f.out()), [
    'prog · phase 1 · in progress',
    'prog · phase 2 · in progress',
    'prog · phase 3 · waiting · after phase 1, 2',
    'prog · phase 4 · done',
    'prog · phase 5 · in progress · after phase 4',
  ]);
});

test('mc goal list of a programme whose record is not JSON says the record is invalid and every unfinished phase waits', async () => {
  const f = arranged('{ not json');
  assert.equal(await run(['list', 'prog'], f.deps), 0, f.err());
  const lines = f.out().trim().split('\n');
  assert.equal(lines[0], 'prog · record invalid — no phase is open');
  assert.deepEqual(phaseLines(f.out()).slice(1), [
    'prog · phase 1 · waiting',
    'prog · phase 2 · waiting',
    'prog · phase 3 · waiting',
    'prog · phase 4 · done',
    'prog · phase 5 · waiting',
  ]);
});

test('mc goal list of a programme with no record, or a record without phases, says in progress and after phase 1, never waiting', async () => {
  for (const [kind, extra] of [['no record', {}], ['a record without phases', { [PROG_RECORD_PATH]: plainRecord() }]]) {
    const f = fixture({ files: { ...progGoal('one', 'build', 1), ...progGoal('two', 'build', 2), ...extra } });
    assert.equal(await run(['list', 'prog'], f.deps), 0, f.err());
    assert.deepEqual(phaseLines(f.out()), ['prog · phase 1 · in progress', 'prog · phase 2 · after phase 1'], kind);
    assert.doesNotMatch(f.out(), /waiting/u, kind);
  }
});

test('mc goal phase of the only goal of a phase another phase waits for is refused, and nothing is written', async () => {
  const files = { ...progGoal('one', 'build', 1), ...progGoal('two', 'build', 2), ...progGoal('three', 'build', 3), [PROG_RECORD_PATH]: statedRecord({ 3: [2] }) };
  const f = fixture({ files });
  const before = JSON.stringify(f.store);
  assert.equal(await run(['phase', 'prog/two', '1'], f.deps), 2);
  assert.match(f.err(), /phase 3/u);
  assert.match(f.err(), /mc programs after prog 3/u);
  assert.equal(JSON.stringify(f.store), before, 'every goal, log and the record are as they were');
  // once phase 3 no longer waits for phase 2 the same move goes through
  f.store[PROG_RECORD_PATH] = statedRecord({ 3: [1] });
  assert.equal(await run(['phase', 'prog/two', '1'], f.deps), 0, f.err());
  const phases = Object.fromEntries(['one', 'two', 'three'].map((name) => [name, parseGoal(f.store[`${HOME}/prog/goals/${name}/GOAL.json`]).phase]));
  assert.deepEqual(phases, { one: 1, two: 1, three: 2 });
  assert.deepEqual(progRecordOf(f).phases, { order: 'stated', after: { 2: [1] } });
});

test('mc goal phase that empties a phase says in one line what it no longer waits for, and a goal later made in that number is open', async () => {
  const f = fixture({ files: { ...progGoal('one', 'build', 1), ...progGoal('two', 'build', 2), ...progGoal('three', 'build', 3), [PROG_RECORD_PATH]: statedRecord({ 3: [1] }) } });
  assert.equal(await run(['phase', 'prog/three', '2'], f.deps), 0, f.err());
  assert.equal(Object.hasOwn(progRecordOf(f).phases.after ?? {}, '3'), false);
  assert.equal(f.out().split('\n').filter((line) => /no longer waits/u.test(line)).length, 1);
  assert.match(f.out(), /phase 3 no longer waits for phase 1/u);
  assert.equal(await run(newArgs('prog/fresh', '--phase', '3'), f.deps), 0, f.err());
  const goals = programsGoals({ home: HOME, list: f.deps.list, read: f.deps.read });
  const fresh = goals.find((goal) => goal.goal === 'fresh');
  assert.equal(fresh.phase, 3);
  assert.equal(phaseOpen(fresh, goals.filter((goal) => goal.programme === 'prog'), programmeOrder('prog', { home: HOME, read: f.deps.read })), true, 'no old dependency stays on the freed number');
});

/* ------------------------------ one repair goal in flight per area (D8) */

const AREA_RECORD = `${JSON.stringify({ ...STATED_RECORD, area: 'memoro-cli/operations' }, null, 2)}\n`;
const newInProg = (name) => ['new', `prog/${name}`, '--repo', 'memoro', '--class', 'fast', '--title', 'T'];

test('several live goals in an area repair programme: mc goal new makes a second goal while the first is in each live stage, exit 0', async () => {
  for (const stage of ['draft', 'build', 'review', 'merge']) {
    const f = fixture({ files: { ...progGoal('first', stage, 1), [PROG_RECORD_PATH]: AREA_RECORD } });
    assert.equal(await run(newInProg('second'), f.deps), 0, `${stage}: ${f.err()}`);
    assert.ok(f.store[`${HOME}/prog/goals/second/GOAL.json`], stage);
    assert.ok(f.store[`${HOME}/prog/goals/first/GOAL.json`], `${stage}: the first goal is left as it was`);
  }
});

test('one way to ask: mc goal martin is gone — exit 2, the mc ask call to make, no --kind and no value, nothing read or written', async () => {
  const secret = 'sk-live-SECRETVALUE123';
  const f = fixture({ files: inStage('build'), env: BUILD, keys: KEYS });
  const before = structuredClone(f.store);
  f.deps.readKeys = () => assert.fail('the retired verb read a keys source');
  const argv = ['martin', 'mc/plain', '--kind', 'product', '--reason', `q ${secret}`, '--option', `a: ${secret}`, '--option', 'b: B', '--recommend', 'a', '--evidence', secret];
  assert.equal(await run(argv, f.deps), 2);
  assert.equal(f.err(), 'mc: mc goal martin is gone — ask with: mc ask mc/plain --reason "<the question>" --option "<key>: <text>" --option "<key>: <text>" --recommend <key>\n');
  assert.doesNotMatch(f.err(), /--kind|SECRETVALUE/u);
  const odd = fixture({ files: inStage('build'), env: BUILD, keys: KEYS });
  assert.equal(await run(['martin', secret, '--reason', 'r'], odd.deps), 2);
  assert.match(odd.err(), /mc ask <p>\/<g> --reason/u, 'a value that is not a goal id is not echoed');
  assert.doesNotMatch(odd.err(), /SECRETVALUE/u);
  assert.deepEqual(f.store, before, 'no goal file, LOG.md or ledger line');
  assert.deepEqual([f.calls, f.requests, f.ledger()], [[], [], []]);
  assert.equal(stateOf(f), 'build · ready');
});

test('one way to ask: mc goal martin names --reserved when it was given, by flag name only, in every role', async () => {
  for (const env of [{}, PLAN, BUILD, REVIEW, { ...SESSION, MC_ROLE: 'martin', MC_HEADLESS: '1' }, { MC_ROLE: 'desk-prepare', MC_TOOL: 'person' }]) {
    const f = fixture({ files: inStage('build'), env });
    assert.equal(await run(['martin', '--kind', 'technical', '--reserved', 'deploy', '--reason', 'r'], f.deps), 2, env.MC_ROLE || 'person');
    assert.match(f.err(), /gone — ask with: mc ask <p>\/<g> .* --recommend <key> --reserved <act>\n$/u);
    assert.doesNotMatch(f.err(), /--kind|deploy/u);
    assert.equal(f.store[`${DIR}/LOG.md`], LOG_TEXT);
  }
});

test('one way to ask: the guard — mc goal in the ask-reader role allows show, list and areas, and no verb that writes', async () => {
  const env = { MC_ROLE: 'ask-reader', MC_HEADLESS: '1', MC_TOOL: 'claude', MC_GOAL: 'mc/plain' };
  for (const argv of [['stage', 'build'], ['ready'], ['log', '--done', 'x'], ['criterion', 'met', '1'], ['set', 'title', '--text', 'x'], ['drop', '--reason', 'x'], ['defect', '--part', 'p', '--found', 'f']]) {
    const f = fixture({ files: inStage('review'), env });
    const before = structuredClone(f.store);
    assert.equal(await run(argv, f.deps), 2, argv.join(' '));
    assert.match(f.err(), /ask-reader/u);
    assert.deepEqual(f.store, before);
  }
  for (const argv of [['show', 'mc/plain'], ['list', 'mc'], ['areas', 'mc/plain']]) {
    const f = fixture({ files: inStage('review'), env });
    await run(argv, f.deps);
    assert.doesNotMatch(f.err(), /ask-reader/u, `${argv.join(' ')} is not refused to the role`);
  }
});


test('programme-review is a reader: every goal mutation, including goal-less creation, is refused before effects', async () => {
  for (const argv of [['new', 'mc/new', '--repo', 'memoro-cli', '--class', 'fast', '--title', 'Do not create'], ['set', 'mc/plain', 'title', '--text', 'Do not rewrite'], ['stage', 'mc/plain', 'build'], ['log', '--done', 'Do not log']]) {
    const f = fixture({ env: { MC_ROLE: 'programme-review', MC_PROGRAMME: 'mc', MC_HEADLESS: '1' } });
    const before = { ...f.store };
    assert.equal(await run(argv, f.deps), 2, argv.join(' '));
    assert.match(f.err(), /programme-review session reads and writes only PROGRAMME-REVIEW.md/u);
    assert.deepEqual(f.store, before);
    assert.deepEqual(f.calls, []);
  }
});

// These command-store cases prove the new refusal precedes Git and every write.
const legacyRecord = () => JSON.stringify({ schema: 'mc-programme', version: 1, horizon: null, end: 'Done.', state: 'open', created: '2026-11-01T20:00:00Z', created_by: 'person' });
const unsignedRecord = (state) => ({ ...JSON.parse(legacyRecord()), version: 2, state, signed_at: null, signed_by: null, signed_text: null, cut_text: null });
const newArgv = ['new', 'mc/fresh', '--repo', 'memoro-cli', '--class', 'fast', '--title', 'A signed part'];

test('goal new refuses draft programmes before any fetch or goal write', async () => {
  for (const state of ['draft']) {
    for (const env of [{}, { MC_ROLE: 'plan', MC_HEADLESS: '1', MC_PROGRAMME: 'mc' }]) {
      const f = fixture({ files: { [`${HOME}/mc/PROGRAMME.json`]: JSON.stringify(unsignedRecord(state)) }, env });
      const before = { ...f.store };
      assert.equal(await run(newArgv, f.deps), 1, state);
      assert.equal(f.err(), 'mc: mc is draft — mc programs show mc\n');
      assert.deepEqual(f.store, before);
      assert.deepEqual(f.calls, []);
    }
  }
});

test('a goal moves to build whether or not it is cut from a part of a signed programme', async () => {
  const signed = JSON.stringify({ ...unsignedRecord('open'), signed_at: '2026-11-16T08:00:00Z', signed_by: 'martin', signed_text: 'a'.repeat(64) });
  const part = DRAFT_V2({ documents: [{ label: 'Part 1', path: `${HOME}/mc/SIGNED.md` }] });
  const cut = gateFixture({ text: part });
  cut.store[`${HOME}/mc/PROGRAMME.json`] = signed;
  let woke = 0;
  cut.deps.wake = () => { woke += 1; };
  assert.equal(await run(['stage', 'mc/plain', 'build'], cut.deps), 0, cut.err());
  assert.equal(woke, 1, 'the stage move wakes the runner\'s idle lanes');
  assert.equal(parseGoal(cut.store[`${DIR}/GOAL.json`]).stage, 'build');

  const unsigned = gateFixture({ text: part });
  unsigned.store[`${HOME}/mc/PROGRAMME.json`] = JSON.stringify(unsignedRecord('open'));
  assert.equal(await run(['stage', 'mc/plain', 'build'], unsigned.deps), 0, unsigned.err());

  const noPart = gateFixture();
  noPart.store[`${HOME}/mc/PROGRAMME.json`] = signed;
  assert.equal(await run(['stage', 'mc/plain', 'build'], noPart.deps), 0, noPart.err());
});

test('goal new refuses headless recordless creation but admits signed, legacy, area and interactive recordless paths', async () => {
  const denied = fixture({ env: { MC_ROLE: 'plan', MC_HEADLESS: '1', MC_PROGRAMME: 'mc' } });
  const before = { ...denied.store };
  assert.equal(await run(newArgv, denied.deps), 1);
  assert.equal(denied.err(), 'mc: mc has no record — a goal here is made at the desk\n');
  assert.deepEqual(denied.store, before);
  assert.deepEqual(denied.calls, []);
  const signature = { signed_at: '2026-11-01T20:00:00Z', signed_by: 'martin', signed_text: 'a'.repeat(64) };
  for (const record of [legacyRecord(), JSON.stringify({ ...unsignedRecord('open'), ...signature }), JSON.stringify({ ...unsignedRecord('open'), area: 'memoro-cli/operations' })]) {
    const f = fixture({ env: { MC_ROLE: 'plan', MC_HEADLESS: '1', MC_PROGRAMME: 'mc' }, files: { [`${HOME}/mc/PROGRAMME.json`]: record } });
    assert.equal(await run(newArgv, f.deps), 0, f.err());
    assert.equal(parseGoal(f.store[`${HOME}/mc/goals/fresh/GOAL.json`]).stage, 'draft');
    assert.ok(f.calls.some(({ args }) => args[0] === 'fetch'));
    assert.equal(f.store[`${HOME}/mc/PROGRAMME.json`], record, 'admission is not migration');
  }
  for (const env of [{}, { MC_ROLE: 'martin' }]) {
    const f = fixture({ env });
    assert.equal(await run(newArgv, f.deps), 0, f.err());
    assert.equal(parseGoal(f.store[`${HOME}/mc/goals/fresh/GOAL.json`]).stage, 'draft');
  }
});
