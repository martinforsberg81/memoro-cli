/**
 * `mc shot` against a fake capture script.
 *
 * No browser and no dev server: the script is a few lines of node that writes
 * a PNG, copies what it was handed — the request, its argv, its environment,
 * the request file's mode — to a side file, and prints the result line. What
 * is asserted is the half mc owns: the request it builds, where a secret may
 * appear, and what it prints back.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { run, usage } from '../../src/mc/commands/shot.js';
import {
  buildRequest, outPath, parseResult, parseViewport, resolveTarget, slug,
} from '../../src/mc/shot.js';

const TOKEN = 'tok-5ecret-7e57';
const COOKIE = 'cookie-5ecret-me';

const FAKE_SCRIPT = `
import { readFileSync, statSync, writeFileSync } from 'node:fs';
const file = process.env.MEMORO_SHOT_REQUEST;
const request = JSON.parse(readFileSync(file, 'utf8'));
const mode = statSync(file).mode & 0o777;
writeFileSync(process.env.SHOT_SIDE, JSON.stringify({ request, file, mode, argv: process.argv, env: process.env }));
const how = process.env.SHOT_BEHAVIOUR || 'ok';
process.stderr.write('fake: capturing\\n');
if (how === 'garbage') { console.log('this is not json'); process.exit(3); }
if (how === 'silent') process.exit(4);
if (how === 'not-signed-in') {
  console.log(JSON.stringify({ ok: false, code: 'not-signed-in', error: 'the session is not signed in at ' + request.base_url }));
  process.exit(1);
}
if (request.mode === 'login') { console.log(JSON.stringify({ ok: true, session: '${COOKIE}' })); process.exit(0); }
writeFileSync(request.out, Buffer.from('89504e470d0a1a0a', 'hex'));
console.log('some progress on stdout');
console.log(JSON.stringify({ ok: true, file: request.out, url: request.base_url + '/app/', subject: request.element ? 'element' : request.shell ? 'shell' : 'page', selector: request.element, width: 10, height: 10, warnings: how === 'warn' ? ['2 elements match; the first was captured'] : [] }));
`;

const SHOT_JSON = {
  schema_version: 1,
  argv: [process.execPath, 'fake-shot.mjs'],
  default_viewport: 'desktop',
  viewports: {
    desktop: { width: 1440, height: 900, dpr: 2 },
    iphone: { width: 390, height: 844, dpr: 3, mobile: true },
  },
  shells: { base: '.base-view', immersive: '.immersive-view', window: '.window-view' },
  targets: [
    { name: 'home', path: '/app/' },
    { name: 'notifications', path: '/app/', window: '.dropdown-window.notifications-dropdown' },
  ],
};

const TEST_JSON = {
  schema_version: 1,
  environments: { dev: { service: 'memoro-measure' }, prod: { base_url: 'https://meetmemoro.app/' } },
  account: { token_env: 'TEST_SEEDED_TOKEN', url_env: 'MEMORO_TEST_ACCOUNT_URL', route: '/demo/' },
  suites: [{ name: 'smoke', argv: ['true'] }],
};

/** A repos home with a memoro checkout declaring both files, and the fake script in it. */
function fixture({ shot = SHOT_JSON } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mc-shot-test-'));
  const worktree = join(home, 'memoro');
  mkdirSync(join(worktree, '.mc'), { recursive: true });
  if (shot) writeFileSync(join(worktree, '.mc', 'shot.json'), JSON.stringify(shot));
  writeFileSync(join(worktree, '.mc', 'test.json'), JSON.stringify(TEST_JSON));
  writeFileSync(join(worktree, 'fake-shot.mjs'), FAKE_SCRIPT);
  return { home, worktree, side: join(home, 'side.json') };
}

function sink() {
  let text = '';
  return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } };
}

async function shot(argv, fx, { behaviour, env = {}, ...deps } = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await run(argv, {
    stdout,
    stderr,
    env: {
      ...process.env, MC_REPOS_HOME: fx.home, SHOT_SIDE: fx.side, SHOT_BEHAVIOUR: behaviour || 'ok', ...env,
    },
    cwd: fx.home,
    now: () => new Date(2026, 8, 26, 14, 3, 9),
    ensureDevServer: async () => ({ ok: true, server: { url: 'http://127.0.0.1:8787/', instance_id: 'srv-1' }, started: false }),
    tokenFor: async () => ({ name: 'TEST_SEEDED_TOKEN', token: TOKEN, from: 'keychain' }),
    getSecret: async () => COOKIE,
    ...deps,
  });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

const sideOf = (fx) => JSON.parse(readFileSync(fx.side, 'utf8'));

describe('mc shot — the surface', () => {
  it('usage starts with usage and names every form', () => {
    assert.match(usage(), /^usage/u);
    for (const form of ['--list', 'login prod', '--paste', 'logout prod', '--me', '--here']) assert.ok(usage().includes(form), form);
  });

  it('refuses what does not belong, each in one line', async () => {
    const fx = fixture();
    const cases = [
      [['dev', 'home', '--me'], /--me is for prod/u],
      [['prod', 'home', '--here'], /--here is for dev/u],
      [['login', 'dev'], /is for prod only/u],
      [['logout', 'dev'], /is for prod only/u],
      [['dev', 'home', '--shell', 'side'], /--shell is base, immersive, window/u],
      [['dev', 'home', '--theme', 'blue'], /--theme is light or dark/u],
      [['dev', 'home', '--out', 'x.jpg'], /ends in \.png/u],
      [['dev', 'home', '--el'], /--el needs a value/u],
      [['dev', 'home', '--bogus'], /unknown flag/u],
      [['staging', 'home'], /dev or prod first, not staging/u],
      [['dev'], /needs a target/u],
      [['dev', 'home', '--el', '.a', '--shell', 'base'], /give one/u],
    ];
    for (const [argv, pattern] of cases) {
      const result = await shot(argv, fx);
      assert.equal(result.code, 2, argv.join(' '));
      assert.match(result.stderr.split('\n')[0], pattern, argv.join(' '));
    }
    assert.equal(existsSync(fx.side), false, 'no refusal ran the script');
  });

  it('an unknown target lists the known names', async () => {
    const fx = fixture();
    const result = await shot(['dev', 'planing'], fx);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /no target called planing — a path under \/app, or one of: home, notifications/u);
  });

  it('a memoro without .mc/shot.json says where it comes from', async () => {
    const fx = fixture({ shot: null });
    const result = await shot(['dev', 'home'], fx);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /memoro has no \.mc\/shot\.json at .* — it comes with memoro's shot-capture project/u);
  });

  it('--list prints the declared targets and viewports', async () => {
    const fx = fixture();
    const result = await shot(['prod', '--list'], fx);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /home {2}\/app\//u);
    assert.match(result.stdout, /notifications/u);
    assert.match(result.stdout, /iphone {2}390x844@3 mobile/u);
    assert.match(result.stdout, /default desktop/u);
  });
});

describe('mc shot — the pieces', () => {
  it('resolves a path or a name', () => {
    assert.deepEqual(resolveTarget('/app/people', SHOT_JSON), { ok: true, target: { path: '/app/people' }, label: 'app-people' });
    assert.deepEqual(resolveTarget('home', SHOT_JSON), { ok: true, target: { name: 'home' }, label: 'home' });
    assert.equal(resolveTarget('people', SHOT_JSON).ok, false);
    assert.equal(slug('/app/'), 'app');
  });

  it('parses a viewport', () => {
    assert.deepEqual(parseViewport(null, SHOT_JSON), { ok: true, viewport: 'desktop', label: 'desktop' });
    assert.deepEqual(parseViewport('iphone', SHOT_JSON), { ok: true, viewport: 'iphone', label: 'iphone' });
    assert.deepEqual(parseViewport('390x844', SHOT_JSON).viewport, { width: 390, height: 844, dpr: 2, mobile: true });
    assert.deepEqual(parseViewport('1280x800@1', SHOT_JSON).viewport, { width: 1280, height: 800, dpr: 1, mobile: false });
    assert.equal(parseViewport('1280x800@1', SHOT_JSON).label, '1280x800');
    assert.match(parseViewport('watch', SHOT_JSON).error, /no viewport called watch — WxH\[@dpr\], or one of: desktop, iphone/u);
  });

  it('names the file', () => {
    const now = new Date(2026, 8, 26, 14, 3, 9);
    assert.equal(outPath({ dir: '/s', now, where: 'dev', target: 'home', viewport: 'desktop' }), '/s/20260926-140309-dev-home-desktop.png');
    assert.equal(
      outPath({ dir: '/s', now, where: 'prod', me: true, target: 'app-people', shell: 'base', viewport: '390x844', theme: 'dark' }),
      '/s/20260926-140309-prod-me-app-people-base-390x844-dark.png',
    );
    assert.equal(outPath({ dir: '/s', now, where: 'dev', target: 'home', element: '.x', viewport: 'iphone' }), '/s/20260926-140309-dev-home-el-iphone.png');
  });

  it('reads the last non-empty line, and nothing else', () => {
    assert.deepEqual(parseResult('noise\n{"ok":true,"file":"/f.png"}\n\n'), { ok: true, result: { ok: true, file: '/f.png' } });
    assert.match(parseResult('nope', { status: 3 }).error, /exited 3 and its last line is not a result/u);
    assert.match(parseResult('', { status: 4 }).error, /exited 4 with no result line/u);
  });

  it('builds the request the contract fixes', () => {
    const request = buildRequest({
      baseUrl: 'http://127.0.0.1:8787', account: 'seeded', signIn: { kind: 'url', url: 'u' }, target: { name: 'home' }, viewport: 'desktop', out: '/o.png',
    });
    assert.deepEqual(Object.keys(request), ['mode', 'base_url', 'account', 'sign_in', 'target', 'element', 'shell', 'full_page', 'viewport', 'theme', 'locale', 'out']);
    assert.equal(request.full_page, false);
  });
});

describe('mc shot — the run', () => {
  it('dev signs in through /dev/login as the seeded account, and prints the path first', async () => {
    const fx = fixture();
    const result = await shot(['dev', 'home'], fx);
    assert.equal(result.code, 0, result.stderr);
    const [first, second] = result.stdout.split('\n');
    const side = sideOf(fx);
    assert.equal(first, side.request.out);
    assert.equal(second, 'http://127.0.0.1:8787/app/');
    assert.ok(existsSync(first));
    assert.match(first, /shots\/20260926-140309-dev-home-desktop\.png$/u);
    assert.deepEqual(side.request.sign_in, { kind: 'url', url: 'http://127.0.0.1:8787/dev/login?account=seeded&ready=1' });
    assert.equal(side.request.account, 'seeded');
    assert.equal(side.request.base_url, 'http://127.0.0.1:8787');
    assert.deepEqual(side.request.target, { name: 'home' });
    assert.match(result.stderr, /was already serving it/u, 'progress goes to stderr');
  });

  it('the four first-criterion forms each build their request', async () => {
    const fx = fixture();
    const forms = [
      [['dev', 'home'], { target: { name: 'home' }, shell: null, element: null }],
      [['dev', 'home', '--shell', 'base'], { target: { name: 'home' }, shell: 'base', element: null }],
      [['dev', 'notifications', '--shell', 'window'], { target: { name: 'notifications' }, shell: 'window', element: null }],
      [['dev', '/app/people', '--el', '.base-view__header'], { target: { path: '/app/people' }, shell: null, element: '.base-view__header' }],
    ];
    for (const [argv, want] of forms) {
      const result = await shot(argv, fx);
      assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`);
      const { request } = sideOf(fx);
      for (const [k, v] of Object.entries(want)) assert.deepEqual(request[k], v, `${argv.join(' ')}: ${k}`);
      assert.equal(result.stdout.split('\n')[0], request.out);
    }
  });

  it('prod signs in with the test token, and it leaks nowhere', async () => {
    const fx = fixture();
    const result = await shot(['prod', 'home', '--viewport', 'iphone', '--json'], fx);
    assert.equal(result.code, 0, result.stderr);
    const side = sideOf(fx);
    assert.deepEqual(side.request.sign_in, { kind: 'url', url: `https://meetmemoro.app/demo/${TOKEN}` });
    assert.equal(side.request.viewport, 'iphone');
    assert.equal(side.mode, 0o600, 'the request file is mode 0600');
    assert.equal(existsSync(side.file), false, 'and gone afterwards');
    assert.ok(!JSON.stringify(side.argv).includes(TOKEN), 'not in argv');
    assert.ok(!JSON.stringify(side.env).includes(TOKEN), 'not in the environment');
    assert.ok(!side.file.includes(TOKEN), 'not in the file name');
    assert.ok(!result.stdout.includes(TOKEN) && !result.stderr.includes(TOKEN), 'not in mc\'s output');
    assert.ok(!result.stdout.includes('/demo/'), 'nor the demo URL');
    assert.equal(JSON.parse(result.stdout).file, side.request.out);
  });

  it('a token exported in the shell is not handed on in the script\'s environment', async () => {
    const fx = fixture();
    const { tokenFor } = await import('../../src/mc/test-environment.js');
    const result = await shot(['prod', 'home'], fx, { tokenFor, env: { TEST_SEEDED_TOKEN: TOKEN } });
    assert.equal(result.code, 0, result.stderr);
    const side = sideOf(fx);
    assert.equal(side.request.sign_in.url, `https://meetmemoro.app/demo/${TOKEN}`);
    assert.ok(!JSON.stringify(side.env).includes(TOKEN));
  });

  it('prod without a token says how to store one', async () => {
    const fx = fixture();
    const result = await shot(['prod', 'home'], fx, { tokenFor: async () => ({ name: 'TEST_SEEDED_TOKEN', token: null }) });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, 'mc: no test-account token — printf %s <token> | mc test token --set\n');
  });

  it('--me signs in with the stored session, and it leaks nowhere', async () => {
    const fx = fixture();
    const result = await shot(['prod', 'home', '--me'], fx);
    assert.equal(result.code, 0, result.stderr);
    const side = sideOf(fx);
    assert.deepEqual(side.request.sign_in, { kind: 'session', cookie: COOKIE });
    assert.equal(side.request.account, 'me');
    assert.match(side.request.out, /-prod-me-home-desktop\.png$/u);
    assert.ok(!JSON.stringify(side.argv).includes(COOKIE));
    assert.ok(!JSON.stringify(side.env).includes(COOKIE));
    assert.ok(!result.stdout.includes(COOKIE) && !result.stderr.includes(COOKIE));
  });

  it('--me with nothing stored says mc shot login prod', async () => {
    const fx = fixture();
    const result = await shot(['prod', 'home', '--me'], fx, { getSecret: async () => '' });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, 'mc: no session of yours is stored — mc shot login prod\n');
  });

  it('not-signed-in for me points at the login', async () => {
    const fx = fixture();
    const result = await shot(['prod', 'home', '--me'], fx, { behaviour: 'not-signed-in' });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^mc: the session is not signed in at https:\/\/meetmemoro\.app\nmc shot login prod\n$/u);
    assert.equal(result.stdout, '');
  });

  it('a script printing garbage, or nothing, is an error that quotes its exit code', async () => {
    const fx = fixture();
    const garbage = await shot(['dev', 'home'], fx, { behaviour: 'garbage' });
    assert.equal(garbage.code, 1);
    assert.match(garbage.stderr, /exited 3 and its last line is not a result/u);
    const silent = await shot(['dev', 'home'], fx, { behaviour: 'silent' });
    assert.equal(silent.code, 1);
    assert.match(silent.stderr, /exited 4 with no result line/u);
    assert.equal(existsSync(sideOf(fx).file), false);
  });

  it('warnings are said, --out is honoured, --open opens the file', async () => {
    const fx = fixture();
    const opened = [];
    const result = await shot(['dev', '/app/people', '--out', 'pics/a.png', '--open'], fx, {
      behaviour: 'warn',
      platform: () => 'darwin',
      spawn: (cmd, args, options) => { opened.push({ cmd, args, options }); return { unref() {} }; },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.split('\n')[0], join(fx.home, 'pics', 'a.png'));
    assert.match(result.stdout, /mc: warning — 2 elements match; the first was captured/u);
    assert.deepEqual(opened.map((o) => [o.cmd, o.args]), [['open', [join(fx.home, 'pics', 'a.png')]]]);
    assert.equal(opened[0].options.detached, true);
  });
});

describe('mc shot login | logout prod', () => {
  it('login runs the script in login mode and stores the session without printing it', async () => {
    const fx = fixture();
    const stored = {};
    const result = await shot(['login', 'prod'], fx, { setSecret: async (k, v) => { stored[k] = v; } });
    assert.equal(result.code, 0, result.stderr);
    const { request } = sideOf(fx);
    assert.equal(request.mode, 'login');
    assert.equal(request.base_url, 'https://meetmemoro.app');
    assert.match(request.profile_dir, /shots\/\.chrome-profile-prod$/u);
    assert.equal(request.sign_in, undefined);
    assert.deepEqual(stored, { MEMORO_SHOT_SESSION: COOKIE });
    assert.equal(result.stdout, 'mc: your session is stored — mc shot prod <target> --me\n');
    assert.ok(!result.stderr.includes(COOKIE));
  });

  it('--paste reads stdin, strips the cookie name, and refuses nothing', async () => {
    const fx = fixture();
    const stored = {};
    const ok = await shot(['login', 'prod', '--paste'], fx, {
      readStdin: async () => ` memoro_session=${COOKIE}\n`, setSecret: async (k, v) => { stored[k] = v; },
    });
    assert.equal(ok.code, 0);
    assert.deepEqual(stored, { MEMORO_SHOT_SESSION: COOKIE });
    assert.ok(!ok.stdout.includes(COOKIE));
    assert.equal(existsSync(fx.side), false, 'no browser for a paste');
    const empty = await shot(['login', 'prod', '--paste'], fx, { readStdin: async () => '  \n' });
    assert.equal(empty.code, 1);
    assert.match(empty.stderr, /nothing was pasted/u);
  });

  it('logout forgets it', async () => {
    const fx = fixture();
    const deleted = [];
    const result = await shot(['logout', 'prod'], fx, { deleteSecret: async (k) => { deleted.push(k); } });
    assert.equal(result.code, 0);
    assert.deepEqual(deleted, ['MEMORO_SHOT_SESSION']);
  });
});
