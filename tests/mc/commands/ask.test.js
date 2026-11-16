import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { run } from '../../../src/mc/commands/ask.js';
import { itemStore } from '../../../src/mc/desk-items.js';
import { parseLog } from '../../../src/mc/goals.js';
import { goalJson, goalJsonV2 } from '../_helpers/goal-file.js';

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
function fixture({ response = reply(), env = { MC_PROGRAMME: 'jev', cwd: repoDir }, realpath, list = ['memoro-cli'], reader = { read: false, reason: 'no reader in this test' }, budget = { held: false } } = {}) {
  const output = [];
  const errors = [];
  const ledger = [];
  const requests = [];
  const readers = [];
  const deps = {
    env, home: programmeHome, now: () => new Date('2026-11-08T00:00:00Z'),
    stdout: { write: (s) => output.push(s) }, stderr: { write: (s) => errors.push(s) },
    list: () => list, known: () => ['/home/m/memoro-cli'], realpath,
    readKeys: () => ({ TYPESAFE_API_KEY: 'fixture-secret-value' }),
    ledger: (line) => ledger.push(JSON.parse(line)),
    budget: () => (typeof budget === 'function' ? budget() : budget),
    askReader: async (input) => { readers.push(input); return typeof reader === 'function' ? reader(input) : reader; },
    jev: { transport: (url, init) => { requests.push({ url, init }); return typeof response === 'function' ? response(url, init) : response; }, timer: () => new Promise(() => {}) },
  };
  return { deps, requests, ledger, readers, out: () => output.join(''), err: () => errors.join('') };
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

test('interactive Martin may consult jev on a newly synthesized question and keeps truthful role evidence', async () => {
  const goal = join(programmeHome, 'jev', 'goals', 'martin-choice');
  mkdirSync(goal, { recursive: true });
  const file = join(goal, 'GOAL.json'); const log = join(goal, 'LOG.md');
  writeFileSync(file, goalJson({ status: 'Martin', stage: 'build', title: 'Martin choice', repos: ['memoro-cli'] }));
  writeFileSync(log, '## 2026-11-07T00:00Z · runner · build · Martin\n\nComment: runner failure: no structured design question\n');
  const f = fixture({ response: reply(0.95, 'shared'), env: { MC_PROGRAMME: 'jev', MC_GOAL: 'jev/martin-choice', MC_TOOL: 'claude', MC_ROLE: 'martin', cwd: repoDir } });
  f.deps.readKeys = () => ({ TYPESAFE_API_KEY: 'fixture-secret-value' });
  const read = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
  assert.equal(await run(['--reason', 'Which general rule?', '--option', 'specific: keep local behavior', '--option', 'shared: define a shared rule', '--recommend', 'shared'], { ...f.deps, read, write: writeFileSync }), 0, `${f.err()}${f.out()}`);
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
  const argv = ['jev/raced', '--reason', 'Which?', '--option', 'one: a', '--option', 'two: b', '--recommend', 'one'];
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
  assert.equal(await run(argv, { ...finishing.deps, read, write: writeFileSync }), 0, finishing.err());
  assert.match(finishing.out(), /^mc: decided by the session, unread /u);
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
    assert.equal(await run([...(goal ? [goal] : []), ...options, '--kind', 'technical'], f.deps), 2); // an old --kind is still parsed, then refused by the role
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
    assert.equal(await run([...options],{...f.deps,read,write:writeFileSync}),0,f.err());
    assert.equal(f.requests.length,1);
    assert.match(f.requests[0].init.body,/How should the timeout test work/u);
    assert.equal(parseLog(readFileSync(join(goal,'LOG.md'),'utf8')).at(-1).role,'decision');
  }
});


// ---------------------------------------------------------------------- one way to ask

const sessionEnv = (name, extra = {}) => ({ MC_PROGRAMME: 'jev', MC_GOAL: `jev/${name}`, MC_TOOL: 'claude', MC_MODEL: 'opus', MC_ROLE: 'build-session:goal', cwd: repoDir,
  MC_WORK_ROOT: join(scratch, 'work'), MC_HOME: join(scratch, 'home'), ...extra });
const missed = () => reply(0.6, 'fake_timer', { fits: 0.88, settled: 0.30, product: 0.10 });
const goalArgs = (name, extraArgs = []) => [`jev/${name}`, '--reason', 'Which timer?', '--option', 'fake_timer: inject a timer', '--option', 'real_wait: wait fifteen seconds', '--recommend', 'fake_timer', '--evidence', 'No standard selects one.', ...extraArgs];
function goalStore(name, fields = {}) {
  const dir = join(programmeHome, 'jev', 'goals', name);
  const file = join(dir, 'GOAL.json');
  const log = join(dir, 'LOG.md');
  const original = goalJson({ stage: 'build', title: `Goal ${name}`, goal: ['Ask once.'], repos: ['memoro-cli'], ...fields });
  const store = { [file]: original, [log]: '' };
  return { file, log, original, store, read: (path) => store[path] ?? null, write: (path, text) => { store[path] = text; } };
}
const verdictOf = (verdict, who = { tool: 'codex', model: 'gpt' }) => ({ read: true, verdict, ...who });
mkdirSync(join(scratch, 'work', 'runner', 'projects'), { recursive: true });

test('one way to ask: a reader continues with its option, says why when it differs, and the call is one LOG entry and one ledger row', async () => {
  const g = goalStore('reads');
  const f = fixture({ response: missed(), env: sessionEnv('reads'), reader: verdictOf({ kind: 'continue', key: 'real_wait', why: 'the standard names real waits for provider timeouts' }) });
  assert.equal(await run(goalArgs('reads'), { ...f.deps, read: g.read, write: g.write }), 0, f.err());
  assert.equal(f.out(), 'mc: the reader answered real_wait — continue with: wait fifteen seconds\n  why: the standard names real waits for provider timeouts\n');
  assert.match(f.err(), /^mc: jev did not settle it — a reader reads it now \(up to 10 minutes\)\n/mu);
  assert.equal(g.store[g.file], g.original, 'the goal is untouched');
  assert.equal(parseLog(g.store[g.log]).length, 1);
  assert.equal(f.ledger.length, 1);
  assert.deepEqual([f.ledger[0].answered_by, f.ledger[0].outcome, f.ledger[0].chosen, f.ledger[0].kind, f.ledger[0].reader.tool, f.ledger[0].reader.model], ['reader', 'read', 'real_wait', null, 'codex', 'gpt']);
  assert.equal(f.readers.length, 1);
  assert.match(f.readers[0].jevText, /not answered/u);
  assert.equal(f.readers[0].goalName, 'jev/reads');
  const jevOnly = fixture({ response: missed(), env: sessionEnv('reads'), reader: verdictOf({ kind: 'continue', key: 'fake_timer', why: null }) });
  assert.equal(await run(goalArgs('reads'), { ...jevOnly.deps, read: g.read, write: g.write }), 0);
  assert.equal(jevOnly.out(), 'mc: the reader answered fake_timer — continue with: inject a timer\n', 'the recommendation needs no why line');
});

test('one way to ask: the reader is given the standards of the rule areas the goal has a stand on, from its obligations and the area declaration', async () => {
  const g = goalStore('areas');
  g.store[g.file] = goalJsonV2({ repos: ['memoro-cli'], obligations: [
    { area: 'memoro-cli/reserved-acts', stand: 'touched', text: 'The reader can do less.', standard: 'memoro-cli/docs/technical/hooks.md#mc hook pre-tool' },
  ] });
  g.store[join(repoDir, '.mc', 'areas.json')] = JSON.stringify({ schema_version: 1, areas: [
    { id: 'reserved-acts', name: 'Reserved acts', covers: 'headless acts', standards: ['docs/technical/hooks.md'], paths: [], questions: [{ when: 'always', ask: 'which?' }] },
  ] });
  g.store[join(repoDir, 'docs', 'technical', 'hooks.md')] = '# Hooks\n\n## mc hook pre-tool\n\nA deploy is refused.\n\n## Other\n\nNo.\n';
  const f = fixture({ response: missed(), env: sessionEnv('areas'), reader: verdictOf({ kind: 'continue', key: 'fake_timer', why: null }) });
  assert.equal(await run(goalArgs('areas'), { ...f.deps, read: g.read, write: g.write }), 0, f.err());
  assert.equal(f.readers.length, 1);
  const [one] = f.readers[0].standards;
  assert.deepEqual([one.area, one.stand, one.pages, one.section.path, one.section.text], ['memoro-cli/reserved-acts', 'touched', ['docs/technical/hooks.md'], 'memoro-cli/docs/technical/hooks.md', '## mc hook pre-tool\n\nA deploy is refused.']);
});

test('one way to ask: jev answers first and no reader is read', async () => {
  const g = goalStore('jevfirst');
  const f = fixture({ env: sessionEnv('jevfirst') });
  assert.equal(await run(goalArgs('jevfirst'), { ...f.deps, read: g.read, write: g.write }), 0, f.err());
  assert.match(f.out(), /^mc: jev answered fake_timer /u);
  assert.deepEqual([f.readers.length, f.ledger[0].answered_by, f.ledger[0].outcome], [0, 'jev', 'answered']);
  assert.doesNotMatch(f.err(), /reader reads it now/u);
});

test('one way to ask: a reader that finds a goal defect writes the entry mc goal defect writes, and the goal waits for the desk', async () => {
  const g = goalStore('defect');
  const f = fixture({ response: missed(), env: sessionEnv('defect'), reader: verdictOf({ kind: 'defect', part: 'criterion 3', found: 'its check names a command that does not exist (src/x.js:4)' }) });
  assert.equal(await run(goalArgs('defect'), { ...f.deps, read: g.read, write: g.write }), 1, `the session ends as after mc goal defect: ${f.err()}${f.out()}`);
  const parsed = JSON.parse(g.store[g.file]);
  assert.deepEqual([parsed.stage, parsed.status], ['build', 'Martin']);
  const entry = parseLog(g.store[g.log]).at(-1);
  assert.equal(entry.comment.split('\n')[0], 'goal defect: criterion 3 — its check names a command that does not exist (src/x.js:4)');
  assert.equal(parseLog(g.store[g.log]).length, 1, 'one entry, as mc goal defect writes one');
  assert.doesNotMatch(entry.comment, /Martin is asked/u);
  assert.match(f.out(), /^mc: the reader found a goal defect — criterion 3\nmc: jev\/defect · build · Martin — goal defect reported/u);
  assert.deepEqual([f.ledger.length, f.ledger[0].outcome, f.ledger[0].answered_by, f.ledger[0].chosen], [1, 'defect', 'reader', null]);
});

test('one way to ask: a text of Martin’s that would change is a desk item, the caller continues inside the wording and the goal does not wait', async () => {
  const g = goalStore('textinside');
  const brief = '## Vad den säger\nA.\n\n## Vad som föreslås\nB.\n\n## Vad som hittades\nC.\n';
  const f = fixture({ response: missed(), env: sessionEnv('textinside'), reader: verdictOf({ kind: 'text', inside: 'fake_timer', text: 'docs/technical/mc-x.md — timers', brief }) });
  assert.equal(await run(goalArgs('textinside'), { ...f.deps, read: g.read, write: g.write }), 0, f.err());
  assert.match(f.out(), /^mc: a text of Martin’s would change — desk item [0-9a-f]+; continue inside the wording with: inject a timer\n$/u);
  const parsed = JSON.parse(g.store[g.file]);
  assert.deepEqual([parsed.stage, parsed.status], ['build', 'ready'], 'stage and status unchanged');
  assert.deepEqual([f.ledger[0].outcome, f.ledger[0].chosen, f.ledger[0].answered_by], ['text', 'fake_timer', 'reader']);
  assert.match(f.ledger[0].desk_item, /^[0-9a-f]+$/u);
  assert.match(parseLog(g.store[g.log]).at(-1).comment, /Text: docs\/technical\/mc-x\.md — timers/u);
  assert.equal(parseLog(g.store[g.log]).at(-1).status, 'ready');
});

test('one way to ask: when no option stays inside the wording the call exits 1, names the item and leaves stage and status', async () => {
  const g = goalStore('textnone');
  const brief = '## Vad den säger\nA.\n\n## Vad som föreslås\nB none.\n\n## Vad som hittades\nC.\n';
  const f = fixture({ response: missed(), env: sessionEnv('textnone'), reader: verdictOf({ kind: 'text', inside: null, text: 'docs/technical/mc-y.md — none', brief }) });
  assert.equal(await run(goalArgs('textnone'), { ...f.deps, read: g.read, write: g.write }), 1, f.err());
  assert.match(f.out(), /^mc: no option stays inside the wording — the part that needs it waits on desk item [0-9a-f]+; continue with the rest and say in LOG\.md what waits\n$/u);
  const parsed = JSON.parse(g.store[g.file]);
  assert.deepEqual([parsed.stage, parsed.status], ['build', 'ready']);
  assert.deepEqual([f.ledger[0].outcome, f.ledger[0].chosen], ['text', null]);
});

test('one way to ask: a duplicate text names the other goal that asked it and takes this goal when it had none', async () => {
  const briefOf = (what) => `## Vad den säger\nA.\n\n## Vad som föreslås\n${what}\n\n## Vad som hittades\nC.\n`;
  const first = goalStore('dupfirst'); const second = goalStore('dupsecond'); const third = goalStore('dupthird');
  const env = (name) => sessionEnv(name, { MC_WORK_ROOT: join(scratch, 'work-dup'), MC_HOME: join(scratch, 'home-dup') });
  mkdirSync(join(scratch, 'work-dup', 'runner', 'projects'), { recursive: true });
  const asked = async (g, name) => {
    const f = fixture({ response: missed(), env: env(name), reader: verdictOf({ kind: 'text', inside: 'fake_timer', text: 'docs/technical/mc-z.md — same', brief: briefOf('The same wording.') }) });
    assert.equal(await run(goalArgs(name), { ...f.deps, read: g.read, write: g.write }), 0, f.err());
    return f;
  };
  const a = await asked(first, 'dupfirst');
  const b = await asked(second, 'dupsecond');
  assert.equal(a.ledger[0].other_goal, null);
  assert.equal(b.ledger[0].other_goal, 'jev/dupfirst', 'the second goal is told the first asked it');
  assert.equal(b.ledger[0].desk_item, a.ledger[0].desk_item, 'one item');
  assert.match(b.out(), /already open\), also asked by goal jev\/dupfirst/u);
  assert.match(parseLog(second.store[second.log]).at(-1).comment, /also asked by goal jev\/dupfirst/u);
  void third;
});

test('one way to ask: an unread call is decided by the session on its recommendation, with the reason, and nothing waits on Martin', async () => {
  for (const [label, reader, expected] of [
    ['no verdict', { read: false, reason: 'the reader ended without a verdict (exit 1)', tool: 'codex', model: 'gpt' }, /the reader ended without a verdict/u],
    ['a timeout', { read: false, reason: 'the reader did not answer within ten minutes' }, /did not answer within ten minutes/u],
    ['no candidate', { read: false, reason: 'no reader can run: no candidate' }, /no reader can run/u],
    ['a verdict that cannot be carried out', verdictOf({ kind: 'continue', key: 'nonexistent', why: 'x' }), /could not be carried out/u],
    ['a throw', () => { throw new Error('launch exploded'); }, /launch exploded/u],
  ]) {
    const g = goalStore('unread');
    const f = fixture({ response: missed(), env: sessionEnv('unread'), reader });
    assert.equal(await run(goalArgs('unread'), { ...f.deps, read: g.read, write: g.write }), 0, `${label}: ${f.err()}`);
    assert.match(f.out(), /^mc: decided by the session, unread \(.+\) — continue with: inject a timer\n$/u, label);
    assert.match(f.out(), expected, label);
    assert.equal(g.store[g.file], g.original, `${label}: the goal is untouched`);
    assert.deepEqual([f.ledger.length, f.ledger[0].answered_by, f.ledger[0].outcome, f.ledger[0].chosen], [1, 'session', 'decided', 'fake_timer'], label);
    assert.match(f.ledger[0].unread_reason, expected, label);
  }
});

test('one way to ask: an unreadable keys source launches no reader and copies nothing', async () => {
  const f = fixture({ env: sessionEnv('nokeys'), reader: verdictOf({ kind: 'continue', key: 'fake_timer' }) });
  f.deps.readKeys = () => { throw new Error('keys source missing'); };
  const g = goalStore('nokeys');
  assert.equal(await run(goalArgs('nokeys'), { ...f.deps, read: g.read, write: g.write }), 0, f.err());
  assert.deepEqual([f.readers.length, f.requests.length], [0, 0]);
  assert.match(f.out(), /^mc: decided by the session, unread \(the mc keys source cannot be read/u);
});

test('one way to ask: the ceiling — a held desk ceiling answers unread without launching a reader', async () => {
  const f = fixture({ response: missed(), env: sessionEnv('ceiling'), budget: { held: true, spent: 1.5, ceiling: 1 }, reader: verdictOf({ kind: 'continue', key: 'real_wait', why: 'x' }) });
  const g = goalStore('ceiling');
  assert.equal(await run(goalArgs('ceiling'), { ...f.deps, read: g.read, write: g.write }), 0, f.err());
  assert.equal(f.readers.length, 0);
  assert.match(f.out(), /^mc: decided by the session, unread \(desk ceiling holds turns: \$1\.5000 today \(UTC\), ceiling \$1\) — continue with: inject a timer\n$/u);
  assert.equal(f.ledger[0].outcome, 'decided');
  const unreadable = fixture({ response: missed(), env: sessionEnv('ceiling'), budget: () => { throw new Error('desk.json is not JSON'); }, reader: verdictOf({ kind: 'continue', key: 'real_wait', why: 'x' }) });
  assert.equal(await run(goalArgs('ceiling'), { ...unreadable.deps, read: g.read, write: g.write }), 0);
  assert.equal(unreadable.readers.length, 0);
  assert.match(unreadable.out(), /the desk ceiling cannot be read/u);
});

test('one way to ask: --kind is accepted with any value and ignored, with one stderr line, and the ledger kind is null', async () => {
  for (const kind of ['technical', 'product', 'nonsense']) {
    const f = fixture({ env: { MC_PROGRAMME: 'jev', MC_TOOL: 'claude', MC_ROLE: 'build-session:goal', cwd: repoDir } });
    assert.equal(await run(['--kind', kind, ...options], f.deps), 0, f.err());
    assert.equal(f.err(), 'mc: --kind is not read — whether a text of Martin’s would change is the reader’s finding\n');
    assert.equal(f.ledger[0].kind, null);
    assert.equal(f.requests.length, 1);
  }
  const without = fixture({ env: { MC_PROGRAMME: 'jev', MC_TOOL: 'claude', MC_ROLE: 'build-session:goal', cwd: repoDir } });
  assert.equal(await run(options, without.deps), 0);
  assert.equal(without.err(), '', 'a call without --kind says nothing');
});

test('one way to ask: --kind is not asked for by the return instruction, the usage or the help', async () => {
  const f = fixture({ env: { MC_PROGRAMME: 'jev', MC_TOOL: 'claude', MC_ROLE: 'build-session:goal', cwd: repoDir } });
  assert.equal(await run(['--reason', 'missing choices'], f.deps), 2);
  assert.doesNotMatch(f.err(), /--kind|mc goal martin/u);
  assert.match(f.err(), /mc ask <programme>\/<goal>/u);
  const { usage } = await import('../../../src/mc/commands/ask.js');
  assert.doesNotMatch(usage(), /--kind/u);
  assert.match(usage(), /mc ask answer/u);
});

test('one way to ask: the guard — an ask-reader session may only answer, and the other roles still refuse as before', async () => {
  for (const argv of [options, ['answer'], ['--help']]) {
    const f = fixture({ env: { MC_ROLE: 'ask-reader', MC_HEADLESS: '1', MC_TOOL: 'claude', cwd: repoDir } });
    const code = await run(argv, f.deps);
    assert.equal(code, 2);
    assert.deepEqual([f.requests.length, f.ledger.length, f.readers.length], [0, 0, 0]);
  }
  const asked = fixture({ env: { MC_ROLE: 'ask-reader', MC_HEADLESS: '1', MC_TOOL: 'claude', cwd: repoDir } });
  await run(options, asked.deps);
  assert.match(asked.err(), /an ask-reader session cannot ask — it answers with mc ask answer/u);
  const answering = fixture({ env: { MC_ROLE: 'ask-reader', MC_HEADLESS: '1', MC_TOOL: 'claude', cwd: repoDir } });
  assert.equal(await run(['answer', 'not-a-call', 'continue', 'x'], answering.deps), 2);
  assert.match(answering.err(), /ask answer is not recorded/u);
  const f = fixture({ env: { MC_ROLE: 'desk-prepare', cwd: repoDir } });
  assert.equal(await run(options, f.deps), 2);
  assert.match(f.err(), /desk-prepare cannot ask/u);
  const person = fixture({ env: { MC_ROLE: 'martin', MC_HEADLESS: '1', cwd: repoDir } });
  assert.equal(await run(options, person.deps), 2);
});

test('one way to ask: reserved — a reserved act never reaches jev or a reader, sets the goal Martin, and names no kind', async () => {
  const g = goalStore('reservedone');
  const f = fixture({ env: sessionEnv('reservedone'), reader: verdictOf({ kind: 'continue', key: 'fake_timer' }) });
  assert.equal(await run(goalArgs('reservedone', ['--reserved', 'deploy']), { ...f.deps, read: g.read, write: g.write }), 1, f.err());
  assert.deepEqual([f.requests.length, f.readers.length], [0, 0]);
  assert.equal(JSON.parse(g.store[g.file]).status, 'Martin');
  assert.deepEqual([f.ledger[0].outcome, f.ledger[0].reserved, f.ledger[0].kind, f.ledger[0].answered_by], ['reserved', 'deploy', null, 'martin']);
  assert.match(f.out(), /^mc: reserved act deploy — Martin decides, jev is not asked\n$/u);
  assert.doesNotMatch(`${f.out()}${f.err()}`, /--kind/u);
});

test('one way to ask: the record — no key-source value reaches the ledger, LOG.md, stdout, stderr or the reader’s input', async () => {
  const secret = 'sk-live-SECRETVALUE123';
  const g = goalStore('secret');
  const f = fixture({ response: missed(), env: sessionEnv('secret'), reader: (input) => { assert.ok(!JSON.stringify(input).includes(secret) || input.secrets.includes(secret)); return verdictOf({ kind: 'continue', key: 'real_wait', why: `uses ${secret}` }); } });
  f.deps.readKeys = () => ({ TYPESAFE_API_KEY: secret });
  const argv = ['jev/secret', '--reason', `Which, with ${secret}?`, '--option', `fake_timer: inject ${secret}`, '--option', 'real_wait: wait', '--recommend', 'fake_timer', '--evidence', `evidence ${secret}`];
  assert.equal(await run(argv, { ...f.deps, read: g.read, write: g.write }), 0, f.err());
  for (const text of [f.out(), f.err(), JSON.stringify(f.ledger), g.store[g.log]]) assert.ok(!text.includes(secret));
});

test('one way to ask: the record — a key-source value in the reader’s text and brief reaches neither the desk item, the ledger nor LOG.md', async () => {
  const secret = 'sk-live-SECRETBRIEF456';
  const g = goalStore('secretbrief');
  const brief = `## Vad den säger\nIt says ${secret}.\n\n## Vad som föreslås\nB.\n\n## Vad som hittades\nC ${secret}.\n`;
  const env = sessionEnv('secretbrief');
  const f = fixture({ response: missed(), env, reader: verdictOf({ kind: 'text', inside: null, text: `docs/technical/mc-s.md — ${secret}`, brief }) });
  f.deps.readKeys = () => ({ TYPESAFE_API_KEY: secret });
  assert.equal(await run(goalArgs('secretbrief'), { ...f.deps, read: g.read, write: g.write }), 1, f.err());
  const itemDir = join(itemStore(env), f.ledger[0].desk_item);
  const written = readdirSync(itemDir).map((name) => join(itemDir, name));
  assert.ok(written.some((path) => path.endsWith('item.json')) && written.some((path) => path.endsWith('brief.md')), `the desk item and its brief are written (${written.join(', ')})`);
  for (const path of written) assert.ok(!readFileSync(path, 'utf8').includes(secret), `${path} carries no key value`);
  assert.match(readFileSync(written.find((path) => path.endsWith('brief.md')), 'utf8'), /It says \S*REDACTED/iu, 'the brief is kept, its key value replaced');
  for (const text of [f.out(), f.err(), JSON.stringify(f.ledger), g.store[g.log]]) assert.ok(!text.includes(secret));
});
