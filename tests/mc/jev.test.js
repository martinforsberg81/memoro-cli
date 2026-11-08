/**
 * jev's request (src/mc/jev.js) through the real verb: the pinned model, the
 * three questions, the state it carries and leaves out, the budget and its
 * trimming order, and the key — read from a fixture keys source
 * (MC_KEYS_FILE) — in the Authorization header and nowhere else. The transport
 * is substituted at its boundary: no network, no real wait.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { run } from '../../src/mc/commands/goal.js';
import { askJev, buildState, defaultTransport, INSTRUCTIONS, JEV_MODEL, JEV_URL, judge, readMartinCall, retryAfterMs, STATE_BUDGET, THRESHOLDS, TRUNCATED, TIMEOUT_MS } from '../../src/mc/jev.js';
import { FINISH_ROLE, parseLog } from '../../src/mc/goals.js';
import { goalJson } from './_helpers/goal-file.js';

const HOME = '/work/programs';
const DIR = `${HOME}/mc/goals/plain`;
const KEY = 'ts-fixture-key-0123456789abcdef';
const OTHER = 'hunter2-hunter2';
const SHORT = 'abc1234';
const scratch = mkdtempSync(join(tmpdir(), 'mc-jev-'));
const KEYS_FILE = join(scratch, '.dev.vars');
writeFileSync(KEYS_FILE, `TYPESAFE_API_KEY=${KEY}\nOTHER_SECRET="${OTHER}"\nSHORT_ONE=${SHORT}\n`);
after(() => rmSync(scratch, { recursive: true, force: true }));

const ENV = { MC_GOAL: 'mc/plain', MC_TOOL: 'claude', MC_MODEL: 'opus', MC_ROLE: FINISH_ROLE, MC_KEYS_FILE: KEYS_FILE };
const entry = (n, text = `entry ${n}`) => `## 2026-11-0${n}T10:00Z · claude opus · finish · ready\n\nDone: ${text}\n`;
const LOG = [1, 2, 3, 4, 5, 6, 7].map((n) => entry(n)).join('\n');
const GOAL = goalJson({
  stage: 'finish',
  title: 'Make the goal plain',
  goal: ['Two files and a worktree.'],
  contract: ['The timer stays injected.'],
  out_of_scope: ['The page.'],
  success_criteria: [{ criterion: 'it works', check: 'a test', met: true }, { criterion: 'it is fast', check: 'timings', met: false }],
  documents: [{ label: 'the standard', path: '/docs/standard.md' }],
});

const ok = (body) => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) });
const ANSWER = ok({
  model: 'jev-1.14.0',
  answers: {
    answer: { type: 'choice', choice: 'fake_timer', confidence: 0.98, probabilities: { fake_timer: 0.99, real_wait: 0.01 } },
    fits: { type: 'noul', noul: 0.95 }, settled: { type: 'noul', noul: 0.95 },
  },
  usage: { input_tokens: 539, output_tokens: 70 },
});

/** The verb's deps over an in-memory tree; the keys source is the real reader of MC_KEYS_FILE. */
function fixture(files = {}) {
  const store = {
    [`${DIR}/GOAL.json`]: GOAL,
    [`${DIR}/LOG.md`]: LOG,
    [`${HOME}/mc/README.md`]: '# mc\n\nThe programme README.',
    [`${DIR}/memoro-cli/docs/project/mc/rulings.md`]: '# rulings\n\n1. Timers are injected.',
    '/docs/standard.md': 'The standard text.',
    [`${DIR}/memoro-cli/docs/extra.md`]: `Extra document; the key ${KEY} and ${OTHER} must not leave.`,
    ...files,
  };
  const requests = [];
  const ledger = [];
  const out = [];
  const err = [];
  const deps = {
    home: HOME,
    env: ENV,
    now: () => new Date('2026-11-07T20:00:00Z'),
    stdout: { write: (text) => out.push(text) },
    stderr: { write: (text) => err.push(text) },
    read: (path) => store[path] ?? null,
    realpath: (path) => path,
    write: (path, text) => { store[path] = text; },
    list: () => [],
    known: () => [],
    git: () => ({ ok: true, stdout: '', stderr: '' }),
    jev: { transport: (url, init) => { requests.push({ url, init }); return ANSWER; }, sleep: async () => {}, timer: () => new Promise(() => {}) },
    ledger: (line) => ledger.push(line),
  };
  return { deps, store, requests, ledger, out: () => out.join(''), err: () => err.join('') };
}

const CALL = [
  'martin', '--reason', `Which timer should the timeout test use? (${KEY})`,
  '--option', 'fake_timer: inject a timer that fires at once',
  '--option', `real_wait: wait the full 15 seconds, ${OTHER}`,
  '--recommend', 'fake_timer',
  '--evidence', `criterion 2: no real waits over 1 s; key ${KEY}; head ${SHORT}`,
  '--document', 'memoro-cli/docs/extra.md',
];

test('the request: POST to the endpoint, model jev-1.14.0, Bearer key, and the three questions with the texts the goal gives', async () => {
  const f = fixture();
  assert.equal(await run(CALL, f.deps), 0, f.err());
  assert.equal(f.requests.length, 1);
  const [{ url, init }] = f.requests;
  assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(JEV_URL, url);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, `Bearer ${KEY}`);
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'jev-1.14.0');
  assert.equal(JEV_MODEL, 'jev-1.14.0');
  assert.deepEqual(Object.keys(body.questions), ['answer', 'fits', 'settled']);
  assert.deepEqual(body.questions.answer, {
    type: 'choice',
    instructions: 'Which option is the right way for this goal to proceed, given the goal, its contract and the decided standards in the state',
    criteria: { fake_timer: 'inject a timer that fires at once', real_wait: 'wait the full 15 seconds, [redacted]' },
  });
  assert.deepEqual(body.questions.fits, { type: 'noul', instructions: 'One of the options in `options` is a correct way for this goal to proceed' });
  assert.deepEqual(body.questions.settled, { type: 'noul', instructions: 'The goal, its contract, the programme\'s rulings or the technical standards in the state already decide which option is right, so no new product or policy decision by Martin is needed' });
  assert.equal(INSTRUCTIONS.fits, body.questions.fits.instructions);
});

test('the state holds question, options, evidence, the goal with contract and criteria, README, rulings, documents and the last five entries — and not the recommendation', async () => {
  const f = fixture();
  assert.equal(await run(CALL, f.deps), 0, f.err());
  const { state } = JSON.parse(f.requests[0].init.body);
  assert.deepEqual(Object.keys(state), ['question', 'options', 'evidence', 'goal', 'programme', 'documents', 'log']);
  assert.equal(state.question, 'Which timer should the timeout test use? ([redacted])');
  assert.deepEqual(Object.keys(state.options), ['fake_timer', 'real_wait']);
  assert.equal(state.evidence, `criterion 2: no real waits over 1 s; key [redacted]; head ${SHORT}`);
  assert.deepEqual(state.goal, {
    title: 'Make the goal plain', goal: 'Two files and a worktree.', contract: 'The timer stays injected.', out_of_scope: 'The page.',
    criteria: [{ criterion: 'it works', check: 'a test', met: true }, { criterion: 'it is fast', check: 'timings', met: false }],
    stage: 'finish', status: 'ready',
  });
  assert.equal(state.programme.readme, '# mc\n\nThe programme README.');
  assert.deepEqual(state.programme.rulings, [{ path: 'memoro-cli/docs/project/mc/rulings.md', text: '# rulings\n\n1. Timers are injected.' }]);
  assert.deepEqual(state.documents, [
    { path: '/docs/standard.md', label: 'the standard', text: 'The standard text.' },
    { path: 'memoro-cli/docs/extra.md', text: 'Extra document; the key [redacted] and [redacted] must not leave.' },
  ]);
  assert.equal(state.log.length, 5);
  assert.deepEqual(state.log.map((text) => parseLog(text)[0].done), ['entry 3', 'entry 4', 'entry 5', 'entry 6', 'entry 7']);
  assert.ok(!Object.hasOwn(state, 'recommend'));
  assert.doesNotMatch(JSON.stringify(state), /recommend/iu, 'the session\'s recommendation is not in the state');
  assert.deepEqual(JSON.parse(f.ledger[0]).documents, ['/docs/standard.md', 'memoro-cli/docs/extra.md'], 'the ledger names the documents sent');
});

test('the key and every keys-source value of 8+ characters are in the Authorization header only: not in the body, LOG.md, the ledger, stdout or stderr', async () => {
  for (const outcome of ['answered', 'martin']) {
    const f = fixture();
    if (outcome === 'martin') f.deps.jev.transport = (url, init) => { f.requests.push({ url, init }); return { status: 500, headers: { get: () => null }, text: async () => `echo ${KEY}` }; };
    assert.equal(await run(CALL, f.deps), 0, f.err());
    const body = f.requests[0].init.body;
    const written = Object.entries(f.store).filter(([path]) => path.startsWith(DIR) && !path.includes('/memoro-cli/')).map(([, text]) => text).join('\n');
    for (const [where, text] of [['body', body], ['GOAL.json and LOG.md', written], ['ledger', f.ledger.join('')], ['stdout', f.out()], ['stderr', f.err()]]) {
      assert.ok(!text.includes(KEY), `${outcome}: the key is not in the ${where}`);
      assert.ok(!text.includes(OTHER), `${outcome}: another keys-source value is not in the ${where}`);
    }
    assert.match(body, /\[redacted\]/u);
    assert.match(body, new RegExp(SHORT, 'u'), 'a value under 8 characters is not redacted (it is no guard)');
    assert.match(f.store[`${DIR}/LOG.md`], /\[redacted\]/u, 'the question is written redacted');
    assert.equal(f.requests.every(({ init }) => init.headers.authorization === `Bearer ${KEY}`), true);
    assert.equal(JSON.parse(f.ledger[0]).outcome, outcome);
  }
});

test('a budget-busting state stays within 240,000 characters, trimmed oldest log entries, then the largest document, then the README; the ledger names each', async () => {
  const big = (n, c) => c.repeat(n);
  const f = fixture({
    [`${DIR}/LOG.md`]: [1, 2, 3, 4, 5, 6, 7].map((n) => entry(n, big(20_000, String(n)))).join('\n'),
    '/docs/standard.md': big(150_000, 's'),
    [`${DIR}/memoro-cli/docs/extra.md`]: big(90_000, 'e'),
    [`${HOME}/mc/README.md`]: big(10_000, 'r'),
  });
  assert.equal(await run(CALL, f.deps), 0, f.err());
  const { state } = JSON.parse(f.requests[0].init.body);
  const ledger = JSON.parse(f.ledger[0]);
  assert.ok(JSON.stringify(state).length <= STATE_BUDGET, `${JSON.stringify(state).length} within the budget`);
  assert.equal(ledger.state_length, JSON.stringify(state).length);
  assert.deepEqual(state.log, [], 'every log entry left out first');
  assert.ok(state.documents[0].text.endsWith(TRUNCATED), 'the largest document is cut, with the marker');
  assert.equal(state.documents[1].text, big(90_000, 'e'), 'the smaller document is whole: the cut of the largest was enough');
  assert.equal(state.programme.readme, big(10_000, 'r'), 'the README is not reached');
  assert.deepEqual(ledger.trimmed, ['log: 5 oldest entries left out', 'document /docs/standard.md truncated']);
});

test('buildState trims in order: the log alone when that is enough; then documents largest first; then the programme README', () => {
  const core = { question: 'q', options: { a: 'x', b: 'y' }, evidence: 'e', goal: { title: 't' } };
  const logOnly = buildState({ ...core, programme: { readme: 'r', rulings: [] }, documents: [{ path: 'd', text: 'd'.repeat(500) }], log: ['l'.repeat(400), 'm'.repeat(400), 'n'.repeat(10)] }, { budget: 1000 });
  assert.deepEqual(logOnly.trimmed, ['log: 2 oldest entries left out']);
  assert.deepEqual(logOnly.state.log, ['n'.repeat(10)]);
  assert.equal(logOnly.state.documents[0].text, 'd'.repeat(500));

  const docs = buildState({ ...core, programme: { readme: 'r'.repeat(300), rulings: [] }, documents: [{ path: 'small', text: 's'.repeat(300) }, { path: 'large', text: 'L'.repeat(600) }], log: ['l'.repeat(100)] }, { budget: 900 });
  assert.deepEqual(docs.trimmed, ['log: 1 oldest entry left out', 'document large truncated']);
  assert.equal(docs.state.documents[0].text, 's'.repeat(300));
  assert.ok(docs.state.documents[1].text.endsWith(TRUNCATED));
  assert.ok(docs.text.length <= 900);

  const readme = buildState({ ...core, programme: { readme: 'r'.repeat(800), rulings: [] }, documents: [{ path: 'a', text: 'a'.repeat(300) }, { path: 'b', text: 'b'.repeat(200) }], log: [] }, { budget: 600 });
  assert.deepEqual(readme.trimmed, ['document a truncated', 'document b truncated', 'programme README truncated']);
  assert.ok(readme.state.programme.readme.endsWith(TRUNCATED));
  assert.ok(readme.text.length <= 600);

  const over = buildState({ ...core, evidence: 'e'.repeat(700), programme: {}, documents: [], log: [] }, { budget: 600 });
  assert.match(over.problems[0], /the question, options, evidence and goal alone are \d+ characters serialized, over jev's budget of 600/u);
});

test('documents whose path metadata keeps the state over budget are dropped whole and the trimmed state is still sent', async () => {
  const documents = Array.from({ length: 100 }, (_, n) => ({ label: `doc ${n}`, path: `${String(n).padStart(3, '0')}-${'p'.repeat(3_000)}` }));
  const files = { [`${DIR}/GOAL.json`]: goalJson({ stage: 'finish', documents }) };
  for (const item of documents) files[`${DIR}/${item.path}`] = 'document text';
  const f = fixture(files);
  assert.equal(await run(CALL, f.deps), 0, f.err());
  assert.equal(f.requests.length, 1, 'trimming does not refuse a state whose core fits');
  const { state } = JSON.parse(f.requests[0].init.body);
  assert.ok(JSON.stringify(state).length <= STATE_BUDGET);
  assert.ok(state.documents.length < documents.length);
  const ledger = f.ledger.map((line) => JSON.parse(line))[0];
  assert.ok(ledger.trimmed.some((item) => item.endsWith('dropped')));
  assert.deepEqual(ledger.documents, state.documents.map((item) => item.path), 'the ledger lists only documents included in the sent state');
});

test('the thresholds are 0.90, 0.70 and 0.70 and every one is required with agreement', () => {
  assert.deepEqual({ ...THRESHOLDS }, { choice: 0.90, fits: 0.70, settled: 0.70 });
  const at = (choice, p, fits, settled) => judge({ answer: { choice, probabilities: { [choice]: p } }, fits, settled }, 'a').outcome;
  assert.equal(at('a', 0.90, 0.70, 0.70), 'answered');
  assert.equal(at('a', 0.8999, 0.70, 0.70), 'martin');
  assert.equal(at('a', 0.90, 0.6999, 0.70), 'martin');
  assert.equal(at('a', 0.90, 0.70, 0.6999), 'martin');
  assert.equal(at('b', 0.99, 0.99, 0.99), 'martin');
});

test('retry-after is read in seconds or as a date, at most 10 seconds; none waits 1 second', () => {
  assert.equal(retryAfterMs('3'), 3000);
  assert.equal(retryAfterMs('600'), 10_000);
  assert.equal(retryAfterMs(null), 1000);
  assert.equal(retryAfterMs('nonsense'), 1000);
  assert.equal(retryAfterMs(new Date(5000).toUTCString(), 0), 5000);
});

test('the real transport makes no request in a test run', async () => {
  await assert.rejects(() => defaultTransport(JEV_URL, {}), /no live jev request in a test run/u);
});

test('a 2xx body read is under the attempt timer, so a stalled text() is unavailable without a real wait', async () => {
  const result = await askJev({
    body: {}, key: KEY,
    transport: async () => ({ status: 200, text: () => new Promise(() => {}) }),
    timer: async (ms) => { assert.equal(ms, TIMEOUT_MS); },
  });
  assert.deepEqual(result, { unavailable: 'no answer in 15 seconds' });
});

test('readMartinCall keeps the option texts by key and the recommendation', () => {
  assert.deepEqual(readMartinCall({ reason: ' Which? ', option: ['a: one: with a colon', 'b_2: two'], recommend: 'b_2', reserved: null }),
    { question: 'Which?', options: { a: 'one: with a colon', b_2: 'two' }, recommend: 'b_2', reserved: null });
  assert.deepEqual(readMartinCall({ reason: 'q', option: [`${'k'.repeat(33)}: x`, 'b: y'], recommend: 'b' }).problems.length, 1, 'a key of 33 characters is refused');
});
