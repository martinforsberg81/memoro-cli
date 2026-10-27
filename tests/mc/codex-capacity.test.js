/**
 * Codex's read-only capacity collector (codex-capacity.js), against a fake app server.
 *
 * No signed-in account and no codex binary are needed: `spawn` is the fake, a
 * child with a stdin that records what it is sent and a stdout that answers. The
 * tests pin what the collector sends (only the four read-only methods, never a
 * thread or a turn), what it reads (the codex window, usage as a fraction, the
 * reset as an instant, credits ignored, the model list every page), and what it
 * does with the bad: malformed lines, errors, out-of-order answers, a silent
 * server, a flood of output, a child that will not start or exits early.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import {
  MODEL_PAGES, SENT_METHODS, codexModelPage, codexRateLimits, codexWindow, collectCodexCapacity, refreshCodexCapacity,
} from '../../src/mc/codex-capacity.js';
import { codexCandidateAt, providerAt, readCapacity, capacityPath } from '../../src/mc/model-capacity.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'mc-codex-capacity-'));
const RESET = 1730947200;
const RESET_ISO = new Date(RESET * 1000).toISOString();
const NOW = new Date('2026-10-11T12:00:00Z');

/** The app server's snapshot as the protocol doc shows it: primary 25 % used, no secondary. */
const RATE_LIMITS = {
  rateLimits: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 15, resetsAt: RESET }, secondary: null },
};
const MODELS = { data: [{ id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }, { reasoningEffort: 'high', description: '' }] }], nextCursor: null };

/**
 * A fake `codex app-server`. `answer(message)` returns what the server answers with:
 * a result or error object (answered with the message's id), a raw string line,
 * `undefined` for silence, or an array of such, sent in order.
 */
function fakeChild(answer, { onSent } = {}) {
  const child = new EventEmitter();
  child.sent = [];
  child.killed = [];
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const emit = (line) => setImmediate(() => child.stdout.write(`${line}\n`));
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        const message = JSON.parse(line);
        child.sent.push(message);
        onSent?.(message, child, emit);
        const replies = [].concat(answer(message) ?? []);
        for (const reply of replies) emit(typeof reply === 'string' ? reply : JSON.stringify({ id: message.id, ...reply }));
      }
      done();
    },
  });
  child.kill = (signal) => { child.killed.push(signal); return true; };
  return child;
}

/** A spawn that records its arguments and hands back one fake child. */
function spawnWith(child) {
  const calls = [];
  const spawn = (bin, args, options) => {
    calls.push({ bin, args, options });
    if (child instanceof Error) throw child;
    return child;
  };
  return { spawn, calls };
}

/** The answers of a healthy server; a test overrides one of them. */
function healthy(overrides = {}) {
  return (message) => {
    if (message.method === 'initialize') return { result: { userAgent: 'fake' } };
    if (message.method === 'account/rateLimits/read') return { result: overrides.rateLimits ?? RATE_LIMITS };
    if (message.method === 'model/list') return { result: overrides.models ?? MODELS };
    return undefined;
  };
}

test('codexWindow: usedPercent 0–100 becomes a fraction and resetsAt Unix seconds an instant; a bad window is null', () => {
  assert.deepEqual(codexWindow({ usedPercent: 25, resetsAt: RESET }), { fraction_used: 0.25, resets_at: RESET_ISO });
  assert.equal(codexWindow({ usedPercent: 101, resetsAt: RESET }), null, 'over 100');
  assert.equal(codexWindow({ usedPercent: -1, resetsAt: RESET }), null, 'negative');
  assert.equal(codexWindow({ usedPercent: '25', resetsAt: RESET }), null, 'a string');
  assert.equal(codexWindow({ usedPercent: 25 }), null, 'no reset');
  assert.equal(codexWindow({ usedPercent: 25, resetsAt: 0 }), null, 'a reset at the epoch');
  assert.equal(codexWindow(null), null);
});

test('codexRateLimits: rateLimitsByLimitId.codex when given, else rateLimits; credits are never read', () => {
  const byId = { rateLimits: { primary: { usedPercent: 10, resetsAt: RESET } }, rateLimitsByLimitId: { codex: { primary: { usedPercent: 40, resetsAt: RESET } }, codex_other: { primary: { usedPercent: 90, resetsAt: RESET } } } };
  assert.equal(codexRateLimits(byId).primary.fraction_used, 0.4);
  assert.equal(codexRateLimits({ rateLimits: { primary: { usedPercent: 10, resetsAt: RESET } }, rateLimitsByLimitId: { codex_other: {} } }).primary.fraction_used, 0.1, 'no codex key: rateLimits');
  assert.equal(codexRateLimits({ rateLimits: { primary: { usedPercent: 10, resetsAt: RESET } }, rateLimitsByLimitId: null }).primary.fraction_used, 0.1);

  const creditsOnly = { rateLimits: { primary: null, secondary: null, credits: { hasCredits: true, unlimited: false, balance: '999' } }, rateLimitResetCredits: { availableCount: 2 } };
  assert.equal(codexRateLimits(creditsOnly), null, 'credits and reset credits are not headroom');
  assert.equal(codexRateLimits('not an object'), null);
});

test('codexModelPage: each model with its efforts, the next cursor, and null for a list that is not one', () => {
  assert.deepEqual(codexModelPage(MODELS), { models: [{ id: 'gpt-6.1-sol', efforts: ['medium', 'high'] }], nextCursor: null });
  assert.deepEqual(codexModelPage({ data: [{ id: 'x' }, 'junk', { model: '' }], nextCursor: 'p2' }), { models: [{ id: 'x', efforts: [] }], nextCursor: 'p2' });
  assert.equal(codexModelPage({ data: 'nope' }), null);
  assert.equal(codexModelPage(null), null);
});

test('a healthy read: the window, the model list, and the child started as app-server --stdio', async () => {
  const child = fakeChild(healthy());
  const { spawn, calls } = spawnWith(child);
  const answer = await collectCodexCapacity({ spawn });
  assert.deepEqual(answer, {
    ok: true,
    windows: { primary: { fraction_used: 0.25, resets_at: RESET_ISO }, secondary: null },
    models: [{ id: 'gpt-6.1-sol', efforts: ['medium', 'high'] }],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, 'codex');
  assert.deepEqual(calls[0].args, ['app-server', '--stdio']);
  assert.deepEqual(child.killed, ['SIGTERM'], 'the collector ends its own child once answered');
});

test('no model turn: every message sent is one of the four read-only methods, and never thread/start or turn/start', async () => {
  const child = fakeChild(healthy());
  await collectCodexCapacity({ spawn: spawnWith(child).spawn });
  const methods = child.sent.map((message) => message.method);
  assert.deepEqual(methods, ['initialize', 'initialized', 'account/rateLimits/read', 'model/list']);
  for (const method of methods) assert.ok(SENT_METHODS.includes(method), method);
  assert.equal(methods.includes('thread/start'), false);
  assert.equal(methods.includes('turn/start'), false);
  assert.equal(child.sent.some((message) => /reset|credit/iu.test(JSON.stringify(message))), false, 'no reset is consumed');
});

test('the handshake: initialized is sent only after the initialize answer, and the reads follow it', async () => {
  const seen = [];
  const child = fakeChild(healthy(), { onSent: (message) => seen.push(message.method) });
  await collectCodexCapacity({ spawn: spawnWith(child).spawn });
  assert.deepEqual(seen, ['initialize', 'initialized', 'account/rateLimits/read', 'model/list']);
  assert.equal(child.sent[1].id, undefined, 'initialized is a notification');
});

test('out-of-order answers and notifications are matched by id and passed over', async () => {
  // The rate limits are asked first and answered last: the model list comes back first, with a notification between.
  let rateLimitsId = null;
  const child = fakeChild((message) => {
    if (message.method === 'initialize') return { result: {} };
    if (message.method === 'account/rateLimits/read') {
      rateLimitsId = message.id;
      return undefined;
    }
    if (message.method === 'model/list') {
      return [{ result: MODELS }, '{"method":"account/rateLimits/updated","params":{}}', JSON.stringify({ id: rateLimitsId, result: RATE_LIMITS })];
    }
    return undefined;
  });
  const answer = await collectCodexCapacity({ spawn: spawnWith(child).spawn });
  assert.equal(answer.ok, true);
  assert.equal(answer.windows.primary.fraction_used, 0.25);
  assert.deepEqual(answer.models, [{ id: 'gpt-6.1-sol', efforts: ['medium', 'high'] }]);
});

test('a line that is not JSON, or an answer to nothing sent, is passed over', async () => {
  const child = fakeChild((message) => {
    if (message.method === 'initialize') return ['not json at all', '{"id":999,"result":{}}', { result: {} }];
    return healthy()(message);
  });
  const answer = await collectCodexCapacity({ spawn: spawnWith(child).spawn });
  assert.equal(answer.ok, true);
});

test('a server error on any request is a failed read that names the request', async () => {
  const onRateLimits = fakeChild((message) => (message.method === 'account/rateLimits/read' ? { error: { message: 'not signed in' } } : healthy()(message)));
  assert.deepEqual(await collectCodexCapacity({ spawn: spawnWith(onRateLimits).spawn }), { ok: false, why: 'account/rateLimits/read failed: not signed in' });

  const onModels = fakeChild((message) => (message.method === 'model/list' ? { error: { message: 'busy' } } : healthy()(message)));
  assert.deepEqual(await collectCodexCapacity({ spawn: spawnWith(onModels).spawn }), { ok: false, why: 'model/list failed: busy' });

  const onInit = fakeChild(() => ({ error: { message: 'refused' } }));
  assert.deepEqual(await collectCodexCapacity({ spawn: spawnWith(onInit).spawn }), { ok: false, why: 'initialize failed: refused' });
});

test('malformed answers are failed reads: no codex window, a model list that is not a list', async () => {
  const noWindow = fakeChild(healthy({ rateLimits: { rateLimits: { primary: null, secondary: null } } }));
  assert.deepEqual(await collectCodexCapacity({ spawn: spawnWith(noWindow).spawn }), { ok: false, why: 'account/rateLimits/read holds no codex window' });

  const notList = fakeChild(healthy({ models: { data: 'nope' } }));
  assert.deepEqual(await collectCodexCapacity({ spawn: spawnWith(notList).spawn }), { ok: false, why: 'model/list did not answer with a list of models' });
});

test('model/list is read to the last page; a list longer than MODEL_PAGES pages is a failed read', async () => {
  const pages = (cursor) => ({ data: [{ id: `m-${cursor ?? 'first'}`, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], nextCursor: cursor === 'p1' ? null : 'p1' });
  const twoPages = fakeChild((message) => {
    if (message.method !== 'model/list') return healthy()(message);
    return { result: pages(message.params?.cursor) };
  });
  const answer = await collectCodexCapacity({ spawn: spawnWith(twoPages).spawn });
  assert.deepEqual(answer.models, [{ id: 'm-first', efforts: ['high'] }, { id: 'm-p1', efforts: ['high'] }]);
  assert.equal(twoPages.sent.filter((message) => message.method === 'model/list').length, 2);

  const endless = fakeChild((message) => (message.method === 'model/list' ? { result: { data: [], nextCursor: 'more' } } : healthy()(message)));
  const longer = await collectCodexCapacity({ spawn: spawnWith(endless).spawn });
  assert.deepEqual(longer, { ok: false, why: `model/list is longer than ${MODEL_PAGES} pages` });
  assert.equal(endless.sent.filter((message) => message.method === 'model/list').length, MODEL_PAGES);
});

test('a silent server times out: the collector ends its own child and says so', async () => {
  const silent = fakeChild((message) => (message.method === 'initialize' ? { result: {} } : undefined));
  const answer = await collectCodexCapacity({ spawn: spawnWith(silent).spawn, timeoutMs: 30 });
  assert.deepEqual(answer, { ok: false, why: 'codex app-server did not answer within 30 ms' });
  assert.deepEqual(silent.killed, ['SIGTERM']);
});

test('output over the byte cap stops the child and fails the read', async () => {
  const flood = fakeChild((message) => (message.method === 'initialize' ? { result: { padding: 'x'.repeat(500) } } : undefined));
  const answer = await collectCodexCapacity({ spawn: spawnWith(flood).spawn, maxBytes: 200 });
  assert.deepEqual(answer, { ok: false, why: 'codex app-server sent more than 200 bytes' });
  assert.deepEqual(flood.killed, ['SIGTERM']);
});

test('a child that will not start, cannot run, or exits early is a failed read', async () => {
  assert.deepEqual(await collectCodexCapacity({ spawn: spawnWith(new Error('spawn codex EACCES')).spawn }), { ok: false, why: 'codex did not start: spawn codex EACCES' });

  const missing = fakeChild(() => undefined);
  const pending = collectCodexCapacity({ spawn: () => missing });
  setImmediate(() => missing.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })));
  assert.deepEqual(await pending, { ok: false, why: 'codex did not run: spawn codex ENOENT' });

  const exits = fakeChild(() => undefined);
  const early = collectCodexCapacity({ spawn: () => exits });
  setImmediate(() => exits.emit('close', 1, null));
  assert.deepEqual(await early, { ok: false, why: 'codex app-server ended before it answered (exit 1)' });
});

test('refreshCodexCapacity: a good read is written; a failed one keeps the last valid snapshot and says why', async () => {
  const root = fresh();
  // The doc's reset is in 2024, before NOW, so this read uses a reset still ahead of it.
  const ahead = { rateLimits: { primary: { usedPercent: 25, resetsAt: Math.floor(NOW.getTime() / 1000) + 7200 }, secondary: null } };
  const good = await refreshCodexCapacity({ root, now: NOW, spawn: spawnWith(fakeChild(healthy({ rateLimits: ahead }))).spawn });
  assert.equal(good.ok, true);
  assert.equal(good.why, null);
  assert.equal(codexCandidateAt(good.state, { model: 'gpt-6.1-sol', effort: 'high' }, NOW).available, true);

  const later = new Date(NOW.getTime() + 3600 * 1000);
  const bad = await refreshCodexCapacity({ root, now: later, spawn: spawnWith(fakeChild(() => ({ error: { message: 'busy' } }))).spawn });
  assert.equal(bad.ok, false);
  const standing = providerAt(readCapacity({ root }), 'codex', later);
  assert.equal(standing.status, 'failed');
  assert.equal(standing.failure.why, 'initialize failed: busy');
  assert.equal(standing.windows.primary.fraction_used, 0.25, 'the snapshot before the failure stays');
  assert.equal(standing.observed_at, NOW.toISOString());
  assert.match(readFileSync(capacityPath(root), 'utf8'), /"failure"/u);
});
