/**
 * `mc dev` — the words memoro's dev-server wrapper speaks, and one for a
 * person.
 *
 *   mc dev list [--json]                    what is running, and where
 *   mc dev status [--json]                  the app servers, the queue for one, the cap and free memory
 *   mc dev register <manifest> [--json]     take a copy of a wrapper's manifest
 *   mc dev unregister <manifest> [--json]   forget it
 *   mc dev admit <service> [--worktree <path>] [--wait <s>] [--json]
 *                                           may one more server start here?
 *   mc dev stop <instance_id>               stop it, through its own stop command
 *   mc dev reap [--dry-run] [--json] [--min-age-seconds <n>]
 *                                           remove what nobody owns any more
 *   mc dev open <surface> [--account <name>] [--onboarding] [--open] [--json]
 *                                           this worktree's app, signed in, on it
 *   mc dev surfaces [--json]                the surfaces and accounts memoro declares
 *
 * `admit` is the fourth, added on 2026-09-26 with the reader it was missing:
 * `resource_class` had been carried in every manifest and read by nothing
 * while an 8 GB machine held seven servers and 8 GB of swap. mc asks it before
 * `mc test dev` starts a server, and memoro's agent server asks it when a
 * person starts one by hand — so the answer is JSON on stdout and exit 75 on a
 * refusal, which is the whole of what that caller reads.
 *
 * `stop` is the fifth, back with `dev-server-lifecycle` on the same day and
 * for the same machine: it runs the manifest's `control.stop.argv` and
 * nothing else, and it is what a workarea's close and `mc work remove` do for
 * every server inside the worktree they take away.
 *
 * `reap` is the sixth, from the same project: the dev processes the three
 * rules in `dev-reap.js` prove orphaned, and registrations whose worktree is
 * gone. The runner's chore pass runs it every pass.
 *
 * `open` and `surfaces` are the seventh and eighth (`mc-dev-open`,
 * 2026-10-15), and speak no protocol: they read memoro's `.mc/shot.json`, and
 * their work is in `dev-open.js`. A session that wanted to look at its change
 * had made five calls to get there; `open` is one.
 *
 * `status` is the ninth (2026-11-03, `dev-queue`), and is not the `status`
 * `mc-cut` removed: it reads the admission queue (`dev-queue.js`) beside the
 * app servers, so a session waiting for a slot can see who is ahead of it.
 *
 * Six protocol verbs, and not the thirteen-verb session manager `mc-cut` removed on
 * 2026-09-03. `ensure`, `plan`, `logs` and `restart` are not coming
 * back with them: the month of `mc.log` that decided this recorded ten human
 * invocations of `mc dev` in total, six of them `ensure`, and the verb that
 * starts a server for a session is `mc test dev`, which is a different
 * question with a different answer. mc holds the index; the project's own
 * wrapper stays authoritative for how a server starts, stops and becomes
 * healthy (`docs/dev-server-protocol.md`).
 *
 * `list` is a capability probe as much as a listing, and that is why it is
 * first: `invokeMcDev` runs `mc dev list --json` before every register and
 * unregister to find out whether the installed mc speaks the protocol at all.
 * It replaced a grep of `--help` text, which broke the day the help was
 * rewritten. So this exits 0 and prints JSON on an empty machine — an empty
 * inventory and a missing verb must not look the same to a caller.
 *
 * The reason a verb `mc-cut` deleted is back at all: it has a reader now.
 * See `dev-servers.js`, which carries that argument and the numbers behind it.
 */
import { resolve } from 'node:path';

import { devServersRoot } from '../paths.js';
import {
  admit, agoText, DEFAULT_MAX_SERVERS, freeMemoryPercent, holdersOf, listServers, minFreePercentOf, processCwd, refusalText,
  registerManifest, stopServer, strayCwd, unregisterManifest, waitingLine,
} from '../dev-servers.js';
import { devQueuePath, queueOrder, readQueue, ticketView } from '../dev-queue.js';
import { ageText, DEFAULT_MIN_AGE_SECONDS, reap as reapOrphans } from '../dev-reap.js';
import { open as openSurface, surfaces } from '../dev-open.js';
import { log } from '../logger.js';
import { parseSafeArea, THEMES } from '../shot.js';
import { callerWorktree } from '../test-environment.js';
import { scanArgs } from './flags.js';
import { commandUsage } from '../command-help.js';

const VERBS = ['list', 'status', 'register', 'unregister', 'admit', 'stop', 'reap', 'open', 'surfaces'];
const SURFACE_VERBS = ['open', 'surfaces'];

/** `EX_TEMPFAIL`: refused for now, try again later. */
export const REFUSED_EXIT = 75;

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const root = deps.root || devServersRoot();

  const opts = parseArgs(argv, { cwd: deps.cwd, callerWorktree: deps.callerWorktree });
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write(usage());
    return 2;
  }

  if (opts.verb === 'surfaces') return surfaces(opts, { stdout, stderr, deps });
  if (opts.verb === 'open') return openSurface(opts, { stdout, stderr, deps });
  if (opts.verb === 'list') return list(opts, { stdout, root, cwdOf: deps.processCwd || processCwd });
  if (opts.verb === 'status') return status(opts, { stdout, root, deps });
  if (opts.verb === 'register') return register(opts, { stdout, stderr, root });
  if (opts.verb === 'admit') return askAdmission(opts, { stdout, root, deps });
  if (opts.verb === 'stop') return stop(opts, { stdout, stderr, root, stopServer: deps.stopServer || stopServer });
  if (opts.verb === 'reap') return reapVerb(opts, { stdout, root, reap: deps.reap || reapOrphans });
  return unregister(opts, { stdout, stderr, root });
}

/**
 * What is running.
 *
 * The sweep happens here rather than on a timer because this is the only verb
 * that reads the whole directory, and a reader is the right moment to notice
 * that a pid is gone. `reaped` is reported rather than done quietly: a caller
 * that asked what was running deserves to know the answer changed while it
 * asked.
 */
function list(opts, { stdout, root, cwdOf }) {
  const { servers, reaped } = listServers({ root });
  if (opts.json) {
    stdout.write(`${JSON.stringify({
      schema_version: 1, root, servers, reaped,
    }, null, 2)}\n`);
    return 0;
  }
  if (!servers.length) {
    stdout.write('mc: no dev server is registered\n');
  }
  for (const server of servers) {
    const stray = strayCwd(server, { cwdOf });
    stdout.write(`${server.instance_id}  ${server.url}  ${server.session_name}  ${server.worktree_path}${stray ? `  (runs in ${stray.cwd} — not this worktree's)` : ''}\n`);
  }
  if (reaped.length) {
    stdout.write(`mc: swept ${reaped.length} registration${reaped.length === 1 ? '' : 's'} whose process is gone\n`);
  }
  return 0;
}

/**
 * Who holds the app servers and who waits for one, in the order they will be
 * served. Stops nothing and joins nothing; like `list`, reading sweeps what is
 * dead — a server whose pid is gone, a ticket whose waiter is.
 */
function status(opts, { stdout, root, deps }) {
  const env = deps.env || process.env;
  const at = (deps.now || Date.now)();
  const { servers } = listServers({ root });
  const app = holdersOf(servers);
  const queue = queueOrder(readQueue({ file: deps.queueFile || devQueuePath(root) }), at).map((ticket) => ticketView(ticket, at));
  const cap = Number(env.MC_DEV_MAX_SERVERS) || DEFAULT_MAX_SERVERS;
  const free = (deps.freeMemory || freeMemoryPercent)();
  const freePercent = Number.isFinite(free) ? free : null;
  const floor = minFreePercentOf(env);
  if (opts.json) {
    stdout.write(`${JSON.stringify({
      schema_version: 1, cap, free_percent: freePercent, min_free_percent: floor, servers: app, queue,
    }, null, 2)}\n`);
    return 0;
  }
  const memory = freePercent === null ? 'free memory unknown' : `${freePercent}% memory free (floor ${floor}%)`;
  stdout.write(`mc: ${app.length} of ${cap} app servers · ${memory}\n`);
  for (const server of app) {
    const used = Date.parse(server.last_used_at ?? '');
    stdout.write(`  ${server.instance_id}  ${server.service}  ${server.worktree_path}  ${Number.isFinite(used) ? `used ${agoText(used, at)}` : 'never used by mc'}\n`);
  }
  if (!queue.length) {
    stdout.write('mc: nobody is waiting\n');
    return 0;
  }
  stdout.write(`mc: ${queue.length} waiting, in the order they will be admitted\n`);
  queue.forEach((ticket, index) => {
    const who = ticket.holder || `pid ${ticket.pid}`;
    stdout.write(`  ${index + 1}. ${who}${ticket.gate ? ' (gate)' : ''}  ${ticket.service}  ${ticket.worktree_path}  joined ${agoText(Date.parse(ticket.joined_at), at)}\n`);
  });
  return 0;
}

/**
 * May one more server start? `{ ok: true }` or the refusal, and the exit says
 * the same thing for a caller that reads only that. Waiting lines go to stderr
 * with `--json`, so stdout stays one JSON document.
 */
async function askAdmission(opts, { stdout, root, deps }) {
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const say = opts.json ? stderr : stdout;
  const verdict = await (deps.admit || admit)({
    service: opts.service,
    worktree: opts.worktree,
    waitSeconds: opts.wait,
    env,
    root,
    ...(deps.queueFile ? { queueFile: deps.queueFile } : {}),
    sleep: deps.sleep,
    now: deps.now,
    freeMemory: deps.freeMemory,
    onWaiting: (waiting) => say.write(`${waitingLine(waiting, { now: (deps.now || Date.now)() })}\n`),
  });
  if (opts.json) stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  else stdout.write(verdict.ok ? 'mc: admitted\n' : `mc: ${refusalText(verdict, { env })}\n`);
  return verdict.ok ? 0 : REFUSED_EXIT;
}

function register(opts, { stdout, stderr, root }) {
  const result = registerManifest(opts.manifest, { root });
  if (opts.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }
  if (!result.ok) {
    stderr.write(`mc: ${result.error}\n`);
    return 1;
  }
  stdout.write(`mc: registered ${result.instance_id}\n`);
  return 0;
}

function unregister(opts, { stdout, stderr, root }) {
  const result = unregisterManifest(opts.manifest, { root });
  if (opts.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (!result.ok) {
    stderr.write(`mc: ${result.error}\n`);
    return 1;
  }
  stdout.write(result.removed
    ? `mc: unregistered ${result.instance_id}\n`
    : 'mc: nothing was registered for that manifest\n');
  return 0;
}

/**
 * Stop one server a person names.
 *
 * Only a live registration is stopped — the id is looked up, not trusted —
 * and only through the manifest's own stop command (`stopServer`).
 */
function stop(opts, { stdout, stderr, root, stopServer: stopOne }) {
  const server = listServers({ root }).servers.find((item) => item.live && item.instance_id === opts.instanceId);
  if (!server) {
    stderr.write(`mc dev stop: no live server ${opts.instanceId} — mc dev list shows what is running\n`);
    return 1;
  }
  const result = stopOne(server);
  log('dev-server-stopped', {
    instance_id: server.instance_id, service: server.service, worktree_path: server.worktree_path, reason: 'asked', ok: Boolean(result.ok),
  });
  if (!result.ok) {
    stderr.write(`mc dev stop: ${result.error}\n`);
    return 1;
  }
  stdout.write(`mc: stopped ${server.instance_id} (${server.url})\n`);
  return 0;
}

/**
 * Remove what the reaper's rules prove orphaned: a line per entry, or that
 * there was nothing. `--dry-run` says what it would do and signals nothing.
 */
async function reapVerb(opts, { stdout, root, reap }) {
  const entries = await reap({ dryRun: opts.dryRun, minAgeSeconds: opts.minAgeSeconds, deps: { root } });
  if (opts.json) {
    stdout.write(`${JSON.stringify({ schema_version: 1, dry_run: opts.dryRun, entries }, null, 2)}\n`);
    return 0;
  }
  if (!entries.length) stdout.write('mc: nothing to reap\n');
  for (const entry of entries) {
    const verb = { 'would-reap': 'would reap', reaped: 'reaped', 'still-running': 'could not reap' }[entry.done] || entry.done;
    const what = entry.pid ? `pid ${entry.pid}` : entry.instance_id;
    const named = entry.kind === 'registration' ? ` ${entry.instance_id}` : '';
    stdout.write(`${verb} ${what} ${entry.kind}${named} — ${entry.why}, ${ageText(entry.age_s)}\n`);
  }
  return entries.some((entry) => entry.done === 'still-running') ? 1 : 0;
}

export function parseArgs(argv, { cwd = process.cwd(), callerWorktree: worktreeOf = callerWorktree } = {}) {
  if (SURFACE_VERBS.includes(argv.find((arg) => !arg.startsWith('-')))) return surfaceArgs(argv);
  const scanned = scanArgs(argv, { booleans: ['--json', '--dry-run'], strictValues: ['--worktree', '--wait', '--min-age-seconds'] });
  const opts = { verb: 'list', json: scanned.flags.json, manifest: null, instanceId: null };
  if (scanned.error) return { ...opts, error: scanned.error };
  const positional = [...scanned.positional];
  // Bare `mc dev` is the question the wrapper asks: what is running.
  const word = positional.shift() || 'list';
  if (!VERBS.includes(word)) return { ...opts, error: `mc dev ${word}? — ${VERBS.join(', ')}` };
  opts.verb = word;
  if (word !== 'admit' && (scanned.flags.worktree !== null || scanned.flags.wait !== null)) {
    return { ...opts, error: `--worktree and --wait belong to mc dev admit, not mc dev ${word}` };
  }
  if (word !== 'reap' && (scanned.flags['dry-run'] || scanned.flags['min-age-seconds'] !== null)) {
    return { ...opts, error: `--dry-run and --min-age-seconds belong to mc dev reap, not mc dev ${word}` };
  }

  if (word === 'list' || word === 'status') {
    if (positional.length) return { ...opts, error: `mc dev ${word} takes no argument (${positional[0]})` };
    return opts;
  }
  if (word === 'reap') {
    if (positional.length) return { ...opts, error: `mc dev reap takes no argument (${positional[0]})` };
    const raw = scanned.flags['min-age-seconds'];
    const minAgeSeconds = raw === null ? DEFAULT_MIN_AGE_SECONDS : Number(raw);
    if (!Number.isInteger(minAgeSeconds) || minAgeSeconds < 0) return { ...opts, error: `--min-age-seconds is a whole number of seconds, not ${raw}` };
    return { ...opts, dryRun: scanned.flags['dry-run'], minAgeSeconds };
  }
  if (word === 'admit') return admitArgs(opts, positional, scanned.flags, { cwd, worktreeOf });
  if (word === 'stop') {
    const id = positional.shift();
    if (!id) return { ...opts, error: 'mc dev stop needs the instance_id mc dev list shows' };
    if (positional.length) return { ...opts, error: `mc dev stop takes one instance_id (${positional[0]})` };
    opts.instanceId = id;
    return opts;
  }
  const manifest = positional.shift();
  if (!manifest) return { ...opts, error: `mc dev ${word} needs the path of the manifest the wrapper wrote` };
  if (positional.length) return { ...opts, error: `mc dev ${word} takes one manifest (${positional[0]})` };
  opts.manifest = manifest;
  return opts;
}

/** `open` and `surfaces` have flags of their own, read by their own scan. */
function surfaceArgs(argv) {
  const scanned = scanArgs(argv, {
    booleans: ['--onboarding', '--open', '--here', '--json'],
    strictValues: ['--account', '--viewport', '--theme', '--locale', '--safe-area'],
  });
  const { flags } = scanned;
  const positional = [...scanned.positional];
  const verb = positional.shift();
  const opts = { verb, json: flags.json, here: flags.here };
  if (scanned.error) return { ...opts, error: scanned.error };
  const browserFlags = ['viewport', 'theme', 'locale', 'safe-area'].filter((name) => flags[name] !== null);
  if (verb === 'surfaces') {
    const extra = [flags.account !== null && 'account', ...browserFlags, flags.onboarding && 'onboarding', flags.open && 'open']
      .find(Boolean);
    if (extra) return { ...opts, error: `--${extra} belongs to mc dev open, not mc dev surfaces` };
    if (positional.length) return { ...opts, error: `mc dev surfaces takes no argument (${positional[0]})` };
    return opts;
  }
  const surface = positional.shift();
  if (!surface) return { ...opts, error: 'mc dev open needs a surface — a name from mc dev surfaces or a path under /app or /admin' };
  if (positional.length) return { ...opts, error: `mc dev open takes one surface (${positional[0]})` };
  if (browserFlags.length && !flags.open) {
    return { ...opts, error: `${browserFlags.map((name) => `--${name}`).join(', ')} ${browserFlags.length === 1 ? 'is' : 'are'} for --open: a URL has no viewport` };
  }
  if (flags.theme !== null && !THEMES.includes(flags.theme)) return { ...opts, error: `--theme is light or dark, not ${flags.theme}` };
  const safeArea = parseSafeArea(flags['safe-area']);
  if (!safeArea.ok) return { ...opts, error: safeArea.error };
  return {
    ...opts,
    surface,
    account: flags.account,
    onboarding: flags.onboarding,
    open: flags.open,
    viewport: flags.viewport,
    theme: flags.theme,
    locale: flags.locale,
    safeArea: safeArea.safeArea,
  };
}

function admitArgs(opts, positional, flags, { cwd, worktreeOf }) {
  const service = positional.shift();
  if (!service) return { ...opts, error: 'mc dev admit needs the service that wants to start' };
  if (positional.length) return { ...opts, error: `mc dev admit takes one service (${positional[0]})` };
  const wait = flags.wait === null ? 0 : Number(flags.wait);
  if (!Number.isFinite(wait) || wait < 0) return { ...opts, error: `--wait is a number of seconds, not ${flags.wait}` };
  const worktree = flags.worktree !== null ? resolve(cwd, flags.worktree) : worktreeOf(cwd);
  if (!worktree) return { ...opts, error: `${cwd} is not in a git worktree — say which with --worktree <path>` };
  return { ...opts, service, worktree, wait };
}

export function usage() {
  return commandUsage('dev');
}
