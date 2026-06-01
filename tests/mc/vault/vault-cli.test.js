/**
 * Subprocess tests for `mc vault` — full bin-mc.js dispatch path.
 *
 * Why subprocess: the in-process tests (vault-commands.test.js) cover
 * the verb internals with a stubbed portal. This file verifies:
 *
 *   - `mc vault <verb>` is wired into the LIFECYCLE dispatch table
 *   - argv reaches the verb intact (flags, --json, positional)
 *   - exit codes propagate
 *   - critically, NO SECRET BYTES leak to stdout or stderr across the
 *     lifecycle: the "test invariant" from the brief.
 *
 * Network is unreachable (MEMORO_API_URL is loopback:1 via the test
 * helper) so any verb that hits the server fails fast with a friendly
 * error — that's enough to test the wrappers without spinning up a
 * real Worker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runMc } from '../_helpers/cli.js';

describe('mc vault — subprocess wiring', () => {
  it('`mc vault` with no args prints help and exits 0', () => {
    const res = runMc(['vault']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /mc vault/);
    assert.match(res.stdout, /VERBS/);
    // The help must include every shipped verb name.
    for (const verb of ['setup', 'unlock', 'lock', 'list', 'get', 'set', 'rm', 'rotate', 'status', 'change-password']) {
      assert.ok(res.stdout.includes(verb), `help missing verb: ${verb}`);
    }
  });

  it('`mc vault bogus` exits 2 with an error', () => {
    const res = runMc(['vault', 'bogus']);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /unknown verb/);
  });

  it('`mc vault status` exits 1 with a friendly JSON error (never throws)', () => {
    // The CLI helper points MEMORO_API_URL at a loopback port that
    // nothing's listening on, so even if a token IS present in the
    // host keychain the verb will fail at the network step. Either
    // way, we want exit 1 (friendly) — never a Node uncaught throw.
    const res = runMc(['vault', 'status', '--json']);
    assert.equal(res.status, 1, `stderr: ${res.stderr}\nstdout: ${res.stdout}`);
    // Output must be a JSON object with ok:false. No stack traces.
    const combined = `${res.stdout}\n${res.stderr}`;
    assert.ok(!combined.includes('    at '), `looks like a JS stack trace leaked:\n${combined}`);
    // The JSON branch goes to stdout per the --json contract.
    const parsed = JSON.parse(res.stdout.trim().split('\n').pop());
    assert.equal(parsed.ok, false);
    assert.ok(typeof parsed.error === 'string' && parsed.error.length > 0);
  });

  it('`mc vault --help` exits 0', () => {
    const res = runMc(['vault', '--help']);
    assert.equal(res.status, 0);
  });
});

describe('mc vault — secret-bytes-never-leak invariant', () => {
  // Sentinel passphrase + secret value we'll grep for across all
  // captured output. Both are sufficiently odd that any leak is
  // unambiguous; lowercase a-z so they survive any future ANSI
  // colour wrap.
  const SECRET_VALUE = 'pancakes-and-syrup-9af237';
  const PASSPHRASE = 'totally-distinct-master-zzz1';

  it('the passphrase never appears in stdout/stderr for any verb', () => {
    // We run each verb that takes the passphrase via env. All of them
    // will fail on the (loopback) server connection — that's fine; the
    // test is about what made it into stdout/stderr.
    const verbsToProbe = [
      ['vault', 'status', '--json'],
      ['vault', 'unlock', '--json'],
      ['vault', 'list', '--json'],
      ['vault', 'get', 'whatever', '--json', '--no-confirm'],
      ['vault', 'rm', 'whatever', '--json', '--no-confirm'],
    ];
    for (const argv of verbsToProbe) {
      const res = runMc(argv, { env: { MC_VAULT_PASSPHRASE: PASSPHRASE } });
      const combined = `${res.stdout}\n${res.stderr}`;
      assert.ok(!combined.includes(PASSPHRASE),
        `passphrase leaked into output for ${argv.join(' ')}:\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
      assert.ok(!combined.includes(SECRET_VALUE),
        `secret-value leaked into output for ${argv.join(' ')}`);
    }
  });

  it('the passphrase + secret never appears across mc new / mc resume / mc end', async () => {
    // §12d/§12f: phase 2 lifecycle integration. `mc new` (and resume)
    // call materialiseForSession before re-exec; `mc end` calls
    // shredForSession. Even with the vault unreachable (the loopback
    // API), the soft-degrade path may emit a hint to stderr. Verify
    // the hint never embeds the passphrase or any token we control.
    //
    // We don't drive a real session here (would require a git repo,
    // worktree creation, etc. — covered by lifecycle.test.js in-
    // process). This subprocess test exercises the hint-emission
    // branch in `mc new` / `mc resume` / `mc end`:
    //   - bogus session name → command fails fast
    //   - any emitted hint must not include MC_VAULT_PASSPHRASE
    const verbsToProbe = [
      ['new', 'no-such-name-bogus-aaa'],   // will fail on "not in repo" or registry check
      ['resume', 'no-such-name-bogus-aaa'], // will fail on "no such session"
      ['end',    'no-such-name-bogus-aaa'], // will fail on "unknown session"
    ];
    for (const argv of verbsToProbe) {
      const res = runMc(argv, {
        env: {
          MC_VAULT_PASSPHRASE: PASSPHRASE,
          // Force materialisation to attempt (would otherwise short-
          // circuit on `MC_TEST_MODE=1`). `runMc` sets MC_TEST_MODE
          // already; we leave it on so we don't actually spawn the
          // tool — the materialise path runs BEFORE that branch
          // anyway in `mc new`/`mc resume`.
        },
      });
      const combined = `${res.stdout}\n${res.stderr}`;
      assert.ok(!combined.includes(PASSPHRASE),
        `passphrase leaked into output for ${argv.join(' ')}:\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
      assert.ok(!combined.includes(SECRET_VALUE),
        `secret-value leaked into output for ${argv.join(' ')}`);
    }
  });

  it('`vault set` with --stdin never echoes the piped value', async () => {
    // Pipe a "secret value" via stdin (--stdin path). Verify it
    // doesn't reappear in any captured output. The verb will fail on
    // the loopback API — that's fine.
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const CLI = join(here, '..', '..', '..', 'src', 'bin-mc.js');

    const child = spawn(process.execPath, [CLI, 'vault', 'set', 'somelabel', '--stdin', '--no-confirm', '--json'], {
      env: {
        ...process.env,
        MC_TEST_MODE: '1',
        MEMORO_API_URL: 'http://127.0.0.1:1',
        MC_VAULT_PASSPHRASE: PASSPHRASE,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.write(SECRET_VALUE);
    child.stdin.end();

    let stdout = '', stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });

    const code = await new Promise((resolve, reject) => {
      const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, 10_000);
      child.on('close', (c) => { clearTimeout(t); resolve(c); });
      child.on('error', (e) => { clearTimeout(t); reject(e); });
    });

    const combined = `${stdout}\n${stderr}`;
    assert.ok(!combined.includes(SECRET_VALUE),
      `piped secret leaked into output (exit ${code}):\nstdout: ${stdout}\nstderr: ${stderr}`);
    assert.ok(!combined.includes(PASSPHRASE),
      `passphrase leaked into output (exit ${code}):\nstdout: ${stdout}\nstderr: ${stderr}`);
  });
});
