import assert from 'node:assert/strict';
import { test } from 'node:test';

import { appendEntry, currentPhase, appendLog, criteriaWords, GOAL_FILE, goalDirIn, lastBuildEntry, LOG_FILE, nextGoal, parseGoal, parseLog, programsGoals, queuedOf, queuedText, renderEntry, renderGoal, renderGoalText, reviewDue, sessions, setStatus, unmetGoalWords, updateGoal, validateGoal, verdictOf, phaseMoves, phaseOpen, renumberPhases, planDue, planHeld, planHeldText, waitsOnPerson, waitsOnPlan } from '../../src/mc/goals.js';
import { programsPlans } from '../../src/mc/plan-source.js';
import { validatePlan } from '../../src/mc/plan-schema.js';
import * as criteria from '../../src/mc/criteria.js';
import { goalField, goalJson, withGoal } from './_helpers/goal-file.js';

const GOAL_TEXT = goalJson({ repos: ['memoro-cli', 'memoro'] });

const LOG_TEXT = [
  '## 2026-11-01T20:00Z · person · open',
  '',
  'Done: created',
  '',
  '## 2026-11-01T21:30Z · claude claude-opus-5-5 · open',
  '',
  'Done: the reader',
  'and its tests, over two paragraphs',
  '',
  'Comment: none yet',
  'Next: the verbs',
  '',
  '## 2026-11-01T22:00Z · runner · open',
  '',
  'Comment: no session ran',
  '',
].join('\n');

/** A file model: `files` keyed by path, `list` the directories under a path. */
function model(files) {
  const store = { ...files };
  const list = (path) => {
    const prefix = `${path}/`;
    const names = new Set();
    for (const key of Object.keys(store)) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length).split('/');
      if (rest.length > 1) names.add(rest[0]);
    }
    return [...names].sort();
  };
  const read = (path) => store[path] ?? null;
  const write = (path, text) => { store[path] = text; };
  return { store, list, read, write };
}

test('parseGoal reads GOAL.json: its fields, prose as paragraphs, criteria and documents', () => {
  const goal = parseGoal(GOAL_TEXT);
  assert.equal(goal.status, 'open');
  assert.deepEqual(goal.repos, ['memoro-cli', 'memoro']);
  assert.equal(goal.class, 'large');
  assert.equal(goal.created, '2026-11-01T20:00:00Z');
  assert.equal(goal.title, 'Make the goal plain');
  assert.deepEqual(goal.goal, ['Two files and a worktree.']);
  assert.deepEqual(goal.success_criteria, [{ criterion: 'it works', check: 'a test', met: false }]);
  assert.deepEqual(goal.documents, []);
});

test('parseGoal names each problem by its field: not JSON, a status or class unknown, no repository, a bad repository name', () => {
  assert.match(parseGoal('# no json\n').problems.join(), /^GOAL\.json is not JSON/u);
  assert.match(parseGoal(withGoal(GOAL_TEXT, { status: 'started' })).problems.join(), /status: one of open, review, blocked, done, dropped, not started/u);
  assert.match(parseGoal(withGoal(GOAL_TEXT, { status: undefined })).problems.join(), /status: .*not missing/u);
  assert.match(parseGoal(withGoal(GOAL_TEXT, { class: 'huge' })).problems.join(), /class: fast or large, not huge/u);
  assert.match(parseGoal(withGoal(GOAL_TEXT, { repos: [] })).problems.join(), /repos: at least one repository/u);
  assert.match(parseGoal(withGoal(GOAL_TEXT, { repos: ['Memoro_CLI'] })).problems.join(), /repos: Memoro_CLI is not a repository name/u);
  assert.match(parseGoal(withGoal(GOAL_TEXT, { schema: 'mc-plan' })).problems.join(), /schema: must be "mc-goal"/u);
});

test('the schema refuses a goal without a criterion, a criterion without a check, and an unknown key, naming the field', () => {
  const value = JSON.parse(GOAL_TEXT);
  assert.deepEqual(validateGoal(value), []);
  assert.deepEqual(validateGoal({ ...value, success_criteria: [] }), ['success_criteria: at least one criterion — a goal with none cannot be finished']);
  assert.deepEqual(validateGoal({ ...value, success_criteria: [{ criterion: 'it works', met: false }] }),
    ['success_criteria[0].check: how it is checked — the assertion, the query, the measurement in the running app']);
  assert.deepEqual(validateGoal({ ...value, steps: [] }), ['steps: unknown key']);
  assert.deepEqual(validateGoal({ ...value, success_criteria: [{ criterion: 'x', check: 'y', met: false, by: 'me' }] }), ['success_criteria[0].by: unknown key']);
  assert.deepEqual(validateGoal({ ...value, documents: [{ label: 'doc' }] }), ['documents[0].path: a path or URL a checkout can follow']);
  // A draft — mc goal new's skeleton — may have no criterion yet; it parses.
  assert.deepEqual(validateGoal({ ...value, success_criteria: [] }, { draft: true }), []);
  assert.deepEqual(parseGoal(withGoal(GOAL_TEXT, { success_criteria: [] })).success_criteria, []);
});

test('PLAN.json and GOAL.json check criteria and documents with the same functions', () => {
  const plan = { schema: 'mc-plan', version: 1, goal: ['g'], contract: ['c'], out_of_scope: ['o'], documents: [], steps: [{ title: 't', status: 'ready', done_when: 'd', instruction: ['i'] }] };
  const bad = [{ criterion: 'it works', met: false }];
  const fromPlan = validatePlan({ ...plan, success_criteria: bad }).problems;
  const fromGoal = validateGoal({ ...JSON.parse(GOAL_TEXT), success_criteria: bad });
  const shared = [];
  criteria.validateCriteria(bad, shared);
  assert.deepEqual(fromPlan, shared);
  assert.deepEqual(fromGoal, shared);
});

test('renderGoal writes every key in order, so a parsed goal renders as it was; an invalid goal is never rendered', () => {
  const goal = parseGoal(GOAL_TEXT);
  assert.equal(renderGoal(goal), GOAL_TEXT);
  assert.equal(renderGoal({ ...goal, status: 'blocked' }), withGoal(GOAL_TEXT, { status: 'blocked' }));
  assert.throws(() => renderGoal({ ...goal, status: 'maybe' }), /GOAL\.json would not validate: status/u);
  assert.throws(() => renderGoal({ ...goal, success_criteria: [{ criterion: 'x', met: false }] }), /success_criteria\[0\]\.check/u);
});

test('renderGoalText shows the goal, contract, out of scope, documents and each criterion with ✓ or ✗ and its check', () => {
  const goal = parseGoal(withGoal(GOAL_TEXT, {
    contract: ['No new dependency.'], out_of_scope: ['Phases.'], documents: [{ label: 'the doc', path: 'docs/technical/mc-goals.md' }],
    success_criteria: [{ criterion: 'it parses', check: 'mc gate tests/mc/goals.test.js', met: true }, { criterion: 'it shows', check: 'a test on the text', met: false }],
  }));
  const text = renderGoalText(goal);
  assert.match(text, /^# Make the goal plain\n\nGOAL\n  Two files and a worktree\.\n\nCONTRACT\n  No new dependency\.\n\nOUT OF SCOPE\n  Phases\.\n\nDOCUMENTS\n  the doc — docs\/technical\/mc-goals\.md\n/u);
  assert.match(text, /\nCRITERIA 1\/2\n  1 ✓ it parses\n      check: mc gate tests\/mc\/goals\.test\.js\n  2 ✗ it shows\n      check: a test on the text\n$/u);
  assert.equal(criteriaWords(goal), 'criteria 1/2');
  assert.match(renderGoalText(parseGoal(withGoal(GOAL_TEXT, { success_criteria: [] }))), /CRITERIA 0\/0\n  none yet — mc goal criterion add/u);
});

test('unmetGoalWords names the unmet criteria by number, and a goal with none; null when all hold', () => {
  const two = (a, b) => ({ success_criteria: [{ met: a }, { met: b }] });
  assert.equal(unmetGoalWords(two(true, true), 'mc/g'), null);
  assert.equal(unmetGoalWords(two(true, false), 'mc/g'), 'criterion 2 is not met — run its check and record it with mc goal criterion met mc/g 2');
  assert.match(unmetGoalWords(two(false, false), 'mc/g'), /^criteria 1, 2 are not met/u);
  assert.match(unmetGoalWords({ success_criteria: [] }, 'mc/g'), /^mc\/g has no criterion — mc goal criterion add mc\/g/u);
});

test('updateGoal writes a valid change, and refuses an invalid one without writing', () => {
  const files = { '/g/GOAL.json': GOAL_TEXT };
  const io = { read: (path) => files[path] ?? null, write: (path, text) => { files[path] = text; } };
  const met = updateGoal({ dir: '/g', change: (goal) => ({ ...goal, success_criteria: [{ ...goal.success_criteria[0], met: true }] }), ...io });
  assert.equal(met.goal.success_criteria[0].met, true);
  assert.equal(goalField(files['/g/GOAL.json'], 'success_criteria')[0].met, true);
  const before = files['/g/GOAL.json'];
  const bad = updateGoal({ dir: '/g', change: (goal) => ({ ...goal, success_criteria: [{ criterion: 'x', met: false }] }), ...io });
  assert.match(bad.problems.join(), /success_criteria\[0\]\.check/u);
  assert.equal(files['/g/GOAL.json'], before, 'nothing written');
  assert.deepEqual(updateGoal({ dir: '/g', change: () => ({ problems: ['no'] }), ...io }).problems, ['no']);
});

test('parseLog reads each heading, and each labelled line up to the next label or heading', () => {
  const log = parseLog(LOG_TEXT);
  assert.equal(log.length, 3);
  assert.deepEqual(log[0], { at: '2026-11-01T20:00Z', tool: 'person', model: null, status: 'open', done: 'created', comment: null, next: null });
  assert.deepEqual(log[1], {
    at: '2026-11-01T21:30Z', tool: 'claude', model: 'claude-opus-5-5', status: 'open',
    done: 'the reader\nand its tests, over two paragraphs', comment: 'none yet', next: 'the verbs',
  });
  assert.deepEqual(log[2], { at: '2026-11-01T22:00Z', tool: 'runner', model: null, status: 'open', done: null, comment: 'no session ran', next: null });
});

test('parseLog still reads a log written with the Swedish labels', () => {
  const log = parseLog('## 2026-11-01T20:00Z · person · open\n\nGjort: skapat\n\n## 2026-11-01T21:30Z · claude opus · open\n\nGjort: the reader\nKommentar: none yet\nNästa: the verbs\n');
  assert.deepEqual(log.map(({ done, comment, next }) => ({ done, comment, next })), [
    { done: 'skapat', comment: null, next: null },
    { done: 'the reader', comment: 'none yet', next: 'the verbs' },
  ]);
});

test('parseLog skips a heading that is not one, and the lines under it', () => {
  const log = parseLog('## not an entry\n\nDone: nothing\n\n## 2026-11-01T20:00Z · person · done\n\nDone: closed\n');
  assert.equal(log.length, 1);
  assert.equal(log[0].status, 'done');
  assert.equal(log[0].done, 'closed');
});

test('appendLog adds one heading at the end, with a blank line between entries, and renders the labels that are set — Done, Comment, Next', () => {
  const entry = { at: '2026-11-01T23:00Z', tool: 'claude', model: 'claude-haiku-5-5', status: 'blocked', done: 'part', comment: null, next: 'the rest' };
  const text = appendLog(LOG_TEXT, entry);
  assert.equal(text, `${LOG_TEXT.trimEnd()}\n\n${renderEntry(entry)}`);
  assert.match(text, /^## 2026-11-01T23:00Z · claude claude-haiku-5-5 · blocked\n\nDone: part\nNext: the rest\n$/mu);
  assert.equal(appendLog('', { at: '2026-11-01T20:00Z', tool: 'person', model: null, status: 'open', done: 'created', comment: 'c', next: null }), '## 2026-11-01T20:00Z · person · open\n\nDone: created\nComment: c\n');
});

test('sessions counts the entries a session wrote: not the runner\'s, not a person\'s', () => {
  assert.equal(sessions(parseLog(LOG_TEXT)), 1);
  assert.equal(sessions(parseLog('')), 0);
});

test('programsGoals lists every goal under every programme, in listing order, with its log', () => {
  const { list, read } = model({
    '/p/mc/goals/plain/GOAL.json': GOAL_TEXT,
    '/p/mc/goals/plain/LOG.md': LOG_TEXT,
    '/p/mc/goals/second/GOAL.json': withGoal(GOAL_TEXT, { class: 'fast' }),
    '/p/mc/goals/notes/LOG.md': LOG_TEXT,
    '/p/other/goals/broken/GOAL.json': 'no json here\n',
    '/p/other/goals/broken/LOG.md': LOG_TEXT,
  });
  const goals = programsGoals({ home: '/p', list, read });
  assert.deepEqual(goals.map((g) => `${g.programme}/${g.goal}`), ['mc/plain', 'mc/second', 'other/broken']);
  assert.equal(goals[0].status, 'open');
  assert.deepEqual(goals[0].repos, ['memoro-cli', 'memoro']);
  assert.equal(goals[0].class, 'large');
  assert.equal(goals[0].title, 'Make the goal plain');
  assert.equal(goals[0].dir, '/p/mc/goals/plain');
  assert.equal(goals[0].log.length, 3);
  assert.deepEqual(goals[0].problems, []);
  assert.deepEqual(goals[0].goal_text, ['Two files and a worktree.']);
  assert.equal(goals[0].success_criteria.length, 1);
  assert.equal(goals[1].class, 'fast');
  assert.match(goals[2].problems.join(), /^GOAL\.json is not JSON/u);
  assert.equal(goals[2].status, null);
  assert.equal(goals[2].log.length, 3);
});

test('programsPlans ignores a goals directory: no PLAN.json sits directly under it, so no goal is a plan', () => {
  // A plan is `<programme>/<project>/PLAN.json`: the goal is `goals/<goal>`, one level deeper.
  const { list, read } = model({
    '/p/mc/proj/PLAN.json': '{"repo":"memoro-cli"}',
    '/p/mc/goals/plain/GOAL.json': GOAL_TEXT,
    '/p/mc/goals/plain/memoro-cli/PLAN.json': '{"repo":"memoro-cli"}',
  });
  const plans = programsPlans({ home: '/p', list, read });
  assert.deepEqual(plans.map((plan) => plan.path), ['/p/mc/proj/PLAN.json']);
});

test('setStatus rewrites the status and appends the entry, in one call; nothing is written for a goal that does not parse', () => {
  const { store, read, write } = model({
    [`${goalDirIn('/p', 'mc', 'plain')}/${GOAL_FILE}`]: GOAL_TEXT,
    [`${goalDirIn('/p', 'mc', 'plain')}/${LOG_FILE}`]: LOG_TEXT,
  });
  const dir = goalDirIn('/p', 'mc', 'plain');
  const entry = { at: '2026-11-02T08:00Z', tool: 'claude', model: 'claude-sonnet-5-5', status: 'blocked', done: null, comment: 'waits for Martin', next: null };
  const outcome = setStatus({ dir, status: 'blocked', entry, read, write });
  assert.equal(outcome.goal.status, 'blocked');
  assert.equal(store[`${dir}/${GOAL_FILE}`], withGoal(GOAL_TEXT, { status: 'blocked' }));
  assert.equal(store[`${dir}/${LOG_FILE}`], appendLog(LOG_TEXT, entry));

  const broken = { [`${dir}/${GOAL_FILE}`]: 'nothing here' };
  const refused = model(broken);
  const refusedOutcome = setStatus({ dir, status: 'done', entry, read: refused.read, write: refused.write });
  assert.ok(refusedOutcome.problems);
  assert.equal(refused.store[`${dir}/${GOAL_FILE}`], 'nothing here');
  assert.equal(refused.store[`${dir}/${LOG_FILE}`], undefined);
});

test('appendEntry adds to LOG.md alone, and starts it when there is none', () => {
  const { store, read, write } = model({});
  appendEntry({ dir: '/p/mc/goals/plain', entry: { at: '2026-11-01T20:00Z', tool: 'person', model: null, status: 'open', done: 'created', comment: null, next: null }, read, write });
  assert.equal(store['/p/mc/goals/plain/LOG.md'], '## 2026-11-01T20:00Z · person · open\n\nDone: created\n');
});

test('verdictOf reads green or red and the head sha off the first Done line, and nothing else is a verdict', () => {
  assert.deepEqual(verdictOf({ done: 'green 46a61dea' }), { verdict: 'green', sha: '46a61dea' });
  assert.deepEqual(verdictOf({ done: 'red — head 46a61dea0b1c\nmore' }), { verdict: 'red', sha: '46a61dea0b1c' });
  assert.equal(verdictOf({ done: 'green light for the page' }), null);
  assert.equal(verdictOf({ done: 'built the reader 46a61dea' }), null);
  assert.equal(verdictOf({ done: null }), null);
});

test('lastBuildEntry is the last entry a build session wrote: not the runner\'s, a person\'s or a review\'s', () => {
  const log = parseLog([
    '## 2026-11-02T09:00Z · person · open', '', 'Done: created', '',
    '## 2026-11-02T10:00Z · claude opus · review', '', 'Done: built', '',
    '## 2026-11-02T11:00Z · codex gpt-6.1-sol · blocked', '', 'Done: red abc1234', '',
    '## 2026-11-02T12:00Z · runner · blocked', '', 'Comment: x', '',
  ].join('\n'));
  assert.equal(lastBuildEntry(log).model, 'opus');
  assert.equal(lastBuildEntry(log.slice(0, 1)), null);
});

test('a goal in review is due a review until the runner has queued its green; then it waits for the merger', () => {
  const entry = (tool, done) => ({ at: '2026-11-02T10:00Z', tool, model: null, status: 'review', done, comment: null, next: null });
  assert.equal(queuedText(12, 'abc1234'), 'queued #12 at abc1234 for the merger');
  assert.deepEqual(queuedOf(entry('runner', queuedText(12, 'abc1234'))), { pr: 12, sha: 'abc1234' });
  assert.equal(queuedOf(entry('claude', queuedText(12, 'abc1234'))), null, 'only the runner queues');
  assert.equal(reviewDue({ status: 'review', log: [entry('claude', 'built')] }), true);
  assert.equal(reviewDue({ status: 'review', log: [entry('runner', queuedText(12, 'abc1234'))] }), false);
  assert.equal(reviewDue({ status: 'open', log: [] }), false);
});

test('a goal in review whose pull request a session queued itself waits for the merger, not a review', () => {
  const goal = { status: 'review', prs: [{ repo: 'memoro-cli', pr: 1244 }], log: [{ at: '2026-11-03T13:32Z', tool: 'claude', model: 'fable', status: 'review', done: 'fixed the red', comment: null, next: null }] };
  assert.equal(reviewDue(goal, [{ repo: 'memoro-cli', pr: 1244, state: 'queued' }]), false);
  assert.equal(reviewDue(goal, [{ repo: 'memoro-cli', pr: 1244, state: 'landing' }]), false);
  assert.equal(reviewDue(goal, [{ repo: 'memoro', pr: 1244, state: 'queued' }]), true, 'another repository\'s #1244 is other work');
  assert.equal(reviewDue(goal, []), true);
});

test('nextGoal takes open goals and goals due a review, oldest first, and leaves out what may refuses', () => {
  const goal = (name, status, at) => ({ programme: 'p', goal: name, status, repos: ['memoro'], problems: [], log: [{ at, tool: 'claude', done: 'x' }] });
  const goals = [goal('a', 'open', '2026-11-02T12:00Z'), goal('b', 'review', '2026-11-02T10:00Z'), goal('c', 'blocked', '2026-11-01T10:00Z')];
  assert.equal(nextGoal(goals, { repos: ['memoro'] }).goal, 'b');
  assert.equal(nextGoal(goals, { repos: ['memoro'], may: (g) => g.status !== 'review' }).goal, 'a');
  // An open goal with no criterion yet — mc goal new's skeleton — is not started.
  const bare = [{ ...goal('a', 'open', '2026-11-02T12:00Z'), success_criteria: [] }];
  assert.equal(nextGoal(bare, { repos: ['memoro'] }), null);
  assert.equal(nextGoal([{ ...bare[0], success_criteria: [{ criterion: 'x', check: 'y', met: false }] }], { repos: ['memoro'] }).goal, 'a');
});

test('waitsOnPlan: a goal blocked by a red review or by the runner, not one blocked on a question or left blocked by plan', () => {
  const blocked = (tool, done, comment = null) => ({ status: 'blocked', problems: [], log: [{ tool, status: 'blocked', done, comment }] });
  assert.equal(waitsOnPlan(blocked('codex', 'red abc1234')), true);
  assert.equal(waitsOnPlan(blocked('runner', 'merger answered red on #12')), true);
  assert.equal(waitsOnPlan(blocked('runner', null, 'three sessions ended without a word — see the logs under runner/log')), true);
  assert.equal(waitsOnPlan(blocked('claude', null)), false);
  assert.equal(waitsOnPlan(blocked('person', null, 'brief being written')), false);
  assert.equal(waitsOnPlan(blocked('runner', planHeldText(true))), false, 'plan has been: it waits on a person');
  assert.equal(planHeld({ tool: 'runner', done: planHeldText(false) }), true);
  assert.equal(waitsOnPlan({ status: 'open', log: [{ tool: 'codex', done: 'red abc1234' }] }), false);
  assert.equal(planDue(blocked('runner', 'merger answered red on #12')), true);
  assert.equal(planDue({ ...blocked('runner', 'merger answered red on #12'), problems: ['x'] }), false);
  assert.equal(waitsOnPerson(blocked('claude', null)), true);
  assert.equal(waitsOnPerson(blocked('runner', planHeldText(true))), true);
  assert.equal(waitsOnPerson(blocked('codex', 'red abc1234')), false);
  assert.equal(waitsOnPerson({ status: 'open', log: [] }), false);
});

/* ------------------------------------------------------------- phases */

/** A goal as `programsGoals` gives it, for the phase tests. */
const listed = (name, status, phase = 1, extra = {}) => {
  const [programme, goal] = name.split('/');
  return { programme, goal, dir: `/p/${programme}/goals/${goal}`, status, phase, repos: ['memoro-cli'], class: 'large', log: [], problems: [], success_criteria: [{ criterion: 'x', check: 'y', met: false }], ...extra };
};

test('a goal without a phase in GOAL.json is read as phase 1, and renderGoal writes it', () => {
  const { phase: _phase, ...bare } = JSON.parse(GOAL_TEXT);
  const goal = parseGoal(JSON.stringify(bare));
  assert.equal(goal.phase, 1);
  assert.equal(goalField(renderGoal(goal), 'phase'), 1);
  assert.equal(parseGoal(withGoal(GOAL_TEXT, { phase: 3 })).phase, 3);
  assert.equal(renderGoal(parseGoal(withGoal(GOAL_TEXT, { phase: 3 }))), withGoal(GOAL_TEXT, { phase: 3 }), 'round trip');
  for (const bad of [0, -1, 1.5, '2', null]) assert.match(parseGoal(withGoal(GOAL_TEXT, { phase: bad })).problems.join(), /phase: a whole number from 1/u, String(bad));
});

test('a GOAL.json with after, or waiting, does not parse, and says mc goal convert gives it a phase', () => {
  assert.match(parseGoal(withGoal(GOAL_TEXT, { after: ['mc/a'] })).problems.join(), /after: goals run in phases now — mc goal convert/u);
  assert.match(parseGoal(withGoal(GOAL_TEXT, { status: 'waiting' })).problems.join(), /status: one of open, review, blocked, done, dropped/u);
});

test('the phase a programme is in is the lowest of its unfinished goals; done and dropped both finish one', () => {
  const goals = [listed('mc/a', 'done'), listed('mc/b', 'dropped'), listed('mc/c', 'open', 2), listed('mc/d', 'blocked', 3), listed('other/e', 'open')];
  assert.equal(currentPhase(goals, 'mc'), 2);
  assert.equal(currentPhase(goals, 'other'), 1);
  assert.equal(currentPhase([listed('mc/a', 'done')], 'mc'), null);
  assert.equal(currentPhase([listed('mc/a', 'open'), { ...listed('mc/broken', null, null), problems: ['x'] }], 'mc'), 1, 'a goal that does not parse holds nothing back');
});

test('a goal in phase 2 is not picked while a goal in phase 1 is open, review or blocked; it is when all are done or dropped; one phase runs side by side', () => {
  for (const status of ['open', 'review', 'blocked']) {
    const goals = [listed('mc/first', status, 1, { repos: ['memoro'] }), listed('mc/second', 'open', 2)];
    assert.equal(phaseOpen(goals[1], goals), false, status);
    assert.equal(nextGoal(goals, { repos: ['memoro-cli'] }), null, `not picked while phase 1 is ${status}`);
  }
  const finished = [listed('mc/first', 'done', 1, { repos: ['memoro'] }), listed('mc/gone', 'dropped', 1), listed('mc/second', 'open', 2)];
  assert.equal(nextGoal(finished, { repos: ['memoro-cli'] }).goal, 'second', 'picked once phase 1 is done or dropped');
  const side = [listed('mc/a', 'open'), listed('mc/b', 'open'), listed('mc/later', 'open', 2)];
  assert.equal(nextGoal(side, { repos: ['memoro-cli'] }).goal, 'a');
  assert.equal(nextGoal(side, { repos: ['memoro-cli'], held: new Set(['goal:mc/a']) }).goal, 'b', 'the second of phase 1 runs while the first is held');
  assert.equal(nextGoal(side, { repos: ['memoro-cli'], held: new Set(['goal:mc/a', 'goal:mc/b']) }), null, 'phase 2 still waits');
  assert.equal(phaseOpen(listed('other/x', 'open', 2), side), true, 'another programme\'s phases do not hold it');
});

test('phaseMoves renumbers each programme so the lowest phase is 1 and there are no holes', () => {
  const goals = [listed('mc/b', 'open', 2), listed('mc/c', 'open', 3), listed('mc/c2', 'open', 3), listed('mc/e', 'open', 5), listed('other/x', 'open', 1)];
  assert.deepEqual(phaseMoves(goals).map((move) => [move.goal.goal, move.from, move.to]), [['b', 2, 1], ['c', 3, 2], ['c2', 3, 2], ['e', 5, 3]]);
  assert.deepEqual(phaseMoves([listed('mc/a', 'open'), listed('mc/b', 'done', 2)]), [], 'nothing to move');
});

test('renumberPhases writes each moved goal\'s phase into its GOAL.json, one programme only', () => {
  const store = {
    '/h/mc/goals/b/GOAL.json': withGoal(GOAL_TEXT, { phase: 2 }),
    '/h/mc/goals/c/GOAL.json': withGoal(GOAL_TEXT, { phase: 3 }),
    '/h/other/goals/x/GOAL.json': withGoal(GOAL_TEXT, { phase: 2 }),
  };
  const list = (path) => ({ '/h': ['mc', 'other'], '/h/mc/goals': ['b', 'c'], '/h/other/goals': ['x'] }[path] ?? []);
  const made = renumberPhases({ home: '/h', programme: 'mc', list, read: (path) => store[path] ?? null, write: (path, text) => { store[path] = text; } });
  assert.deepEqual(made.map((move) => [move.goal.goal, move.from, move.to]), [['b', 2, 1], ['c', 3, 2]]);
  assert.equal(goalField(store['/h/mc/goals/b/GOAL.json'], 'phase'), 1);
  assert.equal(goalField(store['/h/mc/goals/c/GOAL.json'], 'phase'), 2);
  assert.equal(goalField(store['/h/other/goals/x/GOAL.json'], 'phase'), 2, 'another programme is left');
});

/* ------------------------------------------------ prs, done at landing, archive (goal-lifecycle) */

test('prs: <repo>#<n> each once, written back as strings; a bad one is a problem', async () => {
  const { prRef } = await import('../../src/mc/goals.js');
  const text = withGoal(GOAL_TEXT, { prs: ['memoro#14761', 'memoro-cli#1238', 'memoro#14761'] });
  const goal = parseGoal(text);
  assert.deepEqual(goal.prs, [{ repo: 'memoro', pr: 14761 }, { repo: 'memoro-cli', pr: 1238 }]);
  assert.deepEqual(goalField(renderGoal(goal), 'prs'), ['memoro#14761', 'memoro-cli#1238']);
  assert.deepEqual(parseGoal(GOAL_TEXT).prs, []);
  assert.match(parseGoal(withGoal(GOAL_TEXT, { prs: ['14761'] })).problems.join(), /prs: 14761 is not <repo>#<number>/u);
  assert.equal(prRef({ repo: 'memoro', pr: 3 }), 'memoro#3');
});

test('prsLanded: done when every pull request landed or closed and one landed; open or unknown is not', async () => {
  const { prsLanded } = await import('../../src/mc/goals.js');
  const prs = [{ repo: 'memoro', pr: 1 }, { repo: 'memoro-cli', pr: 2 }];
  const states = (map) => ({ repo, pr }) => map[`${repo}#${pr}`] ?? null;
  assert.equal(prsLanded(prs, states({ 'memoro#1': 'MERGED', 'memoro-cli#2': 'MERGED' })).done, true);
  assert.equal(prsLanded(prs, states({ 'memoro#1': 'MERGED', 'memoro-cli#2': 'CLOSED' })).done, true);
  assert.equal(prsLanded(prs, states({ 'memoro#1': 'MERGED', 'memoro-cli#2': 'OPEN' })).done, false);
  assert.equal(prsLanded(prs, states({ 'memoro#1': 'MERGED' })).done, false, 'unknown is not done');
  assert.equal(prsLanded(prs, states({ 'memoro#1': 'CLOSED', 'memoro-cli#2': 'CLOSED' })).done, false, 'nothing landed');
  assert.equal(prsLanded([], () => 'MERGED').done, false);
  assert.deepEqual(prsLanded(prs, states({ 'memoro#1': 'MERGED', 'memoro-cli#2': 'OPEN' })).open, ['memoro-cli#2']);
});

test('goalOfPr and goalOfPath find the goal a pull request or a worktree is', async () => {
  const { goalOfPath, goalOfPr } = await import('../../src/mc/goals.js');
  const goals = [{ programme: 'mc', goal: 'a', prs: [] }, { programme: 'ios', goal: 'b', prs: [{ repo: 'memoro', pr: 7 }] }];
  assert.equal(goalOfPr(goals, 'memoro', 7).goal, 'b');
  assert.equal(goalOfPr(goals, 'memoro-cli', 7), null);
  assert.deepEqual(goalOfPath('/p/mc/goals/a/memoro-cli/src', '/p'), { programme: 'mc', goal: 'a' });
  assert.equal(goalOfPath('/p/mc/goals/a', '/p'), null, 'the goal directory is no worktree');
  assert.equal(goalOfPath('/elsewhere/mc/goals/a/memoro', '/p'), null);
  assert.equal(goalOfPath('/p/mc/memoro-cli', '/p'), null);
});

test('addPr writes a pull request into prs once, with its entry', async () => {
  const { addPr } = await import('../../src/mc/goals.js');
  const files = { [`/g/${GOAL_FILE}`]: GOAL_TEXT, [`/g/${LOG_FILE}`]: '' };
  const io = { read: (path) => files[path] ?? null, write: (path, text) => { files[path] = text; } };
  const entry = { at: '2026-11-03T09:00Z', tool: 'person', model: null, status: 'open', done: 'published memoro#1', comment: null, next: null };
  assert.equal(addPr({ dir: '/g', repo: 'memoro', pr: 1, entry, ...io }).added, true);
  assert.equal(addPr({ dir: '/g', repo: 'memoro', pr: 1, entry, ...io }).added, false);
  assert.deepEqual(parseGoal(files[`/g/${GOAL_FILE}`]).prs, [{ repo: 'memoro', pr: 1 }]);
  assert.equal(parseLog(files[`/g/${LOG_FILE}`]).length, 1);
});

test('goalLogRow: one table row, its pipes escaped, the last Done', async () => {
  const { goalLogRow } = await import('../../src/mc/goals.js');
  const log = [{ done: 'first' }, { done: 'a | b\nc' }, { done: null }];
  assert.equal(goalLogRow({ date: '2026-11-03', goal: 'g', status: 'done', prs: [{ repo: 'memoro', pr: 1 }], log }), '| 2026-11-03 | g | done | memoro#1 | a \\| b c |');
});

test('statusSince is the entry that set the current status, not a later entry that kept it', async () => {
  const { statusSince } = await import('../../src/mc/goals.js');
  const log = [
    { at: '2026-11-01T10:00Z', status: 'review' },
    { at: '2026-11-02T10:00Z', status: 'done' },
    { at: '2026-11-03T10:00Z', status: 'done' },
    { at: '2026-11-03T11:00Z', status: 'done' },
  ];
  assert.equal(statusSince({ status: 'done', log }), '2026-11-02T10:00Z');
  assert.equal(statusSince({ status: 'dropped', log }), null, 'a status the log does not hold');
  assert.equal(statusSince({ status: 'done', log: [] }), null);
  assert.equal(statusSince({ status: 'review', log }), null, 'the last entry is another status: none began it');
});
