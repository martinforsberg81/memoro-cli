/**
 * The runner's switch, driven with no processes and no files.
 *
 * Every boundary `run-control.js` has is a key on `deps`, so `start` is
 * asserted by what it would have spawned, `stop --force` by which pids it
 * signalled and in which order, and the handover by what it told git to do
 * before it let go. Nothing here starts a runner, kills anything, or touches
 * a real `~/mc`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  childEnv, controlPaths, endNow, handOver, readRunner, requestUpdate, startRunner, stopRunner,
} from '../../src/mc/run-control.js';

const ROOT = '/w';
const paths = controlPaths(ROOT);

/**
 * A work root in memory. `runner` is what runner.json says, `live` the pids
 * that answer to a signal, `dir` the extra files under `runner/`.
 */
function fixture({ runner = null, live = [], stop = false, update = false, files = {}, pgid = null, table = '' } = {}) {
  const store = { ...files };
  if (runner) store[paths.runner] = JSON.stringify(runner);
  if (stop) store[paths.stop] = 'stopped\n';
  if (update) store[paths.update] = 'update\n';
  const alive = new Set(live);
  const calls = { spawned: [], killed: [], removed: [], opened: [] };
  const deps = {
    env: { MC_WORK_ROOT: ROOT },
    now: () => new Date('2026-08-30T18:00:00Z'),
    sleep: async () => {},
    exists: (path) => path in store,
    read: (path) => store[path] ?? null,
    write: (path, text) => { store[path] = text; },
    remove: (path) => { calls.removed.push(path); delete store[path]; },
    list: (dir) => Object.keys(store)
      .filter((path) => path.startsWith(`${dir}/`))
      .map((path) => path.slice(dir.length + 1))
      .filter((name) => !name.includes('/')),
    alive: (pid) => alive.has(Number(pid)),
    kill: (pid, signal) => {
      calls.killed.push([pid, signal]);
      // A signal to a group is a signal to every member of it.
      for (const member of [...alive]) {
        if (pid === member || (pid < 0 && -pid === (pgid ?? member))) alive.delete(member);
      }
    },
    ps: (args) => (args[0] === '-o' ? String(pgid ?? '') : table),
    openLog: (path) => { calls.opened.push(path); return 7; },
    spawn: ({ bin, args, stdio }) => { calls.spawned.push({ bin, args, stdio }); return 4242; },
    execPath: '/usr/bin/node',
    entry: '/opt/bin/mc',
  };
  return { store, calls, deps, alive };
}

describe('readRunner', () => {
  it('is a pid and whether it is alive, not what the file claims', () => {
    const live = fixture({ runner: { pid: 100, started: 'T' }, live: [100] });
    assert.deepEqual(readRunner({ paths, read: live.deps.read, alive: live.deps.alive }), { pid: 100, started: 'T', alive: true });

    const dead = fixture({ runner: { pid: 100, started: 'T' } });
    assert.equal(readRunner({ paths, read: dead.deps.read, alive: dead.deps.alive }).alive, false);
  });

  it('is null for no file, an unparseable one, or one with no pid', () => {
    for (const files of [{}, { [paths.runner]: 'not json' }, { [paths.runner]: '{"started":"T"}' }]) {
      const fx = fixture({ files });
      assert.equal(readRunner({ paths, read: fx.deps.read, alive: fx.deps.alive }), null);
    }
  });
});

describe('mc run start', () => {
  // stderr to the log and stdout to nothing: `say()` already appends every
  // line it prints, so a runner whose stdout is that same file logs the whole
  // round twice. stderr is the crash that explains a runner that has vanished.
  it('spawns mc run detached, with its stderr appended to runner.log', async () => {
    const fx = fixture();
    const out = await startRunner({ argv: [], root: ROOT, deps: fx.deps });
    assert.equal(out.ok, true);
    assert.equal(out.code, 0);
    assert.deepEqual(fx.calls.spawned, [{ bin: '/usr/bin/node', args: ['/opt/bin/mc', 'run'], stdio: ['ignore', 'ignore', 7] }]);
    assert.deepEqual(fx.calls.opened, [paths.log]);
    assert.match(out.lines.join('\n'), /runner started — pid 4242/u);
    assert.match(out.lines.join('\n'), /log: \/w\/runner\/log\/runner\.log/u);
  });

  it('carries the run flags through to the background runner', async () => {
    const fx = fixture();
    await startRunner({ argv: ['--no-merge', '--rounds', '3'], root: ROOT, deps: fx.deps });
    assert.deepEqual(fx.calls.spawned[0].args, ['/opt/bin/mc', 'run', '--no-merge', '--rounds', '3']);
  });

  it('refuses while a runner is alive, and says what would end it', async () => {
    const fx = fixture({ runner: { pid: 100, started: '2026-08-30T16:22:11Z' }, live: [100] });
    const out = await startRunner({ root: ROOT, deps: fx.deps });
    assert.equal(out.ok, false);
    assert.equal(out.code, 2);
    assert.deepEqual(fx.calls.spawned, []);
    assert.match(out.lines[0], /already running — pid 100/u);
    assert.match(out.lines[1], /mc run stop/u);
  });

  // start and stop are one switch: a switch that will not turn back on
  // because of the file the last stop wrote is not a switch.
  it('removes the STOP the last stop left, and says it did', async () => {
    const fx = fixture({ stop: true });
    const out = await startRunner({ root: ROOT, deps: fx.deps });
    assert.equal(out.ok, true);
    assert.ok(!(paths.stop in fx.store), 'STOP is still there');
    assert.ok(out.lines.some((line) => /removed the STOP/u.test(line)));
  });

  // The wrapper's fd 3 closes the moment `mc run start` returns; the runner it
  // started is still up hours later, and must not claim otherwise.
  it('starts the runner without the shell wrapper\'s directive flag', () => {
    assert.deepEqual(childEnv({ PATH: '/bin', MC_EMIT_SHELL_DIRECTIVES: '1', HOME: '/h' }), { PATH: '/bin', HOME: '/h' });
    assert.deepEqual(childEnv({ PATH: '/bin' }), { PATH: '/bin' });
  });

  it('clears a runner.json whose pid is gone rather than refusing on it', async () => {
    const fx = fixture({ runner: { pid: 100 }, files: { [`${paths.dir}/current-memoro.json`]: '{}' } });
    const out = await startRunner({ root: ROOT, deps: fx.deps });
    assert.equal(out.ok, true);
    assert.ok(!(`${paths.dir}/current-memoro.json` in fx.store), 'the ghost step is still there');
    assert.ok(out.lines.some((line) => /cleared runner\.json/u.test(line)));
  });
});

describe('mc run stop', () => {
  it('writes STOP and leaves the round in flight alone', async () => {
    const fx = fixture({ runner: { pid: 100 }, live: [100] });
    const out = await stopRunner({ root: ROOT, deps: fx.deps });
    assert.equal(out.ok, true);
    assert.equal(fx.store[paths.stop], '2026-08-30T18:00:00.000Z\n');
    assert.deepEqual(fx.calls.killed, []);
    assert.match(out.lines[0], /finishes the round it is in/u);
  });

  // STOP first, kill second, in every case: if the kill half works, or the
  // runner is between rounds and the signal misses it, the boundary is still
  // an exit.
  it('--force writes STOP as well as killing', async () => {
    const fx = fixture({ runner: { pid: 100 }, live: [100], pgid: 100 });
    await stopRunner({ force: true, root: ROOT, deps: fx.deps });
    assert.equal(paths.stop in fx.store, true);
  });

  it('--force signals the whole process group when the runner leads one', async () => {
    const fx = fixture({ runner: { pid: 100 }, live: [100, 101], pgid: 100 });
    const out = await stopRunner({ force: true, root: ROOT, deps: fx.deps });
    assert.equal(out.ok, true);
    assert.deepEqual(fx.calls.killed, [[-100, 'SIGTERM']]);
    assert.equal(fx.alive.has(101), false, 'the session it was holding is still alive');
    assert.match(out.lines[0], /SIGTERM to process group 100/u);
  });

  it('--force falls back to the descendants when the runner leads no group', async () => {
    const fx = fixture({
      runner: { pid: 100 }, live: [100, 101, 102], pgid: 7,
      table: ' 101 100\n 102 101\n 200 1\n',
    });
    await stopRunner({ force: true, root: ROOT, deps: fx.deps });
    assert.deepEqual(fx.calls.killed.map(([pid]) => pid), [100, 101, 102]);
  });

  it('--force follows SIGTERM with SIGKILL, and says so when even that fails', async () => {
    const fx = fixture({ runner: { pid: 100 }, live: [100], pgid: 100 });
    fx.deps.kill = () => {}; // signalled, and nothing dies
    const out = await stopRunner({ force: true, root: ROOT, deps: fx.deps });
    assert.equal(out.ok, false);
    assert.equal(out.code, 1);
    assert.match(out.lines[0], /still alive after SIGKILL/u);
  });

  // A killed runner never reaches its own `finally`, so the two files it
  // would have removed are removed here — the page draws current-*.json as a
  // step that is still running.
  it('--force clears runner.json and the ghost steps', async () => {
    const fx = fixture({
      runner: { pid: 100 }, live: [100], pgid: 100,
      files: { [`${paths.dir}/current-memoro.json`]: '{}', [`${paths.dir}/current-memoro-cli.json`]: '{}' },
    });
    const out = await stopRunner({ force: true, root: ROOT, deps: fx.deps });
    assert.ok(!(paths.runner in fx.store));
    assert.ok(!(`${paths.dir}/current-memoro.json` in fx.store));
    assert.ok(!(`${paths.dir}/current-memoro-cli.json` in fx.store));
    assert.match(out.lines[1], /and 2 current-\*\.json/u);
  });

  it('says a dead runner.json is a dead one, and clears it', async () => {
    const fx = fixture({ runner: { pid: 100 } });
    const out = await stopRunner({ root: ROOT, deps: fx.deps });
    assert.equal(out.ok, true);
    assert.match(out.lines[0], /pid 100, which is gone/u);
    assert.ok(!(paths.runner in fx.store));
  });

  it('with no runner at all still writes STOP, and says why', async () => {
    const fx = fixture();
    const out = await stopRunner({ root: ROOT, deps: fx.deps });
    assert.equal(out.ok, true);
    assert.equal(paths.stop in fx.store, true);
    assert.match(out.lines.join('\n'), /nothing here says a runner is running/u);
  });

  it('drops a pending UPDATE — a runner on its way out is not going round again', async () => {
    const fx = fixture({ runner: { pid: 100 }, live: [100], update: true });
    await stopRunner({ root: ROOT, deps: fx.deps });
    assert.ok(!(paths.update in fx.store));
  });
});

describe('endNow', () => {
  it('reports the signal that actually worked', async () => {
    const fx = fixture({ live: [100], pgid: 100 });
    const out = await endNow(100, fx.deps);
    assert.deepEqual({ ok: out.ok, signal: out.signal }, { ok: true, signal: 'SIGTERM' });
  });
});

describe('mc run --update', () => {
  it('writes UPDATE and names the pid that will act on it', () => {
    const fx = fixture({ runner: { pid: 100 }, live: [100] });
    const out = requestUpdate({ root: ROOT, deps: fx.deps });
    assert.equal(out.ok, true);
    assert.equal(fx.store[paths.update], '2026-08-30T18:00:00.000Z\n');
    assert.match(out.lines[0], /pid 100 finishes the round it is in, then restarts itself/u);
  });

  it('refuses with no runner up — a runner started now reads the new code anyway', () => {
    const fx = fixture();
    const out = requestUpdate({ root: ROOT, deps: fx.deps });
    assert.equal(out.ok, false);
    assert.equal(out.code, 2);
    assert.ok(!(paths.update in fx.store));
    assert.match(out.lines[1], /mc run start/u);
  });

  it('refuses when STOP is already written', () => {
    const fx = fixture({ runner: { pid: 100 }, live: [100], stop: true });
    const out = requestUpdate({ root: ROOT, deps: fx.deps });
    assert.equal(out.ok, false);
    assert.match(out.lines[0], /on its way out/u);
    assert.ok(!(paths.update in fx.store));
  });
});

describe('handOver', () => {
  /** The runner's own deps, as much of them as a handover touches. */
  function runnerFixture({ ff = true, heads = ['aaa111', 'bbb222'], respawn = 9001 } = {}) {
    const said = [];
    const git = [];
    let head = 0;
    const deps = {
      exists: () => true,
      remove: () => {},
      git: (cwd, args) => {
        git.push([cwd, args.join(' ')]);
        if (args[0] === 'rev-parse') return { ok: true, stdout: `${heads[Math.min(head++, heads.length - 1)]}\n` };
        if (args[0] === 'merge') return { ok: ff, stdout: '', stderr: '' };
        return { ok: true, stdout: '' };
      },
      respawn: () => respawn,
    };
    return { deps, said, git, say: (line) => said.push(line) };
  }

  it('fast-forwards the checkout, then hands over, and states both shas', async () => {
    const fx = runnerFixture();
    const out = await handOver({ paths, deps: fx.deps, say: fx.say, checkout: '/repo' });
    assert.equal(out.ok, true);
    assert.equal(out.pid, 9001);
    assert.deepEqual(fx.git.map(([, args]) => args), [
      'rev-parse --short HEAD', 'fetch -q origin', 'merge --ff-only -q origin/main', 'rev-parse --short HEAD',
    ]);
    assert.match(fx.said.join('\n'), /update: \/repo aaa111 -> bbb222/u);
    assert.match(fx.said.join('\n'), /handed over to pid 9001/u);
  });

  // The restart was asked for. A checkout that will not move is a reason to
  // say so, not a reason to swallow the order.
  it('hands over anyway when the checkout will not fast-forward', async () => {
    const fx = runnerFixture({ ff: false });
    const out = await handOver({ paths, deps: fx.deps, say: fx.say, checkout: '/repo' });
    assert.equal(out.ok, true);
    assert.match(fx.said[0], /would not fast-forward/u);
  });

  it('says so rather than repeating itself when the checkout was already current', async () => {
    const fx = runnerFixture({ heads: ['aaa111', 'aaa111'] });
    await handOver({ paths, deps: fx.deps, say: fx.say, checkout: '/repo' });
    assert.match(fx.said[0], /already at aaa111/u);
  });

  it('keeps this runner up when the new one does not start', async () => {
    const fx = runnerFixture({ respawn: null });
    const out = await handOver({ paths, deps: fx.deps, say: fx.say, checkout: '/repo' });
    assert.equal(out.ok, false);
    assert.match(fx.said.at(-1), /stays up and keeps going/u);
  });

  it('removes the UPDATE file first, so one order is one handover', async () => {
    const removed = [];
    const fx = runnerFixture();
    fx.deps.remove = (path) => removed.push(path);
    await handOver({ paths, deps: fx.deps, say: fx.say, checkout: '/repo' });
    assert.deepEqual(removed, [paths.update]);
  });
});
