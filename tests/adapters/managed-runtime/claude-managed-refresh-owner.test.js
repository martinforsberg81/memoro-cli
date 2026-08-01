import assert from 'node:assert/strict';
import test from 'node:test';

import { createManagedClaudeRefreshOwner } from '../../../src/adapters/managed-runtime/claude-managed-refresh-owner.js';

const initialNow = 1_800_000_000_000;

function registryFixture() {
  const values = [];
  const sentinel = 'fake_value_12345678-1234-4123-8123-123456789abc';
  return {
    values,
    register(name, realValue, hosts) {
      values.push({ name, realValue, hosts });
      return sentinel;
    },
  };
}

function timersFixture() {
  let nextId = 0;
  const timers = new Map();
  return {
    timers,
    setTimer(fn, delay) {
      const id = ++nextId;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
  };
}

function grant(overrides = {}) {
  return {
    accessToken: 'access-old',
    refreshToken: 'refresh-old',
    expiresAt: initialNow + 10 * 60_000,
    scopes: ['user:inference'],
    ...overrides,
  };
}

test('refresh owner exposes one stable sentinel and schedules before expiry', async () => {
  const registry = registryFixture();
  const timers = timersFixture();
  const owner = createManagedClaudeRefreshOwner({
    sentinelRegistry: registry,
    loadCustody: async () => ({ ok: true, grant: grant() }),
    rotateCustody: async () => assert.fail('refresh should be scheduled'),
    now: () => initialNow,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const started = await owner.start();
  assert.equal(started.ok, true);
  assert.match(started.sentinel, /^fake_value_/u);
  assert.deepEqual(registry.values, [{
    name: 'mc:claude-oauth',
    realValue: 'access-old',
    hosts: ['api.anthropic.com'],
  }]);
  assert.deepEqual([...timers.timers.values()].map(({ delay }) => delay), [
    5 * 60_000,
  ]);
  assert.deepEqual(owner.status(), {
    state: 'running',
    scheduled: true,
    refresh_active: false,
    fatal_reason: null,
  });
});

test('refresh owner updates the existing sentinel only after durable rotation', async () => {
  const registry = registryFixture();
  const timers = timersFixture();
  const owner = createManagedClaudeRefreshOwner({
    sentinelRegistry: registry,
    loadCustody: async () => ({ ok: true, grant: grant() }),
    rotateCustody: async () => ({
      ok: true,
      refreshed: true,
      grant: grant({
        accessToken: 'access-new',
        refreshToken: 'refresh-new',
        expiresAt: initialNow + 60 * 60_000,
      }),
      nextRefreshInMs: 15 * 60_000,
    }),
    now: () => initialNow,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const started = await owner.start();
  const refreshed = await owner.refresh();
  assert.equal(refreshed.ok, true);
  assert.equal(registry.values[1].realValue, 'access-new');
  assert.equal(
    registry.register('mc:claude-oauth', 'probe', ['api.anthropic.com']),
    started.sentinel,
  );
  assert.equal([...timers.timers.values()][0].delay, 15 * 60_000);
});

test('refresh owner waits for another lease holder only inside token lifetime', async () => {
  const registry = registryFixture();
  const timers = timersFixture();
  const fatal = [];
  const owner = createManagedClaudeRefreshOwner({
    sentinelRegistry: registry,
    loadCustody: async () => ({ ok: true, grant: grant() }),
    rotateCustody: async () => ({
      ok: false,
      reason: 'managed-claude-refresh-busy',
      retryAt: initialNow + 90_000,
    }),
    now: () => initialNow,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onFatal: (reason) => fatal.push(reason),
  });
  await owner.start();
  assert.equal((await owner.refresh()).reason, 'managed-claude-refresh-busy');
  assert.equal([...timers.timers.values()][0].delay, 91_000);
  assert.deepEqual(fatal, []);
});

test('refresh owner fails closed without replacing the sentinel on persistence failure', async () => {
  const registry = registryFixture();
  const timers = timersFixture();
  const fatal = [];
  const owner = createManagedClaudeRefreshOwner({
    sentinelRegistry: registry,
    loadCustody: async () => ({ ok: true, grant: grant() }),
    rotateCustody: async () => ({
      ok: false,
      reason: 'managed-claude-custody-write-unconfirmed',
    }),
    now: () => initialNow,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onFatal: (reason) => fatal.push(reason),
  });
  await owner.start();
  const result = await owner.refresh();
  assert.equal(result.ok, false);
  assert.equal(registry.values.length, 1);
  assert.deepEqual(fatal, ['managed-claude-custody-write-unconfirmed']);
  assert.equal(owner.status().state, 'failed');
  assert.equal(timers.timers.size, 0);
});
