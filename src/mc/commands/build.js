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
 * build that is running.
 *
 * `--testflight` runs the same preflights with an `Apple Distribution`
 * identity and no phone, asks App Store Connect for the next build number
 * (`listBuilds`), and asks at the terminal before anything is built whether
 * the verified IPA may be uploaded — the yes travels in the job. With
 * `--no-upload` nothing leaves the machine, so nothing is asked.
 *
 * Exit codes: 0 for an answer, a recorded seed, or an installed, built or
 * uploaded build; 1 for a question that cannot be answered, a refused
 * preflight, a no at the question, or a failed build; 2 for a bad argument,
 * a build already running, or no terminal to ask at; 130 when the watching
 * was stopped.
 */
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  devicePreflight, iosBuildLogPath, iosQuestion, listBuilds, recordShipped,
} from '../ios-build.js';
import {
  BUILT, DEVICE, FAILED, INSTALLED, readIosBuilds, recordEnd, recordPid, recordStart, REFUSED, runningIosBuild,
  TESTFLIGHT, UPLOADED,
} from '../ios-builds.js';
import { processAlive } from '../lease-owner.js';
import { workRoot } from '../paths.js';
import { ask as realAsk, interactive as realInteractive } from '../prompt.js';
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
  const misplaced = [
    opts.device && opts.testflight && '--device and --testflight are two builds — one at a time',
    opts.noUpload && !opts.testflight && '--no-upload goes with --testflight',
    opts.deviceId && !opts.device && '--device-id goes with --device',
    opts.sha && !opts.device && !opts.testflight && '--sha goes with --device or --testflight',
  ].find(Boolean);
  if (misplaced) {
    stderr.write(`mc: ${misplaced}\n`);
    stderr.write(usage());
    return 2;
  }
  if (opts.device) return buildDevice(opts, { ...deps, env, stdout, stderr });
  if (opts.testflight) return buildTestflight(opts, { ...deps, env, stdout, stderr });
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
  return [INSTALLED, BUILT, UPLOADED].includes(row?.outcome) ? 0 : 1;
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
  const key = recordStart({ sha, kind: DEVICE, live_commit: live, pid: '' }, env);
  const job = { key, sha, live, repoPath, declaration, device };
  return startAndFollow(job, `for ${device.name}`, deps);
}

/**
 * `mc build ios --testflight`: the terminal first (the question needs one,
 * unless `--no-upload`), the preflights, the number from App Store Connect,
 * the question, the row, and the builder started and followed as
 * `--device`'s is.
 */
async function buildTestflight(opts, deps) {
  const { env, stdout, stderr } = deps;
  const alive = deps.alive || processAlive;
  const interactive = deps.interactive || realInteractive;
  if (!opts.noUpload && !interactive(env)) {
    stderr.write('mc: mc build ios --testflight asks before it uploads — run it in a terminal, or add --no-upload\n');
    return 2;
  }
  const pre = await devicePreflight({
    env, repos: deps.repos, git: deps.git, run: deps.run, fetchVersion: deps.fetchVersion,
    ref: opts.sha, alive, scratch: deps.scratch, testflight: true,
  });
  if (!pre.ok) {
    for (const line of pre.lines) stderr.write(`mc: ${line}\n`);
    return pre.code;
  }
  for (const warning of pre.warnings) stderr.write(`mc: ${warning}\n`);
  const { sha, live, repoPath, declaration } = pre;
  const asc = (deps.listBuilds || listBuilds)({ repoPath, declaration, run: deps.run, env });
  if (!asc.ok) {
    stderr.write(`mc: ${asc.line}\n`);
    return 1;
  }
  const { next } = asc;
  stdout.write(`mc: App Store Connect has up to build ${next - 1} — this one is ${next}\n`);

  let upload = false;
  if (!opts.noUpload) {
    const answer = (deps.ask || realAsk)(
      `upload memoro me (build ${next}) from ${short(sha)} — production runs ${short(live)} — to TestFlight after it is built and verified? [y/N]`,
      { stdout },
    );
    if (!/^y(es)?$/iu.test(String(answer || '').trim())) {
      const at = new Date().toISOString();
      recordStart({
        started: at, ended: at, sha, kind: TESTFLIGHT, build: String(next), live_commit: live, outcome: REFUSED,
        note: 'answered no at the question',
      }, env);
      stdout.write('mc: nothing was built or uploaded\n');
      return 1;
    }
    upload = true;
  }

  const other = runningIosBuild(env, { alive });
  if (other) {
    stderr.write(`mc: an iOS build is running (pid ${other.pid}) — mc build ios --follow\n`);
    return 2;
  }
  const key = recordStart({ sha, kind: TESTFLIGHT, build: String(next), live_commit: live, pid: '' }, env);
  const job = {
    key, sha, live, repoPath, declaration, kind: TESTFLIGHT, build: next, upload,
  };
  return startAndFollow(job, `as build ${next} for TestFlight${upload ? '' : ' (no upload)'}`, deps);
}

/** The builder started for a job whose row is written, and this terminal following it. */
async function startAndFollow(fields, what, deps) {
  const { env, stdout, stderr } = deps;
  const { key, sha } = fields;
  const root = workRoot(env);
  const job = { ...fields, root, ...(deps.lockRoot ? { lockRoot: deps.lockRoot } : {}) };
  const builder = (deps.startBuilder || startBuilderDefault)(job, { env });
  if (!builder?.pid) {
    const note = `the builder did not start: ${builder?.error || 'no pid'}`;
    recordEnd(key, { outcome: FAILED, stopped_at: 'start', note }, env);
    stderr.write(`mc: ${note}\n`);
    return 1;
  }
  recordPid(key, builder.pid, env);
  stdout.write(`mc: building memoro ${short(sha)} ${what} in its own process (pid ${builder.pid}) — ^C stops watching, not the build; mc build ios --follow watches again\n`);
  if (builder.inline) await builder.inline;
  return followBuild({
    log: builder.log || iosBuildLogPath(root), pid: builder.pid, key, env, stdout, deps,
  });
}
