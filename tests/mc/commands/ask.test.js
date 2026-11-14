import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { run } from '../../../src/mc/commands/ask.js';
import { parseLog } from '../../../src/mc/goals.js';
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
const reply = (p = 0.95, choice = 'fake_timer', { fits = 0.9, settled = 0.9, product = 0.1 } = {}) => ({ status: 200, text: async () => JSON.stringify({
  model: 'jev-1.14.0', answers: {
    answer: { choice, probabilities: { [choice]: p } },
    fits: { noul: fits }, settled: { noul: settled }, product: { noul: product },
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
    jev: { transport: (url, init) => { requests.push({ url, init }); return typeof response === 'function' ? response(url, init) : response; }, timer: () => new Promise(() => {}) },
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
  assert.deepEqual(Object.keys(state.programme), ['readme'], 'the programme carries its README and no rulings');
  assert.doesNotMatch(JSON.stringify(state), /Programme ruling/u, 'a docs/project/<programme>/rulings.md is not sent');
  assert.deepEqual(state.documents, [{ path: 'memoro-cli/docs/technical/standard.md', text: 'The standard.' }]);
  assert.match(f.out(), /^mc: jev answered fake_timer /u);
  assert.deepEqual([f.ledger.length, f.ledger[0].verb, f.ledger[0].programme, f.ledger[0].goal, f.ledger[0].model], [1, 'ask', 'jev', null, 'jev-1.14.0']);
});

for (const [label, response, keys, expectedReading] of [
  ['a missed jev reading', reply(0.6, 'inject', { fits: 0.88, settled: 0.30, product: 0.10 }), undefined, 'inject (p 0.60, fits 0.88, settled 0.30, jev-1.14.0)'],
  ['a network error', () => { throw new Error('offline'); }, undefined, 'jev unavailable: network error (offline)'],
  ['a missing key', reply(), {}, 'jev unavailable: no TYPESAFE_API_KEY in the mc keys source'],
]) {
  test(`a session mc ask decides a technical question on ${label} without a goal`, async () => {
    const env = { MC_PROGRAMME: 'jev', MC_TOOL: 'claude', MC_ROLE: 'build-session:goal', cwd: repoDir };
    const args = ['--kind', 'technical', '--reason', 'Which timeout strategy?', '--option', 'inject: inject a timer', '--option', 'wait: wait fifteen seconds', '--recommend', 'inject'];
    const f = fixture({ env, response });
    if (keys) f.deps.readKeys = () => keys;
    assert.equal(await run(args, f.deps), 0, f.err());
    assert.equal(f.out(), `mc: decided by the session: inject — jev did not settle it (${expectedReading}) — continue with: inject a timer\n`);
    assert.equal(f.ledger.length, 1);
    assert.deepEqual([f.ledger[0].kind, f.ledger[0].outcome], ['technical', 'decided']);
    assert.equal(existsSync(join(programmeDir, 'goals')), false, 'no goal was created or changed');
    assert.ok(f.out().includes(expectedReading));
  });
}

test('a session mc ask decides technical reading with high product score without a goal', async () => {
  const env = { MC_PROGRAMME: 'jev', MC_TOOL: 'claude', MC_ROLE: 'build-session:goal', cwd: repoDir };
  const f = fixture({ env, response: reply(0.6, 'inject', { fits: 0.88, settled: 0.30, product: 0.95 }) });
  const args = ['--kind', 'technical', '--reason', 'Which timeout strategy?', '--option', 'inject: inject a timer', '--option', 'wait: wait fifteen seconds', '--recommend', 'inject'];
  assert.equal(await run(args, f.deps), 0, f.err());
  assert.deepEqual([f.ledger[0].kind, f.ledger[0].outcome, f.ledger[0].answers.product], ['technical', 'decided', 0.95]);
  assert.equal(existsSync(join(programmeDir, 'goals')), false);
});

test('a session mc ask without a goal refuses malformed kinds without writes', async () => {
  const env = { MC_PROGRAMME: 'jev', MC_TOOL: 'claude', MC_ROLE: 'build-session:goal', cwd: repoDir };
  const args = ['--kind', 'technical', '--reason', 'Which timeout strategy?', '--option', 'inject: inject a timer', '--option', 'wait: wait fifteen seconds', '--recommend', 'inject'];
  for (const kind of [null, 'unknown']) {
    const malformed = fixture({ env });
    assert.equal(await run([...args.filter((value) => value !== '--kind' && value !== 'technical'), ...(kind ? ['--kind', kind] : [])], malformed.deps), 2);
    assert.deepEqual([malformed.ledger.length, malformed.requests.length, malformed.out()], [0, 0, '']);
    assert.match(malformed.err(), /technical.*product/u);
    assert.match(malformed.err(), /--kind technical/u);
  }
});

test('mc ask rebuilds a state jev refuses for its input limit and answers from the smaller one; the ledger names the budget sent', async () => {
  const f = fixture();
  f.deps.jev.transport = (url, init) => {
    f.requests.push({ url, init });
    return f.requests.length === 1
      ? { status: 400, headers: { get: () => null }, text: async () => JSON.stringify({ detail: { error_type: 'max_tokens_exceeded' } }) }
      : reply();
  };
  assert.equal(await run(options, f.deps), 0, f.err());
  assert.equal(f.requests.length, 2, 'one refusal, then one answer');
  assert.match(f.out(), /^mc: jev answered fake_timer /u);
  assert.deepEqual([f.ledger[0].outcome, f.ledger[0].budget, f.ledger[0].error_type], ['answered', 63_000, 'max_tokens_exceeded']);
  assert.ok(f.ledger[0].trimmed.includes('budget shrunk to 63000 characters after max_tokens_exceeded'), f.ledger[0].trimmed.join('; '));
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
  const questions = JSON.parse(f.requests[0].init.body).questions;
  assert.equal(questions.answer.instructions, 'Which option is the right way for this goal to proceed, given the goal, its contract and the decided standards in the state');
  assert.equal(questions.fits.instructions, 'One of the options in `options` is a correct way for this goal to proceed');
  assert.equal(questions.settled.instructions, 'The goal, its contract, the programme README or the technical standards in the state already decide which option is right, so no new product or policy decision by Martin is needed');
  assert.equal(questions.product.instructions, 'Choosing between the options is a choice of product direction that changes what users are promised, what the product costs or how personal data is handled, and that the goal, the programme page and the standards in the state do not already answer');
  const logged = readFileSync(join(goal, 'LOG.md'), 'utf8');
  assert.match(logged, /jev answered one/u);
  assert.match(logged, /jev was asked: Which\?/u);
  assert.match(logged, /Option one: first/u);
  assert.match(logged, /Option two: second/u);
  assert.match(logged, /Recommended: one/u);
  assert.equal(JSON.parse(readFileSync(documentPath, 'utf8')).status, 'ready');
});

test('goal-bound mc ask ledger records only documents retained in the trimmed request', async () => {
  const goal = join(programmeHome, 'jev', 'goals', 'many-documents');
  mkdirSync(goal, { recursive: true });
  const documents = Array.from({ length: 100 }, (_, n) => ({ label: `doc ${n}`, path: `${String(n).padStart(3, '0')}-${'p'.repeat(3_000)}` }));
  writeFileSync(join(goal, 'GOAL.json'), goalJson({ stage: 'build', title: 'Many documents', goal: ['Ask about documents.'], repos: ['memoro-cli'], documents }));
  writeFileSync(join(goal, 'LOG.md'), '');
  const f = fixture({ response: reply(0.95, 'one') });
  const read = (path) => path.endsWith('/GOAL.json') ? readFileSync(path, 'utf8') : path.endsWith('/LOG.md') ? '' : 'document text';
  const argv = ['jev/many-documents', '--reason', 'Which?', '--option', 'one: first', '--option', 'two: second', '--recommend', 'one'];
  assert.equal(await run(argv, { ...f.deps, read, write: writeFileSync, home: programmeHome }), 0, f.err());
  const state = JSON.parse(f.requests[0].init.body).state;
  assert.ok(state.documents.length < documents.length);
  assert.deepEqual(f.ledger[0].documents, state.documents.map((item) => item.path));
  assert.ok(f.ledger[0].trimmed.some((item) => item.endsWith('dropped')));
});

test('an unresolved goal-bound ask records safe evidence and sets Martin directly', async () => {
  const goal = join(programmeHome, 'jev', 'goals', 'unsettled');
  mkdirSync(goal, { recursive: true });
  const file = join(goal, 'GOAL.json');
  const log = join(goal, 'LOG.md');
  writeFileSync(file, goalJson({ stage: 'build', title: 'Unsettled goal', goal: ['Ask once.'], repos: ['memoro-cli'] }));
  writeFileSync(log, '');
  const f = fixture({ response: reply(0.5, 'one'), env: { MC_PROGRAMME: 'jev', MC_GOAL: 'jev/unsettled', MC_TOOL: 'claude', MC_ROLE: 'build-session:goal', cwd: repoDir } });
  const read = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
  const argv = ['--kind', 'product', '--reason', 'Which design?', '--option', 'one: keep current rule', '--option', 'two: change rule', '--recommend', 'one', '--evidence', 'The standard is silent.'];
  assert.equal(await run(argv, { ...f.deps, read, write: writeFileSync }), 1, f.err());
  assert.equal(f.requests.length, 1, 'one consultation sequence');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).status, 'Martin');
  const logged = readFileSync(log, 'utf8');
  for (const text of ['Which design?', 'Option one: keep current rule', 'Option two: change rule', 'Recommended: one', 'The standard is silent.', 'not answered', 'take it to Martin']) assert.ok(logged.includes(text), text);
  const entry = parseLog(logged).at(-1);
  assert.deepEqual([entry.at, entry.stage, entry.status], ['2026-11-08T00:00:00Z', 'build', 'Martin'], 'the entry parses, so the question reads back from the goal');
  assert.match(entry.comment, /Option two: change rule/u);
  assert.equal(f.ledger[0].goal, 'jev/unsettled');
});

for (const [label, response, keys, expectedReading, product] of [
  ['a missed jev reading', reply(0.6, 'fake_timer', { fits: 0.88, settled: 0.30, product: 0.10 }), undefined, 'fake_timer (p 0.60, fits 0.88, settled 0.30, jev-1.14.0)', 0.10],
  ['a high product reading', reply(0.6, 'fake_timer', { fits: 0.88, settled: 0.30, product: 0.95 }), undefined, 'fake_timer (p 0.60, fits 0.88, settled 0.30, jev-1.14.0)', 0.95],
  ['a network error', () => { throw new Error('offline'); }, undefined, 'jev unavailable: network error (offline)', undefined],
  ['a missing key', reply(), {}, 'jev unavailable: no TYPESAFE_API_KEY in the mc keys source', undefined],
]) {
  test(`a goal-bound technical mc ask decides on ${label} and preserves stage and status`, async () => {
    const goal = join(programmeHome, 'jev', 'goals', 'technical');
    const file = join(goal, 'GOAL.json'); const log = join(goal, 'LOG.md');
    const original = goalJson({ stage: 'build', title: 'Technical call', goal: ['Ask once.'], repos: ['memoro-cli'] });
    const store = { [file]: original, [log]: '' };
    const f = fixture({ response, env: { MC_PROGRAMME: 'jev', MC_GOAL: 'jev/technical', MC_TOOL: 'claude', MC_ROLE: 'build-session:goal', cwd: repoDir } });
    if (keys) f.deps.readKeys = () => keys;
    const argv = ['--kind', 'technical', '--reason', 'Which timer?', '--option', 'fake_timer: inject a timer', '--option', 'real_wait: wait fifteen seconds', '--recommend', 'fake_timer', '--evidence', 'No standard selects one.'];
    const read = (path) => store[path] ?? null;
    const write = (path, text) => { store[path] = text; };
    assert.equal(await run(argv, { ...f.deps, read, write }), 0, f.err());
    assert.equal(store[file], original, 'GOAL.json is byte-identical');
    assert.deepEqual([JSON.parse(store[file]).stage, JSON.parse(store[file]).status], ['build', 'ready']);
    assert.equal(f.out(), `mc: decided by the session: fake_timer — jev did not settle it (${expectedReading}) — continue with: inject a timer\n`);
    const entries = parseLog(store[log]);
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.deepEqual([entry.stage, entry.status], ['build', 'ready']);
    assert.equal(entry.comment.split('\n')[0], 'Decided by the session (technical): Which timer?');
    for (const text of ['Option fake_timer: inject a timer', 'Option real_wait: wait fifteen seconds', 'Recommended: fake_timer', 'Evidence: No standard selects one.', `jev reading: ${expectedReading}`]) assert.ok(entry.comment.split('\n').includes(text), text);
    assert.equal(f.ledger.length, 1);
    assert.deepEqual([f.ledger[0].goal, f.ledger[0].kind, f.ledger[0].outcome], ['jev/technical', 'technical', 'decided']);
    assert.equal(f.ledger[0].question, 'Which timer?');
    assert.deepEqual(f.ledger[0].options, { fake_timer: 'inject a timer', real_wait: 'wait fifteen seconds' });
    assert.equal(f.ledger[0].recommend, 'fake_timer');
    assert.equal(f.ledger[0].answers?.product, product);
    assert.equal(f.requests.length, keys ? 0 : 1);
  });
}

test('jev product reading does not reroute an unsettled technical mc ask to Martin', async () => {
  const f = fixture({ response: reply(0.6, 'fake_timer', { fits: 0.88, settled: 0.30, product: 0.95 }), env: { MC_TOOL: 'claude', MC_ROLE: 'build-session:goal' } });
  const argv = ['--kind', 'technical', '--reason', 'Which timer?', '--option', 'fake_timer: inject a timer', '--option', 'real_wait: wait fifteen seconds', '--recommend', 'fake_timer'];
  assert.equal(await run(argv, f.deps), 0, f.err());
  assert.match(f.out(), /^mc: decided by the session: fake_timer — jev did not settle it \(fake_timer \(p 0\.60, fits 0\.88, settled 0\.30, jev-1\.14\.0\)/u);
  assert.equal(f.ledger.length, 1);
  assert.deepEqual([f.ledger[0].kind, f.ledger[0].outcome, f.ledger[0].answers.product], ['technical', 'decided', 0.95]);
});

test('interactive Martin may consult jev on a newly synthesized question and keeps truthful role evidence', async () => {
  const goal = join(programmeHome, 'jev', 'goals', 'martin-choice');
  mkdirSync(goal, { recursive: true });
  const file = join(goal, 'GOAL.json'); const log = join(goal, 'LOG.md');
  writeFileSync(file, goalJson({ status: 'Martin', stage: 'build', title: 'Martin choice', repos: ['memoro-cli'] }));
  writeFileSync(log, '## 2026-11-07T00:00Z · runner · build · Martin\n\nComment: runner failure: no structured design question\n');
  const f = fixture({ response: reply(0.95, 'shared'), env: { MC_PROGRAMME: 'jev', MC_GOAL: 'jev/martin-choice', MC_TOOL: 'claude', MC_ROLE: 'martin', cwd: repoDir } });
  f.deps.readKeys = () => ({ TYPESAFE_API_KEY: 'fixture-secret-value' });
  const read = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
  assert.equal(await run(['--kind', 'product', '--reason', 'Which general rule?', '--option', 'specific: keep local behavior', '--option', 'shared: define a shared rule', '--recommend', 'shared'], { ...f.deps, read, write: writeFileSync }), 0, `${f.err()}${f.out()}`);
  assert.equal(f.requests.length, 1);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).status, 'Martin');
  assert.equal(parseLog(readFileSync(log, 'utf8')).at(-1).role, 'martin');
});

test('a reserved goal-bound ask sets Martin without a jev request', async () => {
  const goal = join(programmeHome, 'jev', 'goals', 'reserved');
  mkdirSync(goal, { recursive: true });
  const file = join(goal, 'GOAL.json');
  writeFileSync(file, goalJson({ stage: 'build', title: 'Reserved goal', goal: ['Reserved act.'], repos: ['memoro-cli'] }));
  writeFileSync(join(goal, 'LOG.md'), '');
  const f = fixture({ env: { MC_PROGRAMME: 'jev', MC_GOAL: 'jev/reserved', MC_TOOL: 'claude', MC_ROLE: 'build-session:goal', cwd: repoDir } });
  const read = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
  assert.equal(await run(['--kind', 'product', '--reason', 'Deploy?', '--option', 'yes: deploy', '--option', 'no: do not', '--recommend', 'no', '--reserved', 'deploy'], { ...f.deps, read, write: writeFileSync }), 1);
  assert.equal(f.requests.length, 0);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).status, 'Martin');
  const entry = parseLog(readFileSync(join(goal, 'LOG.md'), 'utf8')).at(-1);
  assert.deepEqual([entry.at, entry.stage, entry.status], ['2026-11-08T00:00:00Z', 'build', 'Martin']);
  assert.match(entry.comment, /Deploy\?/u);
  assert.match(entry.comment, /Option yes: deploy/u);
});

test('a goal finished or moved by a person while jev is asked is not set over by the answer', async () => {
  const goal = join(programmeHome, 'jev', 'goals', 'raced');
  mkdirSync(goal, { recursive: true });
  const file = join(goal, 'GOAL.json');
  const log = join(goal, 'LOG.md');
  const read = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
  const argv = ['jev/raced', '--kind', 'product', '--reason', 'Which?', '--option', 'one: a', '--option', 'two: b', '--recommend', 'one'];
  const env = { MC_PROGRAMME: 'jev', MC_GOAL: 'jev/raced', MC_TOOL: 'claude', MC_ROLE: 'build-session:goal', cwd: repoDir };
  const build = (fields) => goalJson({ stage: 'build', title: 'Raced', goal: ['Move while asked.'], repos: ['memoro-cli'], ...fields });

  // Finished while the model is out, and jev does not answer: nothing is written to the finished goal.
  writeFileSync(file, build({}));
  writeFileSync(log, '');
  const finishing = fixture({ env });
  finishing.deps.jev.transport = () => {
    writeFileSync(file, build({ stage: 'done' }));
    return { status: 400, text: async () => '' };
  };
  assert.equal(await run(argv, { ...finishing.deps, read, write: writeFileSync }), 1, finishing.err());
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).stage, 'done');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).status, 'ready', 'a finished goal is not set Martin');
  assert.equal(readFileSync(log, 'utf8'), '', 'a finished goal gets no log entry from the ask');
  assert.match(finishing.err(), /is done — the ask is not recorded/u);
  assert.equal(finishing.ledger.length, 1, 'the jev ledger still records the ask');

  // A person blocks it while jev answers: the answer is logged as the goal now is, and the person's status stands.
  writeFileSync(file, build({}));
  writeFileSync(log, '');
  const moving = fixture({ env });
  moving.deps.jev.transport = () => {
    writeFileSync(file, build({ status: 'blocked' }));
    return reply(0.95, 'one');
  };
  assert.equal(await run(argv, { ...moving.deps, read, write: writeFileSync }), 0, moving.err());
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).status, 'blocked', 'the person\'s status stands');
  const entry = parseLog(readFileSync(log, 'utf8')).at(-1);
  assert.deepEqual([entry.stage, entry.status], ['build', 'blocked']);
  assert.match(entry.done, /^jev answered /u);
});

test('goal-bound ask refuses role/goal mismatches and finished goals without mutation', async () => {
  const mismatch = join(programmeHome, 'jev', 'goals', 'mismatch');
  mkdirSync(mismatch, { recursive: true });
  const mismatchFile = join(mismatch, 'GOAL.json');
  writeFileSync(mismatchFile, goalJson({ stage: 'build', title: 'Mismatch', goal: ['Do not cross goals.'], repos: ['memoro-cli'] }));
  const mismatchLog = join(mismatch, 'LOG.md');
  writeFileSync(mismatchLog, '');
  const f = fixture({ env: { MC_PROGRAMME: 'jev', MC_GOAL: 'jev/other', MC_TOOL: 'claude', MC_ROLE: 'build-session:goal', cwd: repoDir } });
  const read = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
  const argv = ['jev/mismatch', '--reason', 'Which?', '--option', 'one: a', '--option', 'two: b', '--recommend', 'one'];
  assert.equal(await run(argv, { ...f.deps, read, write: writeFileSync }), 2);
  assert.equal(f.requests.length, 0);
  assert.equal(JSON.parse(readFileSync(mismatchFile, 'utf8')).status, 'ready');
  assert.equal(readFileSync(mismatchLog, 'utf8'), '');

  const finished = join(programmeHome, 'jev', 'goals', 'closed-ask');
  mkdirSync(finished, { recursive: true });
  const finishedFile = join(finished, 'GOAL.json');
  writeFileSync(finishedFile, goalJson({ stage: 'done', title: 'Finished', goal: ['Stay closed.'], repos: ['memoro-cli'] }));
  writeFileSync(join(finished, 'LOG.md'), '');
  const closed = fixture();
  assert.equal(await run(['jev/closed-ask', ...argv.slice(1)], { ...closed.deps, read, write: writeFileSync }), 1);
  assert.equal(closed.requests.length, 0);
  assert.equal(JSON.parse(readFileSync(finishedFile, 'utf8')).stage, 'done');
});

test('desk-prepare cannot ask with or without goal identity and writes no file or ledger', async () => {
  const snapshot = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? [[path, 'directory'], ...snapshot(path)] : [[path, readFileSync(path, 'utf8')]];
  });
  for (const goal of [undefined, 'jev/blocked']) {
    const f = fixture({ env: { MC_ROLE: 'desk-prepare', MC_GOAL: goal, MC_HOME: scratch, MC_WORK_ROOT: scratch } });
    const before = snapshot(scratch);
    f.deps.readKeys = () => assert.fail('preparation read question credentials');
    assert.equal(await run([...(goal ? [goal] : []), ...options, '--kind', 'technical'], f.deps), 2);
    assert.match(f.err(), /desk-prepare cannot ask/u);
    assert.deepEqual(snapshot(scratch), before);
    assert.deepEqual(f.requests, []); assert.deepEqual(f.ledger, []);
  }
});


test('headless decision may ask at every active goal stage, with decision attribution', async () => {
  for (const stage of ['draft','build','review','finish','merge']) {
    const goal = join(programmeHome,'jev','goals',`decision-${stage}`);
    mkdirSync(goal,{recursive:true});
    writeFileSync(join(goal,'GOAL.json'),goalJson({stage,status:'Martin'})); writeFileSync(join(goal,'LOG.md'),'');
    const f = fixture({env:{MC_ROLE:'decision',MC_HEADLESS:'1',MC_TOOL:'codex',MC_GOAL:`jev/decision-${stage}`,cwd:repoDir}});
    const read = path => {try {return readFileSync(path,'utf8');} catch {return null;}};
    assert.equal(await run(['--kind','technical',...options],{...f.deps,read,write:writeFileSync}),0,f.err());
    assert.equal(f.requests.length,1);
    assert.match(f.requests[0].init.body,/How should the timeout test work/u);
    assert.equal(parseLog(readFileSync(join(goal,'LOG.md'),'utf8')).at(-1).role,'decision');
  }
});
