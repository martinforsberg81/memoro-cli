/**
 * `mc suite run` — the step that cannot be skipped (D-0176).
 *
 * A track chained `mc suite claim; npm test` and never read the claim's
 * refusal: the mechanism existed (exit 1, stderr) and could not help,
 * because nothing looked. Twice more the same day an interrupt between
 * claim and release left the lease standing — one cost PM 2h25m (D-0167).
 * So the guarded form is one step, and what is asserted here is the whole
 * of its contract: refused runs nothing; the lease goes back on success,
 * on failure, and when the run dies; a right held by hand beforehand is
 * not taken away by it.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { parseArgs, run } from '../../src/mc/commands/suite.js';
import { claimSuiteLease, readSuiteLease } from '../../src/mc/suite-lease.js';

const AREA = { name: 'worker-one', kind: 'work-area' };

function home() {
  const root = mkdtempSync(join(tmpdir(), 'mc-suite-run-'));
  process.env.MC_HOME = root;
  return root;
}

function io() {
  const out = [];
  const err = [];
  return {
    out, err,
    stdout: { write: (line) => out.push(line), isTTY: false },
    stderr: { write: (line) => err.push(line) },
  };
}

/**
 * A dependency tree that is present, for the tests that are not about it.
 *
 * The lease tests once asked the real cwd — and the first treeless cwd they
 * met (the gate's own candidate worktree, 2026-08-24) turned all of them
 * red with exit 2. A test about the lease must not depend on where the
 * process happens to stand.
 */
const TREE_OK = () => ({ manifest: true, declares: 1, present: true, missing: false });

/** The command, faked: what matters is whether it ran and how it ended. */
function shell({ code = 0, signal = null } = {}) {
  const ran = [];
  return {
    ran,
    spawn: (command) => {
      ran.push(command);
      return { child: { pid: 4242 }, done: Promise.resolve({ code, signal }) };
    },
  };
}

const HOME = process.env.MC_HOME;
function restore() { if (HOME) process.env.MC_HOME = HOME; else delete process.env.MC_HOME; }

describe('mc suite run — claim, run, release as one step', () => {
  it('the words: run needs its command', () => {
    assert.equal(parseArgs(['run', 'npm', 'test']).errand, 'npm test');
    assert.match(String(parseArgs(['run']).error), /run needs the command/u);
  });

  it('runs the command with the right held, and gives it back when it passes', async () => {
    const root = home();
    try {
      const sh = shell({ code: 0 });
      const code = await run(['run', 'npm test'], { ...io(), spawn: sh.spawn, runs: async () => [], tree: TREE_OK });
      assert.equal(code, 0);
      assert.deepEqual(sh.ran, ['npm test']);
      assert.equal(readSuiteLease({ root }).held, false, 'the right went back');
    } finally { restore(); rmSync(root, { recursive: true, force: true }); }
  });

  it('a worktree without its dependency tree is refused before anything runs (D-0152)', async () => {
    const root = home();
    try {
      // The shrunk suite runs fewer files and reports fewer failures —
      // greener than the truth, the one direction nobody reviews. The
      // refusal is exit 2, never a test's exit, and says the suite never
      // ran on its first line so nobody can read it as a red run.
      const sh = shell();
      const streams = io();
      const code = await run(['run', 'npm test'], {
        ...streams, spawn: sh.spawn, runs: async () => [],
        cwd: '/work/msr-track-2/memoro',
        tree: (where) => ({ manifest: true, declares: 41, present: false, missing: true, where }),
        toplevel: () => '/work/msr-track-2/memoro',
        declaration: () => ({ ok: true, name: 'memoro', declaration: { prepare: 'npm ci' } }),
      });
      assert.equal(code, 2);
      assert.deepEqual(sh.ran, [], 'the command never started');
      assert.equal(readSuiteLease({ root }).held, false, 'no lease was taken for a run that never was');
      assert.ok(streams.err.some((line) => /REFUSED — the suite never ran: \/work\/msr-track-2\/memoro declares 41 dependencies and has no node_modules/u.test(line)), streams.err.join(''));
      assert.ok(streams.err.some((line) => /greener than the truth \(D-0152\)/u.test(line)));
      assert.ok(streams.err.some((line) => /npm ci, or link node_modules from a sibling worktree with the same lockfile/u.test(line)));
    } finally { restore(); rmSync(root, { recursive: true, force: true }); }
  });

  it('a repository whose declaration vouches a treeless suite runs, and says so (the gate\'s own exception)', async () => {
    const root = home();
    try {
      // memoro-cli itself: prepare: null, verified on every gate round.
      // The exception follows from what the repository IS — its declared,
      // evidenced truth — never from a flag.
      const sh = shell({ code: 0 });
      const streams = io();
      const code = await run(['run', 'npm test'], {
        ...streams, spawn: sh.spawn, runs: async () => [],
        cwd: '/work/x/memoro-cli',
        tree: () => ({ manifest: true, declares: 12, present: false, missing: true }),
        toplevel: () => '/work/x/memoro-cli',
        declaration: () => ({ ok: true, name: 'memoro-cli', declaration: { prepare: null } }),
      });
      assert.equal(code, 0);
      assert.deepEqual(sh.ran, ['npm test'], 'the vouched suite ran');
      assert.ok(streams.out.some((line) => /no node_modules here, and memoro-cli's declaration vouches its suite runs without one — running/u.test(line)), streams.out.join(''));
    } finally { restore(); rmSync(root, { recursive: true, force: true }); }
  });

  it('an undeclared repository with a missing tree is still refused', async () => {
    const root = home();
    try {
      const sh = shell();
      const streams = io();
      const code = await run(['run', 'npm test'], {
        ...streams, spawn: sh.spawn, runs: async () => [],
        cwd: '/work/somewhere/stranger',
        tree: () => ({ manifest: true, declares: 3, present: false, missing: true }),
        toplevel: () => null,
        declaration: () => ({ ok: false, name: 'stranger', reason: 'not declared' }),
      });
      assert.equal(code, 2);
      assert.deepEqual(sh.ran, []);
    } finally { restore(); rmSync(root, { recursive: true, force: true }); }
  });

  it('a directory that is not a Node project, or declares nothing, runs as always', async () => {
    const root = home();
    try {
      const sh = shell({ code: 0 });
      const code = await run(['run', 'make check'], {
        ...io(), spawn: sh.spawn, runs: async () => [],
        cwd: '/work/elsewhere',
        tree: () => ({ manifest: false, declares: 0, present: false, missing: false }),
      });
      assert.equal(code, 0);
      assert.deepEqual(sh.ran, ['make check']);
    } finally { restore(); rmSync(root, { recursive: true, force: true }); }
  });

  it('refused means NOTHING runs, and the exit is the refusal', async () => {
    const root = home();
    try {
      claimSuiteLease({ errand: 'gate round', holder: { name: 'pm', kind: 'work-area' }, root });
      const sh = shell();
      const told = [];
      const streams = io();
      const code = await run(['run', 'npm test'], {
        ...streams, spawn: sh.spawn, runs: async () => [], tree: TREE_OK,
        tell: (message) => { told.push(message); return { told: true, woke: true }; },
      });
      assert.equal(code, 1);
      assert.deepEqual(sh.ran, [], 'the command never started');
      assert.ok(streams.err.some((line) => /NOTHING was run/u.test(line)), streams.err.join(''));
      assert.equal(told.length, 1, 'the holder was told, as a refused claim tells them');
      assert.equal(readSuiteLease({ root }).holder, 'pm', 'their lease untouched');
    } finally { restore(); rmSync(root, { recursive: true, force: true }); }
  });

  it('a failing command still gives the right back, and the exit is the command\'s', async () => {
    const root = home();
    try {
      const streams = io();
      const code = await run(['run', 'npm test'], { ...streams, spawn: shell({ code: 3 }).spawn, runs: async () => [], tree: TREE_OK });
      assert.equal(code, 3);
      assert.equal(readSuiteLease({ root }).held, false, 'the lease did not outlive the failure');
      assert.ok(streams.err.some((line) => /exited 3 — the suite right is released, not left standing/u.test(line)));
    } finally { restore(); rmSync(root, { recursive: true, force: true }); }
  });

  it('a command killed by a signal gives the right back too', async () => {
    const root = home();
    try {
      const code = await run(['run', 'npm test'], { ...io(), spawn: shell({ code: null, signal: 'SIGTERM' }).spawn, runs: async () => [], tree: TREE_OK });
      assert.equal(code, 143);
      assert.equal(readSuiteLease({ root }).held, false);
    } finally { restore(); rmSync(root, { recursive: true, force: true }); }
  });

  it('a right claimed by hand beforehand stays held afterwards', async () => {
    const root = home();
    try {
      // The same holder claimed by hand — mc suite run must give back only
      // what it took (the gate round's own rule for the suite right).
      claimSuiteLease({ errand: 'gate round', holder: AREA, root });
      const streams = io();
      const code = await run(['run', 'npm test'], { ...streams, spawn: shell().spawn, runs: async () => [], holder: AREA, tree: TREE_OK });
      assert.equal(code, 0);
      const after = readSuiteLease({ root });
      assert.equal(after.held, true, 'their hand-claim survived the run');
      assert.equal(after.holder, AREA.name);
      assert.ok(streams.out.some((line) => /you claimed the right by hand, so you still hold it/u.test(line)));
    } finally { restore(); rmSync(root, { recursive: true, force: true }); }
  });
});
