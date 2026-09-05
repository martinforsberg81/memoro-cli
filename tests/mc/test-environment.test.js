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
  accountAvailable, answers, readDeclaration, runSuites, servingWorktree, startArgvFor, suiteEnv,
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

function worktreeWith({ declaration = DECLARATION, definition = DEV_DEFINITION } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-test-env-'));
  mkdirSync(join(root, '.mc'), { recursive: true });
  if (declaration) writeFileSync(join(root, '.mc', 'test.json'), JSON.stringify(declaration));
  if (definition) writeFileSync(join(root, '.mc', 'dev.json'), JSON.stringify(definition));
  return root;
}

function registerServer(root, worktree, { pid = process.pid, port = 8890 } = {}) {
  const dir = join(worktree, '.wrangler', 'dev-server', 'run');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'mc-dev.json');
  writeFileSync(path, JSON.stringify({
    schema_version: 1,
    instance_id: `dev-${port}`,
    service: 'memoro-worker',
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
      why: 'TEST_SEEDED_TOKEN is not set in this shell — the suites that sign in will report skipped',
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
    assert.equal(gone, false);
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
    assert.equal(gone, true);
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
    assert.equal(gone, true);
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
    assert.equal(gone, false);
    assert.deepEqual(results.map((r) => [r.ok, r.unmeasured]), [[false, false]]);
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
