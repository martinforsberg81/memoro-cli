import assert from 'node:assert/strict';
import { test } from 'node:test';
import { itemDirectory } from '../../src/mc/desk-items.js';
import { goalCount, programmeDue, readTurnState, recordTurnFailure, turnName, turnStatePath } from '../../src/mc/programme-turn.js';

/**
 * The programme planning turn's model-free state rules (docs/technical/mc-run.md,
 * "Programme planning turn"): what is due, what the state file means, and what
 * the second failure opens. The runner's own seam tests live in run.test.js.
 */

const HOME = '/p';
const ROOT = '/w';
const RECORD = JSON.stringify({ schema: 'mc-programme', version: 1, horizon: null, end: 'Done when it holds.', state: 'open', created: '2026-11-14T10:20:30Z', created_by: 'person' });

/** An in-memory store: `files` by path; `list` of a directory is its entry names. */
function store(files = {}) {
  const read = (path) => files[path] ?? null;
  const list = (dir) => [...new Set(Object.keys(files).filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1).split('/')[0]))];
  return { files, read, list, write: (path, text) => { files[path] = text; }, writeJson: (path, value) => { files[path] = JSON.stringify(value); }, lock: (root, fn) => fn() };
}
const programmeStore = (extra = {}) => store({ [`${HOME}/prog/PROGRAMME.json`]: RECORD, [`${HOME}/prog/README.md`]: '# prog\n', ...extra });
const due = (s, options = {}) => programmeDue({ programme: 'prog', home: HOME, list: s.list, read: s.read, state: { status: 'none' }, ...options });
const fail = (s, at, reason = 'planning session exited 0 with the programme holding no goal (x)') => recordTurnFailure({ root: ROOT, programme: 'prog', reason, log: `/l/${at}.jsonl`, at, read: s.read, write: s.write, writeJson: s.writeJson, lock: s.lock, env: { MC_WORK_ROOT: ROOT }, itemDirectory });
const stateOf = (s) => JSON.parse(s.files[turnStatePath(ROOT, 'prog')]);

test('programme turn: a programme is due with a valid open record and a README and nothing in goals/ but dot-entries', () => {
  assert.equal(due(programmeStore()).due, true);
  assert.equal(due(programmeStore({ [`${HOME}/prog/goals/.hold.json`]: '{}' })).due, true);
  for (const [kind, extra] of [['a goal', { [`${HOME}/prog/goals/g/GOAL.json`]: '{}' }], ['a goal directory with no goal file', { [`${HOME}/prog/goals/g/LOG.md`]: '' }], ['an archived goal', { [`${HOME}/prog/goals/.archive/old/LOG.md`]: '' }]]) {
    const answer = due(programmeStore(extra));
    assert.deepEqual([answer.due, answer.reason], [false, 'it holds goals'], kind);
  }
  assert.equal(goalCount({ home: HOME, programme: 'prog', list: programmeStore({ [`${HOME}/prog/goals/g/GOAL.json`]: '{}', [`${HOME}/prog/goals/.archive/old/LOG.md`]: '' }).list }), 2);
  assert.equal(turnName('prog'), 'programme:prog');
});

test('programme turn: no record, a README or an open record is not due, and a horizon that is not open says so', () => {
  const noReadme = programmeStore(); delete noReadme.files[`${HOME}/prog/README.md`];
  assert.equal(due(noReadme).reason, 'it has no README.md');
  assert.equal(due(store({ [`${HOME}/prog/README.md`]: '#' })).reason, 'no record');
  assert.equal(due(store({ [`${HOME}/prog/PROGRAMME.json`]: '{ x', [`${HOME}/prog/README.md`]: '#' })).reason, 'its record is invalid');
  const horizonRecord = JSON.stringify({ ...JSON.parse(RECORD), horizon: 'h' });
  const withHorizon = () => programmeStore({ [`${HOME}/prog/PROGRAMME.json`]: horizonRecord });
  assert.equal(due(withHorizon(), { horizon: () => ({ state: 'open' }) }).due, true);
  const reached = due(withHorizon(), { horizon: () => ({ state: 'reached' }) });
  assert.deepEqual([reached.due, reached.notice], [false, 'prog: its horizon h reads reached — no planning turn is started while that lasts']);
  assert.match(due(withHorizon()).notice, /is missing or unreadable/u);
  const open = due(programmeStore(), { items: [{ kind: 'programme', reference: 'programme:prog', state: 'for-martin' }] });
  assert.deepEqual([open.due, open.reason], [false, 'a programme desk item is open']);
  assert.equal(due(programmeStore(), { items: [{ kind: 'programme', reference: 'programme:prog', state: 'closed' }, { kind: 'programme', reference: 'programme:other', state: 'prepared' }] }).due, true);
});

test('programme turn: a missing state file reads as no failures, an unreadable one starts no turn', () => {
  const s = programmeStore();
  assert.deepEqual(readTurnState({ root: ROOT, programme: 'prog', read: s.read }), { status: 'none' });
  for (const text of ['{ x', '[]', JSON.stringify({ schema: 'mc-programme-turn', version: 1, programme: 'other', failures: [], items: [] }), JSON.stringify({ schema: 'mc-programme-turn', version: 1, programme: 'prog', failures: [{ at: 1 }], items: [] })]) {
    const bad = programmeStore({ [turnStatePath(ROOT, 'prog')]: text });
    const found = readTurnState({ root: ROOT, programme: 'prog', read: bad.read });
    assert.equal(found.status, 'unreadable', text);
    const answer = due(bad, { state: found });
    assert.deepEqual([answer.due, answer.reason], [false, 'its turn state is unreadable'], text);
    assert.match(answer.notice, /runner\/programme-turn\/prog\.json is unreadable \(/u);
    assert.throws(() => fail(bad, '2026-11-15T10:00:00Z'), /is unreadable/u, 'counting a failure on it is refused');
    assert.equal(bad.files[turnStatePath(ROOT, 'prog')], text, 'and nothing is rewritten');
  }
});

test('programme turn: the first failure is kept, the second opens a prepared item, the next two a for-martin brief', () => {
  const s = programmeStore();
  const first = fail(s, '2026-11-15T10:00:00Z', 'reason one');
  assert.deepEqual([first.count, first.item], [1, null]);
  assert.equal(stateOf(s).failures.length, 1);
  assert.deepEqual(Object.keys(s.files).filter((path) => path.startsWith(`${ROOT}/martin/`)), [], 'the first opens nothing');

  const second = fail(s, '2026-11-15T10:05:00Z', 'reason two');
  assert.equal(second.count, 2);
  const item = second.item;
  assert.deepEqual([item.kind, item.reference, item.state, item.sort, item.reversible, item.due_at, item.outcome], ['programme', 'programme:prog', 'prepared', 'mechanical', null, null, null]);
  const dir = itemDirectory(item, { MC_WORK_ROOT: ROOT });
  const prepared = s.files[`${dir}/prepared.md`];
  for (const text of ['reason one', 'reason two', '/l/2026-11-15T10:00:00Z.jsonl', '/l/2026-11-15T10:05:00Z.jsonl']) assert.ok(prepared.includes(text), text);
  assert.ok(`${dir}/item.json` in s.files);
  assert.equal(`${dir}/brief.md` in s.files, false);
  assert.deepEqual(stateOf(s).items, [{ id: item.id, opened_at: '2026-11-15T10:05:00Z' }]);

  // The item closed by decision, the failures that count again start after it.
  assert.equal(fail(s, '2026-11-15T11:00:00Z').item, null, 'one failure since the item opens nothing');
  const third = fail(s, '2026-11-15T11:05:00Z');
  assert.equal(third.count, 2);
  const later = third.item;
  assert.deepEqual([later.state, later.sort, later.reversible, later.due_at], ['for-martin', 'mechanical', false, null]);
  assert.notEqual(later.id, item.id);
  const brief = s.files[`${itemDirectory(later, { MC_WORK_ROOT: ROOT })}/brief.md`];
  assert.match(brief, /^## Vad det gäller\n/u);
  assert.match(brief, /## Rekommendation och skäl\n/u);
  assert.equal(`${itemDirectory(later, { MC_WORK_ROOT: ROOT })}/prepared.md` in s.files, false);
  assert.equal(stateOf(s).items.length, 2);
});
