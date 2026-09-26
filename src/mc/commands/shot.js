/**
 * `mc shot` — a PNG of the running app, from a dev server or from production.
 *
 *   mc shot <dev|prod> <target> [--el <css>] [--shell base|immersive|window]
 *           [--full] [--viewport <name|WxH[@dpr]>] [--theme light|dark]
 *           [--locale <code>] [--me] [--here] [--out <file.png>] [--open] [--json]
 *   mc shot <dev|prod> --list
 *   mc shot login prod [--paste]
 *   mc shot logout prod
 *
 * The worktree and the server are found the way `mc test dev|prod` finds
 * them: the shared checkout unless `--here`, a dev server started through the
 * same `ensureAppServer`, production's base URL from `.mc/test.json`. What is
 * pictured, and how, is memoro's: `.mc/shot.json` names the script, and mc
 * hands it one request file and reads back one result line (src/mc/shot.js).
 *
 * The file's path is the first line on stdout, alone, so a caller can take
 * `$(mc shot … | head -1)`; every progress line goes to stderr. A token or a
 * session is never printed, never in `--json`, never in argv.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { deleteSecret, getSecret, setSecret } from '../../lib/keychain.js';
import { openCommandFor } from '../../lib/device-flow.js';
import { mcHome } from '../paths.js';
import {
  SESSION_SECRET, SHELLS, THEMES, buildLoginRequest, buildRequest, outPath, parseViewport,
  readShotDeclaration, resolveTarget, runCapture,
} from '../shot.js';
import {
  callerWorktree, ensureAppServer, readDeclaration, sharedWorktree, tokenFor,
} from '../test-environment.js';
import { scanArgs } from './flags.js';

const PLACES = ['dev', 'prod'];

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const io = { stdout, stderr, deps };

  if (argv[0] === 'login' || argv[0] === 'logout') return account(argv[0], argv.slice(1), io);

  const scanned = scanArgs(argv, {
    booleans: ['--full', '--me', '--here', '--open', '--json', '--list'],
    strictValues: ['--el', '--shell', '--viewport', '--theme', '--locale', '--out'],
  });
  if (scanned.error) { stderr.write(`mc: ${scanned.error}\n${usage()}`); return 2; }
  const { flags, positional } = scanned;
  const [where, word, ...extra] = positional;
  if (!PLACES.includes(where)) {
    stderr.write(`mc: mc shot takes dev or prod first${where ? `, not ${where}` : ''}\n${usage()}`);
    return 2;
  }
  if (extra.length) { stderr.write(`mc: one target at a time (${extra.join(' ')} is extra)\n`); return 2; }
  if (flags.me && where === 'dev') {
    stderr.write('mc: --me is for prod — a dev server has only the accounts /dev/login offers\n');
    return 2;
  }
  if (flags.here && where === 'prod') {
    stderr.write('mc: --here is for dev — production has one app, not one per worktree\n');
    return 2;
  }
  if (flags.shell && !SHELLS.includes(flags.shell)) {
    stderr.write(`mc: --shell is ${SHELLS.join(', ')}, not ${flags.shell}\n`);
    return 2;
  }
  if (flags.theme && !THEMES.includes(flags.theme)) {
    stderr.write(`mc: --theme is light or dark, not ${flags.theme}\n`);
    return 2;
  }
  if (flags.el && flags.shell) {
    stderr.write('mc: --el and --shell both pick what is pictured — give one\n');
    return 2;
  }
  if (flags.out && !flags.out.endsWith('.png')) {
    stderr.write(`mc: --out ends in .png, and ${flags.out} does not\n`);
    return 2;
  }
  if (!flags.list && !word) {
    stderr.write(`mc: mc shot ${where} needs a target — a path under /app or a name from mc shot ${where} --list\n`);
    return 2;
  }

  const env = deps.env || process.env;
  const cwd = deps.cwd || process.cwd();
  const worktree = flags.here
    ? (deps.callerWorktree || callerWorktree)(cwd)
    : sharedWorktree(env);
  if (!worktree) {
    stderr.write(flags.here
      ? 'mc: --here needs a git worktree, and this is not one\n'
      : 'mc: no memoro checkout to read .mc/shot.json from\n');
    return 1;
  }
  const shot = readShotDeclaration(worktree);
  if (!shot.ok) { stderr.write(`mc: ${shot.error}\n`); return 1; }
  const declared = shot.declaration;

  if (flags.list) return listing(declared, { stdout });

  const target = resolveTarget(word, declared);
  if (!target.ok) { stderr.write(`mc: ${target.error}\n`); return 2; }
  const viewport = parseViewport(flags.viewport, declared);
  if (!viewport.ok) { stderr.write(`mc: ${viewport.error}\n`); return 2; }

  const read = readDeclaration(worktree);
  if (!read.ok) { stderr.write(`mc: ${read.error}\n`); return 1; }
  const { declaration } = read;

  // Where the app is, and who signs in. Three cases and no fourth.
  let baseUrl = null;
  let signIn = null;
  let who = 'seeded';
  const secrets = [];
  if (where === 'dev') {
    const app = await ensureAppServer(worktree, declaration, { json: flags.json, stdout: stderr, deps });
    if (!app.ok) { stderr.write(`mc: ${app.error}\n`); return 1; }
    baseUrl = app.baseUrl;
    signIn = { kind: 'url', url: `${baseUrl}/dev/login?account=seeded&ready=1` };
  } else {
    baseUrl = prodBase(declaration);
    if (!baseUrl) { stderr.write(`mc: ${worktree} declares no production base_url\n`); return 1; }
    if (flags.me) {
      const cookie = String(await (deps.getSecret || getSecret)(SESSION_SECRET).catch(() => '') || '').trim();
      if (!cookie) { stderr.write('mc: no session of yours is stored — mc shot login prod\n'); return 1; }
      secrets.push(cookie);
      signIn = { kind: 'session', cookie };
      who = 'me';
    } else {
      const held = await (deps.tokenFor || tokenFor)(declaration, env);
      if (!held.token) { stderr.write('mc: no test-account token — printf %s <token> | mc test token --set\n'); return 1; }
      secrets.push(held.token);
      signIn = { kind: 'url', url: `${baseUrl}${declaration.account?.route || '/demo/'}${held.token}` };
    }
  }

  const out = flags.out
    ? resolve(cwd, flags.out)
    : outPath({
      dir: join(mcHome(), 'shots'),
      now: deps.now ? deps.now() : new Date(),
      where,
      me: who === 'me',
      target: target.label,
      shell: flags.shell,
      element: flags.el,
      viewport: viewport.label,
      theme: flags.theme,
    });
  mkdirSync(dirname(out), { recursive: true });

  const request = buildRequest({
    baseUrl,
    account: who,
    signIn,
    target: target.target,
    element: flags.el,
    shell: flags.shell,
    full: flags.full,
    viewport: viewport.viewport,
    theme: flags.theme,
    locale: flags.locale,
    out,
  });
  const ran = runCapture({ worktree, declaration: declared, request, env: withoutToken(env, declaration), deps });
  const scrub = scrubber(secrets);
  if (!ran.ok) { stderr.write(`mc: ${scrub(ran.error)}\n`); return 1; }
  const { result } = ran;
  if (!result.ok) {
    stderr.write(`mc: ${scrub(result.error || result.code || 'the capture failed')}\n`);
    if (result.code === 'not-signed-in' && who === 'me') stderr.write('mc shot login prod\n');
    return 1;
  }
  if (typeof result.file !== 'string' || !result.file) {
    stderr.write('mc: the capture script said ok and named no file\n');
    return 1;
  }
  if (flags.json) {
    stdout.write(`${scrub(JSON.stringify(result, null, 2))}\n`);
  } else {
    stdout.write(`${result.file}\n`);
    if (result.url) stdout.write(`${scrub(result.url)}\n`);
    for (const warning of result.warnings || []) stdout.write(`mc: warning — ${scrub(warning)}\n`);
  }
  if (flags.open) openFile(result.file, deps);
  return 0;
}

/** `mc shot login prod [--paste]` and `mc shot logout prod`. */
async function account(verb, argv, { stdout, stderr, deps }) {
  const scanned = scanArgs(argv, { booleans: verb === 'login' ? ['--paste'] : [] });
  if (scanned.error) { stderr.write(`mc: ${scanned.error}\n${usage()}`); return 2; }
  const [where, ...extra] = scanned.positional;
  if (where !== 'prod' || extra.length) {
    stderr.write(`mc: mc shot ${verb} is for prod only — a dev server signs in through /dev/login\n`);
    return 2;
  }
  if (verb === 'logout') {
    await (deps.deleteSecret || deleteSecret)(SESSION_SECRET);
    stdout.write('mc: your session is forgotten\n');
    return 0;
  }

  let session = null;
  if (scanned.flags.paste) {
    const raw = await (deps.readStdin || readStdin)();
    session = String(raw || '').trim().replace(/^memoro_session=/u, '').trim();
    if (!session) {
      stderr.write('mc: nothing was pasted — pipe the memoro_session cookie value in on stdin\n');
      return 1;
    }
  } else {
    const env = deps.env || process.env;
    const worktree = sharedWorktree(env);
    if (!worktree) { stderr.write('mc: no memoro checkout to read .mc/shot.json from\n'); return 1; }
    const shot = readShotDeclaration(worktree);
    if (!shot.ok) { stderr.write(`mc: ${shot.error}\n`); return 1; }
    const read = readDeclaration(worktree);
    if (!read.ok) { stderr.write(`mc: ${read.error}\n`); return 1; }
    const baseUrl = prodBase(read.declaration);
    if (!baseUrl) { stderr.write(`mc: ${worktree} declares no production base_url\n`); return 1; }
    const profileDir = join(mcHome(), 'shots', '.chrome-profile-prod');
    mkdirSync(profileDir, { recursive: true });
    const ran = runCapture({
      worktree, declaration: shot.declaration, request: buildLoginRequest({ baseUrl, profileDir }), env, deps,
    });
    if (!ran.ok) { stderr.write(`mc: ${ran.error}\n`); return 1; }
    if (!ran.result.ok) { stderr.write(`mc: ${ran.result.error || ran.result.code || 'the login failed'}\n`); return 1; }
    session = String(ran.result.session || '').trim();
    if (!session) { stderr.write('mc: the capture script said ok and gave no session\n'); return 1; }
  }
  await (deps.setSecret || setSecret)(SESSION_SECRET, session);
  stdout.write('mc: your session is stored — mc shot prod <target> --me\n');
  return 0;
}

/**
 * The environment the script gets, less the test account: a token exported in
 * this shell reaches the script through the request file and nowhere else.
 */
function withoutToken(env, declaration) {
  const next = { ...env };
  for (const name of [declaration?.account?.token_env, declaration?.account?.url_env]) {
    if (name) delete next[name];
  }
  return next;
}

function prodBase(declaration) {
  const url = declaration?.environments?.prod?.base_url;
  return url ? String(url).replace(/\/+$/u, '') : null;
}

/** What `.mc/shot.json` offers: its targets and its viewports. */
function listing(declared, { stdout }) {
  stdout.write('targets:\n');
  for (const target of declared.targets) stdout.write(`  ${target.name}  ${target.path || ''}\n`);
  stdout.write(`viewports (default ${declared.default_viewport || 'desktop'}):\n`);
  for (const [name, size] of Object.entries(declared.viewports || {})) {
    stdout.write(`  ${name}  ${size.width}x${size.height}@${size.dpr ?? 1}${size.mobile ? ' mobile' : ''}\n`);
  }
  stdout.write('  or WxH[@dpr]\n');
  return 0;
}

/** Belt and braces: a secret the script echoed anyway is not passed on. */
function scrubber(secrets) {
  const live = secrets.filter(Boolean);
  return (text) => live.reduce((out, secret) => out.split(secret).join('<redacted>'), String(text));
}

function openFile(file, deps) {
  const how = openCommandFor((deps.platform || platform)());
  if (!how) return;
  const child = (deps.spawn || spawn)(how.cmd, [...how.args, file], { detached: true, stdio: 'ignore' });
  child.on?.('error', () => {});
  child.unref?.();
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export function usage() {
  return [
    'usage — mc shot <dev|prod> <target>   a PNG of the running app; prints its path first, alone\n',
    '          [--el <css>]                one element\n',
    '          [--shell base|immersive|window]  one shell\n',
    '          [--full]                    the whole scrolled page\n',
    '          [--viewport <name|WxH[@dpr]>]    a declared viewport or a size (dpr 2)\n',
    '          [--theme light|dark] [--locale <code>]\n',
    '          [--me]                      prod only: signed in as you, from mc shot login prod\n',
    '          [--here]                    dev only: a server for the worktree you stand in\n',
    '          [--out <file.png>] [--open] [--json]\n',
    '        mc shot <dev|prod> --list     the targets and viewports memoro declares\n',
    '        mc shot login prod            sign in once in a browser; mc keeps the session\n',
    '        mc shot login prod --paste    …or pipe it in: the memoro_session cookie value from\n',
    '                                      meetmemoro.app, Chrome DevTools → Application → Cookies\n',
    '        mc shot logout prod           forget it\n',
    '\n',
    'A target is a path under /app or a name from memoro\'s .mc/shot.json. Without --out the\n',
    'file goes under ~/.memoro/mc/shots/. dev signs in as the seeded account through\n',
    '/dev/login; prod as the test account, or as you with --me.\n',
  ].join('');
}
