import assert from 'node:assert/strict';
import { test } from 'node:test';
import { archiveDue, archiveName, archiveOnOk, archiveReadPrompt, archivedGoals, archiveStatePath, failuresSinceItem, finishDestination, keepReading, moveProposals, pendingDestination, noteDestination, openRestrictedItem, parseWriteBack, readArchiveState, recordArchiveFailure, statedProgrammes } from '../../src/mc/archive-turn.js';
import { itemDirectory } from '../../src/mc/desk-items.js';
import { FALLBACK_AREAS, pageAreaOf } from '../../src/mc/area-proposals.js';
import { renderGoal } from '../../src/mc/goals.js';

/**
 * The programme archive turn's model-free rules (docs/technical/mc-run.md, "Programme archive turn"): what is due, how the
 * reader's WRITE-BACK.md parses, what the archive does on an OK reading and what a NOT OK reading or a failure opens. The
 * runner's own seam tests live in run.test.js.
 */

const HOME = '/p';
const ROOT = '/w';
const ENV = { MC_WORK_ROOT: ROOT };
const RECORD = JSON.stringify({ schema: 'mc-programme', version: 1, horizon: null, end: 'Done when it holds.', state: 'open', created: '2026-11-14T10:20:30Z', created_by: 'person' });
const goalFile = (stage, repo = 'memoro-cli') => renderGoal({ stage, status: 'ready', repos: [repo], class: 'large', title: 'G', goal: ['g'], success_criteria: [{ met: true, criterion: 'x', check: 'y' }] });

/** An in-memory store: `files` by path; `list` of a directory is its entry names. */
function store(files = {}) {
  const read = (path) => files[path] ?? null;
  const list = (dir) => [...new Set(Object.keys(files).filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1).split('/')[0]))];
  return { files, read, list, exists: (path) => path in files || Object.keys(files).some((other) => other.startsWith(`${path}/`)), write: (path, text) => { files[path] = text; }, remove: (path) => { delete files[path]; }, writeJson: (path, value) => { files[path] = JSON.stringify(value); }, lock: (root, fn) => fn() };
}
/** A programme with a record and two archived goals, one done and one dropped. */
const finished = (extra = {}) => store({
  [`${HOME}/prog/PROGRAMME.json`]: RECORD,
  [`${HOME}/prog/README.md`]: '# prog\n',
  [`${HOME}/prog/goals/.archive/a-goal/GOAL.json`]: goalFile('done'),
  [`${HOME}/prog/goals/.archive/b-goal/GOAL.json`]: goalFile('done', 'other-repo'),
  [`${HOME}/prog/goals/.archive/c-goal/GOAL.json`]: goalFile('dropped'),
  ...extra,
});
const due = (s, options = {}) => archiveDue({ programme: 'prog', home: HOME, root: ROOT, list: s.list, read: s.read, state: { status: 'none' }, ...options });
const seams = (s) => ({ root: ROOT, programme: 'prog', read: s.read, writeJson: s.writeJson, lock: s.lock });
const stateOf = (s) => JSON.parse(s.files[archiveStatePath(ROOT, 'prog')]);
const fail = (s, at, extra = {}) => recordArchiveFailure({ kind: 'failed', reason: 'WRITE-BACK.md is missing', log: `/l/${at}.jsonl`, at, env: ENV, write: s.write, itemDirectory, ...seams(s), ...extra });

const GOALS = ['a-goal', 'b-goal'];
const CHECKOUTS = { 'memoro-cli': 'a'.repeat(40), 'other-repo': 'b'.repeat(40) };
const READS = `read: memoro-cli ${'a'.repeat(40)}\nread: other-repo ${'b'.repeat(40)}`;
const parse = (body) => parseWriteBack(body, { goals: GOALS, checkouts: CHECKOUTS });
const OK_LINES = 'a-goal: OK — memoro-cli/docs/technical/mc-run.md § Programme archive turn\nb-goal: OK — none — a repair that left no new rule';

test('archive turn: a programme is due with an open record, no live goal and a done archived goal', () => {
  const answer = due(finished());
  assert.deepEqual([answer.due, answer.mode, answer.goals, answer.dropped, answer.repos], [true, 'read', GOALS, ['c-goal'], ['memoro-cli', 'other-repo']]);
  assert.equal(archiveName('prog'), 'archive:prog');
  assert.deepEqual(archivedGoals({ home: HOME, programme: 'prog', list: finished().list, read: finished().read }).done, GOALS);
  assert.equal(due(finished({ [`${HOME}/prog/goals/.hold.json`]: '{}' })).due, true, 'a dot-entry is no live goal');
});

test('archive turn: no record, an invalid or a done record, a live goal, no done goal, an unreadable goal and an open item are not due', () => {
  const no = finished(); delete no.files[`${HOME}/prog/PROGRAMME.json`];
  assert.deepEqual([due(no).due, due(no).reason], [false, 'no record']);
  assert.equal(due(finished({ [`${HOME}/prog/PROGRAMME.json`]: '{ x' })).reason, 'its record is invalid');
  assert.equal(due(finished({ [`${HOME}/prog/PROGRAMME.json`]: JSON.stringify({ ...JSON.parse(RECORD), state: 'done' }) })).reason, 'its record reads done');
  assert.equal(due(finished({ [`${HOME}/prog/goals/live/GOAL.json`]: goalFile('build') })).reason, 'it holds a live goal');
  const dropped = store({ [`${HOME}/prog/PROGRAMME.json`]: RECORD, [`${HOME}/prog/goals/.archive/c/GOAL.json`]: goalFile('dropped') });
  assert.deepEqual([due(dropped).due, due(dropped).reason], [false, 'no goal reached done']);
  const none = store({ [`${HOME}/prog/PROGRAMME.json`]: RECORD });
  assert.equal(due(none).reason, 'no goal reached done');
  const broken = due(finished({ [`${HOME}/prog/goals/.archive/d-goal/GOAL.json`]: '{ x' }));
  assert.deepEqual([broken.due, broken.reason], [false, 'an archived goal cannot be read']);
  assert.match(broken.notice, /d-goal: its goal file does not parse/u);
  const open = due(finished(), { items: [{ kind: 'archive', reference: 'archive:prog', state: 'for-martin' }] });
  assert.deepEqual([open.due, open.reason], [false, 'an archive desk item is open']);
  assert.equal(due(finished(), { items: [{ kind: 'archive', reference: 'archive:prog', state: 'closed' }, { kind: 'archive', reference: 'archive:other', state: 'prepared' }, { kind: 'programme', reference: 'archive:prog', state: 'prepared' }] }).due, true);
});

test('archive turn: a kept OK reading of exactly the done goals is archived again with no new reading', () => {
  const s = finished();
  keepReading({ at: '2026-11-15T10:00:00Z', goals: GOALS, ...seams(s) });
  const state = readArchiveState({ root: ROOT, programme: 'prog', read: s.read });
  assert.equal(state.status, 'valid');
  assert.equal(due(s, { state }).mode, 'archive');
  const more = finished({ [`${HOME}/prog/goals/.archive/z-goal/GOAL.json`]: goalFile('done') });
  assert.equal(due(more, { state }).mode, 'read', 'a goal archived since the reading needs a new one');
  const less = store({ ...finished().files }); delete less.files[`${HOME}/prog/goals/.archive/b-goal/GOAL.json`];
  assert.equal(due(less, { state }).mode, 'read');
});

test('archive turn: a missing state reads as nothing, an unreadable one starts nothing and counts nothing', () => {
  const s = finished();
  assert.deepEqual(readArchiveState({ root: ROOT, programme: 'prog', read: s.read }), { status: 'none' });
  for (const text of ['{ x', '[]', JSON.stringify({ schema: 'mc-archive-turn', version: 1, programme: 'other', failures: [], items: [], reading: null, destination: null }), JSON.stringify({ schema: 'mc-archive-turn', version: 1, programme: 'prog', failures: [{ at: 1 }], items: [], reading: null, destination: null })]) {
    const bad = finished({ [archiveStatePath(ROOT, 'prog')]: text });
    const found = readArchiveState({ root: ROOT, programme: 'prog', read: bad.read });
    assert.equal(found.status, 'unreadable', text);
    const answer = due(bad, { state: found });
    assert.deepEqual([answer.due, answer.reason], [false, 'its turn state is unreadable'], text);
    assert.match(answer.notice, /runner\/archive-turn\/prog\.json is unreadable \(/u);
    assert.throws(() => fail(bad, '2026-11-15T10:00:00Z'), /is unreadable/u);
    assert.throws(() => keepReading({ at: 'x', goals: GOALS, ...seams(bad) }), /is unreadable/u);
    assert.equal(bad.files[archiveStatePath(ROOT, 'prog')], text, 'and nothing is rewritten');
  }
  const older = finished({ [archiveStatePath(ROOT, 'prog')]: JSON.stringify({ schema: 'mc-archive-turn', version: 0, programme: 'prog', failures: 'x' }) });
  assert.deepEqual(readArchiveState({ root: ROOT, programme: 'prog', read: older.read }), { status: 'none' }, 'a state file of an older version is no failures and no kept reading');
  assert.deepEqual(statedProgrammes({ root: ROOT, list: finished({ [archiveStatePath(ROOT, 'prog')]: '{}', [archiveStatePath(ROOT, 'second')]: '{}' }).list }), ['prog', 'second']);
});

test('archive turn: a destination in the state is due that write alone, whatever the live programme directory says', () => {
  const s = finished({ '/arch/prog/PROGRAMME.json': RECORD });
  noteDestination({ destination: '/arch/prog', ...seams(s) });
  const state = readArchiveState({ root: ROOT, programme: 'prog', read: s.read });
  const answer = due(store({ '/arch/prog/PROGRAMME.json': RECORD, [archiveStatePath(ROOT, 'prog')]: s.files[archiveStatePath(ROOT, 'prog')] }), { state });
  assert.deepEqual([answer.due, answer.mode, answer.destination], [true, 'state', '/arch/prog']);
  const lost = store({ [archiveStatePath(ROOT, 'prog')]: s.files[archiveStatePath(ROOT, 'prog')] });
  const unreadable = due(lost, { state });
  assert.deepEqual([unreadable.due, unreadable.reason], [false, 'its destination record cannot be read']);
  assert.match(unreadable.notice, /the record at \/arch\/prog cannot be read \(none\)/u);
});

test('archive turn: WRITE-BACK.md parses to its verdict and the NOT OK lines, and every malformed form is a failed reading', () => {
  const ok = parse(`${READS}\n${OK_LINES}\nverdict: OK\n`);
  assert.deepEqual([ok.ok, ok.verdict, ok.lines], [true, 'OK', []]);
  assert.deepEqual(Object.keys(ok.goals), GOALS);
  const notOk = parse(`${READS}\na-goal: NOT OK — the archive turn is in no page\nb-goal: OK — none — nothing a page should say\nverdict: NOT OK\n`);
  assert.deepEqual([notOk.ok, notOk.verdict, notOk.lines], [true, 'NOT OK', ['a-goal: NOT OK — the archive turn is in no page']]);
  const bad = (body, pattern) => { const answer = parse(body); assert.equal(answer.ok, false, body); assert.match(answer.problems.join('\n'), pattern, body); };
  assert.deepEqual(parseWriteBack(null, { goals: GOALS, checkouts: CHECKOUTS }), { ok: false, problems: ['WRITE-BACK.md is missing'] });
  bad(`${READS}\n${OK_LINES.replace('a-goal: OK — memoro-cli/docs/technical/mc-run.md § Programme archive turn', 'a-goal: NOT OK — a gap')}\nverdict: OK\n`, /`verdict: OK` beside a NOT OK line/u);
  bad(`${READS}\n${OK_LINES}\nverdict: NOT OK\n`, /`verdict: NOT OK` with no NOT OK line/u);
  bad(`${READS}\na-goal: OK — memoro-cli/docs/technical/mc-run.md § Programme archive turn\nverdict: OK\n`, /no line for the done goal b-goal/u);
  bad(`${READS}\n${OK_LINES}\nc-goal: OK — none — dropped\nverdict: OK\n`, /a line for "c-goal", which is no done goal/u);
  bad(`${READS}\n${OK_LINES}\na-goal: OK — none — twice\nverdict: OK\n`, /two lines for a-goal/u);
  bad(`${READS}\na-goal: OK — none —\nb-goal: OK — none\nverdict: OK\n`, /a-goal: .*b-goal: /su);
  bad(`${READS}\na-goal: OK\nb-goal: OK — none — x\nverdict: OK\n`, /a-goal: /u);
  bad(`${READS}\na-goal: NOT OK —\nb-goal: OK — none — x\nverdict: NOT OK\n`, /not in form: "a-goal: NOT OK —"/u);
  bad(`${OK_LINES}\nverdict: OK\n`, /no `read: memoro-cli <sha>` line/u);
  bad(`read: memoro-cli ${'c'.repeat(40)}\nread: other-repo ${'b'.repeat(40)}\n${OK_LINES}\nverdict: OK\n`, /is not the checkout's commit/u);
  bad(`${READS}\nread: third ${'c'.repeat(40)}\n${OK_LINES}\nverdict: OK\n`, /names no checkout given/u);
  bad(`${READS}\n${OK_LINES}\n`, /no last line `verdict: OK`/u);
  bad(`${READS}\n${OK_LINES}\nverdict: OK\nafter\n`, /not in form: "after"/u);
  bad(`${READS}\nverdict: OK\n${OK_LINES}\n`, /`verdict:` is not the last line/u);
});

test('archive turn: the prompt names the file, the checkouts and the forms', () => {
  const prompt = archiveReadPrompt({ programme: 'prog', dir: '/p/prog', goals: GOALS, dropped: ['c-goal'], checkouts: { 'memoro-cli': '/c/m' }, archive: '/p/prog/goals/.archive' });
  for (const text of ['programme prog', '/p/prog/WRITE-BACK.md', '/p/prog/goals/.archive/a-goal', 'memoro-cli: `/c/m`', 'Dropped goals (c-goal)', 'verdict: OK']) assert.ok(prompt.includes(text), text);
});

test('archive turn: a NOT OK reading opens a prepared item at once and is no failure; a decided one opens a for-martin brief', () => {
  const s = finished();
  const first = fail(s, '2026-11-15T10:00:00Z', { kind: 'not-ok', reason: 'the write-back is not OK', lines: ['a-goal: NOT OK — the archive turn is in no page'] });
  const item = first.item;
  assert.deepEqual([item.kind, item.reference, item.state, item.sort, item.reversible, item.due_at, item.outcome], ['archive', 'archive:prog', 'prepared', 'mechanical', null, null, null]);
  const dir = itemDirectory(item, ENV);
  assert.ok(s.files[`${dir}/prepared.md`].includes('a-goal: NOT OK — the archive turn is in no page'));
  assert.ok(`${dir}/item.json` in s.files);
  assert.equal(`${dir}/brief.md` in s.files, false);
  assert.deepEqual(stateOf(s).failures, [], 'a NOT OK reading is a finding, not a counted failure');
  assert.deepEqual(stateOf(s).items, [{ id: item.id, opened_at: '2026-11-15T10:00:00Z' }]);

  const later = fail(s, '2026-11-15T12:00:00Z', { kind: 'not-ok', reason: 'again', lines: ['a-goal: NOT OK — still'], decided: true }).item;
  assert.deepEqual([later.state, later.sort, later.reversible], ['for-martin', 'mechanical', false]);
  const brief = s.files[`${itemDirectory(later, ENV)}/brief.md`];
  assert.match(brief, /^## Vad det gäller\n/u);
  assert.match(brief, /a-goal: NOT OK — still/u);
  assert.equal(`${itemDirectory(later, ENV)}/prepared.md` in s.files, false);
});

test('archive turn: the first failure is kept for the next pass, the second since the last item opens a for-martin brief', () => {
  const s = finished();
  const first = fail(s, '2026-11-15T10:00:00Z', { reason: 'reason one' });
  assert.deepEqual([first.count, first.item], [1, null]);
  assert.deepEqual(Object.keys(s.files).filter((path) => path.startsWith(`${ROOT}/martin/`)), [], 'the first opens nothing');
  const second = fail(s, '2026-11-15T10:05:00Z', { reason: 'reason two' });
  assert.equal(second.count, 2);
  const item = second.item;
  assert.deepEqual([item.kind, item.state, item.sort, item.reversible], ['archive', 'for-martin', 'mechanical', false]);
  const brief = s.files[`${itemDirectory(item, ENV)}/brief.md`];
  assert.match(brief, /## Rekommendation och skäl\n/u);
  for (const text of ['reason one', 'reason two', '/l/2026-11-15T10:00:00Z.jsonl']) assert.ok(brief.includes(text), text);
  assert.equal(failuresSinceItem(stateOf(s)).length, 0);
  assert.equal(fail(s, '2026-11-15T11:00:00Z').item, null, 'one failure since the item opens nothing');
});

test('archive turn: a programme with restricted data opens a reserved item at once, Swedish, naming mc plan --archive', () => {
  const s = finished();
  const { item } = openRestrictedItem({ entries: ['export.csv'], at: '2026-11-15T10:00:00Z', env: ENV, write: s.write, itemDirectory, ...seams(s) });
  assert.deepEqual([item.kind, item.reference, item.state, item.sort, item.reversible], ['archive', 'archive:prog', 'for-martin', 'reserved', false]);
  const brief = s.files[`${itemDirectory(item, ENV)}/brief.md`];
  assert.match(brief, /mc plan prog --archive/u);
  assert.match(brief, /export\.csv/u);
  assert.match(brief, /^## Vad det gäller\n/u);
});

test('archive turn: a legacy programme\'s proposals move to an area with a first line naming the programme, and never over a file already there', () => {
  const s = finished({ [`${HOME}/prog/proposals/a.md`]: 'A\n', [`${HOME}/prog/proposals/b.md`]: 'B\n', [`${HOME}/prog/proposals/notes.txt`]: 'x', [`${HOME}/prog/proposals/.hidden.md`]: 'h', '/pr/a.md': 'taken\n', '/pr/prog-a.md': 'taken too\n' });
  const moved = moveProposals({ home: HOME, programme: 'prog', target: '/pr', list: s.list, read: s.read, write: s.write, remove: s.remove, exists: s.exists });
  assert.deepEqual(moved, ['a.md', 'b.md']);
  assert.equal(s.files['/pr/a.md'], 'taken\n');
  assert.equal(s.files['/pr/prog-a.md'], 'taken too\n');
  assert.match(s.files['/pr/prog-2-a.md'], /^From programme prog, which was archived with these still open\.\n\nA\n$/u);
  assert.match(s.files['/pr/b.md'], /^From programme prog,/u);
  assert.deepEqual(Object.keys(s.files).filter((path) => path.startsWith(`${HOME}/prog/proposals/`)).sort(), [`${HOME}/prog/proposals/.hidden.md`, `${HOME}/prog/proposals/notes.txt`]);
  // The area is asked for only when something is to move: naming it may read the repositories.
  let asked = 0;
  const none = finished();
  assert.deepEqual(moveProposals({ home: HOME, programme: 'prog', target: () => { asked += 1; return '/pr'; }, list: none.list, read: none.read, write: none.write, remove: none.remove, exists: none.exists }), []);
  assert.equal(asked, 0);
});

test('archive turn: the area a legacy programme\'s proposals go to is the page-area its record names, else memoro-cli/system', () => {
  const repos = [{ name: 'memoro', areas: [{ id: 'keys', page: 'docs/technical/areas/trust.md' }, { id: 'rules', questions: [{}] }] }];
  assert.equal(pageAreaOf('memoro/keys', repos), 'memoro/trust', 'the area id names its page, and the page is the area');
  for (const ref of ['memoro/rules', 'memoro/none', 'memoro-cli/system', null, undefined, 'nonsense']) assert.equal(pageAreaOf(ref, repos), null, String(ref));
  assert.equal(FALLBACK_AREAS.mc, 'memoro-cli/system');
});

/** `archiveOnOk` over a store, with an `archive` that the test supplies. */
const onOk = (s, archive, extra = {}) => archiveOnOk({ programme: 'prog', home: HOME, restrictedDir: '/r/prog', proposalsTarget: (record) => { s.targets = [...(s.targets || []), record.end]; return '/pr'; }, list: s.list, read: s.read, write: s.write, remove: s.remove, exists: s.exists, archive, root: ROOT, writeJson: s.writeJson, lock: s.lock, ...extra });

test('archive turn: on OK the archive runs fenced, the destination is recorded, the record is set done there and the state cleared', async () => {
  const s = finished({ [`${HOME}/prog/proposals/p.md`]: 'P\n' });
  const locked = [];
  let holding = false;
  s.lock = (root, fn, options) => {
    assert.equal(root, ROOT);
    assert.equal(options.strict, true);
    assert.equal(holding, false, 'archive bookkeeping does not nest a record lock');
    locked.push(options.name);
    holding = true;
    try { return fn(); } finally { holding = false; }
  };
  let seen = null;
  const result = await onOk(s, async ({ fence, onShelved }) => {
    seen = { fence: fence() };
    // The runner's archive moves the directory, then says where it went.
    for (const path of Object.keys(s.files).filter((p) => p.startsWith(`${HOME}/prog/`))) { s.files[path.replace(`${HOME}/prog/`, '/arch/prog/')] = s.files[path]; delete s.files[path]; }
    onShelved('/arch/prog-2');
    s.files['/arch/prog-2/PROGRAMME.json'] = s.files['/arch/prog/PROGRAMME.json'];
    assert.equal(stateOf(s).destination, '/arch/prog-2', 'the destination is recorded before anything else can fail');
    return 0;
  });
  assert.deepEqual(result, { ok: true, destination: '/arch/prog-2' });
  assert.equal(seen.fence, null);
  assert.match(s.files['/pr/p.md'], /^From programme prog/u, 'proposals moved before the archive');
  assert.deepEqual(s.targets, ['Done when it holds.'], 'the target is asked once, of the programme\'s record');
  assert.equal(JSON.parse(s.files['/arch/prog-2/PROGRAMME.json']).state, 'done');
  assert.ok(locked.includes('programme-state'), 'the real record writer uses the archive caller lock and root');
  assert.equal(stateOf(s).destination, null);
  assert.equal(stateOf(s).reading, null);
});

test('archive turn: the fence stops the archive when a goal or restricted data appears meanwhile', async () => {
  const s = finished();
  const reasons = [];
  await onOk(s, async ({ fence }) => {
    s.files[`${HOME}/prog/goals/new/GOAL.json`] = goalFile('build');
    reasons.push(fence());
    delete s.files[`${HOME}/prog/goals/new/GOAL.json`];
    s.files['/r/prog/data.csv'] = 'x';
    reasons.push(fence());
    return 1;
  });
  assert.deepEqual(reasons, ['a goal appeared in the programme', 'restricted data appeared (data.csv)']);
});

test('archive turn: restricted data, a live goal, a record not open or an archive that fails leaves the programme as it was', async () => {
  const calls = [];
  const never = async () => { calls.push('archive'); return 0; };
  const restricted = finished({ '/r/prog/data.csv': 'x', [`${HOME}/prog/proposals/p.md`]: 'P\n' });
  assert.deepEqual(await onOk(restricted, never), { ok: false, restricted: ['data.csv'] });
  assert.equal('/pr/p.md' in restricted.files, false, 'nothing is moved while restricted data stands');
  const live = finished({ [`${HOME}/prog/goals/live/GOAL.json`]: goalFile('build') });
  assert.deepEqual(await onOk(live, never), { ok: false, reason: 'the programme holds a live goal' });
  const closed = finished({ [`${HOME}/prog/PROGRAMME.json`]: JSON.stringify({ ...JSON.parse(RECORD), state: 'done' }) });
  assert.match((await onOk(closed, never)).reason, /its record does not read valid and ready \(done\)/u);
  assert.deepEqual(calls, []);
  const failing = finished();
  assert.deepEqual(await onOk(failing, async () => 1), { ok: false, reason: 'archiveProgramme returned 1' });
  assert.equal(archiveStatePath(ROOT, 'prog') in failing.files, false, 'nothing is recorded for an archive that did not shelve');
});

test('archive turn: a record that cannot be set done keeps the destination, and the next pass sets it alone', async () => {
  const s = finished({ '/arch/prog/PROGRAMME.json': RECORD });
  const refused = await onOk(s, async ({ onShelved }) => { onShelved('/arch/prog'); return 0; }, { setDone: () => ({ ok: false, status: 'invalid', problems: ['cannot write'] }) });
  assert.deepEqual([refused.ok, refused.destination], [false, '/arch/prog']);
  assert.match(refused.reason, /could not be set to done: cannot write/u);
  assert.equal(stateOf(s).destination, '/arch/prog');
  const state = readArchiveState({ root: ROOT, programme: 'prog', read: s.read });
  assert.equal(archiveDue({ programme: 'prog', home: HOME, root: ROOT, list: s.list, read: s.read, state }).mode, 'state');
  const locked = [];
  let holding = false;
  const lock = (root, fn, options) => {
    assert.equal(root, ROOT);
    assert.equal(options.strict, true);
    assert.equal(holding, false, 'destination recovery does not nest a record lock');
    locked.push(options.name);
    holding = true;
    try { return fn(); } finally { holding = false; }
  };
  const done = finishDestination({ programme: 'prog', destination: '/arch/prog', read: s.read, write: s.write, root: ROOT, writeJson: s.writeJson, lock });
  assert.deepEqual(done, { ok: true, destination: '/arch/prog' });
  assert.ok(locked.includes('programme-state'), 'recovery passes the same lock and root to the record writer');
  assert.equal(JSON.parse(s.files['/arch/prog/PROGRAMME.json']).state, 'done');
  assert.equal(stateOf(s).destination, null);
  const again = finishDestination({ programme: 'prog', destination: '/arch/prog', read: s.read, write: s.write, root: ROOT, writeJson: s.writeJson, lock: s.lock });
  assert.equal(again.ok, true, 'a record that already reads done is only cleared');
});

test('archive turn: a record write that throws after the move is a refusal, counted; the second opens the item, and while it is open no write is tried', async () => {
  const s = finished({ '/arch/prog/PROGRAMME.json': RECORD });
  // The real setRecordState, its write throwing as writeFileAtomic does on a filesystem error.
  const throwing = (path, text) => { if (path === '/arch/prog/PROGRAMME.json') { const error = new Error(`EACCES: permission denied, open '${path}'`); error.code = 'EACCES'; throw error; } s.write(path, text); };
  const refused = await onOk(s, async ({ onShelved }) => { onShelved('/arch/prog'); return 0; }, { write: throwing });
  assert.deepEqual([refused.ok, refused.destination], [false, '/arch/prog'], 'the throw is answered, not thrown');
  assert.match(refused.reason, /could not be set to done: EACCES: permission denied/u);
  assert.equal(stateOf(s).destination, '/arch/prog');
  const finish = () => finishDestination({ programme: 'prog', destination: '/arch/prog', read: s.read, write: throwing, root: ROOT, writeJson: s.writeJson, lock: s.lock });
  const first = finish();
  assert.equal(first.ok, false);
  assert.match(first.reason, /could not be set to done: EACCES/u);
  // The runner counts each refusal: the first is kept, the second since the last item opens the for-martin item.
  assert.equal(fail(s, '2026-11-15T10:00:00Z', { reason: refused.reason }).item, null);
  const item = fail(s, '2026-11-15T11:00:00Z', { reason: first.reason }).item;
  assert.deepEqual([item.state, item.sort], ['for-martin', 'mechanical']);
  const state = readArchiveState({ root: ROOT, programme: 'prog', read: s.read });
  const held = archiveDue({ programme: 'prog', home: HOME, root: ROOT, list: s.list, read: s.read, state, items: [item] });
  assert.deepEqual([held.due, held.reason], [false, 'an archive desk item is open'], 'no write and no new count while the item is open');
  assert.equal(pendingDestination(state, { read: s.read }), '/arch/prog');
  const decided = archiveDue({ programme: 'prog', home: HOME, root: ROOT, list: s.list, read: s.read, state, items: [{ ...item, state: 'closed' }] });
  assert.deepEqual([decided.due, decided.mode], [true, 'state'], 'once the item is closed the write is tried again');
  s.files['/arch/prog/PROGRAMME.json'] = JSON.stringify({ ...JSON.parse(RECORD), state: 'done' });
  assert.equal(pendingDestination(state, { read: s.read }), null, 'a record set done by hand is no pending write');
  const cleared = archiveDue({ programme: 'prog', home: HOME, root: ROOT, list: s.list, read: s.read, state, items: [item] });
  assert.deepEqual([cleared.due, cleared.mode], [true, 'state'], 'a record that reads done is cleared from the state, item or not');
  assert.equal(finish().ok, true, 'done is not written again, so the throwing write is never called');
  assert.equal(stateOf(s).destination, null);
});

test('archive turn: a directory that did not move (no beside area) has its record set done in place', async () => {
  const s = finished();
  const result = await onOk(s, async () => 0);
  assert.deepEqual(result, { ok: true, destination: `${HOME}/prog` });
  assert.equal(JSON.parse(s.files[`${HOME}/prog/PROGRAMME.json`]).state, 'done');
});
