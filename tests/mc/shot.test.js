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

import { run, servedTree, usage } from '../../src/mc/commands/shot.js';
import {
  accessLine, actionGap, buildRequest, CAPTURE_TIMEOUT_MS, captureTimeoutMs, outPath, parseActions, parseResult, parseSafeArea, parseScroll,
  parseTimeout, parseViewport, resolveAccount, resolveTarget, runCapture, slug, targetRequires,
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
console.log(JSON.stringify({ ok: true, file: request.out, url: request.base_url + '/app/', subject: request.element ? 'element' : request.shell ? 'shell' : 'page', selector: request.element, width: 10, height: 10, safe_area: request.safe_area, ...(request.measure ? { measure: [{ element: 'main.window-view__content', rect: { top: 0, bottom: 844 } }] } : {}), warnings: how === 'warn' ? ['2 elements match; the first was captured'] : [], ...(request.click && how !== 'no-clicked' ? { clicked: request.click } : {}), ...(request.actions && how !== 'no-acted' ? { acted: request.actions } : {}) }));
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
    assert.match(result.stderr, /no target called planing — a path under \/app or \/admin, or one of: home, notifications/u);
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
    assert.deepEqual(resolveTarget('/admin/security', SHOT_JSON), { ok: true, target: { path: '/admin/security' }, label: 'admin-security' });
    assert.equal(resolveTarget('/admin', SHOT_JSON).ok, true);
    assert.match(resolveTarget('/administrator', SHOT_JSON).error, /a path under \/app or \/admin/u);
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
    assert.deepEqual(Object.keys(request), [
      'mode', 'base_url', 'account', 'sign_in', 'target', 'element', 'shell', 'full_page', 'viewport', 'theme', 'locale', 'out',
      'safe_area', 'wait_for', 'scroll', 'measure', 'onboarding', 'click', 'actions', 'timeout_ms',
    ]);
    assert.equal(request.timeout_ms, null);
    assert.equal(request.onboarding, false);
    assert.equal(request.full_page, false);
    assert.equal(request.click, null);
    assert.equal(request.actions, null);
  });

  it('click reaches the request in order, and nothing asked is a null click', () => {
    const base = { baseUrl: 'http://127.0.0.1:8787', account: 'seeded', signIn: { kind: 'url', url: 'u' }, target: { name: 'home' }, viewport: 'desktop', out: '/o.png' };
    assert.deepEqual(buildRequest({ ...base, click: ['.tab', 'text=Save'] }).click, ['.tab', 'text=Save']);
    assert.equal(buildRequest({ ...base, click: [] }).click, null);
  });

  it('actions reach the request in order: click for clicks only, null once a fill or a press is among them', () => {
    const base = { baseUrl: 'http://127.0.0.1:8787', account: 'seeded', signIn: { kind: 'url', url: 'u' }, target: { name: 'home' }, viewport: 'desktop', out: '/o.png' };
    const clicks = [{ kind: 'click', selector: '.tab' }, { kind: 'click', selector: 'text=Save' }];
    const onlyClicks = buildRequest({ ...base, actions: clicks });
    assert.deepEqual(onlyClicks.actions, clicks);
    assert.deepEqual(onlyClicks.click, ['.tab', 'text=Save']);
    const mixed = [{ kind: 'click', selector: '.tab' }, { kind: 'fill', selector: 'input', text: 'hi' }];
    const withFill = buildRequest({ ...base, actions: mixed });
    assert.deepEqual(withFill.actions, mixed);
    assert.equal(withFill.click, null);
    assert.equal(buildRequest({ ...base, actions: [] }).actions, null);
    assert.equal(buildRequest(base).actions, null);
  });

  it('parseActions keeps argv order across the four flags', () => {
    assert.deepEqual(parseActions(['dev', 'home', '--click', 'a', '--fill', 'b=hi', '--context-click', 'c', '--long-press', 'd@800']), {
      ok: true,
      actions: [
        { kind: 'click', selector: 'a' },
        { kind: 'fill', selector: 'b', text: 'hi' },
        { kind: 'context-click', selector: 'c' },
        { kind: 'long-press', selector: 'd', ms: 800 },
      ],
    });
    assert.deepEqual(parseActions(['--long-press', 'd']), { ok: true, actions: [{ kind: 'long-press', selector: 'd', ms: 600 }] });
    assert.deepEqual(parseActions(['--fill', 'a=b=c', '--fill', 'd=']), {
      ok: true, actions: [{ kind: 'fill', selector: 'a', text: 'b=c' }, { kind: 'fill', selector: 'd', text: '' }],
    });
    assert.deepEqual(parseActions(['--fill', 'input[name=setupPassword]=a=b']), {
      ok: true, actions: [{ kind: 'fill', selector: 'input[name=setupPassword]', text: 'a=b' }],
    }, 'an attribute selector\'s = is the selector\'s');
    assert.deepEqual(parseActions(['dev', 'home']), { ok: true, actions: [] });
  });

  it('parseActions refuses a fill with no = or no selector, and a long press with no selector', () => {
    assert.deepEqual(parseActions(['--fill', 'b']), { ok: false, error: '--fill takes <css>=<text>' });
    assert.deepEqual(parseActions(['--fill', '=hi']), { ok: false, error: '--fill takes <css>=<text>' });
    assert.deepEqual(parseActions(['--long-press', '@800']), { ok: false, error: '--long-press takes <css>[@<ms>]' });
  });

  it('actionGap is silent when acted has the same length, names the picture when it is missing, and keeps the clicked rule for clicks', () => {
    const mixed = { actions: [{ kind: 'click', selector: '.tab' }, { kind: 'fill', selector: 'input', text: 'hi' }] };
    assert.equal(actionGap(mixed, { file: '/o.png', acted: mixed.actions }), null);
    assert.match(actionGap(mixed, { file: '/o.png', clicked: ['.tab'] }), /^the picture at \/o\.png was taken without the actions — .*--context-click, --long-press and --fill/u);
    assert.match(actionGap(mixed, { file: '/o.png', acted: [{}] }), /without the actions/u, 'one answer short');
    const clicks = { actions: [{ kind: 'click', selector: '.tab' }, { kind: 'click', selector: 'text=Save' }] };
    assert.equal(actionGap(clicks, { file: '/o.png', clicked: ['.tab', 'text=Save'] }), null);
    assert.equal(actionGap({ actions: null }, { file: '/o.png' }), null, 'nothing asked, nothing to say');
    assert.match(actionGap(clicks, { file: '/o.png' }), /^the picture at \/o\.png was taken without the clicks/u);
    assert.match(actionGap(clicks, { file: '/o.png', clicked: ['.tab'] }), /without the clicks/u, 'one answer short');
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

  it('--click repeats in order into the request, and the path is printed once the script says it clicked', async () => {
    const fx = fixture();
    const result = await shot(['dev', 'home', '--click', '.tab', '--click', 'text=Save'], fx);
    assert.equal(result.code, 0, result.stderr);
    const { request } = sideOf(fx);
    assert.deepEqual(request.click, ['.tab', 'text=Save']);
    assert.equal(result.stdout.split('\n')[0], request.out);
  });

  it('a script that does not say it clicked is refused, and no path is printed', async () => {
    const fx = fixture();
    const result = await shot(['dev', 'home', '--click', '.tab'], fx, { behaviour: 'no-clicked' });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /mc: the picture at .* was taken without the clicks/u);
    assert.equal(result.stdout, '');
  });

  it('without --click nothing is asked of the script, so a script that answers no clicks still captures', async () => {
    const fx = fixture();
    const result = await shot(['dev', 'home'], fx, { behaviour: 'no-clicked' });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(sideOf(fx).request.click, null);
  });

  it('the acting flags reach the request in the order given, and a script that does not answer acted is refused', async () => {
    const fx = fixture();
    const result = await shot(['dev', 'home', '--click', '.tab', '--fill', 'input.name=Ada', '--context-click', '.chip', '--long-press', '.chip@800'], fx);
    assert.equal(result.code, 0, result.stderr);
    const { request } = sideOf(fx);
    assert.deepEqual(request.actions, [
      { kind: 'click', selector: '.tab' },
      { kind: 'fill', selector: 'input.name', text: 'Ada' },
      { kind: 'context-click', selector: '.chip' },
      { kind: 'long-press', selector: '.chip', ms: 800 },
    ]);
    assert.equal(request.click, null);
    assert.equal(result.stdout.split('\n')[0], request.out);
    const old = await shot(['dev', 'home', '--context-click', '.chip'], fx, { behaviour: 'no-acted' });
    assert.equal(old.code, 1);
    assert.match(old.stderr, /mc: the picture at .* was taken without the actions/u);
    assert.equal(old.stdout, '');
    const bad = await shot(['dev', 'home', '--fill', 'input'], fx);
    assert.equal(bad.code, 2);
    assert.equal(bad.stderr, 'mc: --fill takes <css>=<text>\n');
  });
});

describe('mc shot — eval, upload, press, timeout, and what comes back', () => {
  const base = { baseUrl: 'http://127.0.0.1:8787', account: 'seeded', signIn: { kind: 'url', url: 'u' }, target: { name: 'home' }, viewport: 'desktop', out: '/o.png' };
  const captured = (result) => {
    const asked = [];
    return {
      asked,
      runCapture: ({ request }) => { asked.push(request); return { ok: true, result: { ok: true, file: '/tmp/x.png', url: 'http://127.0.0.1:8787/app/', warnings: [], ...result } }; },
    };
  };

  it('parseActions keeps argv order across the seven flags and --eval-file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-shot-acts-'));
    writeFileSync(join(dir, 'probe.js'), 'getComputedStyle(document.body).zIndex\n');
    writeFileSync(join(dir, 'rows.csv'), 'a,b\n');
    assert.deepEqual(parseActions([
      'dev', 'home', '--click', 'a', '--eval', '1 + 1', '--fill', 'b=hi', '--upload', 'input.csv=rows.csv',
      '--context-click', 'c', '--eval-file', 'probe.js', '--press', 'Meta+K', '--long-press', 'd@800',
    ], { cwd: dir }), {
      ok: true,
      actions: [
        { kind: 'click', selector: 'a' },
        { kind: 'eval', script: '1 + 1' },
        { kind: 'fill', selector: 'b', text: 'hi' },
        { kind: 'upload', selector: 'input.csv', file: join(dir, 'rows.csv') },
        { kind: 'context-click', selector: 'c' },
        { kind: 'eval', script: 'getComputedStyle(document.body).zIndex\n' },
        { kind: 'press', key: 'Meta+K' },
        { kind: 'long-press', selector: 'd', ms: 800 },
      ],
    });
  });

  it('the command hands the new kinds to the script in argv order', async () => {
    const fx = fixture();
    writeFileSync(join(fx.home, 'rows.csv'), 'a,b\n');
    const result = await shot(['dev', 'home', '--upload', 'input.import=rows.csv', '--press', 'Enter', '--eval', 'location.href'], fx);
    assert.equal(result.code, 0, result.stderr);
    const { request } = sideOf(fx);
    assert.deepEqual(request.actions, [
      { kind: 'upload', selector: 'input.import', file: join(fx.home, 'rows.csv') },
      { kind: 'press', key: 'Enter' },
      { kind: 'eval', script: 'location.href' },
    ]);
    assert.equal(request.click, null);
  });

  it('parseActions refuses a missing upload file, a bad --upload and an unreadable --eval-file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-shot-acts-'));
    assert.deepEqual(parseActions(['--upload', 'input=nope.csv'], { cwd: dir }), { ok: false, error: `--upload: no file at ${join(dir, 'nope.csv')}` });
    assert.deepEqual(parseActions(['--upload', 'input'], { cwd: dir }), { ok: false, error: '--upload takes <css>=<file>' });
    assert.deepEqual(parseActions(['--upload', '=a.csv'], { cwd: dir }), { ok: false, error: '--upload takes <css>=<file>' });
    assert.match(parseActions(['--eval-file', 'gone.js'], { cwd: dir }).error, /^--eval-file: cannot read .*gone\.js/u);
  });

  it('--timeout is whole seconds 1 to 120, and the spawn timeout grows with it', async () => {
    assert.deepEqual(parseTimeout(null), { ok: true, timeoutMs: null });
    assert.deepEqual(parseTimeout('30'), { ok: true, timeoutMs: 30_000 });
    for (const bad of ['0', '121', '2.5', 'ten']) assert.deepEqual(parseTimeout(bad), { ok: false, error: '--timeout is whole seconds, 1 to 120' }, bad);
    const fx = fixture();
    for (const bad of ['0', '121', '2.5']) {
      const result = await shot(['dev', 'home', '--timeout', bad], fx);
      assert.equal(result.code, 2, bad);
      assert.equal(result.stderr, 'mc: --timeout is whole seconds, 1 to 120\n', bad);
    }
    assert.equal(existsSync(fx.side), false, 'no refusal ran the script');

    assert.equal(captureTimeoutMs({ timeout_ms: null, actions: null }), CAPTURE_TIMEOUT_MS);
    assert.equal(captureTimeoutMs({ timeout_ms: 30_000, actions: [{}, {}] }), 60_000 + 4 * 30_000 * 3);
    const spawned = [];
    const fake = (request) => runCapture({
      worktree: fx.worktree,
      declaration: { argv: ['node', 'x'] },
      request,
      deps: { spawnSync: (cmd, args, options) => { spawned.push(options.timeout); return { status: 0, stdout: '{"ok":true}\n' }; } },
    });
    fake(buildRequest(base));
    fake(buildRequest({ ...base, timeoutMs: 60_000, actions: [{ kind: 'press', key: 'Enter' }] }));
    assert.deepEqual(spawned, [CAPTURE_TIMEOUT_MS, 60_000 + 4 * 60_000 * 2]);

    const ran = await shot(['dev', 'home', '--timeout', '45'], fx);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(sideOf(fx).request.timeout_ms, 45_000);
  });

  it('buildRequest writes timeout_ms after actions, and an eval action nulls click', () => {
    const request = buildRequest({ ...base, timeoutMs: 20_000, actions: [{ kind: 'click', selector: '.a' }, { kind: 'eval', script: '1' }] });
    assert.deepEqual(Object.keys(request).slice(-3), ['click', 'actions', 'timeout_ms']);
    assert.equal(request.timeout_ms, 20_000);
    assert.equal(request.click, null);
    for (const action of [{ kind: 'upload', selector: 'input', file: '/f' }, { kind: 'press', key: 'Enter' }]) {
      assert.equal(buildRequest({ ...base, actions: [action] }).click, null, action.kind);
    }
  });

  it('actionGap: a failed step is no gap, and an older script that answers no acted still is one', () => {
    const asked = { actions: [{ kind: 'eval', script: '1' }, { kind: 'press', key: 'Enter' }] };
    assert.match(actionGap(asked, { file: '/o.png' }), /taken without the actions/u);
    assert.equal(actionGap(asked, { file: '/o.png', acted: [{}], failed: { step: 2, kind: 'press', key: 'Enter', error: 'x' } }), null);
    assert.equal(actionGap({ actions: [{ kind: 'click', selector: '.a' }] }, { file: '/o.png', failed: { step: 1, kind: 'click', selector: '.a', error: 'x' } }), null);
  });

  it('prints error lines after the path with a count suffix, at most 20, and exits 0', async () => {
    const fx = fixture();
    const errors = [
      { kind: 'page', text: 'TypeError: a is undefined\n    at main.js:1' },
      { kind: 'console', text: 'x'.repeat(400), count: 3 },
      { kind: 'request', text: 'GET /api/x 500', count: 1 },
      ...Array.from({ length: 22 }, (_, i) => ({ kind: 'server', text: `log ${i}` })),
    ];
    const fake = captured({ errors });
    const result = await shot(['dev', 'home'], fx, fake);
    assert.equal(result.code, 0, result.stderr);
    const lines = result.stdout.trimEnd().split('\n');
    assert.equal(lines[0], '/tmp/x.png');
    assert.equal(lines[1], 'http://127.0.0.1:8787/app/');
    assert.equal(lines[2], 'error  page  TypeError: a is undefined at main.js:1');
    assert.equal(lines[3], `error  console  ${'x'.repeat(300)}… ×3`);
    assert.equal(lines[4], 'error  request  GET /api/x 500');
    assert.equal(lines.filter((line) => line.startsWith('error  ')).length, 21);
    assert.equal(lines.at(-1), 'error  … 5 more — --json has them all');
    const json = await shot(['dev', 'home', '--json'], fx, captured({ errors }));
    assert.equal(json.code, 0);
    assert.equal(JSON.parse(json.stdout).errors.length, 25);
  });

  it('prints eval lines: the value, what it threw, and a long value cut at 4000', async () => {
    const fx = fixture();
    const long = 'y'.repeat(5000);
    const result = await shot(['dev', 'home', '--eval', '1', '--eval', '2', '--eval', '3'], fx, captured({
      acted: [{}, {}, {}],
      errors: [{ kind: 'dialog', text: 'alert: hi' }],
      evaluated: [{ value: { z: 10, chain: ['a', 'b'] } }, { error: 'ReferenceError: q is not defined' }, { value: long }],
      warnings: ['w'],
    }));
    assert.equal(result.code, 0, result.stderr);
    const lines = result.stdout.trimEnd().split('\n');
    assert.deepEqual(lines.slice(2, 5), ['error  dialog  alert: hi', 'eval 1  {"z":10,"chain":["a","b"]}', 'eval 2  threw: ReferenceError: q is not defined']);
    assert.equal(lines[5], `eval 3  ${JSON.stringify(long).slice(0, 4000)}… (5002 bytes; --json has it whole)`);
    assert.equal(lines[6], 'mc: warning — w');
  });

  it('a failed step prints the path first, then the failed line and what is here, and exits 1', async () => {
    const fx = fixture();
    const result = await shot(['dev', 'home', '--click', '.hero-card__actions', '--press', 'Escape'], fx, captured({
      acted: [{}],
      failed: { step: 1, kind: 'click', selector: '.hero-card__actions', error: 'not visible within 10 s', here: '.vault-setup__progress' },
    }));
    assert.equal(result.code, 1);
    assert.deepEqual(result.stdout.trimEnd().split('\n'), [
      '/tmp/x.png',
      'http://127.0.0.1:8787/app/',
      'failed  step 1 (click .hero-card__actions): not visible within 10 s',
      '  here: .vault-setup__progress',
    ]);
    const key = await shot(['dev', 'home', '--press', 'Escape'], fx, captured({ acted: [], failed: { step: 1, kind: 'press', key: 'Escape', error: 'no page' } }));
    assert.equal(key.code, 1);
    assert.match(key.stdout, /^failed {2}step 1 \(press Escape\): no page$/mu);
  });

  it('an ok: false result with errors prints them after mc: <error>', async () => {
    const fx = fixture();
    const result = await shot(['dev', 'home'], fx, {
      runCapture: () => ({ ok: true, result: { ok: false, code: 'crashed', error: 'the page crashed', errors: [{ kind: 'page', text: 'Out of memory', count: 2 }] } }),
    });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.split('\n').slice(-3).join('\n'), 'mc: the page crashed\nerror  page  Out of memory ×2\n');
  });

  it('usage lists the new flags and the error paragraph', () => {
    for (const flag of ['--eval <js>', '--eval-file <path>', '--upload <css>=<file>', '--press <key>', '--timeout <s>', 'the seven act in the order']) {
      assert.ok(usage().includes(flag), flag);
    }
    assert.match(usage().replace(/\n/gu, ' '), /Every error the page, its requests, the dev server or a dialog raised during the shot prints as error lines after the path/u);
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

describe('mc shot — measuring a layout', () => {
  it('reads --safe-area and --scroll into what the script takes', () => {
    assert.deepEqual(parseSafeArea('47,0,34,0'), { ok: true, safeArea: { top: 47, right: 0, bottom: 34, left: 0 } });
    assert.deepEqual(parseSafeArea('0'), { ok: true, safeArea: { top: 0, right: 0, bottom: 0, left: 0 } });
    assert.deepEqual(parseSafeArea(null), { ok: true, safeArea: null });
    assert.equal(parseSafeArea('47,34').ok, false);
    assert.equal(parseSafeArea('-1').ok, false);
    assert.deepEqual(parseScroll('.window-view__content'), { ok: true, scroll: { selector: '.window-view__content', to: 'end' } });
    assert.deepEqual(parseScroll('[data-x="a"]@top'), { ok: true, scroll: { selector: '[data-x="a"]', to: 'top' } });
    assert.deepEqual(parseScroll('.x@350'), { ok: true, scroll: { selector: '.x', to: 350 } });
    assert.equal(parseScroll('.x@middle').ok, false);
    assert.deepEqual(parseScroll('@end'), { ok: true, scroll: { selector: null, to: 'end' } });
    assert.deepEqual(parseScroll('@top'), { ok: true, scroll: { selector: null, to: 'top' } });
    assert.deepEqual(parseScroll('@350'), { ok: true, scroll: { selector: null, to: 350 } });
    assert.equal(parseScroll('@middle').ok, false);
    assert.equal(parseScroll('').ok, false);
  });

  it('hands the measuring flags over, and prints the numbers on the line after the path', async () => {
    const fx = fixture();
    const result = await shot([
      'dev', '/app/assistant', '--viewport', 'iphone', '--safe-area', '47,0,34,0', '--wait-for', '.window-view--main-chat',
      '--scroll', '.window-view__content', '--measure', '.window-view__content, .assistant-summon',
    ], fx);
    assert.equal(result.code, 0, result.stderr);
    const { request } = sideOf(fx);
    assert.deepEqual(request.safe_area, { top: 47, right: 0, bottom: 34, left: 0 });
    assert.equal(request.wait_for, '.window-view--main-chat');
    assert.deepEqual(request.scroll, { selector: '.window-view__content', to: 'end' });
    assert.equal(request.measure, '.window-view__content, .assistant-summon');
    const lines = result.stdout.split('\n');
    assert.equal(lines[0], request.out, 'the path stays first, alone');
    const numbers = JSON.parse(lines[2]);
    assert.equal(numbers.measure[0].rect.bottom, 844);
    assert.deepEqual(numbers.safe_area, { top: 47, right: 0, bottom: 34, left: 0 });
  });

  it('signs in as the account asked for, reseeded for its onboarding', async () => {
    const fx = fixture();
    let result = await shot(['dev', 'home', '--account', 'new'], fx);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(sideOf(fx).request.sign_in.url, 'http://127.0.0.1:8787/dev/login?account=new&ready=1');
    assert.equal(sideOf(fx).request.account, 'new');
    result = await shot(['dev', 'home', '--onboarding'], fx);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(sideOf(fx).request.sign_in.url, 'http://127.0.0.1:8787/dev/login?account=seeded&reseed=1');
    assert.equal(sideOf(fx).request.onboarding, true);
  });

  it('refuses a measuring flag it cannot read, and the dev-only ones on prod', async () => {
    const fx = fixture();
    for (const [argv, said] of [
      [['dev', 'home', '--safe-area', '1,2'], /--safe-area is top,right,bottom,left/u],
      [['dev', 'home', '--scroll', '.x@middle'], /after @ comes end, top/u],
      [['dev', 'home', '--account', 'review'], /--account is one of seeded, new, not review/u],
      [['prod', 'home', '--account', 'new'], /are for dev/u],
      [['prod', 'home', '--onboarding'], /are for dev/u],
    ]) {
      const result = await shot(argv, fx);
      assert.equal(result.code, 2, argv.join(' '));
      assert.match(result.stderr, said, argv.join(' '));
    }
  });

  it('inside a memoro worktree, dev serves that worktree and says which tree it served', async () => {
    const fx = fixture();
    const result = await shot(['dev', 'home'], fx, {
      callerWorktree: () => fx.worktree,
      servedTree: (worktree) => ({ worktree, branch: 'fix-x', commit: 'abcdef1234', line: `${worktree} — fix-x @ abcdef1234` }),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /serving .*memoro — fix-x @ abcdef1234/u);
    const json = await shot(['dev', 'home', '--json'], fx, {
      callerWorktree: () => fx.worktree,
      servedTree: (worktree) => ({ worktree, branch: 'fix-x', commit: 'abcdef1234', line: 'x' }),
    });
    assert.equal(JSON.parse(json.stdout).served.branch, 'fix-x');
  });

  it('a server built with uncommitted changes says how many, so it is not read as its commit', () => {
    const git = (args) => ({ stdout: args[0] === 'branch' ? 'fix-x\n' : 'abcdef1234ffff\n' });
    const at = (dirty) => servedTree('/w', { url: 'http://127.0.0.1:8920', built_from: { commit: 'abcdef1234ffff', dirty } }, { git });
    assert.equal(at(['a.css', 'b.js']).line, '/w — fix-x @ abcdef1234 + 2 uncommitted files on http://127.0.0.1:8920');
    assert.equal(at(['a.css']).line, '/w — fix-x @ abcdef1234 + 1 uncommitted file on http://127.0.0.1:8920');
    assert.equal(at([]).line, '/w — fix-x @ abcdef1234 on http://127.0.0.1:8920');
    assert.equal(at([]).uncommitted, 0);
    // A manifest that does not list them says nothing either way.
    assert.equal(at(undefined).line, '/w — fix-x @ abcdef1234 on http://127.0.0.1:8920');
    assert.equal(at(undefined).uncommitted, null);
  });
});

describe('mc shot — the accounts table and a bare @end', () => {
  const ACCOUNTS = {
    default_account: 'seeded',
    accounts: {
      seeded: {
        summary: 'the managed seeded account',
        onboarding: { done: '/dev/login?account=seeded&ready=1&next=%2Fapp%2F', fresh: '/dev/login?account=seeded&reseed=1' },
      },
      new: {
        summary: 'an account that has never signed in',
        onboarding: { done: '/dev/login?account=new&ready=1', fresh: '/dev/login?account=new&reseed=1' },
      },
    },
  };
  const WITH_TABLE = {
    ...SHOT_JSON,
    ...ACCOUNTS,
    targets: [...SHOT_JSON.targets, { name: 'onboarding', path: '/app/', onboarding: 'fresh' }],
  };

  it('resolves the account and its onboarding state from the table', () => {
    assert.deepEqual(resolveAccount(ACCOUNTS), {
      ok: true, account: 'seeded', state: 'done', path: '/dev/login?account=seeded&ready=1&next=%2Fapp%2F',
    });
    assert.deepEqual(resolveAccount(ACCOUNTS, { account: 'new' }), { ok: true, account: 'new', state: 'done', path: '/dev/login?account=new&ready=1' });
    assert.deepEqual(resolveAccount({ ...ACCOUNTS, default_account: 'new' }), { ok: true, account: 'new', state: 'done', path: '/dev/login?account=new&ready=1' });
    assert.deepEqual(resolveAccount(ACCOUNTS, { onboarding: true }), { ok: true, account: 'seeded', state: 'fresh', path: '/dev/login?account=seeded&reseed=1' });
    assert.equal(resolveAccount(ACCOUNTS, { entry: { name: 'onboarding', onboarding: 'fresh' } }).path, '/dev/login?account=seeded&reseed=1');
    assert.equal(resolveAccount(ACCOUNTS, { entry: { onboarding: 'done' } }).state, 'done');
    assert.deepEqual(resolveAccount(ACCOUNTS, { account: 'review' }), { ok: false, error: '--account is one of seeded, new, not review' });
    const partial = { accounts: { seeded: { onboarding: { done: '/dev/login?account=seeded&ready=1' } } } };
    assert.deepEqual(resolveAccount(partial, { onboarding: true }), {
      ok: false, error: '.mc/shot.json: account seeded declares no onboarding state fresh',
    });
  });

  it('without a table, today\'s two sign-in paths', () => {
    assert.deepEqual(resolveAccount(SHOT_JSON), { ok: true, account: 'seeded', state: 'done', path: '/dev/login?account=seeded&ready=1' });
    assert.deepEqual(resolveAccount(SHOT_JSON, { account: 'new', onboarding: true }), {
      ok: true, account: 'new', state: 'fresh', path: '/dev/login?account=new&reseed=1',
    });
    assert.deepEqual(resolveAccount(SHOT_JSON, { account: 'review' }), { ok: false, error: '--account is one of seeded, new, not review' });
  });

  it('signs in through the table\'s paths, and a target that declares fresh', async () => {
    const fx = fixture({ shot: WITH_TABLE });
    let result = await shot(['dev', 'home'], fx);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(sideOf(fx).request.sign_in.url, 'http://127.0.0.1:8787/dev/login?account=seeded&ready=1&next=%2Fapp%2F');
    result = await shot(['dev', 'home', '--account', 'new'], fx);
    assert.equal(sideOf(fx).request.sign_in.url, 'http://127.0.0.1:8787/dev/login?account=new&ready=1');
    assert.equal(sideOf(fx).request.onboarding, false);
    result = await shot(['dev', 'onboarding', '--account', 'new', '--viewport', 'iphone'], fx);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(sideOf(fx).request.sign_in.url, 'http://127.0.0.1:8787/dev/login?account=new&reseed=1');
    assert.equal(sideOf(fx).request.onboarding, true);
    assert.equal(sideOf(fx).request.account, 'new');
    result = await shot(['dev', 'home', '--onboarding'], fx);
    assert.equal(sideOf(fx).request.sign_in.url, 'http://127.0.0.1:8787/dev/login?account=seeded&reseed=1');
  });

  it('refuses an account the table does not declare, before a server starts', async () => {
    const fx = fixture({ shot: WITH_TABLE });
    let started = false;
    const result = await shot(['dev', 'home', '--account', 'review'], fx, {
      ensureDevServer: async () => {
        started = true;
        return { ok: true, server: { url: 'http://127.0.0.1:8787/', instance_id: 'srv-1' }, started: false };
      },
    });
    assert.equal(result.code, 2);
    assert.equal(result.stderr, 'mc: --account is one of seeded, new, not review\n');
    assert.equal(started, false);
    assert.equal(existsSync(fx.side), false, 'no script ran');
  });

  it('--scroll @end passes a null selector: the declared scroller', async () => {
    const fx = fixture();
    const result = await shot(['dev', '/app/assistant', '--scroll', '@end', '--measure', '@layout'], fx);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(sideOf(fx).request.scroll, { selector: null, to: 'end' });
    assert.equal(sideOf(fx).request.measure, '@layout');
  });
});

describe('mc shot — a gated target', () => {
  const access = (over = {}) => ({
    requires: 'admin', account: 'new', role: 'user', expected: 'denied', page: 'denied', status: 200,
    probe: { path: '/api/admin/stats', status: 403, expected: '401/403' }, holds: true, ...over,
  });

  it('says what a role requires: declared, or admin under /admin', () => {
    assert.equal(targetRequires({ path: '/app/', access: { requires: 'owner' } }), 'owner');
    assert.equal(targetRequires({ path: '/admin/security' }), 'admin');
    assert.equal(targetRequires(null, '/admin'), 'admin');
    assert.equal(targetRequires({ path: '/app/admin' }), null);
  });

  it('says the verdict in one line, and only a gate that did not hold fails', () => {
    assert.deepEqual(accessLine(access()), {
      failed: false,
      line: 'access: requires admin — new (user) denied, as its role expects; the server answered /api/admin/stats with 403',
    });
    assert.deepEqual(accessLine(access({ page: 'granted', holds: false })), {
      failed: true,
      line: 'the admin gate did not hold: new (user) should be denied, the page was granted 200; the server answered /api/admin/stats with 403',
    });
    const unheld = accessLine(access({ role: null, expected: null, holds: null, probe: null }));
    assert.equal(unheld.failed, false);
    assert.match(unheld.line, /new declares no role, so nothing was held to it/u);
    assert.equal(accessLine(null), null);
  });

  it('prints the verdict after the path, and exits 1 when the gate did not hold — the picture is still taken', async () => {
    const fx = fixture();
    const capture = (verdict) => ({
      runCapture: () => ({ ok: true, result: { ok: true, file: '/tmp/x.png', warnings: [], access: verdict } }),
    });
    const held = await shot(['dev', '/admin/security', '--account', 'new'], fx, capture(access()));
    assert.equal(held.code, 0, held.stderr);
    assert.deepEqual(held.stdout.split('\n').slice(0, 2), ['/tmp/x.png', accessLine(access()).line]);
    const broken = await shot(['dev', '/admin/security', '--account', 'new'], fx, capture(access({ page: 'granted', holds: false })));
    assert.equal(broken.code, 1);
    assert.equal(broken.stdout, '/tmp/x.png\n');
    assert.match(broken.stderr, /mc: the admin gate did not hold: new \(user\) should be denied, the page was granted/u);
    const json = await shot(['dev', '/admin/security', '--json'], fx, capture(access({ page: 'granted', holds: false })));
    assert.equal(json.code, 1);
    assert.equal(JSON.parse(json.stdout).access.holds, false);
  });
});
