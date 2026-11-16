import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { itemDirectory } from '../../src/mc/desk-items.js';
import { cutProblems, cuttable, finishTurn, goalCount, partsCut, partsNamed, programmeDue, readTurnState, recordTurnFailure, signedParts, turnName, turnStatePath } from '../../src/mc/programme-turn.js';
import { goalJson } from './_helpers/goal-file.js';

/**
 * The programme planning turn's model-free state rules (docs/technical/mc-run.md,
 * "Programme planning turn"): what is due, what the state file means, and what
 * the second failure opens. The runner's own seam tests live in run.test.js.
 */

const HOME = '/p';
const ROOT = '/w';
const SIGNED_MD = '# prog\n\n## Parts\n\n### Part 1 — One\n\n### Part 2 — Two\n';
const SIGNED_SHA = createHash('sha256').update(SIGNED_MD).digest('hex');
const SIGNED_AT = `${HOME}/prog/SIGNED.md`;
const BASE = { schema: 'mc-programme', version: 2, horizon: null, end: 'Done when it holds.', state: 'open', created: '2026-11-14T10:20:30Z', created_by: 'person', signed_at: '2026-11-14T11:00:00Z', signed_by: 'martin', signed_text: SIGNED_SHA, cut_text: null };
const RECORD = JSON.stringify(BASE);
const RECORD_AT = `${HOME}/prog/PROGRAMME.json`;
const recordOf = (changes) => JSON.stringify({ ...BASE, ...changes });
const UNSIGNED = { signed_at: null, signed_by: null, signed_text: null };
const OTHER_SHA = 'a'.repeat(64);
const goalNaming = (...labels) => goalJson({ documents: labels.map((label) => ({ label, path: SIGNED_AT })) });
const goalAt = (name, text, archived = false) => ({ [`${HOME}/prog/goals/${archived ? '.archive/' : ''}${name}/GOAL.json`]: text });

/** An in-memory store: `files` by path; `list` of a directory is its entry names. */
function store(files = {}) {
  const read = (path) => files[path] ?? null;
  const list = (dir) => [...new Set(Object.keys(files).filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1).split('/')[0]))];
  return { files, read, list, write: (path, text) => { files[path] = text; }, writeJson: (path, value) => { files[path] = JSON.stringify(value); }, lock: (root, fn) => fn() };
}
const programmeStore = (extra = {}) => store({ [RECORD_AT]: RECORD, [`${HOME}/prog/README.md`]: '# prog\n', [SIGNED_AT]: SIGNED_MD, ...extra });
const due = (s, options = {}) => programmeDue({ programme: 'prog', home: HOME, list: s.list, read: s.read, state: { status: 'none' }, ...options });
const fail = (s, at, reason = 'planning session exited 0 with the programme holding no goal (x)') => recordTurnFailure({ root: ROOT, programme: 'prog', reason, log: `/l/${at}.jsonl`, at, read: s.read, write: s.write, writeJson: s.writeJson, lock: s.lock, env: { MC_WORK_ROOT: ROOT }, itemDirectory });
const stateOf = (s) => JSON.parse(s.files[turnStatePath(ROOT, 'prog')]);

test('programme turn: a signed open programme is due while its signature is not cut, whatever goals it holds', () => {
  assert.equal(due(programmeStore()).due, true);
  assert.equal(due(programmeStore({ [`${HOME}/prog/goals/.hold.json`]: '{}' })).due, true);
  for (const [kind, extra] of [['a goal', goalAt('g', '{}')], ['a goal directory with no goal file', { [`${HOME}/prog/goals/g/LOG.md`]: '' }], ['an archived goal', { [`${HOME}/prog/goals/.archive/old/LOG.md`]: '' }]]) {
    assert.equal(due(programmeStore(extra)).due, true, `${kind} does not stop a turn on an uncut signature`);
  }
  assert.equal(goalCount({ home: HOME, programme: 'prog', list: programmeStore({ ...goalAt('g', '{}'), [`${HOME}/prog/goals/.archive/old/LOG.md`]: '' }).list }), 2);
  assert.equal(turnName('prog'), 'programme:prog');
  // A cut_text from an older signature lags: the programme is due again after a re-sign, though the earlier cut stands.
  assert.equal(due(programmeStore({ [RECORD_AT]: recordOf({ cut_text: OTHER_SHA }) })).due, true);
});

test('programme turn: a draft, a done or dropped record, a legacy or area record without signature and one cut from its signature are not due', () => {
  const table = [
    ['draft', recordOf({ state: 'draft', ...UNSIGNED, cut_text: null }), 'its record reads draft'],
    ['draft that kept an earlier cut', recordOf({ state: 'draft', ...UNSIGNED, cut_text: OTHER_SHA }), 'its record reads draft'],
    ['done', recordOf({ state: 'done' }), 'its record reads done'],
    ['dropped', recordOf({ state: 'dropped', ...UNSIGNED }), 'its record reads dropped'],
    ['legacy v1', JSON.stringify({ schema: 'mc-programme', version: 1, horizon: null, end: 'Done when it holds.', state: 'open', created: '2026-11-14T10:20:30Z', created_by: 'person' }), 'its record carries no signature to cut from'],
    ['legacy v2', recordOf({ ...UNSIGNED, legacy: true }), 'its record carries no signature to cut from'],
    ['area repair', recordOf({ ...UNSIGNED, area: 'memoro/system' }), 'its record carries no signature to cut from'],
    ['cut', recordOf({ cut_text: SIGNED_SHA }), 'it is cut from its current signature'],
  ];
  for (const [kind, record, reason] of table) {
    const answer = due(programmeStore({ [RECORD_AT]: record }));
    assert.deepEqual([answer.due, answer.reason], [false, reason], kind);
  }
  assert.equal(cuttable(BASE), true);
  assert.equal(cuttable({ ...BASE, signed_text: null, legacy: true }), false);
  assert.equal(cuttable({ ...BASE, state: 'draft' }), false);
});

test('programme turn: no record or README is not due, a horizon that is not open says so, and an open desk item holds the turn', () => {
  const noReadme = programmeStore(); delete noReadme.files[`${HOME}/prog/README.md`];
  assert.equal(due(noReadme).reason, 'it has no README.md');
  assert.equal(due(store({ [`${HOME}/prog/README.md`]: '#' })).reason, 'no record');
  assert.equal(due(store({ [RECORD_AT]: '{ x', [`${HOME}/prog/README.md`]: '#' })).reason, 'its record is invalid');
  const withHorizon = () => programmeStore({ [RECORD_AT]: recordOf({ horizon: 'h' }) });
  assert.equal(due(withHorizon(), { horizon: () => ({ state: 'open' }) }).due, true);
  const reached = due(withHorizon(), { horizon: () => ({ state: 'reached' }) });
  assert.deepEqual([reached.due, reached.notice], [false, 'prog: its horizon h reads reached — no planning turn is started while that lasts']);
  assert.match(due(withHorizon()).notice, /is missing or unreadable/u);
  const open = due(programmeStore(), { items: [{ kind: 'programme', reference: 'programme:prog', state: 'for-martin' }] });
  assert.deepEqual([open.due, open.reason], [false, 'a programme desk item is open']);
  assert.equal(due(programmeStore(), { items: [{ kind: 'programme', reference: 'programme:prog', state: 'closed' }, { kind: 'programme', reference: 'programme:other', state: 'prepared' }] }).due, true);
});

test('signed document coverage: part headings come from the Parts entry, and a goal names a part only by an explicit label on a document that points at SIGNED.md', () => {
  assert.deepEqual(signedParts(SIGNED_MD), [1, 2]);
  assert.deepEqual(signedParts('## Parts\n\n```\n### Part 9 — Fenced\n```\n\n### Part 3 — Real\n\n## Else\n\n### Part 4 — Outside\n'), [3], 'a fenced example and a heading outside the entry do not count');
  assert.deepEqual(signedParts('### Part 1 — x\n'), [], 'no Parts entry names no part');
  assert.deepEqual([...partsNamed('Signed design, Part 1; Part 2')], [1, 2]);
  assert.deepEqual([...partsNamed('Parts 1, 2 and 4')], [1, 2, 4]);
  assert.deepEqual([...partsNamed('Parts 1-3')], [1], 'no range is read');
  assert.deepEqual([...partsNamed('The design, section 2 and part-two')], [], 'only an explicit Part n counts');
  assert.deepEqual([...partsNamed(undefined)], []);

  const cover = (goals) => { const s = programmeStore(goals); return [...partsCut({ home: HOME, programme: 'prog', list: s.list, read: s.read })].sort(); };
  assert.deepEqual(cover({}), [], 'no goal names nothing');
  assert.deepEqual(cover(goalAt('one', goalNaming('Signed design, Part 1'))), [1], 'one goal does not consume a two-part document');
  assert.deepEqual(cover({ ...goalAt('one', goalNaming('Part 1')), ...goalAt('two', goalNaming('Part 2')) }), [1, 2]);
  assert.deepEqual(cover({ ...goalAt('one', goalNaming('Part 1')), ...goalAt('old', goalNaming('Part 2'), true) }), [1, 2], 'an archived goal counts');
  assert.deepEqual(cover({ ...goalAt('one', goalNaming('Part 1')), [`${HOME}/prog/goals/.hold.json`]: '{}' }), [1], 'a dot-entry is no goal');
  const elsewhere = goalJson({ documents: [{ label: 'Part 1', path: `${HOME}/other/SIGNED.md` }, { label: 'Part 2', path: `${HOME}/prog/README.md` }] });
  assert.deepEqual(cover(goalAt('else', elsewhere)), [], 'a document of another path names nothing');
  assert.deepEqual(cover(goalAt('plain', goalNaming('The design'))), [], 'a label with no Part n names nothing');
  assert.deepEqual(cover(goalAt('bad', '{ x')), [], 'a goal that does not parse names nothing');
  assert.deepEqual(cover(goalAt('shape', JSON.stringify({ ...JSON.parse(goalJson()), documents: 'Part 1' }))), [], 'a goal that does not validate names nothing');
});

test('signed document coverage: cutProblems names what keeps the document uncut, and finishTurn writes cut_text only on full coverage', () => {
  const both = goalAt('a', goalNaming('Signed design, Part 1; Part 2'));
  const problems = (s, record = BASE) => cutProblems({ home: HOME, programme: 'prog', record, list: s.list, read: s.read });
  assert.deepEqual(problems(programmeStore(both)), []);
  assert.deepEqual(problems(programmeStore(goalAt('a', goalNaming('Part 1')))), ['no goal names part 2']);
  assert.deepEqual(problems(programmeStore()), ['no goal names parts 1, 2']);
  assert.deepEqual(problems(programmeStore(both), { ...BASE, signed_text: null }), ['the record carries no signature']);
  const missing = programmeStore(both); delete missing.files[SIGNED_AT];
  assert.deepEqual(problems(missing), ['SIGNED.md is missing']);
  assert.deepEqual(problems(programmeStore({ ...both, [SIGNED_AT]: `${SIGNED_MD}x` })), ['SIGNED.md does not match the signature']);
  assert.deepEqual(problems(programmeStore({ ...both, [SIGNED_AT]: '# nothing' }), { ...BASE, signed_text: createHash('sha256').update('# nothing').digest('hex') }), ['SIGNED.md names no part']);

  const finish = (s, signed = SIGNED_SHA, lock = s.lock) => finishTurn({ programme: 'prog', home: HOME, signed, list: s.list, read: s.read, write: s.write, lock, root: ROOT });
  const written = (s) => JSON.parse(s.files[RECORD_AT]);
  const full = programmeStore(both);
  assert.equal(finish(full).kind, 'cut');
  assert.equal(written(full).cut_text, SIGNED_SHA);
  assert.equal(written(full).signed_text, SIGNED_SHA, 'and the signature is as it was');
  assert.equal(due(full).due, false, 'a cut programme is not due again');
  const partial = programmeStore(goalAt('a', goalNaming('Part 1')));
  const incomplete = finish(partial);
  assert.deepEqual([incomplete.kind, incomplete.problems], ['incomplete', ['no goal names part 2']]);
  assert.equal(written(partial).cut_text, null, 'a partial cut writes nothing');
  const resigned = programmeStore(both);
  assert.equal(finish(resigned, 'b'.repeat(64)).kind, 'resigned', 'a signature other than the one launched on is not consumed');
  assert.equal(written(resigned).cut_text, null);
  const returned = programmeStore({ ...both, [RECORD_AT]: recordOf({ state: 'draft', ...UNSIGNED, cut_text: OTHER_SHA }) });
  assert.equal(finish(returned).kind, 'returned', 'a return to draft is an ending of its own');
  assert.equal(written(returned).cut_text, OTHER_SHA, 'and keeps the cut it had');
  for (const [kind, record] of [['done', recordOf({ state: 'done' })], ['dropped', recordOf({ state: 'dropped', ...UNSIGNED })], ['legacy', recordOf({ ...UNSIGNED, legacy: true })]]) {
    const s = programmeStore({ ...both, [RECORD_AT]: record });
    assert.equal(finish(s).kind, 'settled', kind);
    assert.equal(s.files[RECORD_AT], record, `${kind}: nothing written`);
  }
  assert.equal(finish(store({})).kind, 'settled', 'a record that is gone is settled');
  const locked = programmeStore(both);
  const refused = finish(locked, SIGNED_SHA, () => { throw new Error('lock held'); });
  assert.deepEqual([refused.kind, refused.problems], ['failed', ['lock held']]);
  assert.equal(written(locked).cut_text, null);
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
