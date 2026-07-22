import test, { afterEach, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runMc, parseJsonOrNull } from '../_helpers/cli.js';

describe('mc dev CLI', () => {
  let root;
  let mcHome;
  let worktree;
  let sourcePath;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mc-dev-cli-'));
    mcHome = join(root, 'mc-home');
    worktree = join(root, 'worktree');
    mkdirSync(join(worktree, '.runtime'), { recursive: true });
    sourcePath = join(worktree, '.runtime', 'mc-dev.json');
    writeFileSync(join(worktree, '.runtime', 'dev.log'), 'line one\nline two\n');
    writeFileSync(sourcePath, JSON.stringify({
      schema_version: 1,
      instance_id: 'dev-cli-example',
      service: 'memoro-worker',
      session_name: 'ios-app',
      worktree_path: worktree,
      pid: 999999,
      process_group_id: 999999,
      url: 'http://127.0.0.1:8787',
      port: 8787,
      health_url: 'http://127.0.0.1:8787/api/version',
      log_path: join(worktree, '.runtime', 'dev.log'),
      started_at: '2026-07-22T10:00:00.000Z',
      control: {
        stop: { argv: ['npm', 'run', 'dev', '--', '--stop'] },
        restart: { argv: ['npm', 'run', 'dev', '--', '--restart'], detached: true },
      },
    }, null, 2));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('register, list, status, logs, and unregister share one protocol', () => {
    const env = { MC_HOME: mcHome };
    const registered = runMc(['dev', 'register', sourcePath, '--json'], { env });
    assert.equal(registered.status, 0, registered.stderr);
    assert.equal(parseJsonOrNull(registered.stdout).instance_id, 'dev-cli-example');

    const listed = runMc(['dev', 'list', '--json'], { env });
    assert.equal(listed.status, 0, listed.stderr);
    const inventory = parseJsonOrNull(listed.stdout);
    assert.equal(inventory.summary.total, 1);
    assert.equal(inventory.servers[0].state, 'orphan');
    assert.equal(inventory.servers[0].session_name, 'ios-app');

    const status = runMc(['dev', 'status', 'ios-app', '--json'], { env });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(parseJsonOrNull(status.stdout).instance_id, 'dev-cli-example');

    const logs = runMc(['dev', 'logs', 'ios-app', '--lines', '1'], { env });
    assert.equal(logs.status, 0, logs.stderr);
    assert.equal(logs.stdout, 'line two\n');

    const stopped = runMc(['dev', 'stop', 'ios-app'], { env });
    assert.equal(stopped.status, 1);
    assert.match(stopped.stderr, /refusing stop.*process-not-running/i);

    const unregistered = runMc(['dev', 'unregister', sourcePath, '--json'], { env });
    assert.equal(unregistered.status, 0, unregistered.stderr);
    assert.equal(parseJsonOrNull(unregistered.stdout).removed, true);
  });

  test('human-readable errors are explicit', () => {
    const result = runMc(['dev', 'status', 'missing'], { env: { MC_HOME: mcHome } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no dev server matches "missing"/);
  });

  test('human list includes the operational fields needed for triage', () => {
    const env = { MC_HOME: mcHome };
    assert.equal(runMc(['dev', 'register', sourcePath], { env }).status, 0);
    const result = runMc(['dev', 'list'], { env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ios-app\/memoro-worker/);
    assert.match(result.stdout, /health=unknown/);
    assert.match(result.stdout, /worktree=.*worktree/);
    assert.match(result.stdout, /log=.*dev\.log/);
  });
});
