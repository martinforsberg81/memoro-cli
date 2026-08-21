/**
 * The daemon form both legs of the loop share.
 *
 * No daemon is started here, on purpose: a suite that spawns detached
 * processes is a suite that leaves them behind on the machine that runs it.
 * What is worth proving is what the pid file means — a pid is checked against
 * the process table rather than trusted, a file whose process is gone reads as
 * abandoned rather than as running, and a watcher that has not written for
 * three intervals says so.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  STALE_ROUNDS, clearOwnState, daemonState, stopDaemon,
} from '../../src/mc/watch-daemon.js';
import { watchRoot, watchStatePath } from '../../src/mc/watch-paths.js';

const RUNNER = '/somewhere/watch-pm-run.js';
const INTERVAL = 1800_000;

function home() {
  const root = mkdtempSync(join(tmpdir(), 'mc-test-watch-daemon-'));
  mkdirSync(watchRoot(root), { recursive: true, mode: 0o700 });
  return root;
}

/** A pid that certainly belongs to nobody: a process that has already exited. */
function deadPid() {
  const gone = spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' });
  return Number(String(gone.stdout).trim());
}

function pidFile(root, pid, extra = {}) {
  writeFileSync(watchStatePath('pm', root), JSON.stringify({
    target: 'pm', pid, started_at: '2026-08-21T10:00:00.000Z', interval_ms: INTERVAL, runner: RUNNER, ...extra,
  }));
}

describe('the watcher daemon form', () => {
  it('with no pid file it has never started', () => {
    const root = home();
    const state = daemonState({ target: 'pm', runner: RUNNER, root, defaultIntervalMs: INTERVAL });
    assert.equal(state.running, false);
    assert.equal(state.abandoned, false);
    assert.equal(state.last_write_at, null);
    assert.equal(state.stale, null);
    assert.match(state.log, /watch\/pm\.log$/u);
  });

  it('a pid file whose process is gone reads as abandoned, never as running', () => {
    const root = home();
    pidFile(root, deadPid());
    const state = daemonState({ target: 'pm', runner: RUNNER, root });
    assert.equal(state.running, false);
    assert.equal(state.abandoned, true, 'stopped without telling anyone is not the same as never started');
    assert.equal(state.pid, null);
  });

  it('this process is alive and still is not the runner', () => {
    const root = home();
    // The pid is real and the command line is node running the test runner,
    // not the watcher: pids are reused, so being alive is not enough.
    pidFile(root, process.pid);
    assert.equal(daemonState({ target: 'pm', runner: RUNNER, root }).running, false);
  });

  it('stopping an abandoned watcher clears the file it left behind', async () => {
    const root = home();
    pidFile(root, deadPid());
    const stopped = await stopDaemon({ target: 'pm', runner: RUNNER, root });
    assert.deepEqual(stopped, { ok: true, stopped: false, abandoned: true });
    assert.equal(existsSync(watchStatePath('pm', root)), false);
  });

  it('a picture older than three intervals reads as stale', () => {
    const root = home();
    const now = Date.parse('2026-08-21T12:00:00.000Z');
    const at = (msAgo) => new Date(now - msAgo).toISOString();

    const fresh = daemonState({
      target: 'pm', runner: RUNNER, root, now, defaultIntervalMs: INTERVAL, lastWriteAt: at(INTERVAL),
    });
    assert.equal(fresh.stale, false);

    const old = daemonState({
      target: 'pm', runner: RUNNER, root, now, defaultIntervalMs: INTERVAL, lastWriteAt: at(INTERVAL * (STALE_ROUNDS + 1)),
    });
    assert.equal(old.stale, true);
    assert.equal(old.last_write_age_ms, INTERVAL * (STALE_ROUNDS + 1));
  });

  it('a runner clears only its own pid file', () => {
    const root = home();
    pidFile(root, deadPid());
    clearOwnState('pm', root);
    assert.equal(existsSync(watchStatePath('pm', root)), true, 'somebody else claimed it since');

    pidFile(root, process.pid);
    clearOwnState('pm', root);
    assert.equal(existsSync(watchStatePath('pm', root)), false);
  });
});
