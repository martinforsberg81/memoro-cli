/**
 * `mc gate` — the verb: a detached gate, a budget, one gate per worktree.
 *
 * Everything the verb touches is injected: the spawn, the clock, the sleep,
 * the files and the pid liveness. Nothing here starts a process or reads disk.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { run } from '../../src/mc/commands/gate.js';

const CHILD = 4242;
const LOG = '/scratch/gate-20260925T100000Z.log';
const EXIT = `${LOG}.exit`;
const LOCK = '/w/x/.git/mc-gate.json';
const OLD_LOG = '/scratch/gate-20260925T095000Z.log';

/**
 * A fake machine. The gate finishes after `finishAfter` sleeps: it writes its
 * log and exit code then, and is no longer alive.
 */
function harness({ lock = null, manifest = { scripts: { test: 'node --test' } }, live = [], finishAfter = Infinity, code = 0, output = '' } = {}) {
  const files = new Map();
  const alive = new Set(live);
  const out = { stdout: '', stderr: '', spawned: [], dirs: [], removed: [], ticks: 0, unref: false };
  let clock = Date.parse('2026-09-25T10:00:00Z');
  if (lock) files.set(LOCK, JSON.stringify(lock));
  const deps = {
    stdout: { write: (s) => { out.stdout += s; } },
    stderr: { write: (s) => { out.stderr += s; } },
    cwd: '/w/x',
    env: { MC_SCRATCH: '/scratch' },
    now: () => new Date(clock),
    git: (cwd, args) => ({ '--show-toplevel': '/w/x', '--absolute-git-dir': '/w/x/.git' })[args[1]] ?? null,
    read: (path) => {
      if (path === '/w/x/package.json' && manifest) return JSON.stringify(manifest);
      if (files.has(path)) return files.get(path);
      throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
    },
    exists: (path) => files.has(path),
    write: (path, text) => { files.set(path, text); },
    remove: (path) => { out.removed.push(path); files.delete(path); },
    mkdir: (dir) => { out.dirs.push(dir); },
    open: () => 9,
    close: () => {},
    spawn: (file, args, opts) => {
      out.spawned.push({ file, args, opts });
      alive.add(CHILD);
      return { pid: CHILD, unref: () => { out.unref = true; } };
    },
    alive: (pid) => alive.has(pid),
    sleep: async (ms) => {
      clock += ms;
      out.ticks += 1;
      if (out.ticks >= finishAfter) {
        files.set(LOG, output);
        files.set(EXIT, `${code}\n`);
        alive.clear();
      }
    },
  };
  return { out, deps, files };
}

const oldGate = (pid, extra = {}) => ({ pid, log: OLD_LOG, started: '2026-09-25T09:50:00.000Z', command: { run: 'npm test', script: 'node --test', base: 'origin/main' }, ...extra });

describe('mc gate, started', () => {
  it('a gate that finishes inside the budget prints its verdict and clears the lock', async () => {
    const { out, deps, files } = harness({ finishAfter: 3, output: '✔ a (1ms)\nℹ tests 1\nℹ pass 1\nℹ fail 0\n' });
    assert.equal(await run([], deps), 0);
    assert.equal(out.spawned[0].file, 'sh');
    assert.deepEqual(out.spawned[0].args, ['-c', `npm test; echo $? > '${EXIT}'`]);
    assert.deepEqual([out.spawned[0].opts.cwd, out.spawned[0].opts.detached, out.spawned[0].opts.stdio], ['/w/x', true, ['ignore', 9, 9]]);
    assert.deepEqual([out.spawned[0].opts.env.CI, out.spawned[0].opts.env.FORCE_COLOR, out.spawned[0].opts.env.NO_COLOR], ['1', '0', '1']);
    assert.equal(out.unref, true);
    assert.deepEqual(out.dirs, ['/scratch']);
    assert.equal(files.get(`${LOG}.pid`), `${CHILD}\n`);
    assert.equal(out.stdout, `GREEN — npm test — 1 tests, 0 failed — 6s\nwhole output: ${LOG}\n`);
    assert.equal(files.has(LOCK), false);
    assert.deepEqual(out.removed, [LOCK]);
  });

  it('past the budget it prints RUNNING with the log and exits 3, and the lock stays', async () => {
    const { out, deps, files } = harness();
    assert.equal(await run(['--budget', '10'], deps), 3);
    assert.equal(out.stdout, `RUNNING — npm test — 10s so far, still running (pid ${CHILD})\nlog: ${LOG} — mc gate --wait waits for it and prints the verdict\n`);
    assert.equal(files.has(LOCK), true);
    assert.deepEqual(out.removed, []);
  });

  it('a second gate while one is alive refuses with exit 2', async () => {
    const { out, deps } = harness({ lock: oldGate(111), live: [111] });
    assert.equal(await run([], deps), 2);
    assert.equal(out.stderr, 'mc: a gate is already running here (pid 111, since 2026-09-25T09:50:00.000Z) — mc gate --wait\n');
    assert.deepEqual(out.spawned, []);
  });

  it('a stale lock is taken over: a dead pid, or a gate whose exit file exists', async () => {
    const dead = harness({ lock: oldGate(111), live: [], finishAfter: 1, output: 'ℹ tests 2\nℹ pass 2\nℹ fail 0\n' });
    assert.equal(await run([], dead.deps), 0);
    assert.equal(dead.out.spawned.length, 1);
    assert.match(dead.out.stdout, /^GREEN — npm test — 2 tests, 0 failed — 2s\n/u);

    const exited = harness({ lock: oldGate(111), live: [111], finishAfter: 1, output: 'ℹ tests 1\nℹ fail 0\n' });
    exited.files.set(`${OLD_LOG}.exit`, '0\n');
    assert.equal(await run([], exited.deps), 0);
    assert.equal(exited.out.spawned.length, 1);
  });

  it('red is exit 1 with the failing lines; --base reaches the ci script; --json is the object', async () => {
    const ci = harness({ manifest: { scripts: { ci: 'node ci.mjs' } }, finishAfter: 1, code: 1, output: '✖ a (1ms)\nℹ tests 1\nℹ fail 1\n' });
    assert.equal(await run(['--base', 'origin/dev'], ci.deps), 1);
    assert.equal(ci.out.spawned[0].args[1], `npm run ci -- --base-ref origin/dev; echo $? > '${EXIT}'`);
    assert.match(ci.out.stdout, /^RED — npm run ci -- --base-ref origin\/dev — 1 tests, 1 failed — 2s\n✖ a\nwhole output: /u);

    const json = harness({ finishAfter: 1, code: 1, output: '✖ a\n' });
    assert.equal(await run(['--json'], json.deps), 1);
    const parsed = JSON.parse(json.out.stdout);
    assert.deepEqual([parsed.ok, parsed.failures, parsed.command, parsed.script, parsed.exit, parsed.seconds], [false, ['✖ a'], 'npm test', 'node --test', 1, 2]);
  });

  it('is 2 outside a worktree, with nothing to run, on a positional, and on a budget that is not seconds', async () => {
    const none = harness({ manifest: { scripts: {} } });
    assert.equal(await run([], none.deps), 2);
    assert.match(none.out.stderr, /no ci or test script/u);
    const outside = harness();
    outside.deps.git = () => null;
    assert.equal(await run([], outside.deps), 2);
    const pos = harness();
    assert.equal(await run(['memoro'], pos.deps), 2);
    const budget = harness();
    assert.equal(await run(['--budget', '0'], budget.deps), 2);
    assert.match(budget.out.stderr, /--budget takes seconds/u);
    assert.deepEqual(budget.out.spawned, []);
  });
});

describe('mc gate --wait', () => {
  it('prints the verdict of the running gate once it ends, and clears its lock', async () => {
    const { out, deps, files } = harness({ lock: { ...oldGate(111), log: LOG, started: '2026-09-25T09:58:00.000Z' }, live: [111], finishAfter: 2, code: 1, output: '✖ a (1ms)\nℹ tests 1\nℹ fail 1\n' });
    assert.equal(await run(['--wait'], deps), 1);
    assert.equal(out.stdout, `RED — npm test — 1 tests, 1 failed — 124s\n✖ a\nwhole output: ${LOG}\n`);
    assert.equal(out.spawned.length, 0);
    assert.equal(files.has(LOCK), false);
  });

  it('with no gate running here it says so and exits 2', async () => {
    const { out, deps } = harness();
    assert.equal(await run(['--wait'], deps), 2);
    assert.equal(out.stderr, 'mc: no gate running here — mc gate starts one\n');
  });

  it('a gate whose process is gone without an exit code is red, and its lock goes', async () => {
    const { out, deps, files } = harness({ lock: { ...oldGate(111), log: LOG }, live: [] });
    assert.equal(await run(['--wait'], deps), 1);
    assert.equal(out.stdout, `RED — the gate's process ended without an exit code — log: ${LOG}\n`);
    assert.equal(files.has(LOCK), false);
  });

  it('past the budget it prints RUNNING again and exits 3, the lock stays', async () => {
    const { out, deps, files } = harness({ lock: { ...oldGate(111), log: LOG }, live: [111] });
    assert.equal(await run(['--wait', '--budget', '4'], deps), 3);
    assert.equal(out.stdout, `RUNNING — npm test — 604s so far, still running (pid 111)\nlog: ${LOG} — mc gate --wait waits for it and prints the verdict\n`);
    assert.equal(files.has(LOCK), true);
  });
});
