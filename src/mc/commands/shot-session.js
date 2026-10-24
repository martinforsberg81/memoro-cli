/**
 * A kept browser — the verbs:
 *
 *   mc shot <dev|prod> <target> --keep [shot flags]   a shot, and the page kept
 *   mc shot next [<id>] [step flags]                  one more step on that page
 *   mc shot close [<id>|--all]
 *   mc shot sessions
 *
 * A session that cannot foresee every step takes one per call, and each step
 * answers in the lines and exit codes a shot answers in (`answer`), every error
 * since the previous step with it. A failed step leaves the page where it
 * stood. A dev session whose tree was edited gets its server restarted as a
 * shot would, and the page opened again on it (`rebase`). The pieces are in
 * src/mc/shot-session.js; docs/technical/mc-shot.md § A kept browser.
 */
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { mcHome } from '../paths.js';
import {
  SHELLS, captureTimeoutMs, outPath, parseActions, parseScroll, parseTimeout, readShotDeclaration, resolveTarget,
  shotWorktree, slug,
} from '../shot.js';
import {
  SESSION_LIMIT, closeSession, ensureSessionsDir, idleMinutes, lastLogLine, liveSessions, nextSessionId,
  readSessions, removeSession, runKeep, sendLine, writeSession,
} from '../shot-session.js';
import { ensureAppServer, readDeclaration } from '../test-environment.js';
import { scanArgs } from './flags.js';
import { answer, servedTree, usage } from './shot.js';

const STEP_FLAGS = {
  booleans: ['--full', '--json', '--open', '--reload', '--no-shot'],
  strictValues: ['--wait-for', '--scroll', '--measure', '--el', '--shell', '--timeout', '--out', '--goto'],
  repeatable: ['--click', '--context-click', '--long-press', '--fill', '--eval', '--eval-file', '--upload', '--press'],
};

/**
 * `--keep`: the shot's request in mode `session`, its answer printed as a
 * shot's, then the kept line and the session file. A fifth closes the longest
 * idle first.
 */
export async function keep({
  worktree, declared, request, session: fields, served, env, flags, scrub, stdout, stderr, deps = {},
}) {
  const now = () => (deps.now ? deps.now() : new Date());
  const dir = ensureSessionsDir(env);
  const live = liveSessions(env, deps);
  while (live.length >= SESSION_LIMIT) {
    const idlest = live.reduce((a, b) => (idleMinutes(b, now()) > idleMinutes(a, now()) ? b : a));
    live.splice(live.indexOf(idlest), 1);
    const idle = idleMinutes(idlest, now());
    await closeSession(idlest, { env, deps });
    stderr.write(`mc: ${SESSION_LIMIT} browsers are kept at most, so ${idlest.id} (idle ${idle} min) was closed\n`);
  }
  const id = nextSessionId(live);
  const socket = join(dir, `${id}.sock`);
  const log = join(dir, `${id}.log`);
  for (const stale of [socket, log, join(dir, `${id}.json`)]) rmSync(stale, { force: true });

  const ran = await (deps.runKeep || runKeep)({
    worktree, declaration: declared, request: { ...request, mode: 'session', socket }, env, log, deps,
  });
  if (!ran.ok) { stderr.write(`mc: ${scrub(ran.error)}\n`); return 1; }
  if (!ran.result.ok) {
    ran.kill?.();
    removeSession({ id, socket, log }, env);
    return answer(ran.result, { request, served, who: fields.account, scrub, stdout, stderr, deps });
  }
  if (existsSync(socket)) chmodSync(socket, 0o600);
  const started = now().toISOString();
  writeSession(env, {
    id, pid: ran.pid, socket, log, ...fields, started, last_used: started, steps: 0,
  });
  const code = answer(flags.json ? { ...ran.result, kept: id } : ran.result, {
    request, served, who: fields.account, json: flags.json, open: flags.open, scrub, stdout, stderr, deps,
  });
  if (!flags.json) stdout.write(`mc: kept as ${id} — mc shot next ${id} [--click …] [--eval …] …; mc shot close ${id}\n`);
  return code;
}

/** `mc shot next [<id>] [step flags]`. */
export async function next(argv, { stdout, stderr, deps = {} }) {
  const scanned = scanArgs(argv, STEP_FLAGS);
  if (scanned.error) { stderr.write(`mc: ${scanned.error}\n${usage()}`); return 2; }
  const { flags, positional } = scanned;
  if (positional.length > 1) { stderr.write(`mc: one session at a time (${positional.slice(1).join(' ')} is extra)\n`); return 2; }
  const cwd = deps.cwd || process.cwd();
  const env = deps.env || process.env;
  const scroll = parseScroll(flags.scroll);
  if (!scroll.ok) { stderr.write(`mc: ${scroll.error}\n`); return 2; }
  const acting = parseActions(argv, { cwd, deps });
  if (!acting.ok) { stderr.write(`mc: ${acting.error}\n`); return 2; }
  const timeout = parseTimeout(flags.timeout);
  if (!timeout.ok) { stderr.write(`mc: ${timeout.error}\n`); return 2; }
  if (flags.shell && !SHELLS.includes(flags.shell)) {
    stderr.write(`mc: --shell is ${SHELLS.join(', ')}, not ${flags.shell}\n`);
    return 2;
  }
  if (flags.el && flags.shell) { stderr.write('mc: --el and --shell both pick what is pictured — give one\n'); return 2; }
  if (flags.out && !flags.out.endsWith('.png')) { stderr.write(`mc: --out ends in .png, and ${flags.out} does not\n`); return 2; }
  if (flags['no-shot'] && (flags.out || flags.el || flags.shell || flags.full || flags.open)) {
    stderr.write('mc: --no-shot takes no picture, so --out, --el, --shell, --full and --open have nothing to do\n');
    return 2;
  }
  if (flags.goto && flags.reload) { stderr.write('mc: --goto and --reload both load a page — give one\n'); return 2; }

  const picked = pick(positional[0], { cwd, env, deps });
  if (picked.error) { stderr.write(`mc: ${picked.error}\n`); return picked.code; }
  const { session } = picked;
  if (!session.alive) return ended(session, { env, stderr });

  const shot = readShotDeclaration(session.worktree);
  if (!shot.ok) { stderr.write(`mc: ${shot.error}\n`); return 1; }
  let goto = null;
  if (flags.goto) {
    const target = resolveTarget(flags.goto, shot.declaration);
    if (!target.ok) { stderr.write(`mc: ${target.error}\n`); return 2; }
    goto = target.target;
  }

  // A dev session's server, as a shot's: restarted when its tree was edited.
  let rebase = null;
  let served = null;
  let server = null;
  if (session.where === 'dev') {
    const read = readDeclaration(session.worktree);
    if (!read.ok) { stderr.write(`mc: ${read.error}\n`); return 1; }
    const app = await (deps.ensureAppServer || ensureAppServer)(session.worktree, read.declaration, { json: flags.json, stdout: stderr, deps });
    if (!app.ok) { stderr.write(`mc: ${app.error}\n`); return 1; }
    served = (deps.servedTree || servedTree)(session.worktree, app.server);
    if (!flags.json) stderr.write(`mc: serving ${served.line}\n`);
    server = { base_url: app.baseUrl, server_id: app.server?.instance_id ?? null };
    if (server.base_url !== session.base_url || server.server_id !== session.server_id) {
      rebase = { base_url: app.baseUrl, sign_in: { kind: 'url', url: `${app.baseUrl}${session.sign_in_path || '/dev/login'}` } };
    }
  }

  const n = (Number(session.steps) || 0) + 1;
  let out = null;
  if (!flags['no-shot']) {
    out = flags.out
      ? resolve(cwd, flags.out)
      : outPath({
        dir: join(mcHome(env), 'shots'),
        now: deps.now ? deps.now() : new Date(),
        where: session.where,
        me: session.account === 'me',
        target: `${slug(session.target)}-${session.id}-${n}`,
        shell: flags.shell,
        element: flags.el,
        viewport: session.viewport,
      });
    mkdirSync(dirname(out), { recursive: true });
  }
  const actions = acting.actions.length ? acting.actions : null;
  const message = {
    step: n,
    actions,
    wait_for: flags['wait-for'],
    scroll: scroll.scroll,
    measure: flags.measure,
    element: flags.el,
    shell: flags.shell,
    full_page: Boolean(flags.full),
    out,
    goto,
    reload: Boolean(flags.reload),
    shot: !flags['no-shot'],
    timeout_ms: timeout.timeoutMs,
    ...(rebase ? { rebase } : {}),
  };
  const timeoutMs = deps.stepTimeoutMs ?? captureTimeoutMs(message);
  const sent = await sendLine({ socket: session.socket, message, timeoutMs, deps });
  if (!sent.ok && sent.refused) return ended(session, { env, stderr });
  if (!sent.ok) {
    stderr.write(`mc: ${session.id} did not answer step ${n}: ${sent.error} — its log is ${session.log}; mc shot close ${session.id}\n`);
    return 1;
  }

  const { result } = sent;
  const rebased = Boolean(rebase && result.rebased);
  writeSession(env, {
    ...session,
    steps: n,
    last_used: (deps.now ? deps.now() : new Date()).toISOString(),
    ...(rebased ? server : {}),
  });
  const code = answer(result, {
    request: { actions }, served, who: session.account, json: flags.json, open: flags.open, picture: !flags['no-shot'], stdout, stderr, deps,
  });
  if (rebased) {
    stdout.write(`mc: the tree was edited, so the server restarted — the page was opened again at ${rebasedPath(result)}; what it held in memory is gone\n`);
  } else if (rebase) {
    stdout.write(`mc: warning — the server restarted, and ${session.id} did not say it opened the page again on it\n`);
  }
  return code;
}

/** `mc shot close [<id>|--all]`. */
export async function close(argv, { stdout, stderr, deps = {} }) {
  const scanned = scanArgs(argv, { booleans: ['--all'] });
  if (scanned.error) { stderr.write(`mc: ${scanned.error}\n${usage()}`); return 2; }
  const { flags, positional } = scanned;
  const env = deps.env || process.env;
  if (flags.all && positional.length) { stderr.write('mc: --all or one id, not both\n'); return 2; }
  if (positional.length > 1) { stderr.write(`mc: one session at a time (${positional.slice(1).join(' ')} is extra)\n`); return 2; }
  let closing = [];
  if (flags.all) {
    closing = readSessions(env, deps);
    if (!closing.length) { stdout.write('mc: no browser is kept\n'); return 0; }
  } else {
    const picked = pick(positional[0], { cwd: deps.cwd || process.cwd(), env, deps });
    if (picked.error) { stderr.write(`mc: ${picked.error}\n`); return picked.code; }
    closing = [picked.session];
  }
  for (const session of closing) {
    if (!session.alive) {
      removeSession(session, env);
      stdout.write(`mc: ${session.id} had already ended\n`);
      continue;
    }
    const left = await closeSession(session, { env, deps });
    stdout.write(`mc: closed ${session.id}${left ? '' : ' — it did not leave within 5 s, so it was ended'}\n`);
  }
  return 0;
}

/** `mc shot sessions`: one line per live session; the dead ones' files go. */
export async function sessions(argv, { stdout, stderr, deps = {} }) {
  const scanned = scanArgs(argv, {});
  if (scanned.error || scanned.positional.length) {
    stderr.write(`mc: ${scanned.error || 'mc shot sessions takes nothing more'}\n${usage()}`);
    return 2;
  }
  const env = deps.env || process.env;
  const now = deps.now ? deps.now() : new Date();
  const live = liveSessions(env, deps);
  if (!live.length) { stdout.write('mc: no browser is kept — mc shot <dev|prod> <target> --keep keeps one\n'); return 0; }
  for (const session of live) {
    stdout.write(`${session.id}  ${session.where} ${session.target}  ${basename(session.worktree)}  ${session.viewport}  idle ${idleMinutes(session, now)} min\n`);
  }
  return 0;
}

/**
 * The session a call means: the id given; else the most recently used live
 * session of the worktree `shotWorktree` chooses here; else the only live one.
 */
function pick(id, { cwd, env, deps }) {
  if (id) {
    if (!/^s\d+$/u.test(id)) return { error: `a session is s<n>, not ${id} — mc shot sessions lists them`, code: 2 };
    const session = readSessions(env, deps).find((entry) => entry.id === id);
    if (!session) return { error: `no session called ${id} — mc shot sessions lists them`, code: 1 };
    return { session };
  }
  // A dead session of this worktree is still the one meant: it says it ended.
  const all = readSessions(env, deps);
  const { worktree } = shotWorktree({ cwd, env, deps });
  const latest = (list) => [...list].sort((a, b) => String(b.last_used).localeCompare(String(a.last_used)))[0];
  const here = all.filter((session) => session.worktree === worktree);
  const live = all.filter((session) => session.alive);
  if (here.length) return { session: latest(here.filter((session) => session.alive)) || latest(here) };
  if (all.length === 1) return { session: all[0] };
  for (const session of all.filter((entry) => !entry.alive)) removeSession(session, env);
  if (live.length === 1) return { session: live[0] };
  if (!live.length) return { error: 'no browser is kept — mc shot <dev|prod> <target> --keep keeps one', code: 1 };
  const named = live.map((session) => `${session.id} (${session.where} ${session.target}, ${basename(session.worktree)})`);
  return { error: `${live.length} browsers are kept and none is this worktree's — name one: ${named.join(', ')}`, code: 2 };
}

/** The one line a dead session gets, and its files gone. */
function ended(session, { env, stderr }) {
  const said = lastLogLine(session.log);
  removeSession(session, env);
  stderr.write(`mc: ${session.id} has ended (${said}) — start again with mc shot ${session.where} ${session.target} --keep\n`);
  return 1;
}

function rebasedPath(result) {
  if (typeof result.rebased?.path === 'string') return result.rebased.path;
  try {
    return new URL(result.url).pathname;
  } catch {
    return 'the same path';
  }
}

