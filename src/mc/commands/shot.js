/**
 * `mc shot` — a PNG of the running app, from a dev server or from production.
 *
 *   mc shot <dev|prod> <target> [--el <css>] [--shell base|immersive|window]
 *           [--full] [--viewport <name|WxH[@dpr]>] [--theme light|dark]
 *           [--locale <code>] [--safe-area <t,r,b,l>] [--wait-for <css>]
 *           [--scroll <css>[@end|@top|@<px>] | @end] [--measure <css> | @<name>]
 *           [--click <selector>]… [--context-click <css>]… [--long-press <css>[@ms]]…
 *           [--fill <css>=<text>]… [--eval <js> | --eval-file <path>]…
 *           [--upload <css>=<file>]… [--press <key>]… [--timeout <s>]
 *           [--account <name>] [--onboarding] [--me] [--here]
 *           [--compare <ref>] [--out <file.png>] [--open] [--json]
 *   mc shot <dev|prod> --list
 *   mc shot <dev|prod> <target> --keep [shot flags]
 *   mc shot next [<id>] [step flags] · mc shot close [<id>|--all] · mc shot sessions
 *   mc shot login prod [--paste]
 *   mc shot logout prod
 *
 * The worktree is the one you stand in when it is a memoro worktree (it has
 * `.mc/shot.json`), else the shared checkout — a session photographs its own
 * change without having to remember `--here`. The server is started through the
 * same `ensureAppServer`, production's base URL from `.mc/test.json`. What is
 * pictured, and how, is memoro's: `.mc/shot.json` names the script, and mc
 * hands it one request file and reads back one result line (src/mc/shot.js).
 *
 * The file's path is the first line on stdout, alone, so a caller can take
 * `$(mc shot … | head -1)`; every progress line goes to stderr. What the shot
 * met — the page's errors, each `--eval`'s value, a step that failed — comes
 * after it, in the same call (`reportLines`). A token or a
 * session is never printed, never in `--json`, never in argv.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { deleteSecret, getSecret, setSecret } from '../../lib/keychain.js';
import { openCommandFor } from '../../lib/device-flow.js';
import { run as runGit } from '../git.js';
import { mcHome } from '../paths.js';
import { runCompare } from '../shot-compare.js';
import {
  SESSION_SECRET, SHELLS, THEMES, accessLine, accountTable, actionGap, buildLoginRequest, buildRequest, outPath,
  errorLines, parseActions, parseSafeArea, parseScroll, parseTimeout, parseViewport, readShotDeclaration, reportLines, resolveAccount,
  resolveTarget, runCapture, shotWorktree,
} from '../shot.js';
import {
  ensureAppServer, NO_SHARED_WORKTREE, readDeclaration, sharedWorktree, tokenFor,
} from '../test-environment.js';
import { scanArgs } from './flags.js';
import {
  close, keep, next, sessions,
} from './shot-session.js';

const PLACES = ['dev', 'prod'];

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const io = { stdout, stderr, deps };

  if (argv[0] === 'login' || argv[0] === 'logout') return account(argv[0], argv.slice(1), io);
  if (argv[0] === 'next') return next(argv.slice(1), io);
  if (argv[0] === 'close') return close(argv.slice(1), io);
  if (argv[0] === 'sessions') return sessions(argv.slice(1), io);

  const scanned = scanArgs(argv, {
    booleans: ['--full', '--me', '--here', '--open', '--json', '--list', '--onboarding', '--keep'],
    strictValues: [
      '--el', '--shell', '--viewport', '--theme', '--locale', '--out',
      '--safe-area', '--wait-for', '--scroll', '--measure', '--account', '--compare', '--timeout',
    ],
    repeatable: ['--click', '--context-click', '--long-press', '--fill', '--eval', '--eval-file', '--upload', '--press'],
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
  if ((flags.account || flags.onboarding) && where === 'prod') {
    stderr.write('mc: --account and --onboarding are for dev — production signs in as the test account or as you\n');
    return 2;
  }
  if (flags.compare && where === 'prod') {
    stderr.write('mc: --compare is for dev — production has one tree\n');
    return 2;
  }
  if (flags.keep && flags.compare) {
    stderr.write('mc: --keep keeps one browser and --compare runs two\n');
    return 2;
  }
  if (flags.compare && flags.out) {
    stderr.write('mc: --compare writes two files and --out names one — two files need two names\n');
    return 2;
  }
  const safeArea = parseSafeArea(flags['safe-area']);
  if (!safeArea.ok) { stderr.write(`mc: ${safeArea.error}\n`); return 2; }
  const scroll = parseScroll(flags.scroll);
  if (!scroll.ok) { stderr.write(`mc: ${scroll.error}\n`); return 2; }
  // The acting flags in the order given; --click's count must agree with scanArgs'.
  const acting = parseActions(argv, { cwd: deps.cwd || process.cwd(), deps });
  if (!acting.ok) { stderr.write(`mc: ${acting.error}\n`); return 2; }
  const timeout = parseTimeout(flags.timeout);
  if (!timeout.ok) { stderr.write(`mc: ${timeout.error}\n`); return 2; }
  if (acting.actions.filter((action) => action.kind === 'click').length !== flags.click.length) {
    stderr.write('mc: --click was read two ways — report it\n');
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
    stderr.write(`mc: mc shot ${where} needs a target — a path under /app or /admin, or a name from mc shot ${where} --list\n`);
    return 2;
  }

  const env = deps.env || process.env;
  const cwd = deps.cwd || process.cwd();
  const chosen = shotWorktree({ cwd, env, here: flags.here, deps });
  if (!chosen.worktree) { stderr.write(`mc: ${chosen.error}\n`); return 1; }
  const { worktree } = chosen;
  const shot = readShotDeclaration(worktree);
  if (!shot.ok) { stderr.write(`mc: ${shot.error}\n`); return 1; }
  const declared = shot.declaration;

  if (flags.list) return listing(declared, { stdout });

  const target = resolveTarget(word, declared);
  if (!target.ok) { stderr.write(`mc: ${target.error}\n`); return 2; }
  const entry = target.target.name ? (declared.targets.find((item) => item.name === target.target.name) ?? null) : null;
  const viewport = parseViewport(flags.viewport, declared);
  if (!viewport.ok) { stderr.write(`mc: ${viewport.error}\n`); return 2; }

  const read = readDeclaration(worktree);
  if (!read.ok) { stderr.write(`mc: ${read.error}\n`); return 1; }
  const { declaration } = read;

  // Where the app is, and who signs in. Three cases and no fourth.
  let baseUrl = null;
  let signIn = null;
  let who = flags.account || 'seeded';
  let served = null;
  let serverId = null;
  let resolved = null;
  const secrets = [];
  if (where === 'dev') {
    // Refused before a server is started, so a wrong name costs no server.
    resolved = resolveAccount(declared, { account: flags.account, onboarding: flags.onboarding, entry });
    if (!resolved.ok) { stderr.write(`mc: ${resolved.error}\n`); return 2; }
    const app = await (deps.ensureAppServer || ensureAppServer)(worktree, declaration, { json: flags.json, stdout: stderr, deps });
    if (!app.ok) { stderr.write(`mc: ${app.error}\n`); return 1; }
    baseUrl = app.baseUrl;
    served = (deps.servedTree || servedTree)(worktree, app.server);
    serverId = app.server?.instance_id ?? null;
    if (!flags.json) stderr.write(`mc: ${flags.compare ? 'here: ' : ''}serving ${served.line}\n`);
    who = resolved.account;
    signIn = { kind: 'url', url: `${baseUrl}${resolved.path}` };
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
    safeArea: safeArea.safeArea,
    waitFor: flags['wait-for'],
    scroll: scroll.scroll,
    measure: flags.measure,
    onboarding: resolved?.state === 'fresh',
    actions: acting.actions,
    timeoutMs: timeout.timeoutMs,
  });
  const scrub = scrubber(secrets);
  if (flags.keep) {
    return keep({
      worktree,
      declared,
      request,
      session: {
        where, worktree, account: who, target: word, viewport: viewport.label, base_url: baseUrl, server_id: serverId,
        ...(where === 'dev' ? { sign_in_path: resolved.path } : {}),
      },
      served,
      env: withoutToken(env, declaration),
      flags,
      scrub,
      stdout,
      stderr,
      deps,
    });
  }
  if (flags.compare) {
    return runCompare({
      worktree,
      ref: flags.compare,
      declared,
      request,
      signInPath: resolved.path,
      served,
      servedTree: deps.servedTree || servedTree,
      env: withoutToken(env, declaration),
      json: flags.json,
      open: flags.open,
      scrub,
      stdout,
      stderr,
      openFile: (file) => openFile(file, deps),
      deps,
    });
  }
  const ran = (deps.runCapture || runCapture)({ worktree, declaration: declared, request, env: withoutToken(env, declaration), deps });
  if (!ran.ok) { stderr.write(`mc: ${scrub(ran.error)}\n`); return 1; }
  return answer(ran.result, {
    request, served, who, json: flags.json, open: flags.open, scrub, stdout, stderr, deps,
  });
}

/**
 * A capture's result line, printed: the path alone first, the URL, the measure
 * line, the access line, then what the shot met (`reportLines`) and the
 * warnings — or `--json`'s object. The exit code: 1 for a failure, a step that
 * failed or a gate that did not hold, else 0. A kept browser's every step is
 * printed here too (src/mc/commands/shot-session.js), so a session reads a
 * step as it reads a shot; `picture: false` is a step asked for no picture,
 * which answers without the path line.
 */
export function answer(result, {
  request, served = null, who = null, json = false, open = false, picture = true,
  scrub = (text) => String(text), stdout, stderr, deps = {},
}) {
  if (!result.ok) {
    stderr.write(`mc: ${scrub(result.error || result.code || 'the capture failed')}\n`);
    // A page that crashed before the picture still says why.
    for (const line of errorLines(result)) stderr.write(`${scrub(line)}\n`);
    if (result.code === 'not-signed-in' && who === 'me') stderr.write('mc shot login prod\n');
    return 1;
  }
  if (picture && (typeof result.file !== 'string' || !result.file)) {
    stderr.write('mc: the capture script said ok and named no file\n');
    return 1;
  }
  // A picture asked with actions is one only if the script says it did them.
  const gap = actionGap(request, result);
  if (gap) { stderr.write(`mc: ${scrub(gap)}\n`); return 1; }
  // A gated target's verdict: the picture is taken either way, and a gate
  // that did not hold makes the exit 1.
  const access = accessLine(result.access);
  // What the shot met, in the same call. An error is information; only a
  // failed step (pictured as the page stood) makes the exit 1.
  const report = reportLines(result);
  if (json) {
    stdout.write(`${scrub(JSON.stringify(served ? { ...result, served } : result, null, 2))}\n`);
  } else {
    if (picture) stdout.write(`${result.file}\n`);
    if (result.url) stdout.write(`${scrub(result.url)}\n`);
    // The numbers, one line, after the path: what a layout question turns on.
    if (result.measure) stdout.write(`${scrub(JSON.stringify({ measure: result.measure, safe_area: result.safe_area ?? null }))}\n`);
    if (access && !access.failed) stdout.write(`${scrub(access.line)}\n`);
    for (const line of report.lines) stdout.write(`${scrub(line)}\n`);
    for (const warning of result.warnings || []) stdout.write(`mc: warning — ${scrub(warning)}\n`);
  }
  if (access?.failed) stderr.write(`mc: ${scrub(access.line)}\n`);
  if (open && picture && result.file) openFile(result.file, deps);
  return access?.failed || report.failed ? 1 : 0;
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
    if (!worktree) { stderr.write(`mc: ${NO_SHARED_WORKTREE}\n`); return 1; }
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
 * Which tree the server is serving, said rather than assumed: the branch and
 * commit it was built from, and the files edited since it started — none
 * after `ensureAppServer`, which starts a fresh one when there are. A port is
 * the server's opinion of itself; this is the evidence. A server built with
 * uncommitted changes says how many (`built_from.dirty`), so two trees at the
 * same commit are not read as the same tree (2026-10-16: a `--compare` of an
 * edited worktree against its own HEAD printed `@ <commit>` on both sides).
 */
export function servedTree(worktree, server, deps = {}) {
  const git = deps.git || ((args) => runGit(worktree, args));
  const branch = String(git(['branch', '--show-current']).stdout || '').trim() || '(detached)';
  const commit = String(server?.built_from?.commit || git(['rev-parse', 'HEAD']).stdout || '').trim().slice(0, 10);
  const dirty = server?.built_from?.dirty;
  const uncommitted = Array.isArray(dirty) ? dirty.length : null;
  const url = server?.url || null;
  const edits = uncommitted ? ` + ${uncommitted} uncommitted ${uncommitted === 1 ? 'file' : 'files'}` : '';
  return {
    worktree, branch, commit, uncommitted, url,
    line: `${worktree} — ${branch} @ ${commit}${edits}${url ? ` on ${url}` : ''}`,
  };
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
  const table = accountTable(declared);
  if (table) {
    stdout.write(`accounts (default ${declared.default_account || 'seeded'}):\n`);
    for (const [name, account] of Object.entries(table)) {
      stdout.write(`  ${name}  ${Object.keys(account?.onboarding || {}).join(', ')}  ${account?.summary || ''}\n`);
    }
  }
  return 0;
}

/** Belt and braces: a secret the script echoed anyway is not passed on. */
function scrubber(secrets) {
  const live = secrets.filter(Boolean);
  return (text) => live.reduce((out, secret) => out.split(secret).join('<redacted>'), String(text));
}

export function openFile(file, deps) {
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
    '          [--safe-area <t,r,b,l>|0]    insets as a phone reports them; iphone carries 47,0,34,0\n',
    '          [--wait-for <css>]          wait until it is visible\n',
    '          [--scroll <css>[@end|@top|@<px>] | @end]\n',
    '                                      scroll that element first (@end by default); a bare\n',
    '                                      @end/@top scrolls the surface\'s declared scroller\n',
    '          [--measure <css> | @<name>]  print every match\'s box, padding, position, scroll, colours and\n',
    '                                      visibility as one JSON line after the path; a name is\n',
    '                                      one of the surface\'s declared measurements (mc dev surfaces)\n',
    '          [--click <selector>]        press it after the page and its window are open and before\n',
    '                                      --wait-for/--scroll/--el; repeatable, in order; a CSS selector\n',
    '                                      or text=<words>, as memoro\'s capture script reads locators\n',
    '          [--context-click <css>]     right-click it\n',
    '          [--long-press <css>[@ms]]   press and hold it (600 ms unless said)\n',
    '          [--fill <css>=<text>]       type text into it\n',
    '          [--eval <js> | --eval-file <path>]\n',
    '                                      run it in the page; its value prints as eval <n>\n',
    '          [--upload <css>=<file>]     choose the file in that file input\n',
    '          [--press <key>]             press a key (Enter, Escape, Meta+K)\n',
    '                                      the seven act in the order they are given\n',
    '          [--timeout <s>]             how long each wait and action may take (10 s)\n',
    '          [--account <name>]          dev only: an account .mc/shot.json declares (seeded by default)\n',
    '          [--onboarding]              dev only: reseed the account and show its onboarding\n',
    '          [--me]                      prod only: signed in as you, from mc shot login prod\n',
    '          [--here]                    the worktree you stand in — the default inside a memoro worktree\n',
    '          [--compare <ref>]           dev only: the same picture and numbers on <ref>, and what moved\n',
    '                                      --compare <sha> pins the tree and its database\n',
    '          [--keep]                    keep the browser open for mc shot next\n',
    '          [--out <file.png>] [--open] [--json]\n',
    '        mc shot next [<id>] [step flags]   one more step on a kept browser, answered as a shot;\n',
    '                                      the step flags are the seven acting flags, --wait-for,\n',
    '                                      --scroll, --measure, --el, --shell, --full, --timeout,\n',
    '                                      --out, --json, --open, and --goto <path|target> (go there\n',
    '                                      in the app), --reload, --no-shot (answer without a picture);\n',
    '                                      without an id, this worktree\'s most recently used session\n',
    '        mc shot close [<id>|--all]    end a kept browser\n',
    '        mc shot sessions              the kept browsers, and how long each has been idle\n',
    '        mc shot <dev|prod> --list     the targets and viewports memoro declares\n',
    '        mc shot login prod            sign in once in a browser; mc keeps the session\n',
    '        mc shot login prod --paste    …or pipe it in: the memoro_session cookie value from\n',
    '                                      meetmemoro.app, Chrome DevTools → Application → Cookies\n',
    '        mc shot logout prod           forget it\n',
    '\n',
    'A target is a path under /app or /admin, or a name from memoro\'s .mc/shot.json. Without\n',
    '--out the file goes under ~/.memoro/mc/shots/. Inside a memoro worktree dev serves that\n',
    'worktree (restarted when it was edited since the server started) and says which tree it\n',
    'serves; elsewhere it serves the shared checkout. dev signs in through /dev/login; prod as\n',
    'the test account, or as you with --me. A target that requires a role (every /admin path)\n',
    'is judged against the account\'s declared role: one line says whether its gate held, and\n',
    'a gate that did not hold exits 1.\n',
    '\n',
    'Every error the page, its requests, the dev server or a dialog raised during the shot\n',
    'prints as error lines after the path; a step that fails is pictured as the page stood\n',
    'and named in a failed line (exit 1).\n',
    '\n',
    'Example — the bottom of the main chat on a phone, with its numbers:\n',
    '  mc shot dev assistant --viewport iphone --scroll \'.window-view__content\' \\\n',
    '    --measure \'.window-view__content, .assistant-layout__footer, .assistant-summon\'\n',
    '\n',
    'A kept browser holds the page between calls, so each step is one call and what the page\n',
    'holds in memory stays; a failed step leaves the page where it stood. A dev session whose\n',
    'tree was edited has its server restarted and the page opened again on it. At most four are\n',
    'kept; a fifth --keep closes the longest idle. Example — set up a vault, then take one step:\n',
    '  mc shot dev /app/tools/vault --keep --fill \'input[name=setupPassword]=…\' \\\n',
    '    --click \'text=Create Vault\' --timeout 30\n',
    '  mc shot next --click \'text=New entry\' --eval \'document.activeElement.name\'\n',
  ].join('');
}
