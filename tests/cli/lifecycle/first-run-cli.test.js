/**
 * CLI integration tests for §11d first-run friendliness.
 *
 * Trigger contract:
 *   - hint fires only when BOTH the sentinel is missing AND the
 *     keychain has no token
 *   - `mc new`: friendly hint replaces the cryptic prereq failure,
 *     exits 1 without touching git
 *   - `mc list`: friendly hint goes to stderr, the empty list still
 *     renders on stdout (machine-parseable)
 *   - successful `mc new` writes the sentinel; subsequent calls
 *     don't re-fire the hint even with no token (migrant path)
 *
 * The runMc helper already scrubs MEMORO_MC_PARENT / MC_EMIT_SHELL_DIRECTIVES
 * (per #34). We further isolate the keychain by pointing HOME at a
 * tmpdir so the file-fallback path can't accidentally pick up a real
 * memoro-cli token. On macOS the OS keychain still has my real token,
 * which is the worst case here — the hint silently won't fire, which
 * is the SAFE direction for false-negatives. We assert behavior that
 * holds either way.
 */
import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runMc, parseJsonOrNull } from '../../mc/_helpers/cli.js';
import { makeTempRepo } from '../../mc/_helpers/git-fixture.js';

const HINT = /New to mc\? Run `mc` to sign in, then `mc setup` to finish local setup\./;

describe('mc list — first-run hint on stderr', () => {
  let repo;
  beforeEach(() => { repo = makeTempRepo({ name: 'firstrun-list' }); });
  afterEach(() => { repo.cleanup(); });

  test('sentinel present → no hint regardless of token state', () => {
    mkdirSync(repo.mcHome, { recursive: true });
    writeFileSync(join(repo.mcHome, '.setup-done-v1'), 'x\n');
    const r = runMc(['list'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, HOME: repo.root },
    });
    assert.doesNotMatch(r.stderr, HINT);
  });

  test('hint goes to stderr, not stdout — JSON callers still parse cleanly', () => {
    const r = runMc(['list', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, HOME: repo.root },
    });
    // Whether the hint fires depends on the host keychain having no
    // token. Either way, stdout must remain pure JSON.
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j && Array.isArray(j.entries), `stdout must be valid JSON; got: ${r.stdout}`);
  });
});

describe('mc new — first-run hint replaces cryptic prereq failure', () => {
  let repo;
  beforeEach(() => { repo = makeTempRepo({ name: 'firstrun-new' }); });
  afterEach(() => { repo.cleanup(); });

  test('sentinel present → no hint, normal mc new flow runs', () => {
    mkdirSync(repo.mcHome, { recursive: true });
    writeFileSync(join(repo.mcHome, '.setup-done-v1'), 'x\n');
    const r = runMc(['new', 'foo', '--no-launch', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, HOME: repo.root },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    assert.doesNotMatch(r.stderr, HINT);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j?.ok);
    assert.equal(j.name, 'foo');
  });

  test('successful mc new writes the sentinel (silent migrant path)', () => {
    // Start with no sentinel. After a successful `mc new`, the
    // sentinel must exist — that's the "migrants stay quiet on
    // subsequent calls" guarantee. The hint may or may not have
    // fired on this very call depending on whether the host keychain
    // contains a real token; we only assert the sentinel side-effect
    // when mc new actually succeeded.
    const sentinel = join(repo.mcHome, '.setup-done-v1');
    assert.equal(existsSync(sentinel), false);
    const r = runMc(['new', 'bar', '--no-launch', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, HOME: repo.root },
    });
    if (r.status === 0) {
      assert.ok(existsSync(sentinel), 'successful mc new must write the sentinel');
    } else {
      // First-run hint path: exit 1, sentinel absent, no git work.
      assert.match(r.stderr, HINT);
      assert.equal(existsSync(sentinel), false);
    }
  });
});

describe('mc setup writes the same sentinel first-run reads', () => {
  // This one is deterministic: it just confirms the two modules
  // agree on the path, by writing one and observing the other.
  test('setup.writeSentinel ↔ first-run.sentinelPath', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mc-firstrun-sentinel-'));
    const orig = process.env.MC_HOME;
    process.env.MC_HOME = tmp;
    try {
      const setup = await import('../../../src/cli/setup.js?p=' + Math.random());
      const firstRun = await import('../../../src/mc/first-run.js?p=' + Math.random());
      setup.writeSentinel();
      assert.ok(existsSync(firstRun.sentinelPath()));
      assert.equal(firstRun.sentinelPath(), setup.sentinelPath());
    } finally {
      if (orig === undefined) delete process.env.MC_HOME; else process.env.MC_HOME = orig;
      try { rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  });
});
