import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { runMcCli } from '../_helpers/mc-cli.js';
import { run } from '../../../src/mc/commands/decisions.js';

const scratch = mkdtempSync(join(tmpdir(), 'mc-decisions-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const row = ({ outcome, at, goal = 'mc/goal', kind = 'technical', choice = 'a', recommend = 'a', product = 0.1 } = {}) => ({
  at, programme: 'mc', goal, kind, question: 'Which rule?\nA second line.', options: { a: 'use the standard', b: 'make a new rule' }, recommend, outcome,
  model: 'jev-1.14.0', answers: { answer: { choice, probabilities: { [choice]: 0.92 } }, fits: 0.88, settled: 0.3, product }, reason: 'recorded reading',
});
const withoutKind = (value) => { const old = { ...value }; delete old.kind; return old; };

function fixture(lines) {
  const home = mkdtempSync(join(scratch, 'home-'));
  const ledger = join(home, 'jev', 'decisions.jsonl');
  mkdirSync(join(home, 'jev'), { recursive: true });
  writeFileSync(ledger, lines.join('\n') + '\n');
  const output = []; const errors = [];
  const env = { MC_HOME: home, MC_WORK_ROOT: join(scratch, 'work') };
  const deps = { env, now: () => new Date('2026-11-14T00:00:00Z'), stdout: { write: (text) => output.push(text) }, stderr: { write: (text) => errors.push(text) } };
  const snapshot = () => snapshotHome(home);
  const before = snapshot();
  return { env, deps, output, errors, ledger, before, snapshot };
}

function snapshotHome(home) {
  if (!existsSync(home)) return null;
  const walk = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const name = prefix + entry.name;
    return entry.isDirectory() ? [[name + '/', null], ...walk(join(dir, entry.name), name + '/')] : [[name, readFileSync(join(dir, entry.name)).toString('base64')]];
  });
  return walk(home);
}

test('mc decisions lists only decided and answered rows, flags product readings first, and never writes', async () => {
  const f = fixture([
    JSON.stringify(row({ outcome: 'answered', at: '2026-11-12T10:00:00Z' })),
    JSON.stringify(row({ outcome: 'decided', at: '2026-11-13T10:00:00Z', choice: 'b', recommend: 'a', product: 0.80 })),
    JSON.stringify(row({ outcome: 'martin', at: '2026-11-13T11:00:00Z' })),
    JSON.stringify(row({ outcome: 'reserved', at: '2026-11-13T12:00:00Z' })),
    JSON.stringify(withoutKind(row({ outcome: 'answered', at: '2026-11-13T13:00:00Z' }))),
    '{broken',
  ]);
  const result = runMcCli(['decisions', '--since', '2026-11-07'], f.env);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.snapshot(), f.before, 'the actual CLI leaves all MC_HOME names and bytes unchanged');
  const text = result.stdout;
  assert.ok(text.indexOf('2026-11-13T10:00:00Z') < text.indexOf('2026-11-12T10:00:00Z'));
  assert.match(text, /2026-11-13T10:00:00Z  mc\/goal  session  Which rule\? A second line\./u);
  assert.match(text, /chose a: use the standard  jev: b \(p 0\.92, fits 0\.88, settled 0\.30, product 0\.80, jev-1\.14\.0\)  jev preferred b  jev read this as a product choice/u);
  assert.match(text, /2026-11-13T13:00:00Z  mc\/goal  jev  Which rule/u);
  assert.ok(text.indexOf('jev read this as a product choice') < text.indexOf('2026-11-13T13:00:00Z'), 'product-flagged decisions are listed first');
  assert.equal(result.stderr, `mc decisions: ${f.ledger}:6: unparseable ledger line\n`);
  assert.equal(await run(['--since', '2026-11-07', '--json'], f.deps), 0);
  const data = JSON.parse(f.output.join(''));
  assert.deepEqual(data.map(({ at, chosen, answered_by, option }) => ({ at, chosen, answered_by, option })), [
    { at: '2026-11-13T10:00:00Z', chosen: 'a', answered_by: 'session', option: 'use the standard' },
    { at: '2026-11-13T13:00:00Z', chosen: 'a', answered_by: 'jev', option: 'use the standard' },
    { at: '2026-11-12T10:00:00Z', chosen: 'a', answered_by: 'jev', option: 'use the standard' },
  ]);
  assert.equal(data[0].jev_preferred, 'b');
  assert.equal(data[0].product_flag, true);
  for (const item of data) {
    assert.equal(item.programme, 'mc');
    assert.equal(item.goal, 'mc/goal');
    assert.equal(item.question, 'Which rule? A second line.');
    assert.ok(text.includes(item.reading));
  }
  assert.deepEqual(f.snapshot(), f.before);
  assert.deepEqual(text.split('\n').filter((line) => /^2026-/u.test(line)).map((line) => line.split('  ')[0]), ['2026-11-13T10:00:00Z', '2026-11-13T13:00:00Z', '2026-11-12T10:00:00Z']);
});

test('since/programme narrow the report, json returns the same filtered data, and an absent ledger is a read-only empty result', async () => {
  const f = fixture([
    JSON.stringify(row({ outcome: 'decided', at: '2026-11-10T00:00:00Z' })),
    JSON.stringify(row({ outcome: 'decided', at: '2026-11-01T00:00:00Z' })),
    JSON.stringify({ ...row({ outcome: 'answered', at: '2026-11-13T00:00:00Z' }), programme: 'other', goal: 'other/task' }),
    JSON.stringify(withoutKind(row({ outcome: 'answered', at: '2026-11-13T12:00:00Z' }))),
  ]);
  const result = runMcCli(['decisions', '--since', '2026-11-12', '--programme', 'mc', '--json'], f.env);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.snapshot(), f.before);
  const rows = JSON.parse(result.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].answered_by, 'jev');
  assert.equal(rows[0].chosen, 'a');
  assert.equal(rows[0].product_flag, undefined);
  assert.equal(await run([], f.deps), 0);
  assert.deepEqual(f.output.join('').split('\n').filter((line) => /^2026-/u.test(line)).map((line) => line.split('  ')[0]), ['2026-11-13T12:00:00Z', '2026-11-13T00:00:00Z', '2026-11-10T00:00:00Z']);
  assert.deepEqual(f.snapshot(), f.before);
  const missing = { ...f.deps, env: { MC_HOME: join(scratch, 'missing') } };
  f.output.length = 0;
  const absent = runMcCli(['decisions'], { ...f.env, ...missing.env });
  assert.equal(absent.status, 0, absent.stderr);
  assert.equal(absent.stdout, 'mc decisions: nothing to report\n');
  assert.equal(existsSync(missing.env.MC_HOME), false, 'missing ledger does not create MC_HOME');
});

const reader = (extra) => ({ ...row({ outcome: 'read', at: '2026-11-13T09:00:00Z', choice: 'b', recommend: 'a' }), answered_by: 'reader', chosen: 'b', reader: { tool: 'claude', model: 'fable', key: 'b', why: 'the standard says b' }, ...extra });

test('one way to ask: the record — mc decisions names who answered, lists differing and unread answers first, and reads old rows as before', async () => {
  const f = fixture([
    JSON.stringify(row({ outcome: 'answered', at: '2026-11-13T12:00:00Z' })),
    JSON.stringify(reader()),
    JSON.stringify({ ...row({ outcome: 'decided', at: '2026-11-12T08:00:00Z', recommend: 'a' }), answered_by: 'session', chosen: 'a', outcome: 'decided', unread_reason: 'the reader ended without a verdict', reason: 'the reader ended without a verdict' }),
    JSON.stringify({ ...reader({ at: '2026-11-13T10:00:00Z', chosen: 'a', reader: { tool: 'codex', model: 'gpt', key: 'a' } }) }),
    JSON.stringify({ ...row({ outcome: 'defect', at: '2026-11-13T11:00:00Z' }), answered_by: 'reader', chosen: null, reader: { tool: 'claude', model: 'fable' } }),
    JSON.stringify(row({ outcome: 'martin', at: '2026-11-13T13:00:00Z' })),
  ]);
  const result = runMcCli(['decisions', '--since', '2026-11-07'], f.env);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.snapshot(), f.before, 'read-only');
  const lines = result.stdout.split('\n').filter((line) => /^2026-/u.test(line));
  assert.deepEqual(lines.map((line) => line.split('  ')[0]), ['2026-11-13T11:00:00Z', '2026-11-13T09:00:00Z', '2026-11-12T08:00:00Z', '2026-11-13T12:00:00Z', '2026-11-13T10:00:00Z'], 'defect, differing and unread first, then the rest by time; martin rows are not listed');
  assert.match(result.stdout, /chose b: make a new rule  reader claude fable: the standard says b  not the recommendation \(a\)/u);
  assert.match(result.stdout, /chose a: use the standard  session: the reader ended without a verdict  UNREAD: nothing read it/u);
  assert.match(result.stdout, /found a goal defect  reader claude fable/u);
  assert.match(result.stdout, /mc\/goal  reader  Which rule\?/u);
  assert.equal(await run(['--since', '2026-11-07', '--json'], f.deps), 0);
  const data = JSON.parse(f.output.join(''));
  assert.deepEqual(data.map((item) => [item.answered_by, item.outcome, item.unread === true, item.differs === true]), [
    ['reader', 'defect', false, false], ['reader', 'read', false, true], ['session', 'decided', true, false], ['jev', 'answered', false, false], ['reader', 'read', false, false],
  ]);
});

test('one way to ask: the record — an old decided row with no answered_by is the session\'s choice of the recommendation, never unread', async () => {
  const f = fixture([JSON.stringify(row({ outcome: 'decided', at: '2026-11-13T10:00:00Z', choice: 'b', recommend: 'a', product: 0.1 }))]);
  assert.equal(await run(['--since', '2026-11-07', '--json'], f.deps), 0);
  const [item] = JSON.parse(f.output.join(''));
  assert.deepEqual([item.answered_by, item.chosen, item.unread, item.differs], ['session', 'a', undefined, undefined]);
});
