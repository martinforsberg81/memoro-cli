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
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { runMc, CLI_PATH } from '../../mc/_helpers/cli.js';

describe('mc vault — subprocess wiring', () => {
  it('`mc vault` with no args prints help and exits 0', () => {
    const res = runMc(['vault']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /mc vault/);
    assert.match(res.stdout, /VERBS/);
    // The help must include every shipped verb name.
    for (const verb of ['setup', 'unlock', 'lock', 'scan', 'import', 'bindings', 'bind', 'list', 'get', 'set', 'rm', 'rotate', 'status', 'change-password']) {
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

  it('`mc vault audit --json` is local, metadata-only, and auth-free', () => {
    const mcHome = mkdtempSync(join(tmpdir(), 'mc-vault-audit-cli-'));
    const res = runMc(['vault', 'audit', '--json'], {
      env: { MC_HOME: mcHome },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout).summary, {
      manifests: 0,
      artifacts: 0,
      leftovers: 0,
      cleaned_manifests: 0,
      uncertain: 0,
    });
  });

  it('`mc vault scan --json` scans local dotenv files without a vault login', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-vault-scan-cli-'));
    const secret = 'pancakes-and-syrup-9af237';
    writeFileSync(join(dir, '.dev.vars'), `CLOUDFLARE_API_TOKEN=${secret}\nPUBLIC_API_URL=http://localhost:8787\n`);

    const res = runMc(['vault', 'scan', '.dev.vars', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stderr, '');
    assert.ok(!res.stdout.includes(secret), `scan leaked secret value: ${res.stdout}`);

    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.files[0].file, '.dev.vars');
    assert.equal(parsed.files[0].format, 'wrangler-dotenv');
    assert.deepEqual(parsed.files[0].keys.map((k) => [k.name, k.classification]), [
      ['CLOUDFLARE_API_TOKEN', 'secret'],
      ['PUBLIC_API_URL', 'config'],
    ]);
  });

  it('`mc vault import --dry-run --json` previews encrypted import without bindings or secret leak', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-vault-import-cli-'));
    const secret = 'pancakes-and-syrup-9af237';
    writeFileSync(join(dir, '.env'), `OPENAI_API_KEY=${secret}\nPUBLIC_API_URL=http://localhost:8787\n`);

    const res = runMc(['vault', 'import', '.env', '--dry-run', '--json'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stderr, '');
    assert.ok(!res.stdout.includes(secret), `import dry-run leaked secret value: ${res.stdout}`);

    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.binding, null);
    assert.equal(parsed.binding_disabled, true);
    assert.equal(parsed.dry_run, true);
    assert.deepEqual(parsed.candidates.map((k) => [k.name, k.selected]), [
      ['OPENAI_API_KEY', true],
      ['PUBLIC_API_URL', false],
    ]);
    assert.deepEqual(parsed.writes, []);
  });

  it('`mc vault import --dry-run` prints a compact human preview', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-vault-import-human-'));
    const secret = 'pancakes-and-syrup-9af237';
    writeFileSync(join(dir, '.env'), [
      `OPENAI_API_KEY=${secret}`,
      'PUBLIC_API_URL=http://localhost:8787',
      'STRIPE_SECRET_KEY=stripe-one',
      'STRIPE_SECRET_KEY=stripe-two',
      '',
    ].join('\n'));

    const res = runMc(['vault', 'import', '.env', '--dry-run'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stderr, '');
    assert.match(res.stdout, /Vault import preview: \.env/);
    assert.match(res.stdout, /Will Import/);
    assert.match(res.stdout, /Skipped/);
    assert.match(res.stdout, /Warnings/);
    assert.match(res.stdout, /STRIPE_SECRET_KEY.*lines 3, 4/);
    assert.match(res.stdout, /No changes made/);
    assert.ok(!res.stdout.includes(secret), `human import preview leaked secret value: ${res.stdout}`);
    assert.ok(!res.stdout.includes('stripe-one'), `human import preview leaked duplicate secret: ${res.stdout}`);
    assert.ok(!res.stdout.trim().startsWith('{'), `human output should not be raw JSON:\n${res.stdout}`);
  });

  it('`mc vault import` human confirmation preview does not call itself a dry-run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-vault-import-confirm-preview-'));
    const secret = 'pancakes-and-syrup-9af237';
    writeFileSync(join(dir, '.env'), `OPENAI_API_KEY=${secret}\n`);

    const env = { ...process.env };
    delete env.MC_EMIT_SHELL_DIRECTIVES;
    delete env.MEMORO_MC_PARENT;
    delete env.MC_ORPHAN_PID_DIR;

    const res = spawnSync(process.execPath, [CLI_PATH, 'vault', 'import', '.env'], {
      cwd: dir,
      input: 'n\n',
      encoding: 'utf8',
      env: {
        ...env,
        MC_TEST_MODE: '1',
        MEMORO_API_URL: 'http://127.0.0.1:1',
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      },
    });
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stdout, /Vault import preview: \.env/);
    assert.match(res.stdout, /write\s+encrypted vault entries after confirmation; source file unchanged/);
    assert.match(res.stdout, /No changes yet\. Confirm to import selected secrets into mc vault\./);
    assert.doesNotMatch(res.stdout, /write\s+nothing \(dry-run\)/);
    assert.ok(!res.stdout.includes(secret), `human import preview leaked secret value: ${res.stdout}`);
  });

  it('`mc vault import --json` requires explicit --no-confirm before mutation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-vault-import-refuse-'));
    writeFileSync(join(dir, '.env'), 'OPENAI_API_KEY=secret\n');

    const res = runMc(['vault', 'import', '.env', '--json'], { cwd: dir });
    assert.equal(res.status, 2);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /requires --no-confirm/);
  });

  it('`mc vault bind` fails closed before login or file writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-vault-bind-cli-'));
    const res = runMc([
      'vault',
      'bind',
      'wrangler:memoro:OPENAI_API_KEY',
      'OPENAI_API_KEY',
      '--file',
      '.dev.vars',
      '--dry-run',
      '--json',
    ], { cwd: dir });
    assert.equal(res.status, 1, res.stderr);
    assert.equal(res.stderr, '');

    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'plaintext_binding_disabled');
    assert.equal(existsSync(join(dir, '.mc', 'secrets.json')), false);
    assert.ok(!res.stdout.includes('sk-'), `bind preview leaked a token-like value: ${res.stdout}`);
  });

  it('plaintext export and set --bind fail closed before vault access', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-vault-containment-cli-'));
    const probes = [
      ['vault', 'get', 'provider-secret', '--json', '--no-confirm'],
      ['vault', 'set', 'provider-secret', '--bind', 'API_TOKEN', '--json', '--no-confirm'],
    ];
    for (const argv of probes) {
      const res = runMc(argv, { cwd: dir });
      assert.equal(res.status, 1, `${argv.join(' ')}\n${res.stderr}`);
      const parsed = JSON.parse(res.stdout);
      assert.equal(parsed.ok, false);
      assert.match(parsed.code, /^plaintext_(export|binding)_disabled$/);
    }
    assert.equal(existsSync(join(dir, '.mc', 'secrets.json')), false);
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
