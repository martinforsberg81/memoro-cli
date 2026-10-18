/**
 * `mc docker` — the container runtime the gates need, and the one door to it.
 *
 *   mc docker [--json]                      up or stopped, the leases on it, what it holds
 *   mc docker ensure [--pid <n>] [--run <label>] [--repo <name>] [--timeout <s>] [--json]
 *                                           start it if it is down, and lease it to a pid
 *   mc docker release [--pid <n>] [--json]  drop the leases of a pid; stops nothing
 *   mc docker prune [--dry-run] [--json]    remove what a dead holder labelled; never the rest
 *
 * The machinery is `src/mc/docker.js`; this file is its words. A bare
 * `mc docker` reads the runtime without starting it: on OrbStack a `docker`
 * call is what starts the VM, so the only `docker` command reached from here
 * is `ensure`'s. The default holder is the shell that typed the command — a
 * person who runs `ensure` in a terminal holds the runtime while it lives.
 *
 * Exit 69 (`EX_UNAVAILABLE`) when `ensure` cannot start it: the same fact the
 * gate exits with, read by the same callers.
 */
import {
  ENSURE_TIMEOUT_MS, ensure, IDLE_GRACE_MS, inventory, liveLeases, releasePid, removeDeadHolders, runtimeOf, writeState,
} from '../docker.js';
import { scanArgs } from './flags.js';

const WORDS = ['ensure', 'release', 'prune'];

/** `EX_UNAVAILABLE`: the runtime cannot be started. */
export const UNAVAILABLE_EXIT = 69;

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;

  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write(usage());
    return 2;
  }

  const ctx = {
    stdout,
    stderr,
    root: deps.root,
    env: deps.env || process.env,
    io: deps.io || {},
    pid: opts.pid ?? (deps.ppid ?? process.ppid),
  };
  if (opts.verb === 'ensure') return ensureVerb(opts, ctx);
  if (opts.verb === 'release') return releaseVerb(opts, ctx);
  if (opts.verb === 'prune') return pruneVerb(opts, ctx);
  return status(opts, ctx);
}

function parseArgs(argv) {
  const scanned = scanArgs(argv, {
    booleans: ['--json', '--dry-run'],
    strictValues: ['--pid', '--run', '--repo', '--timeout'],
  });
  const { flags } = scanned;
  const positional = [...scanned.positional];
  const word = positional.shift() ?? null;
  const verb = word ?? 'status';
  const where = word ? `mc docker ${word}` : 'mc docker';
  const opts = { verb, json: flags.json, dryRun: flags['dry-run'] };
  if (scanned.error) return { ...opts, error: scanned.error };
  if (word !== null && !WORDS.includes(word)) return { ...opts, error: `unknown word ${word}` };
  if (positional.length) return { ...opts, error: `${where} takes no argument (${positional[0]})` };

  const owned = [
    ['--dry-run', flags['dry-run'], ['prune']],
    ['--run', flags.run !== null, ['ensure']],
    ['--repo', flags.repo !== null, ['ensure']],
    ['--timeout', flags.timeout !== null, ['ensure']],
    ['--pid', flags.pid !== null, ['ensure', 'release']],
  ];
  const stray = owned.find(([, given, words]) => given && !words.includes(verb));
  if (stray) {
    return { ...opts, error: `${stray[0]} belongs to ${stray[2].map((w) => `mc docker ${w}`).join(' or ')}, not ${where}` };
  }

  let pid = null;
  if (flags.pid !== null) {
    if (!/^[1-9]\d*$/u.test(flags.pid)) return { ...opts, error: `--pid is a process id, a positive whole number, not ${flags.pid}` };
    pid = Number(flags.pid);
  }
  let timeoutMs = ENSURE_TIMEOUT_MS;
  if (flags.timeout !== null) {
    const seconds = Number(flags.timeout);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return { ...opts, error: `--timeout is a number of seconds above 0, not ${flags.timeout}` };
    }
    timeoutMs = seconds * 1000;
  }
  return { ...opts, pid, run: flags.run, repo: flags.repo, timeoutMs };
}

/**
 * The runtime, its leases and what it holds. The disk and the object lists are
 * read only when it is up, so a stopped OrbStack is not started to be counted.
 */
async function status(opts, { stdout, root, env, io }) {
  const now = (io.now ?? Date.now)();
  const rt = await runtimeOf({ env, io });
  const { leases, swept } = liveLeases({ root, io });
  const held = leases.map(({ path: _path, ...lease }) => lease);
  const inv = rt.up ? await inventory({ io }) : null;
  const labelled = inv && {
    containers: inv.containers.filter((c) => Number.isInteger(c.holder)).length,
    volumes: inv.volumes.filter((v) => Number.isInteger(v.holder)).length,
  };
  const unlabelled = inv && {
    containers: inv.containers.length - labelled.containers,
    volumes: inv.volumes.length - labelled.volumes,
  };
  const state = writeState({
    runtime: rt,
    leases: held,
    ...(inv ? { inventory: { df: inv.df, labelled, unlabelled } } : {}),
    ...(rt.up ? {} : { started_by_mc: false }),
  }, { root, io });
  const idle = rt.up && !held.length && state?.started_by_mc && state.last_release_at
    ? Math.max(0, Math.ceil((IDLE_GRACE_MS - (now - Date.parse(state.last_release_at))) / 60000))
    : null;

  if (opts.json) {
    stdout.write(`${JSON.stringify({
      runtime: rt,
      leases: held,
      swept,
      inventory: inv && { df: inv.df, labelled, unlabelled, errors: inv.errors },
      state,
    }, null, 2)}\n`);
    return 0;
  }

  const lines = [`docker: ${rt.kind} ${rt.up ? 'up' : 'stopped'}${rt.reason ? ` — ${rt.reason}` : ''}`];
  if (!held.length) lines.push('no lease');
  for (const lease of held) {
    lines.push(`lease  pid ${lease.pid}  ${lease.run || '-'}  ${lease.repo || '-'}  since ${lease.since}`);
  }
  if (swept.length) lines.push(`swept ${swept.length} lease(s) whose pid is gone`);
  if (inv?.df) {
    const { df } = inv;
    lines.push(`images ${df.images.count} (${df.images.size}) · containers ${df.containers.count} · volumes ${df.volumes.count} (${df.volumes.size}) · build cache ${df.build_cache.size}`);
  }
  if (inv) {
    lines.push(`labelled by mc: ${labelled.containers} containers, ${labelled.volumes} volumes · unlabelled: ${unlabelled.containers} containers, ${unlabelled.volumes} volumes — reported, never removed`);
    for (const error of inv.errors) lines.push(`could not read ${error}`);
  }
  if (idle !== null) lines.push(`idle stop in ${idle} min (the runner's chore pass stops it)`);
  stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

async function ensureVerb(opts, { stdout, stderr, root, env, io, pid }) {
  const result = await ensure({
    pid, run: opts.run ?? 'mc docker ensure', repo: opts.repo, timeoutMs: opts.timeoutMs, root, env, io,
  });
  if (opts.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    stderr.write(`mc: docker could not be started — ${result.reason}\n`);
    return UNAVAILABLE_EXIT;
  }
  if (!opts.json) {
    stdout.write(`docker: up${result.started ? ` — started in ${Math.round(result.waited_ms / 1000)} s` : ''} (server ${result.server}) — lease for pid ${pid}: ${result.lease}\n`);
  }
  return 0;
}

function releaseVerb(opts, { stdout, root, io, pid }) {
  const released = releasePid(pid, { root, io });
  if (opts.json) stdout.write(`${JSON.stringify({ pid, released }, null, 2)}\n`);
  else stdout.write(released ? `released ${released} lease${released === 1 ? '' : 's'} of pid ${pid}\n` : `no lease of pid ${pid}\n`);
  return 0;
}

async function pruneVerb(opts, { stdout, stderr, root, env, io }) {
  const rt = await runtimeOf({ env, io });
  if (!rt.up) {
    if (opts.json) stdout.write(`${JSON.stringify({ runtime: rt, dry_run: opts.dryRun, pruned: false }, null, 2)}\n`);
    else stdout.write(`docker: ${rt.kind} is not running — nothing to prune (mc docker prune never starts it)\n`);
    return 0;
  }

  const result = await removeDeadHolders({ dryRun: opts.dryRun, io });
  if (opts.json) {
    stdout.write(`${JSON.stringify({ runtime: rt, dry_run: opts.dryRun, ...result }, null, 2)}\n`);
  } else {
    const c = opts.dryRun ? result.dead.containers.length : result.removed.containers.length;
    const v = opts.dryRun ? result.dead.volumes.length : result.removed.volumes.length;
    stdout.write(`${opts.dryRun ? 'would remove' : 'removed'} ${c} container(s) and ${v} volume(s) labelled by a holder that is gone\n`);
    for (const { name, reason } of result.failed) stderr.write(`could not remove ${name}: ${reason}\n`);
    for (const error of result.errors) stderr.write(`could not read ${error}\n`);
    const { unlabelled } = result;
    stdout.write(`unlabelled: ${unlabelled.containers} containers (${unlabelled.running} running), ${unlabelled.volumes} volumes — reported, never removed\n`);
  }
  return result.failed.length || result.errors.length ? 1 : 0;
}

export function usage() {
  return [
    'usage: mc docker [--json]                  the container runtime: up or stopped and why not, the leases\n',
    '                                           on it, what it holds on disk, and what mc labelled or did not\n',
    '       mc docker ensure [--pid <n>] [--run <label>] [--repo <name>] [--timeout <s>] [--json]\n',
    '                                           start OrbStack or Docker Desktop if it is down, wait for\n',
    '                                           docker info, and lease it to --pid (the shell by default).\n',
    '                                           Exit 69 when it cannot be started\n',
    '       mc docker release [--pid <n>] [--json]\n',
    '                                           drop the leases of --pid; stops nothing\n',
    '       mc docker prune [--dry-run] [--json]\n',
    '                                           remove containers and volumes labelled mc.holder whose pid is\n',
    '                                           gone; unlabelled objects are reported, never removed\n',
  ].join('');
}
