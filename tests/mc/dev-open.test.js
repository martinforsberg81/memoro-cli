/**
 * `mc dev open` and `mc dev surfaces` against an injected server, git and
 * spawn.
 *
 * No browser and no dev server: the worktree is a temp directory with a
 * `.mc/shot.json`, `ensureAppServer` and `servedTree` are stubs, and `runOpen`
 * is driven by a fake child — an emitter with a stdout stream — so what is
 * asserted is mc's half: the URL, the one line, the order of refusals, and
 * that the request file never outlives the call.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import { parseArgs, run, usage } from '../../src/mc/commands/dev.js';
import { runOpen } from '../../src/mc/shot.js';

const SHOT_JSON = {
  schema_version: 1,
  argv: ['node', 'scripts/shot/shot.mjs'],
  default_viewport: 'desktop',
  default_account: 'seeded',
  accounts: {
    seeded: { onboarding: { done: '/dev/login?account=seeded&ready=1', fresh: '/dev/login?account=seeded&reseed=1' } },
    new: { onboarding: { done: '/dev/login?account=new&ready=1', fresh: '/dev/login?account=new&reseed=1' } },
  },
  viewports: {
    desktop: { width: 1440, height: 900, dpr: 2 },
    iphone: { width: 390, height: 844, dpr: 3, mobile: true },
  },
  targets: [
    { name: 'home', path: '/app/' },
    {
      name: 'assistant',
      path: '/app/assistant',
      summary: 'Main chat, the assistant window',
      window: '.window-view--main-chat',
      scroller: '.window-view--main-chat > .window-view__content',
      chrome: ['.assistant-layout__footer'],
      measure: { layout: '.a, .b', composer: '.c' },
    },
    {
      name: 'mail', path: '/app/inbox', summary: 'One mail, opened from the inbox', open: [{ click: '.email-row' }, { click: '.mail-open' }],
    },
    { name: 'onboarding', path: '/app/', onboarding: 'fresh', summary: 'First-run onboarding' },
  ],
};

const TEST_JSON = {
  schema_version: 1,
  environments: { dev: { service: 'memoro-measure' } },
  suites: [{ name: 'smoke', argv: ['true'] }],
};

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'mc-dev-open-test-'));
  const worktree = join(home, 'memoro');
  mkdirSync(join(worktree, '.mc'), { recursive: true });
  writeFileSync(join(worktree, '.mc', 'shot.json'), JSON.stringify(SHOT_JSON));
  writeFileSync(join(worktree, '.mc', 'test.json'), JSON.stringify(TEST_JSON));
  return { home, worktree };
}

function sink() {
  let text = '';
  return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } };
}

async function dev(argv, fx, deps = {}) {
  const stdout = sink();
  const stderr = sink();
  const calls = { ensure: 0, open: [] };
  const code = await run(argv, {
    stdout,
    stderr,
    env: { ...process.env, MC_REPOS_HOME: fx.home },
    cwd: fx.worktree,
    callerWorktree: () => fx.worktree,
    ensureAppServer: async () => {
      calls.ensure += 1;
      return { ok: true, server: { url: 'http://127.0.0.1:8787/' }, baseUrl: 'http://127.0.0.1:8787' };
    },
    servedTree: (worktree) => ({ worktree, branch: 'fix-x', commit: 'abcdef1234', line: 'x' }),
    runOpen: async (args) => {
      calls.open.push(args);
      return { ok: true, result: { ok: true, mode: 'open', url: 'http://127.0.0.1:8787/app/assistant', warnings: [] }, log: '/tmp/open.log' };
    },
    ...deps,
  });
  return { code, stdout: stdout.text, stderr: stderr.text, calls };
}

describe('mc dev surfaces', () => {
  it('prints one line per target, then the accounts, default first', async () => {
    const fx = fixture();
    const result = await dev(['surfaces'], fx);
    assert.equal(result.code, 0, result.stderr);
    const lines = result.stdout.split('\n');
    assert.equal(lines[0], 'home        /app/           -');
    assert.equal(lines[1], 'assistant   /app/assistant  Main chat, the assistant window');
    assert.equal(lines[3], 'onboarding  /app/           First-run onboarding');
    assert.equal(lines[4], '');
    assert.equal(lines[5], 'accounts: seeded (done, fresh) · new (done, fresh)');
    assert.equal(result.calls.ensure, 0, 'no server is started');
  });

  it('--json carries the surfaces, the measure names and the accounts', async () => {
    const fx = fixture();
    const result = await dev(['surfaces', '--json'], fx);
    assert.equal(result.code, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.schema_version, 1);
    assert.equal(json.worktree, fx.worktree);
    assert.deepEqual(json.surfaces[1], {
      name: 'assistant',
      path: '/app/assistant',
      summary: 'Main chat, the assistant window',
      window: '.window-view--main-chat',
      scroller: '.window-view--main-chat > .window-view__content',
      chrome: ['.assistant-layout__footer'],
      measure: ['layout', 'composer'],
      onboarding: null,
    });
    assert.deepEqual(json.accounts, { seeded: ['done', 'fresh'], new: ['done', 'fresh'] });
    assert.equal(json.default_account, 'seeded');
  });

  it('refuses the flags of open', () => {
    assert.match(parseArgs(['surfaces', '--account', 'new']).error, /--account belongs to mc dev open/u);
    assert.match(parseArgs(['surfaces', 'x']).error, /takes no argument/u);
  });
});

describe('mc dev open', () => {
  it('prints one line: the URL that signs in and lands on the surface, account/state, branch @ commit', async () => {
    const fx = fixture();
    const result = await dev(['open', 'assistant', '--account', 'new'], fx);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      result.stdout,
      'http://127.0.0.1:8787/dev/login?account=new&ready=1&next=%2Fapp%2Fassistant  new/done  fix-x @ abcdef1234\n',
    );
    assert.doesNotMatch(result.stderr, /reseeds/u);
    assert.equal(result.calls.open.length, 0);
  });

  it('a path target lands on that path', async () => {
    const fx = fixture();
    const result = await dev(['open', '/app/people'], fx);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /account=seeded&ready=1&next=%2Fapp%2Fpeople {2}seeded\/done/u);
  });

  it('a target that opens a window adds the clicks', async () => {
    const fx = fixture();
    const result = await dev(['open', 'mail'], fx);
    assert.equal(result.stdout.split('\n')[1], 'then click: .email-row → .mail-open');
    const json = JSON.parse((await dev(['open', 'mail', '--json'], fx)).stdout);
    assert.deepEqual(json.then, ['.email-row', '.mail-open']);
    assert.equal(json.surface, 'mail');
    assert.equal(json.onboarding, 'done');
    assert.equal(json.served.branch, 'fix-x');
  });

  it('fresh from the entry and from --onboarding, with the reseed warning', async () => {
    const fx = fixture();
    const declared = await dev(['open', 'onboarding', '--account', 'new'], fx);
    assert.match(declared.stdout, /account=new&reseed=1&next=%2Fapp%2F {2}new\/fresh/u);
    assert.match(declared.stderr, /mc: opening this URL reseeds new each time/u);
    const asked = await dev(['open', 'assistant', '--onboarding'], fx);
    assert.match(asked.stdout, /account=seeded&reseed=1&next=%2Fapp%2Fassistant {2}seeded\/fresh/u);
    assert.match(asked.stderr, /reseeds seeded each time/u);
  });

  it('a wrong account or surface is refused before a server is started', async () => {
    const fx = fixture();
    const account = await dev(['open', 'assistant', '--account', 'review'], fx);
    assert.equal(account.code, 2);
    assert.match(account.stderr, /--account is one of seeded, new, not review/u);
    assert.equal(account.calls.ensure, 0);
    const surface = await dev(['open', 'assistent'], fx);
    assert.equal(surface.code, 2);
    assert.equal(surface.calls.ensure, 0);
  });

  it('--viewport and the other browser flags are for --open', async () => {
    const fx = fixture();
    const result = await dev(['open', 'assistant', '--viewport', 'iphone'], fx);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /^mc: --viewport is for --open: a URL has no viewport/u);
    assert.match(parseArgs(['open', 'assistant', '--theme', 'dark', '--locale', 'sv']).error, /--theme, --locale are for --open/u);
    assert.match(parseArgs(['open']).error, /needs a surface/u);
    assert.match(parseArgs(['open', 'a', '--open', '--theme', 'blue']).error, /--theme is light or dark/u);
  });

  it('--open hands memoro an open request and prints the same line', async () => {
    const fx = fixture();
    const result = await dev(['open', 'assistant', '--account', 'new', '--viewport', 'iphone', '--open', '--safe-area', '0'], fx, { platform: 'darwin' });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      result.stdout,
      'http://127.0.0.1:8787/dev/login?account=new&ready=1&next=%2Fapp%2Fassistant  new/done  fix-x @ abcdef1234\n',
    );
    assert.match(result.stderr, /mc: a browser is open on assistant at iphone — close its window when you are done/u);
    const [{ request, worktree, declaration }] = result.calls.open;
    assert.equal(worktree, fx.worktree);
    assert.deepEqual(declaration.argv, SHOT_JSON.argv);
    assert.deepEqual(request, {
      mode: 'open',
      base_url: 'http://127.0.0.1:8787',
      account: 'new',
      sign_in: { kind: 'url', url: 'http://127.0.0.1:8787/dev/login?account=new&ready=1&next=%2Fapp%2Fassistant' },
      target: { name: 'assistant' },
      viewport: 'iphone',
      theme: null,
      locale: null,
      safe_area: { top: 0, right: 0, bottom: 0, left: 0 },
      onboarding: false,
    });
  });

  it('--open says what memoro refused, and is refused without a display', async () => {
    const fx = fixture();
    const refused = await dev(['open', 'assistant', '--open'], fx, {
      platform: 'darwin',
      runOpen: async () => ({ ok: true, result: { ok: false, code: 'no-element', error: 'the window did not open' }, log: '/tmp/x.log' }),
    });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /mc: no-element: the window did not open — \/tmp\/x\.log/u);
    const headless = await dev(['open', 'assistant', '--open'], fx, { platform: 'linux', env: { PATH: process.env.PATH, MC_REPOS_HOME: fx.home } });
    assert.equal(headless.code, 2);
    assert.match(headless.stderr, /--open needs a display/u);
    assert.equal(headless.calls.ensure, 0);
  });

  it('usage names both verbs', () => {
    assert.match(usage(), /mc dev open <surface>/u);
    assert.match(usage(), /mc dev surfaces/u);
  });
});

describe('runOpen', () => {
  function fakeChild() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.unrefed = false;
    child.killed = false;
    child.unref = () => { child.unrefed = true; };
    child.kill = () => { child.killed = true; };
    return child;
  }

  function opened(child, { timeoutMs } = {}) {
    const fx = fixture();
    const dirs = [];
    const spawned = [];
    const pending = runOpen({
      worktree: fx.worktree,
      declaration: SHOT_JSON,
      request: { mode: 'open' },
      env: { PATH: process.env.PATH },
      deps: {
        logDir: join(fx.home, 'shots'),
        now: () => new Date(2026, 9, 15, 21, 3, 9),
        timeoutMs,
        mkdtemp: (prefix) => { const dir = mkdtempSync(prefix); dirs.push(dir); return dir; },
        spawn: (command, args, options) => {
          const file = options.env.MEMORO_SHOT_REQUEST;
          spawned.push({ command, args, options, request: JSON.parse(readFileSync(file, 'utf8')) });
          return child;
        },
      },
    });
    return { pending, dirs, spawned, fx };
  }

  it('resolves on the first result line, lets go of the child, and removes the request', async () => {
    const child = fakeChild();
    const { pending, dirs, spawned, fx } = opened(child);
    child.stdout.write('progress\n{"ok": true, "mode": "open", "url": "http://x/app/assistant"');
    child.stdout.write('}\n');
    const ran = await pending;
    assert.equal(ran.ok, true);
    assert.equal(ran.result.url, 'http://x/app/assistant');
    assert.equal(ran.log, join(fx.home, 'shots', 'open-20261015-210309.log'));
    assert.equal(child.unrefed, true);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(spawned[0].options.detached, true);
    assert.equal(spawned[0].options.cwd, fx.worktree);
    assert.deepEqual(spawned[0].request, { mode: 'open' });
    assert.equal(existsSync(ran.log), true);
    assert.equal(existsSync(dirs[0]), false);
  });

  it('a child that exits first returns the log path', async () => {
    const child = fakeChild();
    const { pending, dirs } = opened(child);
    child.emit('close', 1, null);
    const ran = await pending;
    assert.equal(ran.ok, false);
    assert.match(ran.error, /exited 1 before the surface was open — .*open-20261015-210309\.log$/u);
    assert.equal(existsSync(dirs[0]), false);
  });

  it('a child that never answers is killed', async () => {
    const child = fakeChild();
    const { pending, dirs } = opened(child, { timeoutMs: 10 });
    const ran = await pending;
    assert.equal(ran.ok, false);
    assert.match(ran.error, /did not open within/u);
    assert.equal(child.killed, true);
    assert.equal(existsSync(dirs[0]), false);
  });
});
