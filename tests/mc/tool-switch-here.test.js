/**
 * `mc tool-switch <tool> --here` — mid-session switch (Grounding Phase 3 / §5).
 *
 * The `--here` mode re-grounds the CURRENT worktree into the target tool's
 * native instruction file, persists the per-session tool, and prints the
 * relaunch command — it never spawns (the old tool still owns the TTY).
 * Distinct from the default form, which only flips the default for future
 * `mc new`. Unification decision: ONE verb, two modes, not a new `mc
 * switch` synonym.
 *
 * Pure helpers (findEntryByCwd, relaunchCommand) + the in-process
 * runSwitchHere with stubbed deps. Both --json and human paths covered.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseArgs,
  findEntryByCwd,
  relaunchCommand,
  runSwitchHere,
} from '../../src/mc/commands/tool-switch.js';

// ─────────────────────────────────────────────────────────────
// parseArgs — --here
// ─────────────────────────────────────────────────────────────

describe('parseArgs — --here', () => {
  it('parses --here alongside a tool', () => {
    const r = parseArgs(['codex', '--here']);
    assert.equal(r.tool, 'codex');
    assert.equal(r.here, true);
  });

  it('--here defaults to false', () => {
    assert.equal(parseArgs(['codex']).here, false);
  });
});

// ─────────────────────────────────────────────────────────────
// findEntryByCwd (pure)
// ─────────────────────────────────────────────────────────────

describe('findEntryByCwd', () => {
  const entries = [
    { name: 'a', worktree_path: '/wt/a' },
    { name: 'b', worktree_path: '/wt/b' },
    { name: 'nested', worktree_path: '/wt/b/inner' },
  ];

  it('matches the exact worktree path', () => {
    assert.equal(findEntryByCwd('/wt/a', entries)?.name, 'a');
  });

  it('matches a cwd nested under the worktree', () => {
    assert.equal(findEntryByCwd('/wt/a/src/foo', entries)?.name, 'a');
  });

  it('prefers the deepest matching worktree', () => {
    assert.equal(findEntryByCwd('/wt/b/inner/x', entries)?.name, 'nested');
  });

  it('returns null when nothing matches', () => {
    assert.equal(findEntryByCwd('/somewhere/else', entries), null);
  });

  it('tolerates bad input', () => {
    assert.equal(findEntryByCwd(null, entries), null);
    assert.equal(findEntryByCwd('/wt/a', null), null);
    assert.equal(findEntryByCwd('/wt/a', [{ name: 'x' }]), null);
  });
});

// ─────────────────────────────────────────────────────────────
// relaunchCommand (pure)
// ─────────────────────────────────────────────────────────────

describe('relaunchCommand', () => {
  it('uses mc resume for a named session', () => {
    assert.equal(relaunchCommand({ sessionName: 'feat-x' }), 'mc resume feat-x');
  });
  it('falls back to bare mc for an unregistered cwd', () => {
    assert.equal(relaunchCommand({ sessionName: null }), 'mc');
  });
});

// ─────────────────────────────────────────────────────────────
// runSwitchHere (in-process, stubbed deps)
// ─────────────────────────────────────────────────────────────

function makeDeps(over = {}) {
  const calls = { persisted: null, grounded: null };
  const deps = {
    cwd: () => '/wt/a',
    insideSession: () => true,
    readEntries: async () => [{ name: 'a', worktree_path: '/wt/a', tool: 'claude' }],
    persistTool: async (name, shortName) => { calls.persisted = { name, shortName }; },
    ground: async ({ cwd, adapter }) => {
      calls.grounded = { cwd, adapterId: adapter?.ID };
      return { ok: true, path: '/wt/a/AGENTS.md' };
    },
    resolveLaunch: async (tool) => {
      if (tool === 'codex') {
        return {
          ok: true, id: 'codex', shortName: 'codex',
          adapter: { ID: 'codex' },
          spec: { bin: '/x/codex', label: 'Codex CLI', heartbeatSource: 'codex' },
        };
      }
      return { ok: false, reason: 'unknown', hint: `unknown tool: ${tool}` };
    },
    ...over,
  };
  return { deps, calls };
}

function captureStdout(fn) {
  const out = [];
  const orig = process.stdout.write.bind(process.stdout);
  const origLog = console.log;
  process.stdout.write = (s) => { out.push(typeof s === 'string' ? s : s.toString()); return true; };
  console.log = (...a) => { out.push(a.join(' ') + '\n'); };
  return Promise.resolve(fn()).finally(() => {
    process.stdout.write = orig;
    console.log = origLog;
  }).then((code) => ({ code, stdout: out.join('') }));
}

describe('runSwitchHere', () => {
  it('re-grounds via target adapter + persists the per-session tool', async () => {
    const { deps, calls } = makeDeps();
    const { code, stdout } = await captureStdout(() =>
      runSwitchHere({ tool: 'codex', here: true }, deps));
    assert.equal(code, 0);
    assert.deepEqual(calls.grounded, { cwd: '/wt/a', adapterId: 'codex' });
    assert.deepEqual(calls.persisted, { name: 'a', shortName: 'codex' });
    assert.match(stdout, /re-grounded/i);
    assert.match(stdout, /mc resume a/);
  });

  it('--json reports tool, session, relaunch + grounded', async () => {
    const { deps } = makeDeps();
    const { code, stdout } = await captureStdout(() =>
      runSwitchHere({ tool: 'codex', here: true, json: true }, deps));
    assert.equal(code, 0);
    const j = JSON.parse(stdout);
    assert.equal(j.ok, true);
    assert.equal(j.mode, 'here');
    assert.equal(j.tool, 'codex');
    assert.equal(j.session, 'a');
    assert.equal(j.grounded, true);
    assert.equal(j.relaunch, 'mc resume a');
  });

  it('--dry-run does NOT persist but still reports the plan', async () => {
    const { deps, calls } = makeDeps();
    await captureStdout(() =>
      runSwitchHere({ tool: 'codex', here: true, dryRun: true }, deps));
    assert.equal(calls.persisted, null, 'dry-run must not persist');
  });

  it('fails high on an unknown target (never silently re-grounds)', async () => {
    const { deps, calls } = makeDeps();
    const { code } = await captureStdout(() =>
      runSwitchHere({ tool: 'bogus', here: true }, deps));
    assert.equal(code, 1);
    assert.equal(calls.grounded, null, 'must not ground for an unknown tool');
    assert.equal(calls.persisted, null);
  });

  it('re-grounds in place when no session matches the cwd (no persist)', async () => {
    const { deps, calls } = makeDeps({
      cwd: () => '/somewhere/else',
      insideSession: () => false,
    });
    const { code, stdout } = await captureStdout(() =>
      runSwitchHere({ tool: 'codex', here: true }, deps));
    assert.equal(code, 0);
    assert.deepEqual(calls.grounded, { cwd: '/somewhere/else', adapterId: 'codex' });
    assert.equal(calls.persisted, null, 'no registered session → no per-session persist');
    assert.match(stdout, /no registered session/i);
    assert.match(stdout, /\bmc\b/);
  });
});
