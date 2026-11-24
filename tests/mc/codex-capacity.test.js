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
import { readCapacity } from '../../src/mc/model-capacity.js';
import { QUOTA_SLEEP_MS } from '../../src/mc/run-plan.js';

const NOW = new Date('2026-11-22T10:10:11Z');
const RECORDED_STDERR = readFileSync(new URL('../fixtures/codex/revoked-login-20261122T101009Z.json.err', import.meta.url), 'utf8');
const REVOKED = { code: -32603, message: 'unexpected status 401 Unauthorized: Encountered invalidated oauth token for user, failing request, auth error: 401, auth error code: token_revoked' };

/**
 * A fake app server: it answers `initialize`, then answers `account/rateLimits/read`
 * with `rateLimits` (an error, or nothing: it writes `stderr` and closes).
 */
function appServer({ rateLimits, stderr = '' }) {
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
