/**
 * The codex-rpc capacity read (codex-capacity.js) when Codex's login is revoked:
 * the read fails, and it refuses Codex as a session the same login refused does
 * (plan-refusal.js). The stderr is the one recorded 2026-11-22
 * (tests/fixtures/codex). A fake `codex app-server` answers; no real Codex runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectCodexCapacity, refreshCodexCapacity } from '../../src/mc/codex-capacity.js';
import { applyRefusal, readCapacity, writeCapacity } from '../../src/mc/model-capacity.js';
import { QUOTA_SLEEP_MS } from '../../src/mc/run-plan.js';

const NOW = new Date('2026-11-22T10:10:11Z');
const RECORDED_STDERR = readFileSync(new URL('../fixtures/codex/revoked-login-20261122T101009Z.json.err', import.meta.url), 'utf8');
const REVOKED = { code: -32603, message: 'unexpected status 401 Unauthorized: Encountered invalidated oauth token for user, failing request, auth error: 401, auth error code: token_revoked' };

/**
 * A fake app server: it answers `initialize`, then answers `account/rateLimits/read`
 * with `rateLimits` (an error or a result, or nothing: it writes `stderr` and
 * closes), and `model/list` with `models` when it is given.
 */
function appServer({ rateLimits, stderr = '', models = null }) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const answer = (message) => setImmediate(() => child.stdout.emit('data', `${JSON.stringify(message)}\n`));
    child.stdin = Object.assign(new EventEmitter(), {
      write(line) {
        const message = JSON.parse(line);
        if (message.method === 'initialize') answer({ id: message.id, result: {} });
        if (message.method === 'model/list' && models) { answer({ id: message.id, result: { data: models } }); return; }
        if (message.method !== 'account/rateLimits/read') return;
        if (rateLimits) { answer({ id: message.id, ...rateLimits }); return; }
        setImmediate(() => { child.stderr.emit('data', stderr); child.emit('close', 1, null); });
      },
    });
    return child;
  };
}

const workspace = () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-capacity-'));
  return { root, stored: () => readCapacity({ root }).providers.codex, done: () => rmSync(root, { recursive: true, force: true }) };
};
const refresh = (w, spawn) => refreshCodexCapacity({ root: w.root, lockRoot: w.root, now: NOW, lock: (_root, fn) => fn(), spawn });

test('a capacity read answered with a 401 token_revoked refuses Codex for the quota sleep, as the session refusal does', async () => {
  const w = workspace();
  try {
    const got = await refresh(w, appServer({ rateLimits: { error: REVOKED } }));
    assert.equal(got.ok, false);
    assert.match(got.why, /token_revoked/u);
    assert.equal(w.stored().refusal_until, new Date(NOW.getTime() + QUOTA_SLEEP_MS).toISOString());
    assert.match(w.stored().failure.why, /token_revoked/u);
  } finally { w.done(); }
});

test('a capacity read whose app server only says the revoked login on stderr refuses Codex too', async () => {
  const w = workspace();
  try {
    const answer = await collectCodexCapacity({ spawn: appServer({ stderr: RECORDED_STDERR }) });
    assert.deepEqual([answer.ok, answer.login], [false, true]);
    await refresh(w, appServer({ stderr: RECORDED_STDERR }));
    assert.equal(w.stored().refusal_until, new Date(NOW.getTime() + QUOTA_SLEEP_MS).toISOString());
  } finally { w.done(); }
});

test('a capacity read that fails for another reason records the failure and refuses nothing', async () => {
  const w = workspace();
  try {
    await refresh(w, appServer({ rateLimits: { error: { code: -32603, message: 'upstream 503 Service Unavailable' } } }));
    assert.equal(w.stored().refusal_until, null);
    assert.match(w.stored().failure.why, /503/u);
    await refresh(w, appServer({ stderr: 'ERROR codex_core: stream disconnected before completion' }));
    assert.equal(w.stored().refusal_until, null);
  } finally { w.done(); }
});

const RESETS = Math.floor(NOW.getTime() / 1000) + 3600;
const read = (primary) => appServer({
  rateLimits: { result: { rateLimits: { primary: { usedPercent: primary, resetsAt: RESETS }, secondary: { usedPercent: 20, resetsAt: RESETS + 86400 } } } },
  models: [{ model: 'gpt-6-luna', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }],
});

test('the revoked login refuses Codex with cause login, and the next successful read lifts it', async () => {
  const w = workspace();
  try {
    await refresh(w, appServer({ rateLimits: { error: REVOKED } }));
    const until = new Date(NOW.getTime() + QUOTA_SLEEP_MS).toISOString();
    assert.deepEqual([w.stored().refusal_until, w.stored().refusal_cause, w.stored().refusal_since], [until, 'login', NOW.toISOString()]);
    const got = await refresh(w, read(41));
    assert.equal(got.ok, true);
    assert.deepEqual(got.lifted, { cause: 'login', until });
    assert.deepEqual([w.stored().refusal_until, w.stored().refusal_cause], [null, null]);
    assert.equal(w.stored().windows.primary.fraction_used, 0.41);
  } finally { w.done(); }
});

test('a renewed login refusal keeps the instant it was first seen', async () => {
  const w = workspace();
  try {
    const later = new Date(NOW.getTime() + 15 * 60_000);
    await refresh(w, appServer({ rateLimits: { error: REVOKED } }));
    await refreshCodexCapacity({ root: w.root, lockRoot: w.root, now: later, lock: (_root, fn) => fn(), spawn: appServer({ rateLimits: { error: REVOKED } }) });
    assert.deepEqual([w.stored().refusal_until, w.stored().refusal_since], [new Date(later.getTime() + QUOTA_SLEEP_MS).toISOString(), NOW.toISOString()]);
  } finally { w.done(); }
});

test('a Codex quota refusal survives a read with its primary window at 100 %', async () => {
  const w = workspace();
  try {
    const until = new Date((RESETS) * 1000).toISOString();
    writeCapacity(applyRefusal(readCapacity({ root: w.root }), 'codex', until, null, NOW, 'quota'), { root: w.root });
    const got = await refresh(w, read(100));
    assert.equal(got.ok, true);
    assert.equal(got.lifted, null);
    assert.deepEqual([w.stored().refusal_until, w.stored().refusal_cause], [until, 'quota']);
  } finally { w.done(); }
});
