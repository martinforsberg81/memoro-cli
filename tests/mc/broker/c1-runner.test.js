import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  isExactClaudeC1BrokerContext,
  parseC1LeaseHostReport,
  runClaudeC1BrokerOperationFixture,
  waitForC1ProcessGroupExitFixture,
} from '../../../src/mc/broker/c1-runner.js';
import { watchBrokerLivenessFixture } from '../../../src/mc/broker/c1-lease-host.js';

const context = Object.freeze({ session_id: 'sess_c1', runtime_generation: 'generation_c1' });

test('C1 broker runner rejects malformed context before artifact or custody access', async () => {
  let verified = 0;
  let leased = 0;
  for (const bad of [
    null,
    {},
    { session_id: 'sess_c1' },
    { ...context },
    { ...context, extra: 'attacker-choice' },
    { ...context, runtime_generation: '' },
  ]) {
    const result = await runClaudeC1BrokerOperationFixture(bad, {
      verifySourceClosure: () => true,
      verifyArtifacts: () => { verified += 1; return { ok: true }; },
      runLeaseHost: () => { leased += 1; return { status: 'passed' }; },
    });
    assert.deepEqual(result, { status: 'failed' });
  }
  assert.equal(verified, 0);
  assert.equal(leased, 0);
  assert.equal(isExactClaudeC1BrokerContext(context), true);
});

test('C1 broker verifies fixed artifacts before the no-argument lease', async () => {
  const order = [];
  const result = await runClaudeC1BrokerOperationFixture(context, {
    verifySourceClosure: () => { order.push('source'); return { ok: true }; },
    verifyArtifacts: () => { order.push('verify'); return { ok: true }; },
    runLeaseHost: (...args) => {
      order.push('host');
      assert.deepEqual(args, []);
      return { status: 'passed' };
    },
  });
  assert.deepEqual(result, { status: 'passed' });
  assert.deepEqual(order, ['source', 'verify', 'host']);
});

test('C1 broker fails closed for failed artifacts and malformed lease output', async () => {
  let leaseCalled = false;
  const unavailable = await runClaudeC1BrokerOperationFixture(context, {
    verifySourceClosure: () => true,
    verifyArtifacts: () => ({ ok: false }),
    runLeaseHost: () => { leaseCalled = true; return { status: 'passed' }; },
  });
  assert.deepEqual(unavailable, { status: 'indeterminate' });
  assert.equal(leaseCalled, false);

  const malformed = await runClaudeC1BrokerOperationFixture(context, {
    verifySourceClosure: () => true,
    verifyArtifacts: () => ({ ok: true }),
    runLeaseHost: () => ({ status: 'passed', raw: 'must-not-cross-boundary' }),
  });
  assert.deepEqual(malformed, { status: 'failed' });
});

test('C1 broker refuses source drift before artifact or custody access', async () => {
  let artifacts = 0;
  let leases = 0;
  const result = await runClaudeC1BrokerOperationFixture(context, {
    verifySourceClosure: () => ({ ok: false }),
    verifyArtifacts: () => { artifacts += 1; return { ok: true }; },
    runLeaseHost: () => { leases += 1; return { status: 'passed' }; },
  });
  assert.deepEqual(result, { status: 'failed' });
  assert.equal(artifacts, 0);
  assert.equal(leases, 0);
});

test('C1 fixture seam rejects caller-selected process parameters', async () => {
  let called = false;
  const result = await runClaudeC1BrokerOperationFixture(context, {
    verifySourceClosure: () => true,
    verifyArtifacts: () => { called = true; return { ok: true }; },
    runLeaseHost: () => ({ status: 'passed' }),
    path: '/tmp/attacker-host',
  });
  assert.deepEqual(result, { status: 'failed' });
  assert.equal(called, false);
});

test('C1 lease host report accepts only the fixed redacted schema', () => {
  assert.deepEqual(parseC1LeaseHostReport(Buffer.from('{"schema":1,"status":"passed"}\n')), {
    status: 'passed',
  });
  assert.equal(parseC1LeaseHostReport(Buffer.from('{"schema":1,"status":"passed","raw":"no"}')), null);
  assert.equal(parseC1LeaseHostReport(Buffer.from('{"schema":2,"status":"passed"}')), null);
  assert.equal(parseC1LeaseHostReport(Buffer.from('not-json')), null);
});

test('C1 runner does not import vault code and pins the fixed lease host source', () => {
  const runner = readFileSync(new URL('../../../src/mc/broker/c1-runner.js', import.meta.url), 'utf8');
  const host = readFileSync(new URL('../../../src/mc/broker/c1-lease-host.js', import.meta.url));
  const closure = readFileSync(new URL('../../../src/mc/broker/c1-source-closure.js', import.meta.url));
  assert.doesNotMatch(runner, /(?:from|import\()\s*['"][^'"]*vault\//u);
  const pinned = runner.match(
    /const C1_LEASE_HOST_SOURCE_SHA256 =\s*'([a-f0-9]{64})';/u,
  )?.[1];
  assert.equal(pinned, createHash('sha256').update(host).digest('hex'));
  const closurePin = runner.match(
    /const C1_SOURCE_CLOSURE_SOURCE_SHA256 =\s*'([a-f0-9]{64})';/u,
  )?.[1];
  assert.equal(closurePin, createHash('sha256').update(closure).digest('hex'));
});

test('C1 source closure is verified before vault import and every credential pipe read/write', () => {
  const host = readFileSync(
    new URL('../../../src/mc/broker/c1-lease-host.js', import.meta.url),
    'utf8',
  );
  const lease = readFileSync(
    new URL('../../../src/mc/vault/c1-claude-lease.js', import.meta.url),
    'utf8',
  );
  const child = readFileSync(
    new URL('../../../src/mc/broker/c1-child.js', import.meta.url),
    'utf8',
  );
  assert.ok(host.indexOf('verifyInstalledC1SourceClosure()') >= 0);
  assert.ok(host.indexOf('verifyInstalledC1SourceClosure()')
    < host.indexOf("await import('../vault/c1-claude-lease.js')"));
  assert.ok(lease.indexOf('verifyInstalledC1SourceClosure()')
    < lease.indexOf('child = spawn('));
  assert.ok(lease.indexOf('verifyInstalledC1SourceClosure()')
    < lease.indexOf('credentialPipe.end(credentialBytes'));
  assert.ok(child.indexOf('verifyInstalledC1SourceClosure()')
    < child.indexOf('credentialBytes = readCredentialFd()'));
});

test('C1 process-group terminal proof rejects a close that left survivors', async () => {
  let alive = true;
  let kills = 0;
  const cleared = await waitForC1ProcessGroupExitFixture(4242, {
    isAlive: () => alive,
    kill: () => { kills += 1; alive = false; },
    delay: async () => {},
    now: () => 0,
  });
  assert.deepEqual(cleared, { exited: true, survivorsObserved: true });
  assert.equal(kills, 1);

  let clock = 0;
  const stuck = await waitForC1ProcessGroupExitFixture(4242, {
    isAlive: () => true,
    kill: () => { kills += 1; },
    delay: async () => { clock += 1; },
    now: () => clock,
    timeoutMs: 2,
    pollMs: 1,
  });
  assert.deepEqual(stuck, { exited: false, survivorsObserved: true });
});

test('C1 lease host kills its group when the broker liveness pipe reaches EOF', () => {
  const liveness = new EventEmitter();
  liveness.destroy = () => {};
  let kills = 0;
  const monitor = watchBrokerLivenessFixture(liveness, { killGroup: () => { kills += 1; } });
  assert.ok(monitor);
  liveness.emit('end');
  liveness.emit('close');
  assert.equal(kills, 1);

  const normal = new EventEmitter();
  normal.destroy = () => {};
  const normalMonitor = watchBrokerLivenessFixture(normal, { killGroup: () => { kills += 1; } });
  normalMonitor.stop();
  normal.emit('end');
  assert.equal(kills, 1);
});

test('C1 has exactly one detached group leader and waits for terminal group proof', () => {
  const runner = readFileSync(new URL('../../../src/mc/broker/c1-runner.js', import.meta.url), 'utf8');
  const lease = readFileSync(new URL('../../../src/mc/vault/c1-claude-lease.js', import.meta.url), 'utf8');
  const child = readFileSync(new URL('../../../src/mc/broker/c1-child.js', import.meta.url), 'utf8');
  const harness = readFileSync(new URL('../../../scripts/security/managed-claude-c1-harness.mjs', import.meta.url), 'utf8');
  const runtime = readFileSync(new URL('../../../scripts/security/managed-claude-c1-runtime.mjs', import.meta.url), 'utf8');
  assert.match(runner, /detached: true/u);
  assert.match(runner, /stdio: \['ignore', 'pipe', 'pipe', 'pipe'\]/u);
  assert.match(runner, /brokerLivenessPipe = child\.stdio\[3\]/u);
  assert.match(runner, /waitForC1ProcessGroupExitFixture\(groupLeaderPid/u);
  assert.match(runner, /group\.survivorsObserved/u);
  assert.doesNotMatch(lease, /detached: true/u);
  assert.doesNotMatch(harness, /detached: true/u);
  assert.doesNotMatch(runtime, /detached: true/u);
  assert.match(lease, /detached: false/u);
  assert.match(lease, /stdio: \['ignore', 'pipe', 'pipe', 'pipe'\]/u);
  assert.match(child, /const CREDENTIAL_FD = 3/u);
  assert.match(harness, /detached: false/u);
  assert.match(runtime, /detached: false/u);
  assert.match(runtime, /stdio: \['ignore', 'pipe', 'pipe', 'pipe'\]/u);
  assert.match(runtime, /child\.stdio\[3\]\.end\(sentinel\)/u);
});
