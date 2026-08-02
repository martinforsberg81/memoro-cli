import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach, beforeEach, describe } from 'node:test';

import {
  inspectBrokerSessionAbsence,
  inspectSessionOwnedMcArtifacts,
  removeSessionOwnedRuntimeArtifacts,
} from '../../src/mc/session-owned-artifacts.js';

describe('session-owned mc artifacts', () => {
  let root;
  let previousMcHome;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mc-session-artifacts-'));
    previousMcHome = process.env.MC_HOME;
    process.env.MC_HOME = root;
  });

  afterEach(() => {
    if (previousMcHome === undefined) delete process.env.MC_HOME;
    else process.env.MC_HOME = previousMcHome;
    rmSync(root, { recursive: true, force: true });
  });

  test('stops and removes only the exact host and guard directories', async () => {
    const entry = { name: 'owned', coding_session_id: 'sess_owned' };
    const host = join(root, 'hosts', 'sess_owned');
    const guard = join(root, 'guard-bin', 'sess_owned');
    const siblingHost = join(root, 'hosts', 'sess_other');
    mkdirSync(host, { recursive: true });
    mkdirSync(guard, { recursive: true });
    mkdirSync(siblingHost, { recursive: true });
    writeFileSync(join(host, 'broker.pid'), '4242');
    let alive = true;
    const killed = [];

    const result = await removeSessionOwnedRuntimeArtifacts(entry, {
      isAlive: () => alive,
      kill: (pid) => {
        killed.push(pid);
        alive = false;
        return true;
      },
      requestBroker: async () => ({
        ok: true,
        broker: { pid: 4242 },
      }),
      sleep: async () => {},
    });

    assert.equal(result.ok, true);
    assert.deepEqual(killed, [4242]);
    assert.equal(existsSync(host), false);
    assert.equal(existsSync(guard), false);
    assert.equal(existsSync(siblingHost), true);
  });

  test('does not signal a live PID unless the exact host socket verifies its identity', async () => {
    const entry = { name: 'stale-pid', coding_session_id: 'sess_stale_pid' };
    const host = join(root, 'hosts', 'sess_stale_pid');
    mkdirSync(host, { recursive: true });
    writeFileSync(join(host, 'broker.pid'), '4242');
    let killCalls = 0;

    const result = await removeSessionOwnedRuntimeArtifacts(entry, {
      isAlive: () => true,
      kill: () => {
        killCalls += 1;
        return true;
      },
      requestBroker: async () => ({
        ok: true,
        broker: { pid: 9001 },
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.issues[0].code, 'broker-host-pid-unverified');
    assert.equal(killCalls, 0);
    assert.equal(existsSync(host), true);
  });

  test('uses the exact live host socket when its PID file is missing', async () => {
    const entry = { name: 'socket-owned', coding_session_id: 'sess_socket_owned' };
    const host = join(root, 'hosts', 'sess_socket_owned');
    mkdirSync(host, { recursive: true });
    writeFileSync(join(host, 'broker.sock'), '');
    let alive = true;
    const killed = [];

    const result = await removeSessionOwnedRuntimeArtifacts(entry, {
      isAlive: () => alive,
      kill: (pid) => {
        killed.push(pid);
        alive = false;
        return true;
      },
      requestBroker: async () => ({
        ok: true,
        broker: { pid: 5151 },
      }),
      sleep: async () => {},
    });

    assert.equal(result.ok, true);
    assert.deepEqual(killed, [5151]);
    assert.equal(existsSync(host), false);
  });

  test('removes a dead host whose socket never answers and whose pid file is gone', async () => {
    const entry = { name: 'dead-socket', coding_session_id: 'sess_dead_socket' };
    const host = join(root, 'hosts', 'sess_dead_socket');
    mkdirSync(host, { recursive: true });
    writeFileSync(join(host, 'broker.sock'), '');
    let probes = 0;

    const result = await removeSessionOwnedRuntimeArtifacts(entry, {
      isAlive: () => assert.fail('no pid exists to check'),
      kill: () => assert.fail('no pid exists to stop'),
      requestBroker: async () => {
        probes += 1;
        throw new Error('connection refused');
      },
      sleep: async () => {},
    });

    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.equal(probes, 2);
    assert.equal(existsSync(host), false);
  });

  test('a host that answers without naming its pid stays fail-closed', async () => {
    const entry = { name: 'coy-host', coding_session_id: 'sess_coy_host' };
    const host = join(root, 'hosts', 'sess_coy_host');
    mkdirSync(host, { recursive: true });
    writeFileSync(join(host, 'broker.sock'), '');

    const result = await removeSessionOwnedRuntimeArtifacts(entry, {
      isAlive: () => false,
      kill: () => true,
      requestBroker: async () => ({ ok: true, broker: {} }),
      sleep: async () => {},
    });

    assert.equal(result.ok, false);
    assert.equal(result.issues[0].code, 'broker-host-pid-unverified');
    assert.equal(existsSync(host), true);
  });

  test('revalidates host identity immediately before rm after async stop work', async () => {
    const entry = { name: 'late-swap', coding_session_id: 'sess_late_swap' };
    const host = join(root, 'hosts', 'sess_late_swap');
    const outside = join(root, 'outside-late-swap');
    mkdirSync(host, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(host, 'broker.pid'), '6161');
    writeFileSync(join(outside, 'keep'), 'keep');
    let alive = true;
    const sequence = [];

    const result = await removeSessionOwnedRuntimeArtifacts(entry, {
      isAlive: () => alive,
      kill: () => {
        sequence.push('stop');
        alive = false;
        return true;
      },
      requestBroker: async () => {
        sequence.push('status');
        return { ok: true, broker: { pid: 6161 } };
      },
      sleep: async () => {},
      beforeRemove: async ({ kind, path }) => {
        if (kind !== 'broker-host') return;
        sequence.push('swap');
        rmSync(path, { recursive: true, force: true });
        symlinkSync(outside, path);
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.issues[0].code, 'mc-artifact-changed');
    assert.deepEqual(sequence, ['status', 'stop', 'swap']);
    assert.equal(existsSync(join(outside, 'keep')), true);
  });

  test('fails closed instead of following a sidecar symlink', async () => {
    const entry = { name: 'linked', coding_session_id: 'sess_linked' };
    const outside = join(root, 'outside');
    const host = join(root, 'hosts', 'sess_linked');
    mkdirSync(join(root, 'hosts'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep'), 'keep');
    symlinkSync(outside, host);

    const result = await removeSessionOwnedRuntimeArtifacts(entry);

    assert.equal(result.ok, false);
    assert.equal(result.issues[0].code, 'symlink-not-allowed');
    assert.equal(existsSync(join(outside, 'keep')), true);
  });

  test('fails closed when a sidecar parent redirects outside MC_HOME', async () => {
    const entry = { name: 'linked-parent', coding_session_id: 'sess_linked_parent' };
    const outside = join(root, 'outside');
    mkdirSync(join(outside, 'sess_linked_parent'), { recursive: true });
    writeFileSync(join(outside, 'sess_linked_parent', 'keep'), 'keep');
    symlinkSync(outside, join(root, 'hosts'));

    const result = await removeSessionOwnedRuntimeArtifacts(entry);

    assert.equal(result.ok, false);
    assert.equal(result.issues[0].code, 'symlink-not-allowed');
    assert.equal(existsSync(join(outside, 'sess_linked_parent', 'keep')), true);
  });

  test('reports vault manifests as exact leftovers', () => {
    const entry = { name: 'vaulted', coding_session_id: null };
    const manifest = join(root, 'state', 'vaulted-materialised.json');
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(manifest, '{}');

    const result = inspectSessionOwnedMcArtifacts(entry);

    assert.equal(result.ok, true);
    assert.deepEqual(result.leftovers, [{ kind: 'vault-manifest', path: manifest }]);
  });

  test('a reachable broker row is a verified leftover', async () => {
    const entry = {
      name: 'brokered',
      coding_session_id: 'sess_brokered',
      worktree_path: '/repo/brokered',
    };
    const socket = join(root, 'broker.sock');
    writeFileSync(socket, '');

    const result = await inspectBrokerSessionAbsence(entry, {
      exists: (path) => path === socket,
      requestBroker: async () => ({
        ok: true,
        sessions: [{
          id: 'sess_brokered',
          name: 'brokered',
          cwd: '/repo/brokered',
        }],
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.state, 'present');
    assert.equal(result.issues[0].code, 'broker-session-leftover');
  });

  test('same label with a different coding ID and repo is not a target leftover', async () => {
    const entry = {
      name: 'brokered',
      coding_session_id: 'sess_brokered',
      worktree_path: '/repo/brokered',
    };
    const socket = join(root, 'broker.sock');
    writeFileSync(socket, '');

    const result = await inspectBrokerSessionAbsence(entry, {
      exists: (path) => path === socket,
      requestBroker: async () => ({
        ok: true,
        sessions: [{
          id: 'sess_other',
          coding_session_id: 'sess_other',
          name: 'brokered',
          cwd: '/repo/other',
        }],
      }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.state, 'absent');
  });

  test('an unreachable existing broker socket is unverified, not absent', async () => {
    const entry = { name: 'unverified', coding_session_id: 'sess_unverified' };
    const socket = join(root, 'broker.sock');
    writeFileSync(socket, '');

    const result = await inspectBrokerSessionAbsence(entry, {
      exists: (path) => path === socket,
      requestBroker: async () => ({ ok: false, error: 'locked' }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.state, 'unverified');
    assert.equal(result.issues[0].code, 'broker-inventory-unavailable');
  });
});

test('a definitively refused dead socket file proves broker absence', async () => {
  const { inspectBrokerSessionAbsence } = await import('../../src/mc/session-owned-artifacts.js');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'mc-absence-'));
  const previous = process.env.MC_HOME;
  process.env.MC_HOME = root;
  try {
    mkdirSync(join(root, 'hosts', 'sess_dead'), { recursive: true });
    writeFileSync(join(root, 'broker.sock'), '');
    writeFileSync(join(root, 'hosts', 'sess_dead', 'broker.sock'), '');
    const entry = {
      name: 'dead',
      coding_session_id: 'sess_dead',
      session_id: `mcs_${'a'.repeat(24)}`,
    };

    const refused = await inspectBrokerSessionAbsence(entry, {
      mcDir: root,
      requestBroker: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      },
    });
    const undecided = await inspectBrokerSessionAbsence(entry, {
      mcDir: root,
      requestBroker: async () => {
        throw Object.assign(new Error('connect EPERM'), { code: 'EPERM' });
      },
    });

    if (refused.state !== 'absent') throw new Error(`refused socket must prove absence, got ${refused.state}`);
    if (undecided.state !== 'unverified') throw new Error('non-definitive failure must stay unverified');
  } finally {
    if (previous == null) delete process.env.MC_HOME; else process.env.MC_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
