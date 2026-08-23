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
import { existsSync, mkdtempSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  STALE_ROUNDS, clearOwnState, codeDrift, codeStamp, daemonState, stopDaemon,
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

/**
 * The code a watcher runs is the code that was on disk when it started.
 *
 * Measured 2026-08-23: the PM round was started thirteen minutes before the
 * fix for the prompt it could not find, and ran the old code for a day — 188
 * knocks, none landed, and the board read "nothing to say". So a running
 * watcher carries the stamp of the tree it started from, says when the tree
 * has moved, and restarts itself between passes. None of that spawns
 * anything here; what is proved is the stamp, the drift and the verdict.
 */
describe('a watcher runs the code on disk, not the code it was started with', () => {
  function tree() {
    const root = mkdtempSync(join(tmpdir(), 'mc-test-watch-code-'));
    const src = join(root, 'src');
    mkdirSync(join(src, 'commands'), { recursive: true });
    writeFileSync(join(src, 'watch-pm-run.js'), '// runner\n');
    writeFileSync(join(src, 'commands', 'watch.js'), '// command\n');
    return { root, runner: join(src, 'watch-pm-run.js'), file: join(src, 'commands', 'watch.js') };
  }

  it('the stamp moves when a source file does, and not otherwise', () => {
    const { runner, file } = tree();
    const before = codeStamp(runner);
    assert.equal(codeStamp(runner), before, 'the same tree is the same stamp');
    const later = new Date(Date.now() + 60_000);
    utimesSync(file, later, later);
    assert.notEqual(codeStamp(runner), before, 'an edit under src/ is a new stamp');
  });

  it('drift is asked at most every so often, and sticks once seen', () => {
    const { runner, file } = tree();
    let clock = 1_000_000;
    const drifted = codeDrift(runner, { everyMs: 30_000, now: () => clock });
    assert.equal(drifted(), false);
    const later = new Date(Date.now() + 60_000);
    utimesSync(file, later, later);
    clock += 10_000;
    assert.equal(drifted(), false, 'not looked at again yet — a stat walk every 200ms is not free');
    clock += 30_000;
    assert.equal(drifted(), true, 'looked, and the tree has moved');
    assert.equal(drifted(), true, 'and it stays decided');
  });

  it('a running watcher on old code is said as such, in two ways', () => {
    // A pid file with a stamp that no longer matches: a watcher that knows
    // to check and will restart itself. One with no stamp at all: started
    // before mc knew to check, and the one that needs a hand.
    const { runner, file } = tree();
    const root = home();
    const stamp = codeStamp(runner);
    writeFileSync(watchStatePath('pm', root), JSON.stringify({
      target: 'pm', pid: process.pid, interval_ms: INTERVAL, runner, code: stamp,
    }));
    const isRunner = (pid) => pid === process.pid;
    const fresh = daemonState({ target: 'pm', runner, root, isRunner });
    assert.equal(fresh.running, true);
    assert.equal(fresh.stale_code, false);
    assert.equal(fresh.code, stamp);

    const later = new Date(Date.now() + 60_000);
    utimesSync(file, later, later);
    const moved = daemonState({ target: 'pm', runner, root, isRunner });
    assert.equal(moved.stale_code, true, 'the tree moved under it');
    assert.equal(moved.code, stamp, 'and the old stamp is still what it carries');

    writeFileSync(watchStatePath('pm', root), JSON.stringify({
      target: 'pm', pid: process.pid, interval_ms: INTERVAL, runner,
    }));
    const unaware = daemonState({ target: 'pm', runner, root, isRunner });
    assert.equal(unaware.stale_code, true);
    assert.equal(unaware.code, null, 'no stamp: started before the check existed');
  });
});
