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
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { parseRunArgs, usage } from '../../src/mc/commands/run.js';
import {
  agentPlist, childEnv, controlPaths, drainLine, drainState, endNow, handOver, readRunner, requestUpdate, startRunner, stopRunner,
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
    spawn: ({ bin, args, stdio, env }) => { calls.spawned.push({ bin, args, stdio, ...(env ? { env } : {}) }); return 4242; },
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

  // After `mc run --update` two runners overlap: the successor's runner.json
  // names the one it replaced, which is finishing the steps it held.
  it('returns the predecessor a successor names, and whether it is still alive', () => {
    const fx = fixture({ runner: { pid: 200, started: 'T2', predecessor: { pid: 100, started: 'T1' } }, live: [100, 200] });
    assert.deepEqual(readRunner({ paths, read: fx.deps.read, alive: fx.deps.alive }), {
      pid: 200, started: 'T2', alive: true, predecessor: { pid: 100, started: 'T1', alive: true },
    });
    fx.alive.delete(100);
    assert.equal(readRunner({ paths, read: fx.deps.read, alive: fx.deps.alive }).predecessor.alive, false);
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

  it('refuses while either runner of a handover is alive', async () => {
    const both = fixture({ runner: { pid: 200, predecessor: { pid: 100 } }, live: [100, 200] });
    const out = await startRunner({ root: ROOT, deps: both.deps });
    assert.equal(out.code, 2);
    assert.match(out.lines[0], /already running — pid 200/u);

  });

  // The successor died; the runner it replaced is still finishing. Nothing
  // runs the other lanes — a start is a new successor beside it.
  it('takes over beside a runner still finishing what a handover left it', async () => {
    const old = fixture({ runner: { pid: 200, predecessor: { pid: 100, started: 'T1' } }, live: [100] });
    const out = await startRunner({ root: ROOT, deps: old.deps });
    assert.equal(out.ok, true);
    assert.equal(old.calls.spawned.length, 1);
    assert.deepEqual(old.calls.spawned[0].env, { MC_RUN_SUCCESSOR_OF: '100' });
    assert.deepEqual(JSON.parse(old.store[paths.runner]).predecessor, { pid: 100, started: 'T1' });
    assert.match(out.lines[0], /pid 100 is finishing/u);
  });

  // start and stop are one switch: a switch that will not turn back on
  // because of the file the last stop wrote is not a switch.
  // runner.json is the child's before this command returns: a second start
  // in the second the child takes to load sees a runner, not a gap.
  it('writes runner.json for the child the moment its pid is known', async () => {
    const fx = fixture();
    await startRunner({ argv: ['--no-merge'], root: ROOT, deps: fx.deps });
    const written = JSON.parse(fx.store[paths.runner]);
    assert.equal(written.pid, 4242);
    assert.deepEqual(written.args, ['--no-merge']);
    fx.alive.add(4242);
    const again = await startRunner({ root: ROOT, deps: fx.deps });
    assert.equal(again.ok, false);
    assert.equal(fx.calls.spawned.length, 1);
  });

  // `mc run stop` then `mc run start`: the stopping runner is taken over —
  // runner.json names the new one before STOP is removed, so the old one is
  // never without an order — and it finishes only what it holds.
  it('takes over from a runner that is stopping', async () => {
    const fx = fixture({
      runner: { pid: 100, started: 'T1', takeover: true }, live: [100], stop: true,
      files: { [`${paths.dir}/current-memoro-5.json`]: JSON.stringify({ name: 'video-window', pid: 100 }) },
    });
    const order = [];
    const write = fx.deps.write;
    const remove = fx.deps.remove;
    fx.deps.write = (path, text) => { order.push(`write ${path}`); write(path, text); };
    fx.deps.remove = (path) => { order.push(`remove ${path}`); remove(path); };
    const out = await startRunner({ root: ROOT, deps: fx.deps });
    assert.equal(out.ok, true);
    assert.deepEqual(fx.calls.spawned[0].env, { MC_RUN_SUCCESSOR_OF: '100' });
    const written = JSON.parse(fx.store[paths.runner]);
    assert.equal(written.pid, 4242);
    assert.deepEqual(written.predecessor, { pid: 100, started: 'T1' });
    assert.ok(!(paths.stop in fx.store));
    assert.ok(order.indexOf(`write ${paths.runner}`) < order.indexOf(`remove ${paths.stop}`), 'STOP went before the successor was named');
    assert.match(out.lines[0], /pid 100 was stopping — a new runner takes over every lane now, and pid 100 only finishes 1 step in flight \(video-window\)/u);
  });

  it('waits for a stopping runner that predates take-over rather than run beside it', async () => {
    const fx = fixture({ runner: { pid: 100 }, live: [100], stop: true });
    const out = await startRunner({ root: ROOT, deps: fx.deps });
    assert.equal(out.ok, false);
    assert.deepEqual(fx.calls.spawned, []);
    assert.ok(paths.stop in fx.store);
    assert.match(out.lines.join('\n'), /older than take-over/u);
  });

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

describe('mc run start --if-was-running', () => {
  const FLAG = ['--if-was-running'];

  it('starts a runner when runner.json names a dead pid and no STOP is written, with its flags', async () => {
    const fx = fixture({ runner: { pid: 100, args: ['--no-merge'] } });
    const out = await startRunner({ argv: FLAG, root: ROOT, deps: fx.deps });
    assert.equal(out.ok, true);
    assert.equal(out.code, 0);
    assert.deepEqual(fx.calls.spawned[0].args, ['/opt/bin/mc', 'run', '--no-merge']);
    assert.deepEqual(JSON.parse(fx.store[paths.runner]).args, ['--no-merge']);
  });

  it('starts nothing after mc run stop, and says so', async () => {
    const fx = fixture({ runner: { pid: 100 }, stop: true });
    const out = await startRunner({ argv: FLAG, root: ROOT, deps: fx.deps });
    assert.deepEqual([out.ok, out.code, out.lines], [true, 0, ['not started — the runner was stopped (STOP present)']]);
    assert.deepEqual(fx.calls.spawned, []);
    assert.ok(paths.stop in fx.store, 'STOP was removed');
  });

  it('starts nothing with no runner.json, and says so', async () => {
    const fx = fixture();
    const out = await startRunner({ argv: FLAG, root: ROOT, deps: fx.deps });
    assert.deepEqual([out.ok, out.code, out.lines], [true, 0, ['not started — no runner was running']]);
    assert.deepEqual(fx.calls.spawned, []);
  });

  it('starts nothing beside a live runner, and exits 0', async () => {
    const fx = fixture({ runner: { pid: 100, started: '2026-08-30T16:22:11Z' }, live: [100] });
    const out = await startRunner({ argv: FLAG, root: ROOT, deps: fx.deps });
    assert.equal(out.ok, true);
    assert.equal(out.code, 0);
    assert.match(out.lines[0], /already running — pid 100/u);
    assert.deepEqual(fx.calls.spawned, []);
  });

  it('is parsed as start\'s own flag and never reaches the loop', () => {
    const opts = parseRunArgs(['start', '--if-was-running']);
    assert.equal(opts.error, undefined);
    assert.deepEqual(opts.pass, ['--if-was-running']);
    assert.match(usage(), /--if-was-running/u);
  });
});

describe('the login agent', () => {
  const env = { MC_WORK_ROOT: ROOT, HOME: '/Users/m', PATH: '/opt/homebrew/bin:/Users/m/.local/bin:/usr/bin' };
  const AGENT = '/Users/m/Library/LaunchAgents/se.memoro.mc-runner.plist';

  function withAgent(fx) {
    const agents = {};
    const writes = [];
    fx.deps.env = env;
    fx.deps.writeAgent = (path, text) => {
      if (agents[path] === text) return false;
      agents[path] = text;
      writes.push(path);
      return true;
    };
    return { agents, writes };
  }

  it('is written by a start that spawns, and not again when unchanged', async () => {
    const fx = fixture();
    const { agents, writes } = withAgent(fx);
    const first = await startRunner({ root: ROOT, deps: fx.deps });
    assert.deepEqual(writes, [AGENT]);
    assert.ok(first.lines.includes(`login agent: ${AGENT}`));
    assert.equal(agents[AGENT], agentPlist({ execPath: '/usr/bin/node', entry: '/opt/bin/mc', env, log: paths.agentLog }));
    delete fx.store[paths.runner];
    const second = await startRunner({ root: ROOT, deps: fx.deps });
    assert.equal(fx.calls.spawned.length, 2);
    assert.deepEqual(writes, [AGENT]);
    assert.ok(!second.lines.some((line) => /login agent/u.test(line)));
  });

  it('is not written by a start that is refused', async () => {
    const fx = fixture({ runner: { pid: 100 }, live: [100] });
    const { writes } = withAgent(fx);
    await startRunner({ root: ROOT, deps: fx.deps });
    await startRunner({ argv: ['--if-was-running'], root: ROOT, deps: fx.deps });
    assert.deepEqual(writes, []);
  });

  it('runs start --if-was-running at load, once, with the PATH and HOME it was written with', () => {
    assert.equal(agentPlist({ execPath: '/usr/bin/node', entry: '/opt/bin/mc', env, log: '/Users/m/mc/runner/log/login-agent.log' }), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key>',
      '  <string>se.memoro.mc-runner</string>',
      '  <key>ProgramArguments</key>',
      '  <array>',
      '    <string>/usr/bin/node</string>',
      '    <string>/opt/bin/mc</string>',
      '    <string>run</string>',
      '    <string>start</string>',
      '    <string>--if-was-running</string>',
      '  </array>',
      '  <key>RunAtLoad</key>',
      '  <true/>',
      '  <key>EnvironmentVariables</key>',
      '  <dict>',
      '    <key>PATH</key>',
      '    <string>/opt/homebrew/bin:/Users/m/.local/bin:/usr/bin</string>',
      '    <key>HOME</key>',
      '    <string>/Users/m</string>',
      '  </dict>',
      '  <key>StandardOutPath</key>',
      '  <string>/Users/m/mc/runner/log/login-agent.log</string>',
      '  <key>StandardErrorPath</key>',
      '  <string>/Users/m/mc/runner/log/login-agent.log</string>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n'));
    assert.doesNotMatch(agentPlist({ execPath: 'n', entry: 'e', env, log: 'l' }), /KeepAlive/u);
  });

  const plutil = spawnSync('plutil', ['-help'], { encoding: 'utf8' }).error ? null : 'plutil';
  it('passes plutil -lint', { skip: plutil ? false : 'no plutil on this machine' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-agent-'));
    try {
      const file = join(dir, 'agent.plist');
      writeFileSync(file, agentPlist({ execPath: '/usr/bin/node', entry: '/opt/bin/a&b <mc>', env, log: paths.agentLog }));
      const lint = spawnSync(plutil, ['-lint', file], { encoding: 'utf8' });
      assert.equal(lint.status, 0, lint.stdout + lint.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mc run stop', () => {
  it('writes STOP and leaves the round in flight alone', async () => {
    const fx = fixture({ runner: { pid: 100 }, live: [100] });
    const out = await stopRunner({ root: ROOT, deps: fx.deps });
    assert.equal(out.ok, true);
    assert.equal(fx.store[paths.stop], '2026-08-30T18:00:00.000Z\n');
    assert.deepEqual(fx.calls.killed, []);
    assert.match(out.lines[0], /finishes the ones in flight, then exits/u);
    assert.match(out.lines.join('\n'), /mc run start takes over/u);
  });

  // The stop line's clock is the first stop's: a second one says it was
  // already written rather than restarting it.
  it('a second stop keeps the first one\'s time, and says how the stop stands', async () => {
    const fx = fixture({
      runner: { pid: 100 }, live: [100],
      files: {
        [paths.stop]: '2026-08-30T17:20:00.000Z\n',
        [`${paths.dir}/current-memoro-5.json`]: JSON.stringify({ name: 'video-window', step: 1, pid: 100, started: '2026-08-30T16:40:00Z' }),
      },
    });
    fx.deps.laneCount = () => 12;
    const out = await stopRunner({ root: ROOT, deps: fx.deps });
    assert.equal(fx.store[paths.stop], '2026-08-30T17:20:00.000Z\n');
    assert.match(out.lines[0], /^STOP was already written/u);
    assert.match(out.lines[1], /^stopping since \d\d:\d\d \(40 min\) — waiting on video-window step 1 \(memoro#6, 80 min\); 11 lanes done$/u);
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

  it('--force ends both runners of a handover', async () => {
    const fx = fixture({
      runner: { pid: 200, predecessor: { pid: 100 } }, live: [100, 200],
      files: { [`${paths.dir}/current-memoro.json`]: '{"pid":100}' },
    });
    const out = await stopRunner({ force: true, root: ROOT, deps: fx.deps });
    assert.equal(out.ok, true);
    assert.deepEqual(fx.calls.killed.map(([pid]) => pid).sort(), [100, 200]);
    assert.equal(fx.alive.size, 0, 'a runner outlived --force');
    assert.match(out.lines.join('\n'), /pid 200 is gone[\s\S]*pid 100 is gone/u);
    assert.ok(!(paths.runner in fx.store));
    assert.ok(!(`${paths.dir}/current-memoro.json` in fx.store));
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
    assert.match(out.lines[0], /pid 100 hands over to a new runner at its next look, and only finishes the steps in flight/u);
  });

  // Two steps in flight, the way `runStep` writes them: a repository's first
  // lane is `current-<repo>.json`, lane n+1 is `current-<repo>-<n>.json`.
  const CURRENTS = {
    [`${paths.dir}/current-memoro-4.json`]: JSON.stringify({ name: 'gmail-ready', step: 1, repo: 'memoro', lane: 4, started: '2026-08-30T17:46:00Z' }),
    [`${paths.dir}/current-memoro-1.json`]: JSON.stringify({ name: 'claims-entity', step: 2, repo: 'memoro', lane: 1, started: '2026-08-30T17:30:00Z' }),
  };
  /** The mc checkout, with `origin/main` at `main` and a fetch that `fetches`. */
  function withGit(fx, { main = 'abc1234', fetches = true } = {}) {
    const asked = [];
    fx.deps.git = (cwd, args) => {
      asked.push(`${cwd} ${args.join(' ')}`);
      if (args[0] === 'fetch') return { ok: fetches, stdout: '' };
      return { ok: true, stdout: `${main}\n` };
    };
    fx.deps.laneCount = () => 8;
    return asked;
  }

  it('on a runner already on origin/main writes nothing, after a fetch', () => {
    const fx = fixture({ runner: { pid: 100, commit: 'abc1234' }, live: [100] });
    const asked = withGit(fx, { main: 'abc12345' });
    const out = requestUpdate({ root: ROOT, checkout: '/code/mc', deps: fx.deps });
    assert.equal(out.ok, true);
    assert.ok(!(paths.update in fx.store));
    assert.deepEqual(asked, ['/code/mc fetch -q origin', '/code/mc rev-parse --short origin/main']);
    assert.equal(out.lines[0], 'runner pid 100 is already on abc1234 — nothing to update');
    assert.match(out.lines[1], /--force/u);
  });

  it('--force writes UPDATE on a current runner anyway', () => {
    const fx = fixture({ runner: { pid: 100, commit: 'abc1234' }, live: [100] });
    withGit(fx);
    const out = requestUpdate({ root: ROOT, force: true, checkout: '/code/mc', deps: fx.deps });
    assert.equal(fx.store[paths.update], '2026-08-30T18:00:00.000Z\n');
    assert.match(out.lines[0], /^UPDATE written/u);
  });

  it('writes UPDATE when origin/main has moved, and prints the drain it starts', () => {
    const fx = fixture({ runner: { pid: 100, commit: 'abc1234' }, live: [100], files: CURRENTS });
    withGit(fx, { main: 'def5678' });
    const out = requestUpdate({ root: ROOT, checkout: '/code/mc', deps: fx.deps });
    assert.equal(fx.store[paths.update], '2026-08-30T18:00:00.000Z\n');
    assert.match(out.lines[0], /pid 100 hands over/u);
    assert.match(out.lines[1], /fast-forwards \/code\/mc/u);
    assert.match(out.lines.at(-1), /^draining since \d\d:\d\d \(0s\) — waiting on claims-entity step 2 \(memoro#2, 30 min\), gmail-ready step 1 \(memoro#5, 14 min\); 6 lanes done$/u);
  });

  it('writes UPDATE when the fetch fails, and says it could not tell', () => {
    const fx = fixture({ runner: { pid: 100, commit: 'abc1234' }, live: [100] });
    withGit(fx, { fetches: false });
    const out = requestUpdate({ root: ROOT, checkout: '/code/mc', deps: fx.deps });
    assert.equal(paths.update in fx.store, true);
    assert.match(out.lines.join('\n'), /could not fetch origin/u);
  });

  it('on a runner already draining prints the drain and writes nothing', () => {
    const fx = fixture({
      runner: { pid: 100, commit: 'abc1234' }, live: [100],
      files: { ...CURRENTS, [paths.update]: '2026-08-30T17:46:00.000Z\n' },
    });
    const asked = withGit(fx, { main: 'def5678' });
    const out = requestUpdate({ root: ROOT, checkout: '/code/mc', deps: fx.deps });
    assert.equal(out.ok, true);
    assert.equal(fx.store[paths.update], '2026-08-30T17:46:00.000Z\n', 'the drain keeps its clock');
    assert.deepEqual(asked, [], 'nothing to fetch for an order already given');
    assert.equal(out.lines[0], 'UPDATE is already written — pid 100 is draining');
    assert.match(out.lines[1], /^draining since \d\d:\d\d \(14 min\) — waiting on claims-entity step 2 \(memoro#2, 30 min\), gmail-ready step 1 \(memoro#5, 14 min\); 6 lanes done$/u);
  });

  it('mc run start refuses a draining runner with the same drain line', async () => {
    const fx = fixture({
      runner: { pid: 100 }, live: [100],
      files: { ...CURRENTS, [paths.update]: '2026-08-30T17:46:00.000Z\n' },
    });
    fx.deps.laneCount = () => 8;
    const out = await startRunner({ root: ROOT, deps: fx.deps });
    assert.equal(out.ok, false);
    assert.equal(out.lines[1], requestUpdate({ root: ROOT, deps: fx.deps }).lines[1]);
    assert.match(out.lines[1], /^draining since/u);
  });

  it('drainLine: nothing in flight, a first lane, and no UPDATE at all', () => {
    const fx = fixture({ files: { [paths.update]: '2026-08-30T17:50:00Z\n', [`${paths.dir}/current-memoro-cli.json`]: JSON.stringify({ name: 'mc-ui', started: '2026-08-30T17:58:00Z' }) } });
    const state = drainState({ paths, read: fx.deps.read, list: fx.deps.list, now: fx.deps.now(), lanes: 2 });
    assert.equal(state.requested, '2026-08-30T17:50:00.000Z');
    assert.deepEqual(state.inFlight, [{ name: 'mc-ui', step: null, lane: 'memoro-cli#1', started: '2026-08-30T17:58:00.000Z', elapsed_seconds: 120 }]);
    assert.match(drainLine(state), /— waiting on mc-ui \(memoro-cli#1, 2 min\); 1 lane done$/u);
    assert.match(drainLine({ ...state, inFlight: [] }), /— nothing in flight, the handover comes at the next pick; 2 lanes done$/u);
    assert.equal(drainLine({ ...state, draining: false }), null);
  });

  it('refuses with no runner up — a runner started now reads the new code anyway', () => {
    const fx = fixture();
    const out = requestUpdate({ root: ROOT, deps: fx.deps });
    assert.equal(out.ok, false);
    assert.equal(out.code, 2);
    assert.ok(!(paths.update in fx.store));
    assert.match(out.lines[1], /mc run start/u);
  });

  // A stopping runner will never pick again, so it is not told to update:
  // the checkout is fast-forwarded and a new runner takes over from it, with
  // the flags the old one ran with.
  it('on a stopping runner fast-forwards and takes over, with its flags', () => {
    const fx = fixture({ runner: { pid: 100, takeover: true, args: ['--no-merge'] }, live: [100], stop: true });
    const asked = withGit(fx);
    const out = requestUpdate({ root: ROOT, checkout: '/code/mc', deps: fx.deps });
    assert.equal(out.ok, true);
    assert.ok(!(paths.update in fx.store));
    assert.ok(!(paths.stop in fx.store), 'STOP is still there for the new runner to read');
    assert.ok(asked.includes('/code/mc merge --ff-only -q origin/main'));
    assert.deepEqual(fx.calls.spawned[0].args, ['/opt/bin/mc', 'run', '--no-merge']);
    assert.match(out.lines.join('\n'), /pid 100 was stopping — a new runner takes over/u);
  });

  it('on a stopping runner older than take-over refuses, and writes nothing', () => {
    const fx = fixture({ runner: { pid: 100 }, live: [100], stop: true });
    withGit(fx);
    const out = requestUpdate({ root: ROOT, checkout: '/code/mc', deps: fx.deps });
    assert.equal(out.ok, false);
    assert.match(out.lines[0], /older than take-over/u);
    assert.deepEqual(fx.calls.spawned, []);
    assert.ok(paths.stop in fx.store);
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

describe('mc run stop on a runner seconds old', () => {
  it('says the STOP lands on the successor, not the runner it replaced', async () => {
    const fx = fixture({ runner: { pid: 100, started: '2026-08-30T17:59:57.000Z' }, live: [100] });
    const out = await stopRunner({ root: ROOT, deps: fx.deps });
    assert.equal(out.ok, true);
    assert.ok(out.lines.some((line) => /started 3s ago — if you meant the runner it replaced/u.test(line)), out.lines.join('\n'));
  });
  it('says nothing of the kind about a runner that has been up', async () => {
    const fx = fixture({ runner: { pid: 100, started: '2026-08-30T16:00:00.000Z' }, live: [100] });
    const out = await stopRunner({ root: ROOT, deps: fx.deps });
    assert.ok(!out.lines.some((line) => /if you meant the runner it replaced/u.test(line)));
  });
});
