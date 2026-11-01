import assert from 'node:assert/strict';
import { test } from 'node:test';

import { appendEntry, appendLog, GOAL_FILE, goalDirIn, LOG_FILE, parseGoal, parseLog, programsGoals, renderEntry, renderGoal, sessions, setStatus } from '../../src/mc/goals.js';
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
  assert.match(parseGoal(GOAL_TEXT.replace('status: open', 'status: started')).problems.join(), /status is open, blocked, done, not started/u);
  assert.match(parseGoal(GOAL_TEXT.replace('status: open\n', '')).problems.join(), /status is open, blocked, done, not missing/u);
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
