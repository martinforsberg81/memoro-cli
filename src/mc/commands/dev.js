/**
 * `mc dev` — the words memoro's dev-server wrapper speaks, and one for a
 * person.
 *
 *   mc dev list [--json]                    what is running, and where
 *   mc dev register <manifest> [--json]     take a copy of a wrapper's manifest
 *   mc dev unregister <manifest> [--json]   forget it
 *   mc dev admit <service> [--worktree <path>] [--wait <s>] [--json]
 *                                           may one more server start here?
 *   mc dev stop <instance_id>               stop it, through its own stop command
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
 * Five, and not the thirteen-verb session manager `mc-cut` removed on
 * 2026-09-03. `ensure`, `plan`, `status`, `logs` and `restart` are not coming
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
  admit, holdersText, listServers, refusalText, registerManifest, stopServer, unregisterManifest,
} from '../dev-servers.js';
import { log } from '../logger.js';
import { callerWorktree } from '../test-environment.js';
import { scanArgs } from './flags.js';

const VERBS = ['list', 'register', 'unregister', 'admit', 'stop'];

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

  if (opts.verb === 'list') return list(opts, { stdout, root });
  if (opts.verb === 'register') return register(opts, { stdout, stderr, root });
  if (opts.verb === 'admit') return askAdmission(opts, { stdout, root, deps });
  if (opts.verb === 'stop') return stop(opts, { stdout, stderr, root, stopServer: deps.stopServer || stopServer });
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
function list(opts, { stdout, root }) {
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
    stdout.write(`${server.instance_id}  ${server.url}  ${server.session_name}  ${server.worktree_path}\n`);
  }
  if (reaped.length) {
    stdout.write(`mc: swept ${reaped.length} registration${reaped.length === 1 ? '' : 's'} whose process is gone\n`);
  }
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
    sleep: deps.sleep,
    now: deps.now,
    freeMemory: deps.freeMemory,
    onWaiting: (waiting) => say.write(`mc: waiting for a slot — held by ${holdersText(waiting)}\n`),
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

export function parseArgs(argv, { cwd = process.cwd(), callerWorktree: worktreeOf = callerWorktree } = {}) {
  const scanned = scanArgs(argv, { booleans: ['--json'], strictValues: ['--worktree', '--wait'] });
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

  if (word === 'list') {
    if (positional.length) return { ...opts, error: `mc dev list takes no argument (${positional[0]})` };
    return opts;
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
  return [
    'usage — mc dev list [--json]                  what is running, and where\n',
    '        mc dev register <manifest> [--json]   take a copy of it\n',
    '        mc dev unregister <manifest> [--json] forget it\n',
    '        mc dev admit <service> [--worktree <path>] [--wait <seconds>] [--json]\n',
    '                                              may one more server start? exit 0 yes, 75 no\n',
    '        mc dev stop <instance_id>             stop it through its own stop command\n',
  ].join('');
}
