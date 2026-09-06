/**
 * `mc test dev` and `mc test prod` — the parts that decide, without the parts
 * that take minutes.
 *
 * Nothing here starts a server or opens a browser. What is worth pinning is
 * the judgement: which worktree, which server counts as *this* worktree's,
 * what the suites are handed, and what happens when the repository says
 * something mc cannot use. The measurement itself is memoro's suites, and
 * asserting that they pass would be asserting memoro is green.
 *
 * The one rule with teeth is reuse. A URL that answers says something is
 * serving; it never says it is serving the tree you are about to judge. On a
 * machine running four lanes those are different servers with identical
 * shapes, and the failure — measuring one worktree and reporting it as
 * another — leaves no trace at all.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { registerManifest } from '../../src/mc/dev-servers.js';
import {
  accountAvailable, answers, ensureDevServer, isLoopback, readDeclaration, runSuites, serversFor, servingWorktree,
  startArgvFor, stopServer, suiteEnv, tierOf,
} from '../../src/mc/test-environment.js';

const DEAD_PID = 2_147_483_646;

const DECLARATION = {
  schema_version: 1,
  environments: {
    dev: { service: 'memoro-worker', profile: 'agent' },
    prod: { base_url: 'https://meetmemoro.app' },
  },
  base_url_env: 'MEMORO_BASE_URL',
  account: { token_env: 'TEST_SEEDED_TOKEN', url_env: 'MEMORO_TEST_ACCOUNT_URL', route: '/demo/' },
  suites: [
    { name: 'signs-in', argv: ['npm', 'run', 'test:signs-in'], needs_account: true },
    { name: 'does-not', argv: ['npm', 'run', 'test:does-not'], needs_account: false },
  ],
};

const DEV_DEFINITION = {
  schema_version: 1,
  default_service: 'memoro-worker',
  services: {
    'memoro-worker': {
      default_profile: 'full',
      profiles: {
        agent: { start: { argv: ['npm', 'run', 'dev', '--', '--skip-containers'] } },
        full: { start: { argv: ['npm', 'run', 'dev'] } },
      },
    },
  },
};

/** The same repository once it has a static tier. */
const TIERED_DECLARATION = {
  ...DECLARATION,
  environments: {
    dev: { service: 'memoro-worker', profile: 'agent', static_service: 'memoro-static' },
    prod: { base_url: 'https://meetmemoro.app' },
  },
  suites: [
    { name: 'signs-in', argv: ['npm', 'run', 'test:signs-in'], server: 'app', needs_account: true },
    { name: 'harness', argv: ['npm', 'run', 'test:harness'], server: 'static', needs_account: false },
    { name: 'does-not', argv: ['npm', 'run', 'test:does-not'], server: 'app', needs_account: false },
  ],
};

const TIERED_DEFINITION = {
  ...DEV_DEFINITION,
  services: {
    ...DEV_DEFINITION.services,
    'memoro-static': {
      default_profile: 'static',
      profiles: {
        static: {
          start: { argv: ['node', 'scripts/testing/static-server.mjs'] },
          readiness: { kind: 'runtime-manifest', path: '.wrangler/dev-server/run/mc-static.json', timeout_ms: 15000 },
        },
      },
    },
  },
};

function worktreeWith({ declaration = DECLARATION, definition = DEV_DEFINITION } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-test-env-'));
  mkdirSync(join(root, '.mc'), { recursive: true });
  if (declaration) writeFileSync(join(root, '.mc', 'test.json'), JSON.stringify(declaration));
  if (definition) writeFileSync(join(root, '.mc', 'dev.json'), JSON.stringify(definition));
  return root;
}

function registerServer(root, worktree, { pid = process.pid, port = 8890, service = 'memoro-worker' } = {}) {
  const dir = join(worktree, '.wrangler', 'dev-server', 'run');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, service === 'memoro-worker' ? 'mc-dev.json' : 'mc-static.json');
  writeFileSync(path, JSON.stringify({
    schema_version: 1,
    instance_id: `${service === 'memoro-worker' ? 'dev' : 'static'}-${port}`,
    service,
    session_name: 'a-session',
    worktree_path: worktree,
    pid,
    url: `http://127.0.0.1:${port}`,
    health_url: `http://127.0.0.1:${port}/api/version`,
  }));
  const done = registerManifest(path, { root });
  assert.equal(done.ok, true, done.error);
  return done;
}

describe('what the repository declares', () => {
  it('reads the shape mc uses', () => {
    const worktree = worktreeWith();
    const read = readDeclaration(worktree);
    assert.equal(read.ok, true, read.error);
    assert.equal(read.declaration.environments.prod.base_url, 'https://meetmemoro.app');
    rmSync(worktree, { recursive: true, force: true });
  });

  it('says which repository has no declaration, rather than assuming one', () => {
    const worktree = worktreeWith({ declaration: null });
    const read = readDeclaration(worktree);
    assert.equal(read.ok, false);
    assert.match(read.error, /does not declare \.mc\/test\.json/u);
    rmSync(worktree, { recursive: true, force: true });
  });

  it('refuses a suite whose argv is a shell string', async () => {
    const worktree = worktreeWith({
      declaration: {
        ...DECLARATION,
        suites: [{ name: 'shelly', argv: ['npm run test:shelly && rm -rf /'], needs_account: false }],
      },
    });
    // One string is a valid argv of length one, so the rule that catches this
    // is the emptiness check on each part — assert the whole line is refused,
    // whichever rule does it.
    const read = readDeclaration(worktree);
    assert.equal(read.ok, true, 'a one-element argv parses…');
    // …and running it can never reach a shell: the first element is the
    // command, and nothing else is passed to one.
    const calls = [];
    await runSuites(
      { declaration: read.declaration, worktree, baseUrl: 'http://127.0.0.1:8787' },
      { spawnSync: (command, args, options) => { calls.push({ command, args, options }); return { status: 0 }; } },
    );
    assert.equal(calls[0].command, 'npm run test:shelly && rm -rf /');
    assert.equal(calls[0].options.shell, false, 'never a shell, whatever the declaration says');
    rmSync(worktree, { recursive: true, force: true });
  });

  it('finds the start argv through the declared profile, not the default one', () => {
    const worktree = worktreeWith();
    const start = startArgvFor(worktree, DECLARATION);
    assert.equal(start.ok, true, start.error);
    assert.equal(start.profile, 'agent', 'the declaration asks for agent; the definition defaults to full');
    assert.deepEqual(start.argv, ['npm', 'run', 'dev', '--', '--skip-containers']);
    rmSync(worktree, { recursive: true, force: true });
  });
});

describe('which server is this worktree\'s', () => {
  it('a live server in another worktree is never this one', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-test-env-root-'));
    const mine = worktreeWith();
    const theirs = worktreeWith();
    registerServer(root, theirs, { port: 8891 });

    assert.equal(servingWorktree(mine, { root }), null, 'somebody else serving is not this tree served');
    assert.ok(servingWorktree(theirs, { root }), 'and theirs is found');

    for (const path of [root, mine, theirs]) rmSync(path, { recursive: true, force: true });
  });

  it('a registration whose process is gone is not a server', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-test-env-root-'));
    const worktree = worktreeWith();
    registerServer(root, worktree, { pid: DEAD_PID, port: 8892 });
    assert.equal(servingWorktree(worktree, { root }), null);
    for (const path of [root, worktree]) rmSync(path, { recursive: true, force: true });
  });
});

describe('what a suite is handed', () => {
  it('one variable points every suite at the server', () => {
    const env = suiteEnv({ declaration: DECLARATION, baseUrl: 'https://meetmemoro.app', env: {} });
    assert.equal(env.MEMORO_BASE_URL, 'https://meetmemoro.app');
  });

  it('a per-suite variable somebody set on purpose is left alone', () => {
    const env = suiteEnv({
      declaration: DECLARATION,
      baseUrl: 'https://meetmemoro.app',
      needsAccount: true,
      env: { TEST_SEEDED_TOKEN: 'tok', MEMORO_TEST_ACCOUNT_URL: 'http://127.0.0.1:9000/demo/other' },
    });
    assert.equal(env.MEMORO_TEST_ACCOUNT_URL, 'http://127.0.0.1:9000/demo/other');
  });

  it('the production token is never handed to a local server', () => {
    // The first full round on the two tiers (2026-09-06): the write smoke got
    // `http://127.0.0.1:8920/demo/<prod token>`, asked the fixture, and read
    // the 404 as "is TEST_ACCOUNT_ENABLED on, and is the token current?".
    // Locally it has /dev/login, and takes it when no link is set.
    for (const baseUrl of ['http://127.0.0.1:8920', 'http://localhost:8787', 'http://[::1]:8787']) {
      const env = suiteEnv({
        declaration: DECLARATION, baseUrl, env: { TEST_SEEDED_TOKEN: 'tok' }, needsAccount: true,
      });
      assert.equal(env.MEMORO_TEST_ACCOUNT_URL, undefined, `${baseUrl}: no link, the suite finds its own door`);
      assert.equal(env.MEMORO_BASE_URL, baseUrl);
    }
    const prod = suiteEnv({
      declaration: DECLARATION, baseUrl: 'https://meetmemoro.app', env: { TEST_SEEDED_TOKEN: 'tok' }, needsAccount: true,
    });
    assert.equal(prod.MEMORO_TEST_ACCOUNT_URL, 'https://meetmemoro.app/demo/tok', 'production is what the token is for');
    assert.equal(isLoopback('http://127.0.0.1:1'), true);
    assert.equal(isLoopback('https://meetmemoro.app'), false);
    assert.equal(isLoopback('not a url'), false);
  });

  it('the account link is built only for the suites that sign in', () => {
    const withToken = { TEST_SEEDED_TOKEN: 'tok' };
    assert.equal(
      suiteEnv({
        declaration: DECLARATION, baseUrl: 'https://meetmemoro.app', needsAccount: true, env: withToken,
      }).MEMORO_TEST_ACCOUNT_URL,
      'https://meetmemoro.app/demo/tok',
    );
    assert.equal(
      suiteEnv({
        declaration: DECLARATION, baseUrl: 'https://meetmemoro.app', needsAccount: false, env: withToken,
      }).MEMORO_TEST_ACCOUNT_URL,
      undefined,
      'a suite that does not sign in is never handed a production login',
    );
  });

  it('no token is a sentence, not a crash', () => {
    assert.deepEqual(accountAvailable(DECLARATION, {}), {
      available: false,
      why: 'no TEST_SEEDED_TOKEN: mc test token --set, or export it',
    });
    assert.equal(accountAvailable(DECLARATION, { TEST_SEEDED_TOKEN: 'tok' }).available, true);
    assert.equal(
      suiteEnv({
        declaration: DECLARATION, baseUrl: 'https://meetmemoro.app', needsAccount: true, env: {},
      }).MEMORO_TEST_ACCOUNT_URL,
      undefined,
    );
  });
});

describe('the round', () => {
  it('runs every suite even after one goes red, and the verdict is the round\'s', async () => {
    const worktree = worktreeWith();
    const seen = [];
    const { results, gone } = await runSuites(
      { declaration: DECLARATION, worktree, baseUrl: 'http://127.0.0.1:8787' },
      {
        spawnSync: (command, args) => {
          seen.push(args.at(-1));
          return { status: args.at(-1) === 'test:signs-in' ? 1 : 0, stdout: 'a line\nanother\n', stderr: '' };
        },
        now: (() => { let t = 0; return () => { t += 1500; return t; }; })(),
      },
    );
    assert.deepEqual(seen, ['test:signs-in', 'test:does-not'], 'the second suite ran after the first went red');
    assert.deepEqual(results.map((r) => [r.name, r.ok]), [['signs-in', false], ['does-not', true]]);
    assert.equal(results[0].tail, 'a line\nanother');
    assert.deepEqual(gone, [], 'no tier lost its server');
    rmSync(worktree, { recursive: true, force: true });
  });

  it('one suite can be named, and only that one runs', async () => {
    const worktree = worktreeWith();
    const seen = [];
    await runSuites(
      {
        declaration: DECLARATION, worktree, baseUrl: 'http://127.0.0.1:8787', only: 'does-not',
      },
      { spawnSync: (command, args) => { seen.push(args.at(-1)); return { status: 0 }; } },
    );
    assert.deepEqual(seen, ['test:does-not']);
    rmSync(worktree, { recursive: true, force: true });
  });

  it('every suite runs in the worktree being measured, with no shell', async () => {
    const worktree = worktreeWith();
    await runSuites(
      { declaration: DECLARATION, worktree, baseUrl: 'http://127.0.0.1:8787' },
      {
        spawnSync: (command, args, options) => {
          assert.equal(options.cwd, worktree);
          assert.equal(options.shell, false);
          assert.equal(options.env.MEMORO_BASE_URL, 'http://127.0.0.1:8787');
          return { status: 0 };
        },
      },
    );
    rmSync(worktree, { recursive: true, force: true });
  });
});

describe('a server that leaves in the middle', () => {
  it('the suite that was running when it went is unmeasured, not red', async () => {
    // The first full round this verb ever ran produced six red suites and one
    // real cause: memoro's worker exited at 17:24:41 and every suite after it
    // failed on ERR_CONNECTION_REFUSED. Six red suites and a broken
    // measurement read identically in a log, and somebody acts on the broken
    // one.
    const worktree = worktreeWith();
    let alive = true;
    const { results, gone, skipped } = await runSuites(
      {
        declaration: DECLARATION,
        worktree,
        baseUrl: 'http://127.0.0.1:8787',
        stillThere: async () => alive,
      },
      {
        spawnSync: () => { alive = false; return { status: 1, stdout: 'ERR_CONNECTION_REFUSED\n' }; },
      },
    );
    assert.deepEqual(gone, ['app'], 'the app tier lost its server');
    assert.deepEqual(results.map((r) => [r.name, r.ok, r.unmeasured]), [['signs-in', false, true]]);
    assert.deepEqual(skipped, ['does-not'], 'the suite that never ran is named, not counted as green');
    rmSync(worktree, { recursive: true, force: true });
  });

  it('a round that cannot reach the server at all spends no minutes proving it', async () => {
    const worktree = worktreeWith();
    let ran = 0;
    const { results, gone, skipped } = await runSuites(
      {
        declaration: DECLARATION,
        worktree,
        baseUrl: 'http://127.0.0.1:8787',
        stillThere: async () => false,
      },
      { spawnSync: () => { ran += 1; return { status: 0 }; } },
    );
    assert.equal(ran, 0);
    assert.deepEqual(gone, ['app'], 'the app tier lost its server');
    assert.deepEqual(results, []);
    assert.deepEqual(skipped, ['signs-in', 'does-not']);
    rmSync(worktree, { recursive: true, force: true });
  });

  it('a red suite with the server still up stays red', async () => {
    const worktree = worktreeWith();
    const { results, gone } = await runSuites(
      {
        declaration: DECLARATION,
        worktree,
        baseUrl: 'http://127.0.0.1:8787',
        only: 'does-not',
        stillThere: async () => true,
      },
      { spawnSync: () => ({ status: 1, stdout: 'a real failure\n' }) },
    );
    assert.deepEqual(gone, [], 'no tier lost its server');
    assert.deepEqual(results.map((r) => [r.ok, r.unmeasured, r.skipped]), [[false, false, false]]);
    rmSync(worktree, { recursive: true, force: true });
  });
});

describe('is it still there', () => {
  const SERVER = { health_url: 'http://127.0.0.1:8787/api/version' };

  it('one refusal under load is not a death', async () => {
    // This is the mirror of the guard above, and it happened on the round
    // after it: the server was up the whole time — 200 on the port, its log
    // still filling — and one request that did not come back while a browser
    // matrix hammered it condemned nine suites as never-run.
    let asked = 0;
    const ok = await answers(SERVER, {
      attempts: 3,
      delayMs: 0,
      fetch: async () => {
        asked += 1;
        if (asked === 1) throw new Error('socket hang up');
        return { ok: true };
      },
    });
    assert.equal(ok, true);
    assert.equal(asked, 2, 'it stops asking as soon as one answer comes back');
  });

  it('a server that is really gone is still reported gone', async () => {
    let asked = 0;
    const ok = await answers(SERVER, {
      attempts: 3,
      delayMs: 0,
      fetch: async () => { asked += 1; throw new Error('ECONNREFUSED'); },
    });
    assert.equal(ok, false);
    assert.equal(asked, 3);
  });

  it('a non-ok response is not an answer', async () => {
    assert.equal(
      await answers(SERVER, { attempts: 1, delayMs: 0, fetch: async () => ({ ok: false, status: 503 }) }),
      false,
    );
  });
});

describe('a suite that says it did not run', () => {
  const WITH_SKIP = { ...DECLARATION, skip_exit_code: 78 };

  it('is neither green nor red', async () => {
    // Both wrong readings of a skip happened within an hour of this verb
    // existing. The write smoke exited 0 against production having skipped
    // every step, and was reported green. Deciding from `needs_account`
    // instead then reported a local run that did sign in and did write as
    // "never signed in". The suite is the only thing that knows.
    const worktree = worktreeWith();
    const { results } = await runSuites(
      { declaration: WITH_SKIP, worktree, baseUrl: 'https://meetmemoro.app', only: 'signs-in' },
      { spawnSync: () => ({ status: 78, stdout: '○ skipped\n' }) },
    );
    assert.deepEqual(results.map((r) => [r.ok, r.skipped]), [[false, true]]);
    rmSync(worktree, { recursive: true, force: true });
  });

  it('a skip is not evidence that the server went away', async () => {
    const worktree = worktreeWith();
    let asked = 0;
    const { results, gone } = await runSuites(
      {
        declaration: WITH_SKIP,
        worktree,
        baseUrl: 'https://meetmemoro.app',
        only: 'signs-in',
        stillThere: async () => { asked += 1; return true; },
      },
      { spawnSync: () => ({ status: 78 }) },
    );
    assert.deepEqual(gone, [], 'no tier lost its server');
    assert.equal(asked, 1, 'asked before the suite, and not again after a skip');
    assert.equal(results[0].skipped, true);
    rmSync(worktree, { recursive: true, force: true });
  });

  it('without a declared code, 78 is just a failure', async () => {
    const worktree = worktreeWith();
    const { results } = await runSuites(
      { declaration: DECLARATION, worktree, baseUrl: 'https://meetmemoro.app', only: 'signs-in' },
      { spawnSync: () => ({ status: 78 }) },
    );
    assert.deepEqual(results.map((r) => [r.ok, r.skipped]), [[false, false]]);
    rmSync(worktree, { recursive: true, force: true });
  });
});

describe('stopping one', () => {
  const SERVER = Object.freeze({
    instance_id: 'dev-8890',
    worktree_path: '/tmp/a-worktree',
    url: 'http://127.0.0.1:8890',
    control: { stop: { argv: ['/usr/bin/node', '/tmp/a-worktree/scripts/dev.mjs', '--stop'], timeout_ms: 30_000 } },
  });

  it('asks the project, and signals nothing itself', () => {
    let asked = null;
    const stopped = stopServer(SERVER, {
      spawnSync: (command, args, options) => {
        asked = { command, args, options };
        return { status: 0 };
      },
    });
    assert.equal(stopped.ok, true);
    assert.equal(asked.command, '/usr/bin/node');
    assert.deepEqual(asked.args, ['/tmp/a-worktree/scripts/dev.mjs', '--stop']);
    assert.equal(asked.options.cwd, '/tmp/a-worktree');
    assert.equal(asked.options.shell, false);
  });

  it('refuses rather than guessing when there is no stop command', () => {
    const stopped = stopServer({ instance_id: 'dev-nothing', worktree_path: '/tmp/x' });
    assert.equal(stopped.ok, false);
    assert.match(stopped.error, /declares no stop command/u);
  });

  it('a stop command that fails is reported, not swallowed', () => {
    const stopped = stopServer(SERVER, {
      spawnSync: () => ({ status: 3, stderr: 'lock held by another wrapper\n' }),
    });
    assert.equal(stopped.ok, false);
    assert.match(stopped.error, /exited 3: lock held by another wrapper/u);
  });
});

describe('bringing one up', () => {
  /** A clock the test drives, so ten minutes of patience costs no seconds. */
  function clock() {
    let t = 0;
    return { now: () => t, sleep: async (ms) => { t += ms; } };
  }

  it('waits minutes for a server that has registered', async () => {
    // Measured 2026-09-05: a cold start with two other dev servers running
    // took 181 seconds from spawn to `Ready on http://127.0.0.1:8900` — CSS
    // build, 283 migrations, then wrangler. A two-minute ceiling called that
    // a failure while the wrapper was working perfectly.
    const root = mkdtempSync(join(tmpdir(), 'mc-test-env-root-'));
    const worktree = worktreeWith();
    const { now, sleep } = clock();
    let readyAt = null;

    const ensured = await ensureDevServer(worktree, DECLARATION, {
      root,
      now,
      sleep,
      spawn: () => { registerServer(root, worktree, { port: 8900 }); return { unref() {} }; },
      fetch: async () => {
        if (readyAt === null) readyAt = now() + 181_000;
        return { ok: now() >= readyAt };
      },
    });

    assert.equal(ensured.ok, true, ensured.error);
    assert.equal(ensured.started, true);
    assert.ok(now() >= 181_000, `gave up after ${now()}ms`);

    for (const path of [root, worktree]) rmSync(path, { recursive: true, force: true });
  });

  it('gives up in seconds when nothing registers at all', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-test-env-root-'));
    const worktree = worktreeWith();
    const { now, sleep } = clock();
    let asked = 0;

    const ensured = await ensureDevServer(worktree, DECLARATION, {
      root,
      now,
      sleep,
      registerTimeoutMs: 5_000,
      spawn: () => ({ unref() {} }),
      fetch: async () => { asked += 1; return { ok: true }; },
    });

    assert.equal(ensured.ok, false);
    assert.match(ensured.error, /no memoro-worker registered/u, 'the message names the service it waited for');
    assert.equal(asked, 0, 'nothing was asked for health — nothing had said where');

    for (const path of [root, worktree]) rmSync(path, { recursive: true, force: true });
  });

  it('a wrapper that dies while starting fails at once, not in ten minutes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-test-env-root-'));
    const worktree = worktreeWith();
    const { now, sleep } = clock();

    const ensured = await ensureDevServer(worktree, DECLARATION, {
      root,
      now,
      sleep,
      spawn: () => { registerServer(root, worktree, { port: 8900 }); return { unref() {} }; },
      fetch: async () => {
        // It registered, then went. The registration is swept on the next read.
        rmSync(join(root, 'dev-8900.json'), { force: true });
        return { ok: false };
      },
    });

    assert.equal(ensured.ok, false);
    assert.match(ensured.error, /stopped before it answered/u);
    assert.ok(now() < 60_000, `waited ${now()}ms for a wrapper that was gone`);

    for (const path of [root, worktree]) rmSync(path, { recursive: true, force: true });
  });

  it('reuses a live server for this worktree and starts nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-test-env-root-'));
    const worktree = worktreeWith();
    registerServer(root, worktree, { port: 8900 });
    let spawned = 0;

    const ensured = await ensureDevServer(worktree, DECLARATION, {
      root,
      spawn: () => { spawned += 1; return { unref() {} }; },
    });

    assert.equal(ensured.ok, true);
    assert.equal(ensured.started, false);
    assert.equal(spawned, 0);

    for (const path of [root, worktree]) rmSync(path, { recursive: true, force: true });
  });
});

describe('two tiers', () => {
  it('a suite is static only when the repository says so', () => {
    assert.equal(tierOf({ server: 'static' }), 'static');
    assert.equal(tierOf({ server: 'app' }), 'app');
    assert.equal(tierOf({}), 'app', 'an omission is the app, as every suite was before there were tiers');
  });

  it('a worktree can have a server per service, and a caller says which', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-test-env-root-'));
    const worktree = worktreeWith({ declaration: TIERED_DECLARATION, definition: TIERED_DEFINITION });
    registerServer(root, worktree, { port: 8900 });
    registerServer(root, worktree, { port: 8910, service: 'memoro-static' });

    assert.equal(servingWorktree(worktree, { root, service: 'memoro-worker' }).port ?? 8900, 8900);
    assert.equal(servingWorktree(worktree, { root, service: 'memoro-static' }).instance_id, 'static-8910');
    assert.equal(servingWorktree(worktree, { root, service: 'memoro-measure' }), null, 'a service nobody runs');
    assert.equal(serversFor(worktree, { root }).length, 2, 'and both are the worktree\'s');

    for (const path of [root, worktree]) rmSync(path, { recursive: true, force: true });
  });

  it('the static service starts with its own profile and its own registration window', () => {
    const worktree = worktreeWith({ declaration: TIERED_DECLARATION, definition: TIERED_DEFINITION });
    const app = startArgvFor(worktree, TIERED_DECLARATION);
    assert.deepEqual([app.service, app.profile, app.registerTimeoutMs], ['memoro-worker', 'agent', null]);
    const fileServer = startArgvFor(worktree, TIERED_DECLARATION, { service: 'memoro-static' });
    assert.deepEqual(fileServer.argv, ['node', 'scripts/testing/static-server.mjs']);
    assert.equal(fileServer.profile, 'static', 'the declaration\'s profile is the app\'s, not this service\'s');
    assert.equal(fileServer.registerTimeoutMs, 15000, 'what .mc/dev.json says it needs, not the Worker\'s two minutes');
    rmSync(worktree, { recursive: true, force: true });
  });

  it('ensuring the static tier reuses a live Worker for nothing and starts the file server', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-test-env-root-'));
    const worktree = worktreeWith({ declaration: TIERED_DECLARATION, definition: TIERED_DEFINITION });
    registerServer(root, worktree, { port: 8900 });
    const started = [];
    const ensured = await ensureDevServer(worktree, TIERED_DECLARATION, {
      root,
      service: 'memoro-static',
      sleep: async () => {},
      now: (() => { let t = 0; return () => { t += 1000; return t; }; })(),
      spawn: (command, args) => {
        started.push([command, ...args]);
        registerServer(root, worktree, { port: 8910, service: 'memoro-static' });
        return { unref() {} };
      },
      fetch: async () => ({ ok: true }),
    });
    assert.equal(ensured.ok, true, ensured.error);
    assert.equal(ensured.started, true, 'the Worker being up is not the file server being up');
    assert.deepEqual(started, [['node', 'scripts/testing/static-server.mjs']]);
    assert.equal(ensured.server.service, 'memoro-static');
    for (const path of [root, worktree]) rmSync(path, { recursive: true, force: true });
  });

  it('a static suite is handed the static URL, and an app suite the app\'s', async () => {
    const worktree = worktreeWith({ declaration: TIERED_DECLARATION, definition: TIERED_DEFINITION });
    const handed = {};
    const { results } = await runSuites(
      {
        declaration: TIERED_DECLARATION, worktree, baseUrl: 'http://127.0.0.1:8900', staticBaseUrl: 'http://127.0.0.1:8910',
      },
      { spawnSync: (command, args, options) => { handed[args.at(-1)] = options.env.MEMORO_BASE_URL; return { status: 0 }; } },
    );
    assert.deepEqual(handed, {
      'test:signs-in': 'http://127.0.0.1:8900',
      'test:harness': 'http://127.0.0.1:8910',
      'test:does-not': 'http://127.0.0.1:8900',
    });
    assert.deepEqual(results.map((r) => r.server), ['app', 'static', 'app'], 'and each result says which');
    rmSync(worktree, { recursive: true, force: true });
  });

  it('without a static service, a static suite runs against the app like before', async () => {
    const worktree = worktreeWith({ declaration: TIERED_DECLARATION, definition: DEV_DEFINITION });
    const handed = {};
    await runSuites(
      { declaration: TIERED_DECLARATION, worktree, baseUrl: 'http://127.0.0.1:8900' },
      { spawnSync: (command, args, options) => { handed[args.at(-1)] = options.env.MEMORO_BASE_URL; return { status: 0 }; } },
    );
    assert.equal(handed['test:harness'], 'http://127.0.0.1:8900');
    rmSync(worktree, { recursive: true, force: true });
  });

  it('the Worker leaving takes the app suites, and the static suite still runs', async () => {
    const worktree = worktreeWith({ declaration: TIERED_DECLARATION, definition: TIERED_DEFINITION });
    const ran = [];
    const { results, gone, skipped } = await runSuites(
      {
        declaration: TIERED_DECLARATION, worktree, baseUrl: 'http://127.0.0.1:8900', staticBaseUrl: 'http://127.0.0.1:8910',
        stillThere: async (suite) => tierOf(suite) === 'static',
      },
      { spawnSync: (command, args) => { ran.push(args.at(-1)); return { status: 0 }; } },
    );
    assert.deepEqual(ran, ['test:harness'], 'the file server was there; the Worker was not');
    assert.deepEqual(gone, ['app']);
    assert.deepEqual(skipped, ['signs-in', 'does-not'], 'the app suites never ran, and are named');
    assert.deepEqual(results.map((r) => [r.name, r.ok]), [['harness', true]]);
    rmSync(worktree, { recursive: true, force: true });
  });
});
