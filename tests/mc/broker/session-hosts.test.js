import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import {
  listLocalBrokerAndHostSessions,
  requestForSession,
} from '../../../src/mc/broker/session-hosts.js';

function makeHostManifest({ hostsDir, sessionId = 'sess_a' }) {
  const dir = join(hostsDir, sessionId);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    session_id: sessionId,
    socket_path: join(dir, 'broker.sock'),
    pid_path: join(dir, 'broker.pid'),
    log_path: join(dir, 'broker.log'),
  };
  writeFileSync(join(dir, 'host.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

describe('session broker hosts', () => {
  test('lists hosted sessions and routes requests to the host socket', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-session-hosts-'));
    try {
      const hostsDir = join(root, 'hosts');
      const host = makeHostManifest({ hostsDir });
      const seen = [];
      const request = async (message, options) => {
        seen.push({ message, options });
        if (message.type === 'sessions' && options?.socketPath === host.socket_path) {
          return { ok: true, sessions: [{ id: 'sess_a', cwd: '/repo/hosted' }] };
        }
        if (message.type === 'sessions' && !options) {
          return { ok: true, sessions: [{ id: 'sess_global', cwd: '/repo/global' }] };
        }
        if (message.type === 'session_status' && options?.socketPath === host.socket_path) {
          return { ok: true, session: { id: message.id } };
        }
        return { ok: false, error: `unexpected ${message.type}` };
      };

      const sessions = await listLocalBrokerAndHostSessions({
        request,
        includeHosts: true,
        hostsDir,
      });

      assert.equal(sessions.length, 2);
      assert.deepEqual(sessions[0], {
        id: 'sess_a',
        cwd: '/repo/hosted',
        broker_socket_path: host.socket_path,
        broker_pid_path: host.pid_path,
        broker_log_path: host.log_path,
        host_session_id: 'sess_a',
        host_kind: 'session',
      });
      assert.deepEqual(sessions[1], { id: 'sess_global', cwd: '/repo/global' });

      const routedRequest = requestForSession(sessions[0], { request });
      await routedRequest({ type: 'session_status', id: 'sess_a' });
      assert.deepEqual(seen.at(-1), {
        message: { type: 'session_status', id: 'sess_a' },
        options: { socketPath: host.socket_path },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not scan session-host manifests for injected requests unless requested', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-session-hosts-skip-'));
    try {
      const hostsDir = join(root, 'hosts');
      makeHostManifest({ hostsDir });
      const seen = [];
      const sessions = await listLocalBrokerAndHostSessions({
        hostsDir,
        request: async (message, options) => {
          seen.push({ message, options });
          return { ok: true, sessions: [{ id: 'sess_global' }] };
        },
      });

      assert.deepEqual(sessions, [{ id: 'sess_global' }]);
      assert.deepEqual(seen, [{ message: { type: 'sessions' }, options: undefined }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('prefers the hosted session when a global broker reports the same id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-session-hosts-dedupe-'));
    try {
      const hostsDir = join(root, 'hosts');
      const host = makeHostManifest({ hostsDir });
      const sessions = await listLocalBrokerAndHostSessions({
        request: async (message, options) => {
          if (message.type === 'sessions' && options?.socketPath === host.socket_path) {
            return { ok: true, sessions: [{ id: 'sess_a', cwd: '/repo/hosted' }] };
          }
          if (message.type === 'sessions' && !options) {
            return { ok: true, sessions: [{ id: 'sess_a', cwd: '/repo/global' }] };
          }
          return { ok: false };
        },
        includeHosts: true,
        hostsDir,
      });

      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].cwd, '/repo/hosted');
      assert.equal(sessions[0].broker_socket_path, host.socket_path);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
