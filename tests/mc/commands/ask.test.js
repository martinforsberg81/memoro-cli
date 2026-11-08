import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { run } from '../../../src/mc/commands/ask.js';
import { goalJson } from '../_helpers/goal-file.js';

const scratch = mkdtempSync(join(tmpdir(), 'mc-ask-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const programmeHome = join(scratch, 'programmes');
const programmeDir = join(programmeHome, 'jev');
const repoDir = join(programmeDir, 'memoro-cli');
const extra = join(repoDir, 'docs/technical/standard.md');
mkdirSync(join(repoDir, 'docs/project/jev'), { recursive: true });
mkdirSync(join(repoDir, 'docs/technical'), { recursive: true });
writeFileSync(join(programmeDir, 'README.md'), 'Programme aim.');
writeFileSync(join(repoDir, 'docs/project/jev/rulings.md'), 'Programme ruling.');
writeFileSync(extra, 'The standard.');

const options = [
  '--reason', 'How should the timeout test work?',
  '--option', 'fake_timer: inject a timer', '--option', 'real_wait: sleep 15 seconds',
  '--recommend', 'fake_timer', '--document', 'memoro-cli/docs/technical/standard.md',
];
const reply = (p = 0.95, choice = 'fake_timer') => ({ status: 200, text: async () => JSON.stringify({
  model: 'jev-1.14.0', answers: {
    answer: { choice, probabilities: { [choice]: p } },
    fits: { noul: 0.9 }, settled: { noul: 0.9 },
  },
}) });
function fixture({ response = reply(), env = { MC_PROGRAMME: 'jev', cwd: repoDir }, realpath, list = ['memoro-cli'] } = {}) {
  const output = [];
  const errors = [];
  const ledger = [];
  const requests = [];
  const deps = {
    env, home: programmeHome, now: () => new Date('2026-11-08T00:00:00Z'),
    stdout: { write: (s) => output.push(s) }, stderr: { write: (s) => errors.push(s) },
    list: () => list, known: () => ['/home/m/memoro-cli'], realpath,
    readKeys: () => ({ TYPESAFE_API_KEY: 'fixture-secret-value' }),
    ledger: (line) => ledger.push(JSON.parse(line)),
    jev: { transport: (url, init) => { requests.push({ url, init }); return response; }, timer: () => new Promise(() => {}) },
  };
  return { deps, requests, ledger, out: () => output.join(''), err: () => errors.join('') };
}

test('mc ask without a goal asks jev, sends programme context and a confined document, and leaves goal state absent', async () => {
  const f = fixture();
  assert.equal(await run(options, f.deps), 0, f.err());
  const state = JSON.parse(f.requests[0].init.body).state;
  assert.equal(state.goal, null);
  assert.equal(existsSync(join(programmeDir, 'goals')), false, 'an ask without a goal created no goal directory or files');
  assert.match(JSON.stringify(JSON.parse(f.requests[0].init.body).questions), /this work/u);
  assert.doesNotMatch(JSON.stringify(JSON.parse(f.requests[0].init.body).questions), /this goal/u);
  assert.equal(state.programme.readme, 'Programme aim.');
  assert.deepEqual(state.programme.rulings, [{ path: 'memoro-cli/docs/project/jev/rulings.md', text: 'Programme ruling.' }]);
  assert.deepEqual(state.documents, [{ path: 'memoro-cli/docs/technical/standard.md', text: 'The standard.' }]);
  assert.match(f.out(), /^mc: jev answered fake_timer /u);
  assert.deepEqual([f.ledger.length, f.ledger[0].verb, f.ledger[0].programme, f.ledger[0].goal, f.ledger[0].model], [1, 'ask', 'jev', null, 'jev-1.14.0']);
});

test('mc ask asks jev when MC_TOOL is unset or person, but a reserved act never requests', async () => {
  for (const env of [{ cwd: repoDir }, { MC_PROGRAMME: 'jev', MC_TOOL: 'person', cwd: repoDir }]) {
    const f = fixture({ env });
    assert.equal(await run(options, f.deps), 0, f.err());
    assert.equal(f.requests.length, 1);
    assert.equal(f.ledger[0].programme, 'jev');
  }
  const reserved = fixture();
  assert.equal(await run([...options, '--reserved', 'deploy'], reserved.deps), 1);
  assert.equal(reserved.requests.length, 0);
  assert.deepEqual([reserved.ledger.length, reserved.ledger[0].verb, reserved.ledger[0].outcome], [1, 'ask', 'reserved']);
  assert.match(reserved.out(), /reserved act deploy — Martin decides, jev is not asked/u);
});

test('a non-answer exits 1; malformed calls exit 2 with an mc ask example', async () => {
  const f = fixture({ response: reply(0.5) });
  assert.equal(await run(options, f.deps), 1);
  assert.match(f.out(), /jev did not settle it: fake_timer .* not answered: p 0\.50/u);
  assert.equal(f.ledger[0].outcome, 'martin');
  const malformed = fixture();
  assert.equal(await run(['--reason', 'missing choices'], malformed.deps), 2);
  assert.match(malformed.err(), /mc ask <programme>\/<goal>/u);
});

test('mc ask redacts keys-source values from a malformed-call return instruction', async () => {
  const f = fixture();
  const key = 'fixture-secret-value';
  f.deps.readKeys = () => ({ TYPESAFE_API_KEY: key });
  assert.equal(await run(['--reason', 'question', '--option', key, '--option', 'second: option', '--recommend', 'missing'], f.deps), 2);
  assert.match(f.err(), /\[redacted\]/u);
  assert.doesNotMatch(f.err(), /fixture-secret-value/u);
});

test('outside and symlink-escaping documents are omitted with a confinement warning', async () => {
  const outside = join(scratch, 'secret.md');
  writeFileSync(outside, 'Do not send.');
  const link = join(repoDir, 'docs/technical/escape.md');
  const { symlinkSync } = await import('node:fs');
  symlinkSync(outside, link);
  const f = fixture();
  assert.equal(await run([...options, '--document', outside, '--document', '~/mc-ask-outside.md', '--document', 'memoro-cli/docs/technical/escape.md'], f.deps), 0);
  const state = JSON.parse(f.requests[0].init.body).state;
  assert.equal(state.documents.length, 1);
  assert.equal((f.err().match(/outside the goal's and programme's repositories/gu) || []).length, 3);
});

test('answering with a named goal appends a goal log entry without changing its status', async () => {
  const goal = join(programmeHome, 'jev', 'goals', 'plain');
  mkdirSync(goal, { recursive: true });
  const documentPath = join(goal, 'GOAL.json');
  writeFileSync(documentPath, goalJson({ stage: 'build', title: 'Plain goal', goal: ['Answer one question.'], repos: ['memoro-cli'] }));
  writeFileSync(join(goal, 'LOG.md'), '');
  const f = fixture({ response: reply(0.95, 'one'), env: { MC_PROGRAMME: 'jev', cwd: repoDir }, list: ['memoro-cli'] });
  const argv = ['jev/plain', '--reason', 'Which?', '--option', 'one: first', '--option', 'two: second', '--recommend', 'one'];
  assert.equal(await run(argv, { ...f.deps, read: (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } }, write: writeFileSync,
    home: programmeHome, now: () => new Date('2026-11-08T00:00:00Z') }), 0, f.err());
  const logged = readFileSync(join(goal, 'LOG.md'), 'utf8');
  assert.match(logged, /jev answered one/u);
  assert.equal(JSON.parse(readFileSync(documentPath, 'utf8')).status, 'ready');
});
