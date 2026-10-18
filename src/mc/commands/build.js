/**
 * `mc build ios` — whether memoro needs a new iOS binary, and the binary
 * itself.
 *
 * With no flag it is the question (`iosQuestion`, ios-build.js): it builds
 * nothing and touches no worktree. `--shipped <build> <sha>` records a binary
 * made before the verb existed (`recordShipped`).
 *
 * `--device` runs its preflights here, in the asking process
 * (`devicePreflight`), writes the `running` row, and starts the builder
 * (`ios-build-run.js` → `buildIos`) detached exactly as `mc deploy` starts
 * its deployer; this terminal then follows `~/mc/runner/log/ios-build.log`,
 * and ^C stops the watching, not the build. `--follow` alone watches the
 * build that is running. `--testflight` is declared and refused until its
 * step lands.
 *
 * Exit codes: 0 for an answer, a recorded seed, or an installed build; 1 for
 * a question that cannot be answered, a refused preflight or a failed build;
 * 2 for a bad argument, a build already running, or a build not here yet;
 * 130 when the watching was stopped.
 */
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  devicePreflight, iosBuildLogPath, iosQuestion, recordShipped,
} from '../ios-build.js';
import {
  DEVICE, FAILED, INSTALLED, readIosBuilds, recordEnd, recordPid, recordStart, runningIosBuild,
} from '../ios-builds.js';
import { processAlive } from '../lease-owner.js';
import { workRoot } from '../paths.js';
import { followLog, startDetached } from './deploy.js';
import { scanArgs } from './flags.js';

const BUILDER_RUN = fileURLToPath(new URL('../ios-build-run.js', import.meta.url));

export function usage() {
  return [
    'usage — mc build ios                          does memoro need a new iOS binary? builds nothing\n',
    '        mc build ios --device [--sha <ref>] [--device-id <id>]\n',
    '                                              build the commit production runs, install it on the paired iPhone\n',
    '        mc build ios --testflight [--no-upload] [--sha <ref>]\n',
    '                                              build, verify and, after one question, upload to TestFlight\n',
    '        mc build ios --shipped <build> <sha>  record a binary built before this verb existed\n',
    '        mc build ios --follow                 watch the build that is running\n',
  ].join('');
}

/** `--shipped` takes two words, which the shared scanner has no grammar for. */
export function parseBuildArgs(argv) {
  const words = [...argv];
  let shipped = null;
  const at = words.indexOf('--shipped');
  if (at !== -1) {
    const [build, sha] = words.slice(at + 1, at + 3);
    if (!build || !sha || build.startsWith('--') || sha.startsWith('--')) {
      return { error: '--shipped needs a build number and a sha' };
    }
    shipped = { build, sha };
    words.splice(at, 3);
  }
  const scanned = scanArgs(words, {
    booleans: ['--device', '--testflight', '--no-upload', '--follow', '--json'],
    strictValues: ['--sha', '--device-id'],
  });
  if (scanned.error) return { error: scanned.error };
  const [platform, ...rest] = scanned.positional;
  if (platform !== 'ios') return { error: platform ? `mc build builds ios and nothing else (${platform})` : 'mc build needs ios' };
  if (rest.length) return { error: `mc build ios takes no further arguments (${rest[0]})` };
  const { flags } = scanned;
  return {
    platform,
    device: flags.device,
    testflight: flags.testflight,
    noUpload: flags['no-upload'],
    follow: flags.follow,
    json: flags.json,
    sha: flags.sha,
    deviceId: flags['device-id'],
    shipped,
  };
}

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const opts = parseBuildArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write(usage());
    return 2;
  }
  if (opts.shipped) {
    return recordShipped({ ...opts.shipped, env, repos: deps.repos, git: deps.git, stdout, stderr });
  }
  if (opts.testflight || opts.noUpload) {
    stderr.write('mc: not yet: mc-build-ios step 3\n');
    return 2;
  }
  if ((opts.sha || opts.deviceId) && !opts.device) {
    stderr.write(`mc: ${opts.sha ? '--sha' : '--device-id'} goes with --device\n`);
    stderr.write(usage());
    return 2;
  }
  if (opts.device) return buildDevice(opts, { ...deps, env, stdout, stderr });
  if (opts.follow) return followRunning({ ...deps, env, stdout, stderr });
  return iosQuestion({
    env, repos: deps.repos, git: deps.git, fetchVersion: deps.fetchVersion, lastShipped: deps.lastShipped,
    stdout, stderr, json: opts.json,
  });
}

function short(sha) {
  return String(sha || '').slice(0, 7);
}

/** The builder, started detached with its log emptied — `startDetached`, as the deployer is. */
export function startBuilderDefault(job, { env = process.env } = {}) {
  return startDetached(job, {
    script: join('src', 'mc', 'ios-build-run.js'), fallback: BUILDER_RUN, log: iosBuildLogPath(job.root),
    cwd: job.repoPath, env,
  });
}

/**
 * Watch a build in its own process until it is gone, then the row's word on
 * how it ended: 0 for `installed`, 1 otherwise, 130 when the watching stopped.
 */
export async function followBuild({ log, pid, key = null, env, stdout, deps = {} }) {
  const stopped = await followLog({
    log, pid, stdout, deps, stopped: `the build goes on (pid ${pid}); mc build ios --follow watches again`,
  });
  if (stopped !== null) return stopped;
  const rows = readIosBuilds(env);
  const row = key
    ? rows.findLast((r) => r.started === key.started && r.sha === key.sha)
    : rows.findLast((r) => String(r.pid) === String(pid));
  return row?.outcome === INSTALLED ? 0 : 1;
}

/** `mc build ios --follow`: the build going on now, watched; or a line saying none is. */
async function followRunning({ env, stdout, ...deps }) {
  const running = runningIosBuild(env, { alive: deps.alive || processAlive });
  if (!running) {
    stdout.write('mc: no iOS build is running\n');
    return 0;
  }
  stdout.write(`mc: following the build of memoro ${short(running.sha)} (pid ${running.pid}) — ^C stops watching, not the build\n`);
  return followBuild({
    log: iosBuildLogPath(workRoot(env)), pid: Number(running.pid), key: running, env, stdout, deps,
  });
}

/**
 * `mc build ios --device`: the preflights, the row, the builder started in
 * its own process, and this terminal following it.
 */
async function buildDevice(opts, deps) {
  const { env, stdout, stderr } = deps;
  const alive = deps.alive || processAlive;
  const pre = await devicePreflight({
    env, repos: deps.repos, git: deps.git, run: deps.run, fetchVersion: deps.fetchVersion,
    deviceId: opts.deviceId, ref: opts.sha, alive, scratch: deps.scratch,
  });
  if (!pre.ok) {
    for (const line of pre.lines) stderr.write(`mc: ${line}\n`);
    return pre.code;
  }
  for (const warning of pre.warnings) stderr.write(`mc: ${warning}\n`);
  // Again, just before the row: the preflights take a minute, and another
  // terminal may have started one meanwhile.
  const other = runningIosBuild(env, { alive });
  if (other) {
    stderr.write(`mc: an iOS build is running (pid ${other.pid}) — mc build ios --follow\n`);
    return 2;
  }
  const { sha, device, live, repoPath, declaration } = pre;
  const root = workRoot(env);
  const key = recordStart({ sha, kind: DEVICE, live_commit: live, pid: '' }, env);
  const job = {
    key, sha, live, repoPath, declaration, device, root, ...(deps.lockRoot ? { lockRoot: deps.lockRoot } : {}),
  };
  const builder = (deps.startBuilder || startBuilderDefault)(job, { env });
  if (!builder?.pid) {
    const note = `the builder did not start: ${builder?.error || 'no pid'}`;
    recordEnd(key, { outcome: FAILED, stopped_at: 'start', note }, env);
    stderr.write(`mc: ${note}\n`);
    return 1;
  }
  recordPid(key, builder.pid, env);
  stdout.write(`mc: building memoro ${short(sha)} for ${device.name} in its own process (pid ${builder.pid}) — ^C stops watching, not the build; mc build ios --follow watches again\n`);
  if (builder.inline) await builder.inline;
  return followBuild({
    log: builder.log || iosBuildLogPath(root), pid: builder.pid, key, env, stdout, deps,
  });
}
