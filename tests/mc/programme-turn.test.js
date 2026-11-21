import assert from 'node:assert/strict';
import { test } from 'node:test';
import { itemDirectory } from '../../src/mc/desk-items.js';
import { parseGoal, parseLog } from '../../src/mc/goals.js';
import { cutParts, cutProblems, cuttable, goalSlug, goalsNamingNoPart, partBrief, partOfOrder, partsCut, partsNamed, programmeDue, readTurnState, recordTurnFailure, documentParts, partsOrder, turnName, turnStatePath } from '../../src/mc/programme-turn.js';
import { goalJson } from './_helpers/goal-file.js';

/**
 * The cut of a ready order, model-free (docs/technical/mc-run.md, "The cut of a ready order"): what is due, what a
 * part waits for, the goals the cut makes, what a session on one is given, what the state file means, and what the
 * second failure opens. The runner's own seam tests live in run.test.js.
 */

const HOME = '/p';
const ROOT = '/w';
const README_MD = '# prog\n\nRepositories: memoro.\n\n## Parts\n\n### Part 1 — One\n\n### Part 2 — Two\n';
const README_AT = `${HOME}/prog/README.md`;
const BASE = { schema: 'mc-programme', version: 2, horizon: null, end: 'Done when it holds.', state: 'ready', created: '2026-11-14T10:20:30Z', created_by: 'person', phases: { order: 'stated', after: { 2: [1] } } };
const RECORD = JSON.stringify(BASE);
const RECORD_AT = `${HOME}/prog/PROGRAMME.json`;
const recordOf = (changes) => JSON.stringify({ ...BASE, ...changes });
const goalNaming = (...labels) => goalJson({ documents: labels.map((label) => ({ label, path: README_AT })) });
const goalFile = (name, archived = false) => `${HOME}/prog/goals/${archived ? '.archive/' : ''}${name}/GOAL.json`;
const goalAt = (name, text, archived = false) => ({ [goalFile(name, archived)]: text });

/** An in-memory store: `files` by path; `list` of a directory is its entry names. */
function store(files = {}) {
  const read = (path) => files[path] ?? null;
  const list = (dir) => [...new Set(Object.keys(files).filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1).split('/')[0]))];
  return { files, read, list, write: (path, text) => { files[path] = text; }, writeJson: (path, value) => { files[path] = JSON.stringify(value); }, lock: (root, fn) => fn() };
}
const programmeStore = (extra = {}) => store({ [RECORD_AT]: RECORD, [README_AT]: README_MD, ...extra });
const due = (s, options = {}) => programmeDue({ programme: 'prog', home: HOME, list: s.list, read: s.read, state: { status: 'none' }, ...options });
const fail = (s, at, reason = 'the cut could not be made: README.md needs a nonempty Repositories: line') => recordTurnFailure({ root: ROOT, programme: 'prog', reason, log: null, at, read: s.read, write: s.write, writeJson: s.writeJson, lock: s.lock, env: { MC_WORK_ROOT: ROOT }, itemDirectory });
const stateOf = (s) => JSON.parse(s.files[turnStatePath(ROOT, 'prog')]);

test('the cut: a ready programme is due while its parts are not all cut, whatever goals it holds', () => {
  assert.equal(due(programmeStore()).due, true);
  assert.equal(due(programmeStore({ [`${HOME}/prog/goals/.hold.json`]: '{}' })).due, true);
  for (const [kind, extra] of [['a goal', goalAt('g', '{}')], ['a goal directory with no goal file', { [`${HOME}/prog/goals/g/LOG.md`]: '' }], ['an archived goal', { [`${HOME}/prog/goals/.archive/old/LOG.md`]: '' }]]) {
    assert.equal(due(programmeStore(extra)).due, true, `${kind} does not stop the cut of uncut parts`);
  }
  assert.equal(turnName('prog'), 'programme:prog');
});

test('the cut: an order whose record does not state the order its parts give is not cut and says what the desk does', () => {
  const said = 'prog: its record does not state the order its parts give — the desk sets it ready again';
  for (const [kind, record] of [['a record that states no phases', recordOf({ phases: undefined })], ['a record that states no dependency', recordOf({ phases: { order: 'stated' } })], ['a record stated for other parts', recordOf({ phases: { order: 'stated', after: { 2: [1], 3: [2] } } })]]) {
    assert.deepEqual(due(programmeStore({ [RECORD_AT]: record })), { due: false, reason: 'its record does not state the order its parts give', notice: said }, kind);
  }
  // A line added to a part since the order was set ready changes what the parts give.
  const parallel = programmeStore({ [README_AT]: README_MD.replace('### Part 2 — Two\n', '### Part 2 — Two\n\nIn parallel with the previous part.\n') });
  assert.deepEqual([due(parallel).due, due(parallel).notice], [false, said]);
  assert.equal(due(programmeStore({ [README_AT]: parallel.files[README_AT], [RECORD_AT]: recordOf({ phases: { order: 'stated' } }) })).due, true);
  // Every part of such an order that has a goal already goes on: only the cut waits.
  const covered = programmeStore({ [RECORD_AT]: recordOf({ phases: undefined }), ...goalAt('both', goalNaming('Part 1; Part 2')) });
  assert.deepEqual([due(covered).due, due(covered).reason, due(covered).notice], [false, 'its goals are already cut', null]);
});

test('the cut: a draft, a done or dropped record, and one whose goals name all parts are not due', () => {
  const table = [
    ['draft', recordOf({ state: 'draft' }), 'its record reads draft'],
    ['done', recordOf({ state: 'done' }), 'its record reads done'],
    ['dropped', recordOf({ state: 'dropped' }), 'its record reads done'],
  ];
  for (const [kind, record, reason] of table) {
    const answer = due(programmeStore({ [RECORD_AT]: record }));
    assert.deepEqual([answer.due, answer.reason], [false, reason], kind);
  }
  assert.equal(cuttable(BASE), true);
  assert.equal(cuttable({ ...BASE, state: 'draft' }), false);
  assert.equal(cuttable({ ...BASE, state: 'done' }), false);

  const bothCut = programmeStore(goalAt('both', goalNaming('Part 1; Part 2')));
  assert.deepEqual([due(bothCut).due, due(bothCut).reason], [false, 'its goals are already cut']);
});

test('the cut: a ready programme holding a goal that names no part of README.md is written by hand and is not due', () => {
  const byHand = programmeStore({ ...goalAt('one', goalNaming('Part 1')), ...goalAt('plain', goalNaming('The design')) });
  assert.deepEqual([due(byHand).due, due(byHand).reason], [false, 'its goal plain names no part of README.md']);
  assert.deepEqual(goalsNamingNoPart({ home: HOME, programme: 'prog', list: byHand.list, read: byHand.read }), ['plain']);
  const elsewhere = goalJson({ documents: [{ label: 'Part 1', path: `${HOME}/prog/OTHER.md` }] });
  const older = programmeStore({ ...goalAt('a', elsewhere), ...goalAt('b', elsewhere, true) });
  assert.deepEqual([due(older).due, due(older).reason], [false, 'its goals a, b name no part of README.md'], 'goals cut from another document of the programme, live or archived, hold the cut');
  const partial = programmeStore(goalAt('one', goalNaming('Part 1')));
  assert.equal(due(partial).due, true, 'goals that all name README.md parts leave the uncut parts due');
});

test('the cut: no record or README is not due, a horizon that is not open says so, and an open desk item holds the cut', () => {
  const noReadme = programmeStore(); delete noReadme.files[README_AT];
  assert.equal(due(noReadme).reason, 'it has no README.md');
  assert.equal(due(store({ [README_AT]: '#' })).reason, 'no record');
  assert.equal(due(store({ [RECORD_AT]: '{ x', [README_AT]: '#' })).reason, 'its record is invalid');
  const withHorizon = () => programmeStore({ [RECORD_AT]: recordOf({ horizon: 'h' }) });
  assert.equal(due(withHorizon(), { horizon: () => ({ state: 'open' }) }).due, true);
  const reached = due(withHorizon(), { horizon: () => ({ state: 'reached' }) });
  assert.deepEqual([reached.due, reached.notice], [false, 'prog: its horizon h reads reached — the programme is not cut while that lasts']);
  assert.match(due(withHorizon()).notice, /is missing or unreadable/u);
  const open = due(programmeStore(), { items: [{ kind: 'programme', reference: 'programme:prog', state: 'for-martin' }] });
  assert.deepEqual([open.due, open.reason], [false, 'a programme desk item is open']);
  assert.equal(due(programmeStore(), { items: [{ kind: 'programme', reference: 'programme:prog', state: 'closed' }, { kind: 'programme', reference: 'programme:other', state: 'prepared' }] }).due, true);
});

test('programme document coverage: part headings come from the Parts entry, and a goal names a part only by an explicit label on a document that points at README.md', () => {
  assert.deepEqual(documentParts(README_MD), [1, 2]);
  assert.deepEqual(documentParts('## Parts\n\n```\n### Part 9 — Fenced\n```\n\n### Part 3 — Real\n\n## Else\n\n### Part 4 — Outside\n'), [3], 'a fenced example and a heading outside the entry do not count');
  assert.deepEqual(documentParts('### Part 1 — x\n'), [], 'no Parts entry names no part');
  assert.deepEqual([...partsNamed('Part 1; Part 2')], [1, 2]);
  assert.deepEqual([...partsNamed('Parts 1, 2 and 4')], [1, 2, 4]);
  assert.deepEqual([...partsNamed('Parts 1-3')], [1], 'no range is read');
  assert.deepEqual([...partsNamed('The design, section 2 and part-two')], [], 'only an explicit Part n counts');
  assert.deepEqual([...partsNamed(undefined)], []);

  const cover = (goals) => { const s = programmeStore(goals); return [...partsCut({ home: HOME, programme: 'prog', list: s.list, read: s.read })].sort(); };
  assert.deepEqual(cover({}), [], 'no goal names nothing');
  assert.deepEqual(cover(goalAt('one', goalNaming('Part 1'))), [1], 'one goal does not consume a two-part document');
  assert.deepEqual(cover({ ...goalAt('one', goalNaming('Part 1')), ...goalAt('two', goalNaming('Part 2')) }), [1, 2]);
  assert.deepEqual(cover({ ...goalAt('one', goalNaming('Part 1')), ...goalAt('old', goalNaming('Part 2'), true) }), [1, 2], 'an archived goal counts');
  assert.deepEqual(cover({ ...goalAt('one', goalNaming('Part 1')), [`${HOME}/prog/goals/.hold.json`]: '{}' }), [1], 'a dot-entry is no goal');
  const elsewhere = goalJson({ documents: [{ label: 'Part 1', path: `${HOME}/other/README.md` }] });
  assert.deepEqual(cover(goalAt('else', elsewhere)), [], 'a document of another path names nothing');
  assert.deepEqual(cover(goalAt('plain', goalNaming('The design'))), [], 'a label with no Part n names nothing');
  assert.deepEqual(cover(goalAt('bad', '{ x')), [], 'a goal that does not parse names nothing');
  assert.deepEqual(cover(goalAt('shape', JSON.stringify({ ...JSON.parse(goalJson()), documents: 'Part 1' }))), [], 'a goal that does not validate names nothing');
});

test('programme document coverage: cutProblems names what keeps the document uncut', () => {
  const both = goalAt('a', goalNaming('Part 1; Part 2'));
  const problems = (s) => cutProblems({ home: HOME, programme: 'prog', list: s.list, read: s.read });
  assert.deepEqual(problems(programmeStore(both)), []);
  assert.equal(due(programmeStore(both)).due, false, 'a cut programme is not due again');
  assert.deepEqual(problems(programmeStore(goalAt('a', goalNaming('Part 1')))), ['no goal names part 2']);
  assert.deepEqual(problems(programmeStore()), ['no goal names parts 1, 2']);
  const missing = programmeStore(both); delete missing.files[README_AT];
  assert.deepEqual(problems(missing), ['README.md is missing']);
  assert.deepEqual(problems(programmeStore({ ...both, [README_AT]: '# nothing' })), ['README.md names no part']);
});

const THREE = [
  '# prog — three parts',
  '',
  'Repositories: memoro, memoro-cli.',
  '',
  '## Why',
  '',
  'Because.',
  '',
  '## Parts',
  '',
  '### Part 1 — A part is a goal',
  '',
  'Closes: the rewriting.',
  '',
  '```',
  '### Part 9 — Fenced',
  'In parallel with the previous part.',
  '```',
  '',
  '### Part 2 — The build session reads, decides & hands over',
  '',
  'Closes: the stops.',
  '',
  '### Part 3 — Åter i mål',
  '',
  '  in parallel with the previous part  ',
  '',
  '## Order',
  '',
  'In sequence.',
  '',
].join('\n');
const KNOWN = [{ repo: 'memoro', path: '/r/memoro' }, { repo: 'memoro-cli', path: '/r/memoro-cli' }];
const repositories = (text) => {
  const words = /^Repositories: (.+?)\.?$/mu.exec(text)?.[1].split(/[\s,]+/u) ?? [];
  return words.length ? { repos: words.map((repo) => KNOWN.find((one) => one.repo === repo)) } : { error: 'README.md needs a nonempty Repositories: line' };
};
const cut = (s) => cutParts({ programme: 'prog', home: HOME, list: s.list, read: s.read, write: s.write, repositories, now: new Date('2026-11-21T16:00:30.000Z') });
const goalOf = (s, name) => parseGoal(s.files[goalFile(name)]);

test('what a part waits for: the part before it, or with the line "In parallel with the previous part." what that part waits for', () => {
  const order = (...lines) => `## Parts\n\n${lines.map((line, at) => `### Part ${at + 1} — P${at + 1}\n\n${line}\n`).join('\n')}`;
  const LINE = 'In parallel with the previous part.';
  assert.deepEqual(partsOrder(order('Closes: a.', 'Closes: b.', LINE, 'Closes: d.')), { after: { 2: [1], 3: [1], 4: [2, 3] } }, 'a parallel part joins the group of the part before it, and the next part waits for the whole group');
  assert.deepEqual(partsOrder(README_MD), { after: { 2: [1] } }, 'no line: each part waits for the part before it');
  assert.deepEqual(partsOrder(order(LINE, LINE, LINE)), { after: {} }, 'the first part waits for nothing even with the line, and parts beside it wait for nothing');
  assert.deepEqual(partsOrder(THREE), { after: { 2: [1], 3: [1] } }, 'surrounding spaces, letter case and a missing full stop are read; a fenced example is no line');
  assert.deepEqual(partsOrder(order('Closes: a.', `Runs ${LINE}`, 'Closes: in parallel with the previous part, mostly.')), { after: { 2: [1], 3: [2] } }, 'the line is a line of its own: the words inside another sentence are not it');
  assert.deepEqual(partsOrder('## Parts\n\n### Part 1 — One\n'), { after: {} });
  assert.equal(partsOrder('# no parts\n'), null, 'a document with no part gives no order');
});

test('the cut: one goal per part with none, in build · ready, named from its heading, holding the part number and no text of its own', () => {
  const s = store({ [README_AT]: THREE, [`${HOME}/other/goals/a-part-is-a-goal/LOG.md`]: '' });
  assert.deepEqual(cut(s), [{ name: 'a-part-is-a-goal-2', part: 1 }, { name: 'the-build-session-reads-decides-hands-over', part: 2 }, { name: 'ater-i-mal', part: 3 }]);
  const two = goalOf(s, 'the-build-session-reads-decides-hands-over');
  assert.deepEqual([two.version, two.stage, two.status, two.phase, two.part, two.title, two.repos, two.created],
    [2, 'build', 'ready', 2, 2, 'The build session reads, decides & hands over', ['memoro', 'memoro-cli'], '2026-11-21T16:00:30Z']);
  assert.deepEqual(two.documents, [{ label: 'Part 2', path: README_AT }], 'it names its part by the document, as every goal cut from an order does');
  assert.deepEqual([two.success_criteria, two.outcome, two.change, two.obligations, two.prs], [[], [], [], [], []], 'no authored text');
  const [entry, ...more] = parseLog(s.files[`${HOME}/prog/goals/ater-i-mal/LOG.md`]);
  assert.deepEqual([more.length, entry.tool, entry.stage, entry.status, entry.done, entry.at], [0, 'runner', 'build', 'ready', 'cut from Part 3 of README.md', '2026-11-21T16:00Z']);
  assert.deepEqual([...partsCut({ home: HOME, programme: 'prog', list: s.list, read: s.read })].sort(), [1, 2, 3]);
  assert.deepEqual(cut(s), [], 'a second cut makes nothing');

  // A part whose goal exists, landed and archived too, gets no second goal, however the part reads now.
  const partial = store({ [README_AT]: THREE.replace('Closes: the rewriting.', 'Closes: something else entirely.'),
    ...goalAt('landed', goalJson({ stage: 'done', documents: [{ label: 'Part 1', path: README_AT }] }), true) });
  assert.deepEqual(cut(partial).map((goal) => goal.part), [2, 3]);

  assert.equal(goalSlug('—', 4), 'part-4', 'a heading with no letter or digit');
  assert.equal(goalSlug('One', 1, new Set(['one', 'one-2'])), 'one-3');
  assert.match(goalSlug('x'.repeat(90), 1), /^x{56}$/u);
  assert.throws(() => cut(store({ [README_AT]: THREE.replace('Repositories: memoro, memoro-cli.', '') })), /README\.md needs a nonempty Repositories: line/u, 'no repository to read: the cut cannot be made');
  assert.throws(() => cut(store({})), /README\.md is missing/u);
});

test('what a session on a goal that is a part is given: the part byte for byte under its heading line, then the shared sections; a part that has left gives nothing', () => {
  const part = partOfOrder(THREE, 2);
  assert.deepEqual([part.number, part.name, part.heading], [2, 'The build session reads, decides & hands over', 'PART 2 — The build session reads, decides & hands over, as README.md has it now']);
  assert.equal(part.section, '### Part 2 — The build session reads, decides & hands over\n\nCloses: the stops.');
  assert.equal(partBrief(part), `${part.heading}\n\n${part.section}\n\n${part.shared}\n`);
  for (const text of ['Repositories: memoro, memoro-cli.', '## Why\n\nBecause.', '## Order\n\nIn sequence.']) assert.ok(part.shared.includes(text), text);
  assert.equal(part.shared.includes('### Part 1'), false, 'no other part is in the shared sections');
  assert.equal(partOfOrder(THREE.replace('Closes: the stops.', 'Closes: the stops.\n\nSolution: read the part.'), 2).section.endsWith('Solution: read the part.'), true, 'an edited part reads as edited');
  assert.equal(partOfOrder(THREE, 4), null);
  assert.equal(partOfOrder(null, 1), null, 'no document, no part');
});

test('the cut: a missing state file reads as no failures, an unreadable one cuts nothing', () => {
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

test('the cut: the first failure is kept, the second opens a prepared item, the next two a for-martin brief', () => {
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
  for (const text of ['reason one', 'reason two', 'its cut failed twice', 'so the runner cuts the programme again']) assert.ok(prepared.includes(text), text);
  assert.doesNotMatch(prepared, /planning|session log/u, 'no session is named: none ran');
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
