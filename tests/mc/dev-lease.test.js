/**
 * Who holds a dev server (goal mc/dev-section): `mc shot dev`, `mc test dev`
 * and `mc dev open` each write the session that took the server — its kind,
 * owner, name and pid — into mc's copy of the registration, and a waiter's
 * queue ticket carries the same. The page reads that back; it never guesses
 * from the worktree.
 *
 * Each verb runs for real down to `ensureDevServer`, which runs for real
 * against a temporary registry holding one live server for the worktree: no
 * server is started, the health check is a stub, and the session's process is
 * found through a fake `ps` whose parent is `claude`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { run as devRun } from '../../src/mc/commands/dev.js';
import { run as shotRun } from '../../src/mc/commands/shot.js';
import { run as testRun } from '../../src/mc/commands/test.js';
import { agentPid, holderLabel, leaseHolder } from '../../src/mc/dev-holder.js';
import { joinQueue, readQueue } from '../../src/mc/dev-queue.js';
import { registerManifest, registeredPath, touchServer } from '../../src/mc/dev-servers.js';
import { ensureDevServer } from '../../src/mc/test-environment.js';

const SESSION = { MC_ROLE: 'build-session:goal', MC_GOAL: 'mc/no-work', MC_PROGRAMME: 'mc', MC_TOOL: 'claude' };
/** The session's process: the verb's parent is `claude`. */
const AGENT = process.ppid;
const ps = (pid) => (pid === AGENT ? { ppid: 1, command: 'claude' } : null);

const SHOT_JSON = {
  schema_version: 1,
  argv: [process.execPath, 'fake-shot.mjs'],
  default_viewport: 'desktop',
  default_account: 'seeded',
  accounts: { seeded: { onboarding: { done: '/dev/login?account=seeded&ready=1' } } },
  viewports: { desktop: { width: 1440, height: 900, dpr: 2 } },
  targets: [{ name: 'home', path: '/app/' }],
};
const TEST_JSON = {
  schema_version: 1,
  environments: { dev: { service: 'memoro-measure' }, prod: { base_url: 'https://meetmemoro.app/' } },
  account: { token_env: 'TEST_SEEDED_TOKEN', url_env: 'MEMORO_TEST_ACCOUNT_URL', route: '/demo/' },
  base_url_env: 'MEMORO_BASE_URL',
  suites: [{ name: 'smoke', argv: ['true'], server: 'app' }],
};

/** This process's environment without any session's or gate round's identity: the test says whose it is. */
function bare() {
  const env = { ...process.env };
  for (const key of ['MC_ROLE', 'MC_GOAL', 'MC_PROGRAMME', 'MC_STEP', 'MC_GATE_ROUND', 'MC_SESSION_PID', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID']) delete env[key];
  return env;
}

function sink() {
  let text = '';
  return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } };
}

/** A repos home with a memoro checkout — a git repository — and a registry with its server, live. */
function fixture() {
  // Real, because git names the worktree by its real path (`/private/var/…` on macOS).
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mc-dev-lease-')));
  const worktree = join(home, 'memoro');
  mkdirSync(join(worktree, '.mc'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: worktree });
  writeFileSync(join(worktree, '.mc', 'shot.json'), JSON.stringify(SHOT_JSON));
  writeFileSync(join(worktree, '.mc', 'test.json'), JSON.stringify(TEST_JSON));
  const root = join(home, 'dev-servers');
  const run = join(worktree, '.wrangler', 'dev-server', 'run');
  mkdirSync(run, { recursive: true });
  const manifest = join(run, 'mc-dev.json');
  writeFileSync(manifest, JSON.stringify({
    schema_version: 1, instance_id: 'dev-8787', service: 'memoro-measure', session_name: 's', worktree_path: worktree,
    pid: process.pid, url: 'http://127.0.0.1:8787', health_url: 'http://127.0.0.1:8787/api/version',
  }));
  assert.equal(registerManifest(manifest, { root }).ok, true);
  return { home, worktree, root, env: { ...bare(), MC_REPOS_HOME: home, ...SESSION } };
}

/** The real `ensureDevServer`, on the fixture's registry, with the verb's own options. */
function ensureOn(fx) {
  return (worktree, declaration, options) => ensureDevServer(worktree, declaration, {
    ...options, root: fx.root, main: null, processCwd: () => null, freeMemory: () => null, fetch: async () => ({ ok: true }), ps,
  });
}

const holderOf = (fx) => JSON.parse(readFileSync(registeredPath('dev-8787', fx.root), 'utf8')).holder;
const EXPECTED = { kind: 'build', owner: 'mc', name: 'mc/no-work', pid: AGENT };

describe('the verbs that take a server record who took it', () => {
  it('mc shot dev', async () => {
    const fx = fixture();
    const stderr = sink();
    const code = await shotRun(['dev', 'home'], {
      stdout: sink(), stderr, env: fx.env, cwd: fx.home,
      ensureDevServer: ensureOn(fx),
      servedTree: (worktree) => ({ worktree, line: 'x' }),
      tokenFor: async () => ({ name: 'TEST_SEEDED_TOKEN', token: 't', from: 'keychain' }),
      runCapture: () => ({ ok: true, result: { ok: true, file: '/tmp/x.png', url: 'http://x/app/', warnings: [] } }),
    });
    assert.equal(code, 0, stderr.text);
    assert.deepEqual(holderOf(fx), EXPECTED);
  });

  it('mc test dev', async () => {
    const fx = fixture();
    const stderr = sink();
    const code = await testRun(['dev', '--here', '--url'], {
      stdout: sink(), stderr, env: fx.env, cwd: fx.worktree, ensureDevServer: ensureOn(fx),
    });
    assert.equal(code, 0, stderr.text);
    assert.deepEqual(holderOf(fx), EXPECTED);
  });

  it('mc dev open', async () => {
    const fx = fixture();
    const stderr = sink();
    const code = await devRun(['open', 'home'], {
      stdout: sink(), stderr, env: fx.env, cwd: fx.worktree, callerWorktree: () => fx.worktree,
      ensureDevServer: ensureOn(fx),
      servedTree: (worktree) => ({ worktree, branch: 'x', commit: 'abcdef1234', line: 'x' }),
    });
    assert.equal(code, 0, stderr.text);
    assert.deepEqual(holderOf(fx), EXPECTED);
  });

  it('a verb no session ran holds it as itself, with its own pid', async () => {
    const fx = fixture();
    const env = { ...bare(), MC_REPOS_HOME: fx.home };
    const code = await testRun(['dev', '--here', '--url'], {
      stdout: sink(), stderr: sink(), env, cwd: fx.worktree, ensureDevServer: ensureOn(fx),
    });
    assert.equal(code, 0);
    assert.deepEqual(holderOf(fx), { kind: 'test', owner: null, name: null, pid: process.pid });
  });
});

describe('leaseHolder', () => {
  it('names each kind of session, and the verb when there is none', () => {
    const of = (env, verb = 'shot') => leaseHolder({ env, verb, pid: 42, ps });
    assert.deepEqual(of(SESSION), EXPECTED);
    assert.deepEqual(of({ MC_ROLE: 'review-session:goal', MC_GOAL: 'mc/email-compose' }),
      { kind: 'review', owner: 'mc', name: 'mc/email-compose', pid: AGENT });
    assert.deepEqual(of({ MC_ROLE: 'plan-session', MC_PROGRAMME: 'mc' }), { kind: 'plan', owner: 'mc', name: 'mc', pid: AGENT });
    assert.deepEqual(of({ MC_ROLE: 'brief' }), { kind: 'brief', owner: 'brief', name: null, pid: AGENT });
    assert.deepEqual(of({}), { kind: 'shot', owner: null, name: null, pid: 42 });
    assert.equal(of({ ...SESSION, MC_SESSION_PID: '77' }).pid, 77, 'a session may say its own pid');
  });

  it('labels a holder as the page names a session', () => {
    assert.equal(holderLabel(EXPECTED), 'BUILD mc/no-work');
    assert.equal(holderLabel({ kind: 'review', name: 'email-compose 7/7' }), 'REVIEW email-compose 7/7');
    assert.equal(holderLabel({ kind: 'plan', name: 'mc' }), 'plan mc');
    assert.equal(holderLabel({ kind: 'brief' }), 'brief');
    assert.equal(holderLabel({ kind: 'shot' }), 'shot');
  });

  it('finds the coding agent above the verb, and nothing when there is none', () => {
    const table = { 10: { ppid: 9, command: 'zsh' }, 9: { ppid: 8, command: '/usr/local/bin/claude' }, 8: { ppid: 1, command: 'login' } };
    assert.equal(agentPid({ start: 10, ps: (pid) => table[pid] || null }), 9);
    assert.equal(agentPid({ start: 8, ps: (pid) => table[pid] || null }), null);
  });
});

describe('the lease on the record and the ticket', () => {
  it('keeps held_since while the same holder goes on using the server', () => {
    const fx = fixture();
    const read = () => JSON.parse(readFileSync(registeredPath('dev-8787', fx.root), 'utf8'));
    touchServer('dev-8787', { root: fx.root, holder: EXPECTED, now: () => new Date('2026-11-04T10:00:00Z') });
    touchServer('dev-8787', { root: fx.root, holder: EXPECTED, now: () => new Date('2026-11-04T10:03:00Z') });
    assert.equal(read().held_since, '2026-11-04T10:00:00.000Z');
    assert.equal(read().last_used_at, '2026-11-04T10:03:00.000Z');
    touchServer('dev-8787', { root: fx.root, holder: { ...EXPECTED, name: 'mc/other' }, now: () => new Date('2026-11-04T10:04:00Z') });
    assert.equal(read().held_since, '2026-11-04T10:04:00.000Z', 'a new holder starts a new lease');
  });

  it('a waiter carries who it is on its queue ticket', () => {
    const fx = fixture();
    const file = join(fx.home, 'dev-queue.json');
    joinQueue({ file, worktree: fx.worktree, service: 'memoro-measure', env: {}, session: EXPECTED, alive: () => true });
    assert.deepEqual(readQueue({ file, alive: () => true })[0].session, EXPECTED);
  });
});
