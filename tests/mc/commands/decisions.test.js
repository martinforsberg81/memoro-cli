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
  assert.match(text, /2026-11-13T10:00:00Z  mc\/goal  technical  Which rule\? A second line\./u);
  assert.match(text, /chose a: use the standard  jev: b \(p 0\.92, fits 0\.88, settled 0\.30, product 0\.80, jev-1\.14\.0\)  jev preferred b  jev read this as a product choice/u);
  assert.match(text, /2026-11-13T13:00:00Z  mc\/goal  -/u);
  assert.ok(text.indexOf('jev read this as a product choice') < text.indexOf('2026-11-13T13:00:00Z'), 'product-flagged decisions are listed first');
  assert.equal(result.stderr, `mc decisions: ${f.ledger}:6: unparseable ledger line\n`);
  assert.equal(await run(['--since', '2026-11-07', '--json'], f.deps), 0);
  const data = JSON.parse(f.output.join(''));
  assert.deepEqual(data.map(({ at, chosen, kind, option }) => ({ at, chosen, kind, option })), [
    { at: '2026-11-13T10:00:00Z', chosen: 'a', kind: 'technical', option: 'use the standard' },
    { at: '2026-11-13T13:00:00Z', chosen: 'a', kind: '-', option: 'use the standard' },
    { at: '2026-11-12T10:00:00Z', chosen: 'a', kind: 'technical', option: 'use the standard' },
  ]);
  assert.equal(data[0].jev_preferred, 'b');
  assert.equal(data[0].product_flag, true);
  for (const item of data) {
    assert.equal(item.programme, 'mc');
    assert.equal(item.goal, 'mc/goal');
    assert.equal(item.question, 'Which rule? A second line.');
    assert.ok(text.includes(`jev: ${item.reading}`));
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
  assert.equal(rows[0].kind, '-');
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
