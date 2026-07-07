/**
 * `mc auth memoro`, `mc auth github`, and `mc auth <tool>` per-target helpers (§11c).
 *
 * Shape contract:
 *   - `mc auth memoro`           — shells out to `memoro-cli login`
 *   - `mc auth memoro --logout`  — shells out to `memoro-cli logout`
 *   - `mc auth memoro --status`  — prints just the Memoro section
 *   - `mc auth <tool> [--status]` — prints just that tool's row + hint
 *   - `mc auth gemini`           — surfaces the planned-tool stub
 *   - `mc auth github`           — checks host gh auth without printing tokens
 *
 * Memoro alias is exercised via the keychain fallback (MEMORO_API_URL
 * pointing at a closed port → API check fails but keychain write
 * succeeds via env override). We don't drive the full interactive
 * login path here; the alias's only contract is "forward to
 * memoro-cli".
 */
import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { existsSync } from 'node:fs';

import { runMc, parseJsonOrNull } from '../_helpers/cli.js';
import { makeTempRepo } from '../_helpers/git-fixture.js';
import { parseMemoroArgs, probeGitHub, resolveMemoroBin } from '../../../src/mc/commands/auth.js';

describe('mc auth memoro', () => {
  let repo;
  let pidDir;

  beforeEach(() => {
    repo = makeTempRepo({ name: 'auth-memoro' });
    pidDir = mkdtempSync(join(tmpdir(), 'mc-auth-pid-'));
  });
  afterEach(() => {
    repo.cleanup();
    try { rmSync(pidDir, { recursive: true, force: true }); } catch {}
  });

  test('--status prints just the Memoro section, exits non-zero when no token', () => {
    const r = runMc(['auth', 'memoro', '--status'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.notEqual(r.status, 0, 'no token → non-zero');
    assert.match(r.stdout, /Memoro account:/);
    // Should NOT print the tools / shell / workspace sections.
    assert.doesNotMatch(r.stdout, /LLM tools/);
    assert.doesNotMatch(r.stdout, /Shell wrapper:/);
  });

  test('--status --json shape: just the memoro key', () => {
    const r = runMc(['auth', 'memoro', '--status', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j, r.stdout);
    assert.ok(j.memoro);
    assert.equal(typeof j.memoro.authenticated, 'boolean');
    assert.ok(!j.tools, 'tools section must be omitted');
  });

  test('resolveMemoroBin points at an existing bin.js', () => {
    // The alias relies on spawning node + bin.js — verify the path
    // resolution is correct so future moves of the file don't silently
    // break `mc auth memoro`.
    const p = resolveMemoroBin();
    assert.ok(existsSync(p), `expected memoro-cli bin at ${p}`);
    assert.match(p, /bin\.js$/);
  });

  test('parseMemoroArgs forwards unknown args via passthrough', () => {
    const o = parseMemoroArgs(['--token', 'foo', '--logout']);
    assert.equal(o.logout, true);
    assert.deepEqual(o.passthrough, ['--token', 'foo']);
  });

  test('parseMemoroArgs intercepts the known flags', () => {
    const o = parseMemoroArgs(['--status', '--json']);
    assert.equal(o.status, true);
    assert.equal(o.json, true);
    assert.deepEqual(o.passthrough, []);
  });

  test('--logout + --status are mutually exclusive', () => {
    const r = runMc(['auth', 'memoro', '--logout', '--status'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /mutually exclusive/);
  });

});

describe('mc auth github', () => {
  let repo;
  let pidDir;

  beforeEach(() => {
    repo = makeTempRepo({ name: 'auth-github' });
    pidDir = mkdtempSync(join(tmpdir(), 'mc-auth-pid-'));
  });
  afterEach(() => {
    repo.cleanup();
    try { rmSync(pidDir, { recursive: true, force: true }); } catch {}
  });

  test('--json shape: just the github key', () => {
    const r = runMc(['auth', 'github', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j, r.stdout);
    assert.ok(j.github);
    assert.equal(typeof j.github.installed, 'boolean');
    assert.equal(j.github.token_exposed, false);
    assert.ok(!j.tools, 'tools section must be omitted');
  });

  test('probeGitHub parses host gh auth without invoking token export', () => {
    const calls = [];
    const fakeSpawn = (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'which' && args[0] === 'gh') {
        return { status: 0, stdout: '/usr/local/bin/gh\n', stderr: '' };
      }
      if (cmd === 'gh' && args[0] === '--version') {
        return { status: 0, stdout: 'gh version 2.95.0 (2026-06-17)\n', stderr: '' };
      }
      if (cmd === 'gh' && args[0] === 'auth' && args[1] === 'status') {
        return {
          status: 0,
          stdout: JSON.stringify({
            hosts: {
              'github.com': [{
                state: 'success',
                active: true,
                login: 'martinforsberg81',
                tokenSource: 'keyring',
                scopes: 'gist, read:org, repo',
              }],
            },
          }),
          stderr: '',
        };
      }
      return { status: 1, stdout: '', stderr: 'unexpected command' };
    };

    const s = probeGitHub({ spawnSyncFn: fakeSpawn });
    assert.equal(s.authenticated, true);
    assert.equal(s.login, 'martinforsberg81');
    assert.equal(s.token_source, 'keyring');
    assert.equal(s.token_exposed, false);
    assert.equal(s.capabilities.pull_requests, true);
    assert.equal(s.capabilities.merge, true);
    assert.equal(calls.some(([cmd, args]) => cmd === 'gh' && args.includes('token')), false);
    assert.equal(calls.some(([cmd, args]) => cmd === 'gh' && args.includes('--show-token')), false);
  });
});

describe('mc auth <tool>', () => {
  let repo;
  let pidDir;

  beforeEach(() => {
    repo = makeTempRepo({ name: 'auth-tool' });
    pidDir = mkdtempSync(join(tmpdir(), 'mc-auth-pid-'));
  });
  afterEach(() => {
    repo.cleanup();
    try { rmSync(pidDir, { recursive: true, force: true }); } catch {}
  });

  test('mc auth claude — prints one row, non-zero when not installed', () => {
    const r = runMc(['auth', 'claude'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.notEqual(r.status, 0, 'safe PATH means not installed → non-zero');
    assert.match(r.stdout, /claude\b/);
    assert.match(r.stdout, /not installed/);
    // Hint must follow.
    assert.match(r.stdout, /→ /);
    // Must not render the full health-check layout.
    assert.doesNotMatch(r.stdout, /Memoro account:/);
    assert.doesNotMatch(r.stdout, /Shell wrapper:/);
  });

  test('mc auth codex --json shape: { tool, installed, ... }', () => {
    const r = runMc(['auth', 'codex', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j, r.stdout);
    assert.equal(j.tool, 'codex');
    assert.equal(typeof j.installed, 'boolean');
    assert.ok('hint' in j);
  });

  test('mc auth gemini — surfaces the planned-tool stub', () => {
    const r = runMc(['auth', 'gemini', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j, r.stdout);
    assert.equal(j.tool, 'gemini');
    assert.ok(j.hint && /gemini|planned/i.test(j.hint));
  });

  test('--status flag is accepted (no-op vs default)', () => {
    const r = runMc(['auth', 'claude', '--status'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /claude\b/);
  });

  test('rejects unknown flag', () => {
    const r = runMc(['auth', 'claude', '--whatever'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown flag/);
  });
});
