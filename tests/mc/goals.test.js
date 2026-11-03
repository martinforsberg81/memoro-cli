import assert from 'node:assert/strict';
import { test } from 'node:test';

import { afterCycle, afterGoneText, afterOf, appendEntry, appendLog, GOAL_FILE, goalDirIn, lastBuildEntry, LOG_FILE, nextGoal, parseGoal, parseLog, programsGoals, queuedOf, queuedText, renderEntry, renderGoal, reviewDue, sessions, setStatus, verdictOf, waitingMoves, planDue, planHeld, planHeldText, waitsOnPerson, waitsOnPlan } from '../../src/mc/goals.js';
import { programsPlans } from '../../src/mc/plan-source.js';

const GOAL_TEXT = [
  '---',
  'status: open',
  'repos: memoro-cli, memoro',
  'class: large',
  'created: 2026-11-01T20:00:00Z',
  '---',
  '# Make the goal plain',
  '',
  '## Goal',
  '',
  'Two files and a worktree.',
  '',
  '## Criteria',
  '',
  '## Out of scope',
  '',
].join('\n');

const LOG_TEXT = [
  '## 2026-11-01T20:00Z · person · open',
  '',
  'Gjort: skapat',
  '',
  '## 2026-11-01T21:30Z · claude claude-opus-5-5 · open',
  '',
  'Gjort: the reader',
  'and its tests, over two paragraphs',
  '',
  'Kommentar: none yet',
  'Nästa: the verbs',
  '',
  '## 2026-11-01T22:00Z · runner · open',
  '',
  'Kommentar: no session ran',
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

test('parseGoal reads the front matter and the title, and keeps the body as it is', () => {
  const goal = parseGoal(GOAL_TEXT);
  assert.equal(goal.status, 'open');
  assert.deepEqual(goal.repos, ['memoro-cli', 'memoro']);
  assert.equal(goal.class, 'large');
  assert.equal(goal.created, '2026-11-01T20:00:00Z');
  assert.equal(goal.title, 'Make the goal plain');
  assert.equal(goal.body, GOAL_TEXT.slice(GOAL_TEXT.indexOf('# Make')));
});

test('parseGoal names each problem: no front matter, a status or class unknown, no repository, a bad repository name', () => {
  assert.deepEqual(parseGoal('# no front matter\n').problems, ['GOAL.md has no front matter between --- lines']);
  assert.match(parseGoal(GOAL_TEXT.replace('status: open', 'status: started')).problems.join(), /status is open, review, blocked, done, waiting, dropped, not started/u);
  assert.match(parseGoal(GOAL_TEXT.replace('status: open\n', '')).problems.join(), /status is open, review, blocked, done, waiting, dropped, not missing/u);
  assert.match(parseGoal(GOAL_TEXT.replace('class: large', 'class: huge')).problems.join(), /class is fast or large, not huge/u);
  assert.match(parseGoal(GOAL_TEXT.replace('repos: memoro-cli, memoro', 'repos: ')).problems.join(), /repos names no repository/u);
  assert.match(parseGoal(GOAL_TEXT.replace('repos: memoro-cli, memoro', 'repos: Memoro_CLI')).problems.join(), /repo Memoro_CLI is not a repository name/u);
});

test('renderGoal writes the front matter back, and the body untouched, so a parsed goal renders as it was', () => {
  const goal = parseGoal(GOAL_TEXT);
  assert.equal(renderGoal(goal), GOAL_TEXT);
  assert.equal(renderGoal({ ...goal, status: 'blocked' }), GOAL_TEXT.replace('status: open', 'status: blocked'));
});

test('parseLog reads each heading, and each labelled line up to the next label or heading', () => {
  const log = parseLog(LOG_TEXT);
  assert.equal(log.length, 3);
  assert.deepEqual(log[0], { at: '2026-11-01T20:00Z', tool: 'person', model: null, status: 'open', done: 'skapat', comment: null, next: null });
  assert.deepEqual(log[1], {
    at: '2026-11-01T21:30Z', tool: 'claude', model: 'claude-opus-5-5', status: 'open',
    done: 'the reader\nand its tests, over two paragraphs', comment: 'none yet', next: 'the verbs',
  });
  assert.deepEqual(log[2], { at: '2026-11-01T22:00Z', tool: 'runner', model: null, status: 'open', done: null, comment: 'no session ran', next: null });
});

test('parseLog skips a heading that is not one, and the lines under it', () => {
  const log = parseLog('## not an entry\n\nGjort: nothing\n\n## 2026-11-01T20:00Z · person · done\n\nGjort: closed\n');
  assert.equal(log.length, 1);
  assert.equal(log[0].status, 'done');
  assert.equal(log[0].done, 'closed');
});

test('appendLog adds one heading at the end, with a blank line between entries, and renders the labels that are set', () => {
  const entry = { at: '2026-11-01T23:00Z', tool: 'claude', model: 'claude-haiku-5-5', status: 'blocked', done: 'part', comment: null, next: 'the rest' };
  const text = appendLog(LOG_TEXT, entry);
  assert.equal(text, `${LOG_TEXT.trimEnd()}\n\n${renderEntry(entry)}`);
  assert.match(text, /^## 2026-11-01T23:00Z · claude claude-haiku-5-5 · blocked\n\nGjort: part\nNästa: the rest\n$/mu);
  assert.equal(appendLog('', { at: '2026-11-01T20:00Z', tool: 'person', model: null, status: 'open', done: 'skapat', comment: null, next: null }), '## 2026-11-01T20:00Z · person · open\n\nGjort: skapat\n');
});

test('sessions counts the entries a session wrote: not the runner\'s, not a person\'s', () => {
  assert.equal(sessions(parseLog(LOG_TEXT)), 1);
  assert.equal(sessions(parseLog('')), 0);
});

test('programsGoals lists every goal under every programme, in listing order, with its log', () => {
  const { list, read } = model({
    '/p/mc/goals/plain/GOAL.md': GOAL_TEXT,
    '/p/mc/goals/plain/LOG.md': LOG_TEXT,
    '/p/mc/goals/second/GOAL.md': GOAL_TEXT.replace('class: large', 'class: fast'),
    '/p/mc/goals/notes/LOG.md': LOG_TEXT,
    '/p/other/goals/broken/GOAL.md': 'no front matter here\n',
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
  assert.equal(goals[1].class, 'fast');
  assert.deepEqual(goals[2].problems, ['GOAL.md has no front matter between --- lines']);
  assert.equal(goals[2].status, null);
  assert.equal(goals[2].log.length, 3);
});

test('programsPlans ignores a goals directory: no PLAN.json sits directly under it, so no goal is a plan', () => {
  // A plan is `<programme>/<project>/PLAN.json`: the goal is `goals/<goal>`, one level deeper.
  const { list, read } = model({
    '/p/mc/proj/PLAN.json': '{"repo":"memoro-cli"}',
    '/p/mc/goals/plain/GOAL.md': GOAL_TEXT,
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
  assert.equal(store[`${dir}/${GOAL_FILE}`], GOAL_TEXT.replace('status: open', 'status: blocked'));
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
  appendEntry({ dir: '/p/mc/goals/plain', entry: { at: '2026-11-01T20:00Z', tool: 'person', model: null, status: 'open', done: 'skapat', comment: null, next: null }, read, write });
  assert.equal(store['/p/mc/goals/plain/LOG.md'], '## 2026-11-01T20:00Z · person · open\n\nGjort: skapat\n');
});

test('verdictOf reads green or red and the head sha off the first Gjort line, and nothing else is a verdict', () => {
  assert.deepEqual(verdictOf({ done: 'green 46a61dea' }), { verdict: 'green', sha: '46a61dea' });
  assert.deepEqual(verdictOf({ done: 'red — head 46a61dea0b1c\nmore' }), { verdict: 'red', sha: '46a61dea0b1c' });
  assert.equal(verdictOf({ done: 'green light for the page' }), null);
  assert.equal(verdictOf({ done: 'built the reader 46a61dea' }), null);
  assert.equal(verdictOf({ done: null }), null);
});

test('lastBuildEntry is the last entry a build session wrote: not the runner\'s, a person\'s or a review\'s', () => {
  const log = parseLog([
    '## 2026-11-02T09:00Z · person · open', '', 'Gjort: skapat', '',
    '## 2026-11-02T10:00Z · claude opus · review', '', 'Gjort: built', '',
    '## 2026-11-02T11:00Z · codex gpt-6.1-sol · blocked', '', 'Gjort: red abc1234', '',
    '## 2026-11-02T12:00Z · runner · blocked', '', 'Kommentar: x', '',
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

/* ------------------------------------------------------------- after, waiting */

/** A goal as `programsGoals` gives it, for the after tests. */
const listed = (name, status, after = [], extra = {}) => {
  const [programme, goal] = name.split('/');
  return { programme, goal, dir: `/p/${programme}/goals/${goal}`, status, repos: ['memoro-cli'], class: 'large', after, log: [], problems: [], ...extra };
};

test('parseGoal reads after as <programme>/<goal> names, and renderGoal writes it back', () => {
  const text = GOAL_TEXT.replace('created: 2026-11-01T20:00:00Z\n', 'created: 2026-11-01T20:00:00Z\nafter: mc/runner-sessions, mc/agent-skills-text\n').replace('status: open', 'status: waiting');
  const goal = parseGoal(text);
  assert.equal(goal.status, 'waiting');
  assert.deepEqual(goal.after, ['mc/runner-sessions', 'mc/agent-skills-text']);
  assert.equal(renderGoal(goal), text);
  assert.deepEqual(parseGoal(GOAL_TEXT).after, [], 'no after line, no after');
  assert.doesNotMatch(renderGoal(parseGoal(GOAL_TEXT)), /after:/u, 'no after, no line');
  assert.deepEqual(parseGoal(text.replace('mc/agent-skills-text', 'agent-skills-text')).problems, ['after agent-skills-text is not <programme>/<goal>']);
});

test('setStatus with after writes both, and keeps the after it has when given none', () => {
  const store = { '/g/GOAL.md': GOAL_TEXT, '/g/LOG.md': '' };
  const io = { read: (path) => store[path] ?? null, write: (path, text) => { store[path] = text; } };
  const entry = { at: '2026-11-02T10:00Z', tool: 'person', model: null, status: 'waiting', done: 'after mc/a', comment: null, next: null };
  setStatus({ dir: '/g', status: 'waiting', after: ['mc/a'], entry, ...io });
  assert.match(store['/g/GOAL.md'], /^status: waiting\n.*\nafter: mc\/a\n---/msu);
  setStatus({ dir: '/g', status: 'blocked', entry: { ...entry, status: 'blocked' }, ...io });
  assert.deepEqual(parseGoal(store['/g/GOAL.md']).after, ['mc/a']);
});

test('afterOf: done is landed, a goal not there is gone, anything else — blocked too — is pending', () => {
  const goals = [listed('mc/landed', 'done'), listed('mc/stuck', 'blocked'), listed('mc/going', 'open')];
  assert.deepEqual(afterOf({ after: ['mc/landed', 'mc/stuck', 'mc/going', 'mc/discarded'] }, goals), {
    landed: ['mc/landed'], pending: ['mc/stuck', 'mc/going'], gone: ['mc/discarded'],
  });
  assert.deepEqual(afterOf({ after: [] }, goals), { landed: [], pending: [], gone: [] });
});

test('waitingMoves opens a goal whose after has all landed, keeps one behind a blocked goal waiting, and blocks one whose after is gone', () => {
  const goals = [
    listed('mc/runner-sessions', 'done'),
    listed('mc/stuck', 'blocked'),
    listed('mc/ready', 'waiting', ['mc/runner-sessions']),
    listed('mc/behind', 'waiting', ['mc/runner-sessions', 'mc/stuck']),
    listed('mc/orphan', 'waiting', ['mc/discarded']),
    listed('mc/early', 'open', ['mc/stuck']),
    listed('mc/judged', 'review', ['mc/stuck']),
    listed('mc/asked', 'blocked', ['mc/runner-sessions']),
  ];
  const moves = waitingMoves(goals).map((move) => ({ goal: move.goal.goal, status: move.status, done: move.done, comment: move.comment }));
  assert.deepEqual(moves, [
    { goal: 'ready', status: 'open', done: 'mc/runner-sessions landed — starting', comment: null },
    { goal: 'orphan', status: 'blocked', done: null, comment: afterGoneText(['mc/discarded']) },
    { goal: 'early', status: 'waiting', done: null, comment: 'waits on mc/stuck' },
  ]);
  assert.equal(waitsOnPlan({ status: 'blocked', log: [{ tool: 'runner', status: 'blocked', done: null, comment: afterGoneText(['mc/discarded']) }] }), true, 'a gone after waits on plan');
});

test('nextGoal never picks a waiting goal', () => {
  const goals = [listed('mc/held', 'waiting', ['mc/other']), listed('mc/other', 'blocked')];
  assert.equal(nextGoal(goals, { repos: ['memoro-cli'] }), null);
});

test('afterCycle finds a ring of goals waiting on each other', () => {
  const goals = [listed('mc/a', 'waiting', ['mc/b']), listed('mc/b', 'waiting', ['mc/c']), listed('mc/c', 'open')];
  assert.equal(afterCycle('mc/c', ['mc/a'], goals), 'mc/a');
  assert.equal(afterCycle('mc/c', ['mc/x'], goals), null);
  assert.equal(afterCycle('mc/d', ['mc/a'], goals), null);
});

/* ------------------------------------------------ prs, done at landing, archive (goal-lifecycle) */

test('prs: <repo>#<n> each once, written back after created and after; a bad one is a problem', async () => {
  const { prRef } = await import('../../src/mc/goals.js');
  const text = GOAL_TEXT.replace('class: large', 'class: large\nprs: memoro#14761, memoro-cli#1238, memoro#14761');
  const goal = parseGoal(text);
  assert.deepEqual(goal.prs, [{ repo: 'memoro', pr: 14761 }, { repo: 'memoro-cli', pr: 1238 }]);
  assert.match(renderGoal(goal), /\nprs: memoro#14761, memoro-cli#1238\n---\n/u);
  assert.deepEqual(parseGoal(GOAL_TEXT).prs, []);
  assert.doesNotMatch(renderGoal(parseGoal(GOAL_TEXT)), /prs:/u);
  assert.match(parseGoal(GOAL_TEXT.replace('class: large', 'class: large\nprs: 14761')).problems.join(), /prs 14761 is not <repo>#<number>/u);
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

test('goalLogRow: one table row, its pipes escaped, the last Gjort', async () => {
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
