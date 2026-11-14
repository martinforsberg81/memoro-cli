/** Commissioned lesson protection: the real store and verbs on a fixture home; no model, no network. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { run as martin } from '../../src/mc/commands/martin.js';
import { deskItemId, itemDirectory, readDeskItem, writeDeskItem } from '../../src/mc/desk-items.js';
import { writeJsonAtomic } from '../../src/mc/atomic-write.js';
import { decisionFailure } from '../../src/mc/desk-decision.js';
import { briefLesson, carryLesson, dismissLesson, listLessons, reconcileLessons } from '../../src/mc/desk-lessons.js';

const roots = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
const NOW = new Date('2026-11-14T12:00:00Z');
const BODY = '## What happened\nAn item reached Martin that was not his.\n\n## The rule\nA question established practice answers is not his.\n\n## Where the change belongs\ncanon/roles/decision.md\n';
const BRIEF = 'Vad det gäller\n\n- keep: behåll regeln som den är\n- change: ändra regeln till att gälla alla\n\nRekommendation: keep.\n';

function home() {
  const root = mkdtempSync(join(tmpdir(), 'mc-lessons-')); roots.push(root);
  mkdirSync(join(root, 'mc', 'runner', 'projects'), { recursive: true }); // the runner lock's directory
  return { root, env: { MC_WORK_ROOT: join(root, 'mc'), MC_HOME: join(root, 'mc-home') } };
}
/** Every file under the fixture home, by path: what "nothing was written" is compared against. */
function tree(dir, out = {}) {
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names.sort()) { const path = join(dir, name); if (statSync(path).isDirectory()) tree(path, out); else out[path] = readFileSync(path, 'utf8'); }
  return out;
}
function io() { const o = { stdout: '', stderr: '' }; return { o, stdout: { write: (s) => { o.stdout += s; } }, stderr: { write: (s) => { o.stderr += s; } } }; }
const call = (h, role, argv, stdin = BODY) => { const out = io(); return martin(argv, { ...out, env: { ...h.env, MC_ROLE: role }, now: () => NOW, readStdin: () => stdin }).then((code) => ({ code, ...out.o })); };
const addArgs = ['lesson', 'add', '--kind', 'wrong-question', '--file', '-'];
async function open(h, n = 1) {
  const names = [];
  for (let i = 0; i < n; i += 1) { const r = await call(h, 'martin', addArgs); assert.equal(r.code, 0, r.stderr); names.push(r.stdout.trim()); }
  return names;
}
function briefedItem(h, { recommend = 'keep' } = {}) {
  const at = '2026-11-13T10:00:00Z';
  const item = { schema: 'mc-desk-item', version: 1, id: deskItemId('goal', 'alpha/one', at), kind: 'goal', reference: 'alpha/one', source_at: at, opened_at: at, state: 'for-martin', sort: 'product', reversible: true, due_at: '2026-11-15T10:00:00Z', outcome: null, recommend };
  writeDeskItem(item, { env: h.env });
  writeFileSync(join(itemDirectory(item, h.env), 'brief.md'), BRIEF);
  return item;
}

describe('who records, carries and dismisses a lesson', () => {
  it('lets a person and the roles martin, decision and review-session:goal add one, and refuses any other role with the home unchanged', async () => {
    const h = home();
    for (const role of ['person', 'martin', 'decision', 'learning', 'review-session:goal']) {
      const r = await call(h, role, addArgs);
      assert.equal(r.code, 0, `${role}: ${r.stderr}`);
    }
    assert.equal(listLessons({ env: h.env }).length, 5);
    assert.deepEqual(listLessons({ env: h.env }).map((x) => x.by), ['person', 'martin', 'decision', 'learning', 'review-session:goal']);
    for (const role of ['desk-prepare', 'build-session:goal', 'finish-session:goal', 'plan-session', 'session']) {
      const before = tree(h.root);
      const r = await call(h, role, addArgs);
      assert.equal(r.code, 2, role); assert.match(r.stderr, new RegExp(`role ${role} cannot add lessons`, 'u'));
      assert.deepEqual(tree(h.root), before, `${role}: nothing written`);
    }
  });

  it('refuses carry and dismiss to the review role and to roles that may not write lessons, and changes nothing', async () => {
    const h = home(); const [name] = await open(h);
    for (const [role, argv] of [
      ['review-session:goal', ['lesson', 'carry', name, '--goal', 'mc/x']], ['review-session:goal', ['lesson', 'dismiss', name, '--reason', 'an accident']],
      ['desk-prepare', ['lesson', 'dismiss', name, '--reason', 'an accident']], ['build-session:goal', ['lesson', 'carry', name, '--goal', 'mc/x']],
    ]) {
      const before = tree(h.root);
      const r = await call(h, role, argv);
      assert.equal(r.code, 2, `${role} ${argv[1]}`); assert.match(r.stderr, /cannot (carry|dismiss) lessons/u);
      assert.deepEqual(tree(h.root), before, `${role} ${argv[1]}: nothing written`);
    }
  });

  it('needs a reason to dismiss from everyone, and dismisses with one', async () => {
    const h = home(); const [name] = await open(h);
    for (const role of ['person', 'martin', 'decision', 'learning']) {
      for (const argv of [['lesson', 'dismiss', name], ['lesson', 'dismiss', name, '--reason', '   ']]) {
        const before = tree(h.root);
        const r = await call(h, role, argv);
        assert.equal(r.code, 2, `${role} ${argv.join(' ')}`); assert.match(r.stderr, /needs --reason/u);
        assert.deepEqual(tree(h.root), before, `${role}: nothing written`);
      }
    }
    const r = await call(h, 'martin', ['lesson', 'dismiss', name, '--reason', 'One accident that no change would have prevented.']);
    assert.equal(r.code, 0, r.stderr);
    const [lesson] = listLessons({ env: h.env });
    assert.deepEqual([lesson.state, lesson.reason, lesson.dismissed_at], ['dismissed', 'One accident that no change would have prevented.', NOW.toISOString()]);
  });

  it('lets the learning pass dismiss at most one lesson in five of those it was given', async () => {
    const h = home(); const names = await open(h, 5);
    assert.equal(dismissLesson({ env: h.env, name: names[0], reason: 'one accident', role: 'learning', since: '2026-11-14T00:00:00Z', now: NOW }).lesson.state, 'dismissed');
    const before = tree(h.root);
    assert.match(dismissLesson({ env: h.env, name: names[1], reason: 'another', role: 'learning', since: '2026-11-14T00:00:00Z', now: NOW }).error, /at most one lesson in 5/u);
    assert.deepEqual(tree(h.root), before);
  });
});

describe('a lesson lands only through a done goal', () => {
  const goals = (stage) => [{ programme: 'mc', goal: 'learned', stage, prs: ['memoro-cli#7'], problems: [] }];
  it('is carried to a live goal, landed with its pull request when that goal is done, and open again when it is dropped; no verb sets landed', async () => {
    const h = home(); const [a, b] = await open(h, 2);
    const live = [{ programme: 'mc', goal: 'learned', stage: 'build', prs: [], problems: [] }];
    for (const name of [a, b]) assert.equal(await martin(['lesson', 'carry', name, '--goal', 'mc/learned'], { ...io(), env: { ...h.env, MC_ROLE: 'martin' }, now: () => NOW, home: join(h.root, 'programs') }), 2, 'a goal that does not exist carries nothing');
    assert.deepEqual(listLessons({ env: h.env }).map((x) => x.state), ['open', 'open']);
    // The goal exists: carry through the library, as the verb does.
    for (const name of [a, b]) assert.ok(carryLesson({ env: h.env, name, goal: 'mc/learned', now: NOW, goals: live }).lesson);
    assert.deepEqual(reconcileLessons({ env: h.env, now: NOW, goals: live }), [], 'a live goal changes nothing');
    assert.deepEqual(reconcileLessons({ env: h.env, now: NOW, goals: [] }), [], 'a goal that cannot be found changes nothing');
    assert.deepEqual(listLessons({ env: h.env }).map((x) => x.state), ['in-goal', 'in-goal']);
    reconcileLessons({ env: h.env, now: NOW, goals: goals('done') });
    assert.deepEqual(listLessons({ env: h.env }).map((x) => [x.state, x.pr, x.landed_at]), [['landed', 'memoro-cli#7', NOW.toISOString()], ['landed', 'memoro-cli#7', NOW.toISOString()]]);
    // No verb moves a landed lesson, and none sets landed on an open one.
    for (const argv of [['lesson', 'carry', a, '--goal', 'mc/learned'], ['lesson', 'dismiss', a, '--reason', 'x'], ['lesson', 'add', '--kind', 'wrong-question', '--state', 'landed', '--file', '-']]) {
      const before = tree(h.root);
      assert.equal((await call(h, 'person', argv)).code, 2, argv.join(' '));
      assert.deepEqual(tree(h.root), before, `${argv.join(' ')}: nothing written`);
    }
    const dropped = home(); const [c] = await open(dropped);
    carryLesson({ env: dropped.env, name: c, goal: 'mc/learned', now: NOW, goals: live });
    reconcileLessons({ env: dropped.env, now: NOW, goals: goals('dropped') });
    const [lesson] = listLessons({ env: dropped.env });
    assert.deepEqual([lesson.state, lesson.goal, lesson.pr], ['open', null, null]);
  });
});

describe('a differing answer always leaves a lesson', () => {
  it('leaves an answer-differs lesson naming the item and both option texts when Martin chose otherwise than the recommendation', async () => {
    const h = home(); const item = briefedItem(h);
    const r = await call(h, 'martin', ['item', item.id, 'close', '--by', 'martin', '--chose', 'change', '--summary', 'Martin valde att ändra regeln.']);
    assert.equal(r.code, 0, r.stderr);
    const lessons = listLessons({ env: h.env });
    assert.equal(lessons.length, 1);
    assert.deepEqual([lessons[0].kind, lessons[0].state, lessons[0].item, lessons[0].programme], ['answer-differs', 'open', item.id, 'alpha']);
    const text = readFileSync(join(h.env.MC_WORK_ROOT, 'martin', 'lessons', `${lessons[0].name}.md`), 'utf8');
    for (const wanted of [item.id, 'alpha/one', 'keep', 'behåll regeln som den är', 'change', 'ändra regeln till att gälla alla']) assert.ok(text.includes(wanted), wanted);
    assert.deepEqual([readDeskItem(item.id, { env: h.env }).state, readDeskItem(item.id, { env: h.env }).chose], ['closed', 'change']);
  });

  it('leaves none when he chose the recommendation, and refuses a close that names no option or one the brief lacks, leaving the item open', async () => {
    const h = home(); const item = briefedItem(h);
    for (const argv of [['--chose', 'nope'], []]) {
      const before = tree(h.root);
      const r = await call(h, 'martin', ['item', item.id, 'close', '--by', 'martin', ...argv, '--summary', 'Martin valde.']);
      assert.equal(r.code, 2, argv.join(' '));
      assert.deepEqual(tree(h.root), before, `${argv.join(' ') || 'no --chose'}: nothing written, the item stays open`);
    }
    const r = await call(h, 'martin', ['item', item.id, 'close', '--by', 'martin', '--chose', 'keep', '--summary', 'Martin behöll regeln.']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(listLessons({ env: h.env }), []);
    assert.equal(readDeskItem(item.id, { env: h.env }).state, 'closed');
  });

  it('records the recommendation with brief --recommend, only an option the brief names', async () => {
    const h = home(); const at = '2026-11-13T10:00:00Z';
    const item = { schema: 'mc-desk-item', version: 1, id: deskItemId('goal', 'alpha/one', at), kind: 'goal', reference: 'alpha/one', source_at: at, opened_at: at, state: 'prepared', sort: 'product', reversible: null, due_at: null, outcome: null };
    writeDeskItem(item, { env: h.env }); writeFileSync(join(itemDirectory(item, h.env), 'brief.md'), BRIEF);
    const before = tree(h.root);
    assert.equal((await call(h, 'decision', ['item', item.id, 'brief', '--sort', 'product', '--reversible', 'yes', '--recommend', 'maybe'])).code, 2);
    assert.deepEqual(tree(h.root), before);
    assert.equal((await call(h, 'decision', ['item', item.id, 'brief', '--sort', 'product', '--reversible', 'yes', '--recommend', 'keep'])).code, 0);
    assert.equal(readDeskItem(item.id, { env: h.env }).recommend, 'keep');
  });
});

describe('a decision pass that gives up leaves an unsettled lesson', () => {
  it('writes one lesson at the second failure, not the first, and only one per item', () => {
    const h = home(); mkdirSync(h.env.MC_WORK_ROOT, { recursive: true });
    const at = '2026-11-14T10:00:00Z';
    const item = { schema: 'mc-desk-item', version: 1, id: deskItemId('decision', 'decision:r', at), kind: 'decision', reference: 'decision:r', source_at: at, opened_at: at, state: 'prepared', sort: 'technical', reversible: null, due_at: null, outcome: null };
    writeDeskItem(item, { env: h.env });
    const io2 = { env: h.env, write: (path, text) => writeFileSync(path, text), writeJson: (path, value) => writeFileSync(path, JSON.stringify(value)) };
    const first = decisionFailure(item.id, { ...io2, reason: 'session exited', at: '2026-11-14T10:05:00Z' });
    assert.deepEqual([first.lessonError, first.item.decision_failures.length], [null, 1]);
    assert.deepEqual(listLessons({ env: h.env }), [], 'one failure is not giving up');
    assert.equal(decisionFailure(item.id, { ...io2, reason: 'session exited again', at: '2026-11-14T11:05:00Z' }).lessonError, null);
    const [lesson] = listLessons({ env: h.env });
    assert.deepEqual([lesson.kind, lesson.state, lesson.item, lesson.by], ['unsettled', 'open', item.id, 'runner']);
    assert.equal(readDeskItem(item.id, { env: h.env }).state, 'for-martin', 'the item still goes to Martin');
    decisionFailure(item.id, { ...io2, reason: 'a third time', at: '2026-11-14T12:05:00Z' });
    assert.equal(listLessons({ env: h.env }).length, 1);
  });
});

describe('a failed decision pass and a lesson brief are written under the lock, on the record read there', () => {
  const at = '2026-11-14T10:00:00Z';
  const prepared = () => ({ schema: 'mc-desk-item', version: 1, id: deskItemId('decision', 'decision:r', at), kind: 'decision', reference: 'decision:r', source_at: at, opened_at: at, state: 'prepared', sort: 'technical', reversible: null, due_at: null, outcome: null });
  const io2 = (h) => ({ env: h.env, write: (path, text) => writeFileSync(path, text), writeJson: (path, value) => writeFileSync(path, JSON.stringify(value)) });
  it('adds no failure, brief or lesson to an item the session settled before the hold', () => {
    const h = home(); const item = prepared(); writeDeskItem(item, { env: h.env });
    const settled = { ...item, state: 'closed', outcome: { by: 'decision', at: '2026-11-14T10:04:00.000Z', summary: 'Settled.' } };
    const holds = [];
    const lock = (root, fn, options) => { holds.push(options); writeJsonAtomic(join(itemDirectory(item, h.env), 'item.json'), settled); return fn(); };
    const before = tree(h.root);
    const ended = decisionFailure(item.id, { ...io2(h), reason: 'exited', at: '2026-11-14T10:05:00Z', lock, read: id => readDeskItem(id, { env: h.env }) });
    assert.deepEqual(ended, { item: null, lessonError: null }); assert.deepEqual(holds, [{ strict: true, name: 'desk-item' }]);
    assert.deepEqual(readDeskItem(item.id, { env: h.env }), settled);
    assert.deepEqual(Object.keys(tree(h.root)), Object.keys(before), 'no brief.md and no other file appeared');
    assert.deepEqual(listLessons({ env: h.env }), []);
  });
  it('lets a lock that cannot be taken stop the failure before anything is written', () => {
    const h = home(); const item = prepared(); writeDeskItem(item, { env: h.env }); const before = tree(h.root);
    const lock = () => { throw new Error('the runner lock is held by pid 4242 — try again'); };
    assert.throws(() => decisionFailure(item.id, { ...io2(h), reason: 'exited', at: '2026-11-14T10:05:00Z', lock }), /held by pid 4242/u);
    assert.deepEqual(tree(h.root), before);
  });
  it('briefs a lesson once: an item that appears before the hold is kept, and the second brief is refused', async () => {
    const h = home(); const [name] = await open(h);
    const other = 'Vad det gäller\n\n- keep: behåll\n- change: ändra\n';
    let made;
    const lock = (root, fn) => { made = briefLesson({ env: h.env, name, brief: BRIEF, now: NOW }); return fn(); };
    const twice = briefLesson({ env: h.env, name, brief: other, now: NOW, lock });
    assert.equal(twice.error, `lesson ${name} has been brought to Martin already`);
    assert.equal(readFileSync(join(itemDirectory(made.item, h.env), 'brief.md'), 'utf8'), `${BRIEF.trim()}\n`, 'the brief of the first stands');
    assert.deepEqual(readDeskItem(made.item.id, { env: h.env }), made.item);
    assert.deepEqual(readdirSync(join(h.env.MC_WORK_ROOT, 'martin', 'items')).filter(n => !n.startsWith('.')), [made.item.id], 'one item');
    assert.equal(listLessons({ env: h.env })[0].state, 'dismissed');
  });
  it('briefs a lesson under the strict lock, writes nothing when it cannot be taken, and leaves the lesson open', async () => {
    const h = home(); const [name] = await open(h); const holds = [];
    const before = tree(h.root);
    const lock = (root, fn, options) => { holds.push(options); throw new Error('the runner lock is held by pid 4242 — try again'); };
    assert.throws(() => briefLesson({ env: h.env, name, brief: BRIEF, now: NOW, lock }), /held by pid 4242/u);
    assert.deepEqual(holds, [{ strict: true, name: 'desk-item' }]); assert.deepEqual(tree(h.root), before);
    assert.equal(listLessons({ env: h.env })[0].state, 'open');
    const refused = io();
    assert.equal(await martin(['lesson', 'brief', name, '--file', '-'], { ...refused, env: { ...h.env, MC_ROLE: 'martin' }, now: () => NOW, readStdin: () => BRIEF, lock }), 1);
    assert.equal(refused.o.stderr, 'mc: the runner lock is held by pid 4242 — try again\n');
  });
});
