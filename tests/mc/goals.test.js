import assert from 'node:assert/strict';
import { test } from 'node:test';

import { appendEntry, backward, currentPhase, appendLog, criteriaWords, GOAL_FILE, goalDirIn, goalSession, inStage, lastBuildEntry, LOG_FILE, mergeAnswered, mergeRetryDue, nextGoal, parseGoal, parseLog, programsGoals, redMergeText, renderEntry, renderGoal, renderGoalText, REVIEW_DIED_TEXT, reviewDiedBefore, sessions, setGoalState, STAGES, stageWords, STATUSES, unmetGoalWords, updateGoal, validateGoal, phaseMoves, phaseOpen, renumberPhases, waitsOnPerson } from '../../src/mc/goals.js';
import * as criteria from '../../src/mc/criteria.js';
import { goalField, goalJson, withGoal } from './_helpers/goal-file.js';

const GOAL_TEXT = goalJson({ repos: ['memoro-cli', 'memoro'] });

const LOG_TEXT = [
  '## 2026-11-01T20:00Z · person · plan · ready',
  '',
  'Done: created',
  '',
  '## 2026-11-01T21:30Z · claude claude-opus-5-5 · build · ready',
  '',
  'Done: the reader',
  'and its tests, over two paragraphs',
  '',
  'Comment: none yet',
  'Next: the verbs',
  '',
  '## 2026-11-01T22:00Z · runner · build · ready',
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
  assert.equal(goal.stage, 'build');
  assert.equal(goal.status, 'ready');
  assert.deepEqual(goal.repos, ['memoro-cli', 'memoro']);
  assert.equal(goal.class, 'large');
  assert.equal(goal.created, '2026-11-01T20:00:00Z');
  assert.equal(goal.title, 'Make the goal plain');
  assert.deepEqual(goal.goal, ['Two files and a worktree.']);
  assert.deepEqual(goal.success_criteria, [{ criterion: 'it works', check: 'a test', met: false }]);
  assert.deepEqual(goal.documents, []);
});

test('parseGoal names each problem by its field: not JSON, a stage, status or class unknown, no repository, a bad repository name', () => {
  assert.match(parseGoal('# no json\n').problems.join(), /^GOAL\.json is not JSON/u);
  assert.deepEqual(STAGES, ['plan', 'build', 'review', 'finish', 'merge', 'done', 'dropped']);
  assert.deepEqual(STATUSES, ['ready', 'blocked', 'Martin']);
  assert.match(parseGoal(withGoal(GOAL_TEXT, { stage: 'started' })).problems.join(), /^stage: one of plan, build, review, finish, merge, done, dropped, not started$/u);
  assert.match(parseGoal(withGoal(GOAL_TEXT, { status: 'started' })).problems.join(), /^status: one of ready, blocked, Martin, not started$/u);
  assert.match(parseGoal(withGoal(GOAL_TEXT, { status: undefined })).problems.join(), /status: .*not missing/u);
  assert.match(parseGoal(withGoal(GOAL_TEXT, { stage: undefined })).problems.join(), /stage: .*not missing/u);
  // No status of before stages is one now: open, review, waiting are refused, and say how to convert.
  for (const old of ['open', 'review', 'waiting', 'blocked']) {
    assert.equal(parseGoal(withGoal(GOAL_TEXT, { stage: undefined, status: old })).problems.join(), `stage: missing — goals have a stage now; mc goal convert gives this ${old} goal one`, old);
    if (old !== 'blocked') assert.match(parseGoal(withGoal(GOAL_TEXT, { status: old })).problems.join(), /^status: one of ready, blocked/u, `${old} beside a stage`);
  }
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

test('GOAL.json checks its criteria with the shared validator of criteria.js', () => {
  const bad = [{ criterion: 'it works', met: false }];
  const fromGoal = validateGoal({ ...JSON.parse(GOAL_TEXT), success_criteria: bad });
  const shared = [];
  criteria.validateCriteria(bad, shared);
  assert.deepEqual(fromGoal, shared);
});

test('renderGoal writes every key in order, so a parsed goal renders as it was; an invalid goal is never rendered', () => {
  const goal = parseGoal(GOAL_TEXT);
  assert.equal(renderGoal(goal), GOAL_TEXT);
  assert.equal(renderGoal({ ...goal, status: 'blocked' }), withGoal(GOAL_TEXT, { status: 'blocked' }));
  assert.deepEqual(Object.keys(JSON.parse(renderGoal(goal))).slice(0, 5), ['schema', 'version', 'stage', 'status', 'phase']);
  assert.throws(() => renderGoal({ ...goal, status: 'maybe' }), /GOAL\.json would not validate: status/u);
  assert.throws(() => renderGoal({ ...goal, stage: 'open' }), /GOAL\.json would not validate: stage/u);
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
  assert.deepEqual(log[0], { at: '2026-11-01T20:00Z', tool: 'person', model: null, stage: 'plan', status: 'ready', role: null, done: 'created', comment: null, next: null });
  assert.deepEqual(log[1], {
    at: '2026-11-01T21:30Z', tool: 'claude', model: 'claude-opus-5-5', stage: 'build', status: 'ready', role: null,
    done: 'the reader\nand its tests, over two paragraphs', comment: 'none yet', next: 'the verbs',
  });
  assert.deepEqual(log[2], { at: '2026-11-01T22:00Z', tool: 'runner', model: null, stage: 'build', status: 'ready', role: null, done: null, comment: 'no session ran', next: null });
});

test('parseLog reads an entry written before stages with its old status and no stage', () => {
  const [entry] = parseLog('## 2026-11-01T20:00Z · claude opus · review\n\nDone: built\n');
  assert.deepEqual([entry.model, entry.stage, entry.status], ['opus', null, 'review']);
  assert.equal(renderEntry(entry), '## 2026-11-01T20:00Z · claude opus · review\n\nDone: built\n', 'written back as it was');
});

test('parseLog reads the by segment as the writer\'s role; the three old forms read as before, with role null', () => {
  const log = parseLog([
    '## 2026-11-01T19:00Z · person · done\n\nDone: closed\n',
    '## 2026-11-01T20:00Z · claude opus · review\n\nDone: built\n',
    '## 2026-11-01T21:00Z · person · plan · ready\n\nDone: created\n',
    '## 2026-11-01T22:00Z · claude opus · build · ready · by build\n\nDone: next\nNext: the page\n',
    '## 2026-11-01T23:00Z · claude · review · ready · by review\n\nDone: looked\n',
  ].join('\n'));
  assert.deepEqual(log.map(({ stage, status, role }) => [stage, status, role]), [
    [null, 'done', null], [null, 'review', null], ['plan', 'ready', null], ['build', 'ready', 'build'], ['review', 'ready', 'review'],
  ]);
  assert.deepEqual(log[3], { at: '2026-11-01T22:00Z', tool: 'claude', model: 'opus', stage: 'build', status: 'ready', role: 'build', done: 'next', comment: null, next: 'the page' });
  assert.equal(renderEntry(log[3]), '## 2026-11-01T22:00Z · claude opus · build · ready · by build\n\nDone: next\nNext: the page\n', 'written back with its segment');
  assert.equal(renderEntry(log[1]), '## 2026-11-01T20:00Z · claude opus · review\n\nDone: built\n', 'an old heading is written back as it was');
  assert.equal(sessions(log), 3, 'a session is any entry but the runner\'s and a person\'s');
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
  const entry = { at: '2026-11-01T23:00Z', tool: 'claude', model: 'claude-haiku-5-5', stage: 'build', status: 'blocked', done: 'part', comment: null, next: 'the rest' };
  const text = appendLog(LOG_TEXT, entry);
  assert.equal(text, `${LOG_TEXT.trimEnd()}\n\n${renderEntry(entry)}`);
  assert.match(text, /^## 2026-11-01T23:00Z · claude claude-haiku-5-5 · build · blocked\n\nDone: part\nNext: the rest\n$/mu);
  assert.equal(appendLog('', { at: '2026-11-01T20:00Z', tool: 'person', model: null, stage: 'plan', status: 'ready', done: 'created', comment: 'c', next: null }), '## 2026-11-01T20:00Z · person · plan · ready\n\nDone: created\nComment: c\n');
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
  assert.equal(stageWords(goals[0]), 'build · ready');
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
  assert.equal(goals[2].stage, null);
  assert.equal(goals[2].log.length, 3);
});

test('setGoalState rewrites the stage or status and appends the entry with both, in one call; nothing is written for a value unknown or a goal that does not parse', () => {
  const dir = goalDirIn('/p', 'mc', 'plain');
  const { store, read, write } = model({ [`${dir}/${GOAL_FILE}`]: GOAL_TEXT, [`${dir}/${LOG_FILE}`]: LOG_TEXT });
  const entry = { at: '2026-11-02T08:00Z', tool: 'claude', model: 'claude-sonnet-5-5', done: null, comment: 'waits for Martin', next: null };
  const blocked = setGoalState({ dir, status: 'blocked', entry, read, write });
  assert.deepEqual([blocked.goal.stage, blocked.goal.status, blocked.from], ['build', 'blocked', 'build'], 'a status keeps the stage');
  assert.equal(store[`${dir}/${GOAL_FILE}`], withGoal(GOAL_TEXT, { status: 'blocked' }));
  assert.equal(store[`${dir}/${LOG_FILE}`], appendLog(LOG_TEXT, { ...entry, stage: 'build', status: 'blocked' }));
  const moved = setGoalState({ dir, stage: 'review', entry, read, write });
  assert.deepEqual([moved.goal.stage, moved.goal.status], ['review', 'ready'], 'a stage moved to is ready unless told otherwise');
  assert.equal(parseLog(store[`${dir}/${LOG_FILE}`]).at(-1).stage, 'review');

  const before = { ...store };
  assert.deepEqual(setGoalState({ dir, stage: 'open', entry, read, write }).problems, ['stage: one of plan, build, review, finish, merge, done, dropped, not open']);
  assert.deepEqual(setGoalState({ dir, status: 'waiting', entry, read, write }).problems, ['status: one of ready, blocked, Martin, not waiting']);
  assert.deepEqual(store, before, 'nothing written');
  const refused = model({ [`${dir}/${GOAL_FILE}`]: 'nothing here' });
  assert.ok(setGoalState({ dir, stage: 'done', entry, read: refused.read, write: refused.write }).problems);
  assert.equal(refused.store[`${dir}/${GOAL_FILE}`], 'nothing here');
  assert.equal(refused.store[`${dir}/${LOG_FILE}`], undefined);
});

test('backward: an earlier stage, or out of done or dropped; staying, forward and dropping are not', () => {
  assert.equal(backward('review', 'build'), true);
  assert.equal(backward('merge', 'review'), true);
  assert.equal(backward('finish', 'plan'), true);
  assert.equal(backward('done', 'merge'), true);
  assert.equal(backward('dropped', 'done'), true);
  for (const [from, to] of [['plan', 'build'], ['build', 'review'], ['review', 'finish'], ['review', 'merge'], ['finish', 'merge'], ['merge', 'done'], ['build', 'dropped'], ['build', 'build'], ['plan', 'merge']]) {
    assert.equal(backward(from, to), false, `${from} → ${to}`);
  }
});

test('appendEntry adds to LOG.md alone, and starts it when there is none', () => {
  const { store, read, write } = model({});
  appendEntry({ dir: '/p/mc/goals/plain', entry: { at: '2026-11-01T20:00Z', tool: 'person', model: null, stage: 'plan', status: 'ready', done: 'created', comment: null, next: null }, read, write });
  assert.equal(store['/p/mc/goals/plain/LOG.md'], '## 2026-11-01T20:00Z · person · plan · ready\n\nDone: created\n');
});

test('lastBuildEntry is the last entry a build session wrote: not the runner\'s, a person\'s or a review\'s', () => {
  const log = parseLog([
    '## 2026-11-02T09:00Z · person · plan · ready', '', 'Done: created', '',
    '## 2026-11-02T10:00Z · claude opus · review · ready', '', 'Done: built', '',
    '## 2026-11-02T11:00Z · codex gpt-6.1-sol · finish · ready', '', 'Done: REVIEW.md, proposal', '',
    '## 2026-11-02T12:00Z · runner · finish · ready', '', 'Comment: x', '',
  ].join('\n'));
  assert.equal(lastBuildEntry(log).model, 'opus');
  assert.equal(lastBuildEntry(log.slice(0, 1)), null);
  // A log from before stages: a review's verdict is no build entry.
  const old = parseLog('## 2026-11-02T10:00Z · claude opus · review\n\nDone: built\n\n## 2026-11-02T11:00Z · codex sol · blocked\n\nDone: red abc1234\n');
  assert.equal(lastBuildEntry(old).model, 'opus');
  // An entry that names another role is no build entry: a plan's stage entry moved the goal to build, a review's is a review's.
  const byPlan = [
    '## 2026-11-03T09:00Z · person · plan · ready', '', 'Done: created', '',
    '## 2026-11-03T10:00Z · claude opus · build · ready · by plan', '', 'Done: the plan', '',
    '## 2026-11-03T11:00Z · claude opus · review · ready · by review', '', 'Done: judged', '',
  ].join('\n');
  assert.equal(lastBuildEntry(parseLog(byPlan)), null);
  const builtAfter = `${byPlan}\n## 2026-11-03T12:00Z · codex gpt-6.1-sol · review · ready · by build\n\nDone: built\n`;
  assert.equal(lastBuildEntry(parseLog(builtAfter)).model, 'gpt-6.1-sol');
});

/** A goal as `programsGoals` gives it, in `stage · status`, with `log`. */
const staged = (stage, status = 'ready', log = [], extra = {}) => ({ programme: 'p', goal: 'g', stage, status, repos: ['memoro'], problems: [], prs: [], log, success_criteria: [{ criterion: 'x', check: 'y', met: false }], ...extra });
const said = (tool, stage, done, comment = null) => ({ at: '2026-11-02T10:00Z', tool, model: null, stage, status: 'ready', done, comment, next: null });

test('goalSession: build · ready is a build, review · ready a review, finish · ready a finish, merge · ready after a red a mend, blocked in any stage a mend; never plan · ready, never Martin', () => {
  assert.equal(goalSession(staged('build')), 'build');
  assert.equal(goalSession(staged('build', 'ready', [], { success_criteria: [] })), null, 'no criterion yet: not started');
  assert.equal(goalSession(staged('review')), 'review');
  assert.equal(goalSession(staged('finish')), 'finish');
  assert.equal(goalSession(staged('merge')), null, 'in the merger\'s hands');
  const red = (kind) => staged('merge', 'ready', [said('runner', 'merge', redMergeText(12, kind))], { prs: [{ repo: 'memoro', pr: 12 }] });
  assert.equal(goalSession(red('red')), 'mend');
  assert.equal(goalSession(red('moved')), 'mend', 'a moved head the same');
  assert.equal(goalSession(red('red'), [{ repo: 'memoro', pr: 12, state: 'queued' }]), null, 'queued again: the merger\'s');
  for (const stage of STAGES) {
    assert.equal(goalSession(staged(stage, 'Martin')), null, `${stage} · Martin`);
    assert.equal(goalSession(staged(stage, 'blocked')), ['done', 'dropped'].includes(stage) ? null : 'mend', `${stage} · blocked`);
  }
  for (const stage of ['plan', 'done', 'dropped']) assert.equal(goalSession(staged(stage)), null, stage);
  assert.equal(goalSession({ ...staged('build'), problems: ['x'] }), null);
});

test('the merger\'s red, inStage and a review that died before', () => {
  assert.equal(redMergeText(31), 'merger answered red on #31');
  assert.equal(mergeAnswered(said('runner', 'merge', redMergeText(31))), true);
  assert.equal(mergeAnswered(said('claude', 'merge', redMergeText(31))), false, 'only the runner\'s');
  const log = [said('claude', 'build', 'x'), said('runner', 'review', null, `${REVIEW_DIED_TEXT} — a review runs again`), said('runner', 'review', null, 'y')];
  assert.equal(inStage(log, 'review').length, 2);
  assert.equal(inStage(log, 'build').length, 0, 'only the entries at the end');
  assert.equal(reviewDiedBefore(log), true);
  assert.equal(reviewDiedBefore(log.slice(0, 1)), false);
  assert.equal(mergeRetryDue(staged('merge', 'blocked', [said('runner', 'merge', redMergeText(1))])), false);
});

test('nextGoal takes the goals the runner starts, oldest first, and leaves out what may refuses', () => {
  const goal = (name, stage, at, status = 'ready') => ({ ...staged(stage, status, [{ at, tool: 'claude', done: 'x' }]), goal: name });
  const goals = [goal('a', 'build', '2026-11-02T12:00Z'), goal('b', 'review', '2026-11-02T10:00Z'), goal('c', 'build', '2026-11-01T10:00Z', 'Martin'), goal('d', 'plan', '2026-11-01T09:00Z')];
  assert.equal(nextGoal(goals, { repos: ['memoro'] }).goal, 'b');
  assert.equal(nextGoal(goals, { repos: ['memoro'], may: (g) => g.stage !== 'review' }).goal, 'a');
  const bare = [{ ...goal('a', 'build', '2026-11-02T12:00Z'), success_criteria: [] }];
  assert.equal(nextGoal(bare, { repos: ['memoro'] }), null);
});

test('waitsOnPerson: Martin, in any stage that is not finished', () => {
  for (const stage of ['plan', 'build', 'review', 'finish', 'merge']) assert.equal(waitsOnPerson(staged(stage, 'Martin')), true, stage);
  assert.equal(waitsOnPerson(staged('build')), false);
  assert.equal(waitsOnPerson(staged('done', 'blocked')), false);
});

/* ------------------------------------------------------------- phases */

/** A goal as `programsGoals` gives it, for the phase tests. */
const listed = (name, stage, phase = 1, extra = {}) => {
  const [programme, goal] = name.split('/');
  return { programme, goal, dir: `/p/${programme}/goals/${goal}`, stage, status: 'ready', phase, repos: ['memoro-cli'], class: 'large', log: [], problems: [], success_criteria: [{ criterion: 'x', check: 'y', met: false }], ...extra };
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
  assert.match(parseGoal(withGoal(GOAL_TEXT, { stage: undefined, status: 'waiting' })).problems.join(), /stage: missing — .*mc goal convert/u);
});

test('the phase a programme is in is the lowest of its unfinished goals; done and dropped both finish one', () => {
  const goals = [listed('mc/a', 'done'), listed('mc/b', 'dropped'), listed('mc/c', 'build', 2), listed('mc/d', 'blocked', 3), listed('other/e', 'build')];
  assert.equal(currentPhase(goals, 'mc'), 2);
  assert.equal(currentPhase(goals, 'other'), 1);
  assert.equal(currentPhase([listed('mc/a', 'done')], 'mc'), null);
  assert.equal(currentPhase([listed('mc/a', 'build'), { ...listed('mc/broken', null, null), problems: ['x'] }], 'mc'), 1, 'a goal that does not parse holds nothing back');
});

test('a goal in phase 2 is not picked while a goal in phase 1 is in build, review, finish or merge; it is when all are done or dropped; one phase runs side by side', () => {
  for (const status of ['build', 'review', 'finish', 'merge']) {
    const goals = [listed('mc/first', status, 1, { repos: ['memoro'] }), listed('mc/second', 'build', 2)];
    assert.equal(phaseOpen(goals[1], goals), false, status);
    assert.equal(nextGoal(goals, { repos: ['memoro-cli'] }), null, `not picked while phase 1 is ${status}`);
  }
  const finished = [listed('mc/first', 'done', 1, { repos: ['memoro'] }), listed('mc/gone', 'dropped', 1), listed('mc/second', 'build', 2)];
  assert.equal(nextGoal(finished, { repos: ['memoro-cli'] }).goal, 'second', 'picked once phase 1 is done or dropped');
  const side = [listed('mc/a', 'build'), listed('mc/b', 'build'), listed('mc/later', 'build', 2)];
  assert.equal(nextGoal(side, { repos: ['memoro-cli'] }).goal, 'a');
  assert.equal(nextGoal(side, { repos: ['memoro-cli'], held: new Set(['goal:mc/a']) }).goal, 'b', 'the second of phase 1 runs while the first is held');
  assert.equal(nextGoal(side, { repos: ['memoro-cli'], held: new Set(['goal:mc/a', 'goal:mc/b']) }), null, 'phase 2 still waits');
  assert.equal(phaseOpen(listed('other/x', 'build', 2), side), true, 'another programme\'s phases do not hold it');
});

test('phaseMoves renumbers each programme so the lowest phase is 1 and there are no holes', () => {
  const goals = [listed('mc/b', 'build', 2), listed('mc/c', 'build', 3), listed('mc/c2', 'build', 3), listed('mc/e', 'build', 5), listed('other/x', 'build', 1)];
  assert.deepEqual(phaseMoves(goals).map((move) => [move.goal.goal, move.from, move.to]), [['b', 2, 1], ['c', 3, 2], ['c2', 3, 2], ['e', 5, 3]]);
  assert.deepEqual(phaseMoves([listed('mc/a', 'build'), listed('mc/b', 'done', 2)]), [], 'nothing to move');
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

test('prsLanded: done when one landed and every other is closed or landed; open or unknown is not', async () => {
  const { prsLanded } = await import('../../src/mc/goals.js');
  const prs = [{ repo: 'memoro', pr: 1 }, { repo: 'memoro-cli', pr: 2 }];
  const states = (map) => ({ repo, pr }) => map[`${repo}#${pr}`] ?? null;
  assert.equal(prsLanded(prs, states({ 'memoro#1': 'MERGED', 'memoro-cli#2': 'MERGED' })).done, true);
  const settled = prsLanded(prs, states({ 'memoro#1': 'MERGED', 'memoro-cli#2': 'CLOSED' }));
  assert.equal(settled.done, true, 'a closed pull request is settled');
  assert.deepEqual(settled.closed, ['memoro-cli#2']);
  assert.equal(prsLanded(prs, states({ 'memoro#1': 'MERGED', 'memoro-cli#2': 'OPEN' })).done, false);
  assert.equal(prsLanded(prs, states({ 'memoro#1': 'MERGED' })).done, false, 'unknown is not done');
  assert.equal(prsLanded(prs, states({ 'memoro#1': 'CLOSED', 'memoro-cli#2': 'CLOSED' })).done, false, 'nothing landed');
  assert.equal(prsLanded([prs[0]], states({ 'memoro#1': 'CLOSED' })).done, false, 'one closed alone is not done');
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
  const entry = { at: '2026-11-03T09:00Z', tool: 'person', model: null, stage: 'build', status: 'ready', done: 'published memoro#1', comment: null, next: null };
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

test('stageSince is the entry that set the current stage, not a later entry that kept it; an entry from before stages counts by its done or dropped', async () => {
  const { stageSince } = await import('../../src/mc/goals.js');
  const log = [
    { at: '2026-11-01T10:00Z', stage: 'merge', status: 'ready' },
    { at: '2026-11-02T10:00Z', stage: 'done', status: 'ready' },
    { at: '2026-11-03T10:00Z', stage: 'done', status: 'ready' },
  ];
  assert.equal(stageSince({ stage: 'done', log }), '2026-11-02T10:00Z');
  assert.equal(stageSince({ stage: 'dropped', log }), null, 'a stage the log does not hold');
  assert.equal(stageSince({ stage: 'done', log: [] }), null);
  assert.equal(stageSince({ stage: 'merge', log }), null, 'the last entry is another stage: none began it');
  assert.equal(stageSince({ stage: 'done', log: [{ at: '2026-10-01T10:00Z', stage: null, status: 'done' }] }), '2026-10-01T10:00Z');
});

// Existing goals must remain runnable after the public stage is renamed.
test('legacy merging records and log headings read as merge and write the new stage', () => {
  const goal = parseGoal(withGoal(GOAL_TEXT, { stage: 'merging' }));
  assert.equal(goal.stage, 'merge');
  assert.equal(JSON.parse(renderGoal(goal)).stage, 'merge');
  const log = parseLog('## 2026-11-01T20:00Z · runner · merging · ready\n\nDone: merger answered red on #31\n');
  assert.equal(log[0].stage, 'merge');
  assert.equal(mergeRetryDue({ ...goal, log }), true);
});
