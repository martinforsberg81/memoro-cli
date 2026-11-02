/**
 * `mc asc` — everything memoro's App Store Connect side needs, under one verb:
 * the iOS binary (`build`), the state of a version (`status`), the store's
 * metadata, screenshots, review notes and in-app purchases, and the two acts
 * that are a person's: `submit` and `release`.
 *
 * mc reads no App Store Connect key. Every subverb but `build`'s question
 * runs a script memoro declares in `.mc/ios.json` on `origin/main`, as
 * `origin/main` has it (`atRev`, ios-build.js) together with the
 * declaration's `script_paths` (the `marketing/` the scripts read), with
 * `MEMORO_DEV_VARS` naming the secrets file in memoro's checkout
 * (`secretsEnv`). The script reads the key; mc only says where it is.
 *
 * `mc asc build` with no flag is the question (`iosQuestion`, ios-build.js):
 * it builds nothing and touches no worktree. `--shipped <build> <sha>`
 * records a binary made before the verb existed (`recordShipped`).
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
 * the verified IPA may be uploaded — the yes travels in the job. `--yes` is
 * that yes given on the command line, for a headless session. With
 * `--no-upload` nothing leaves the machine, so nothing is asked.
 *
 * `submit` and `release` ask one question at the terminal, as `mc deploy`
 * does: first the script's own `--dry-run` reading (which refuses a version
 * in the wrong state), then the question, then the act. `--dry-run` is the
 * reading and asks nothing. With no terminal they refuse before anything
 * runs.
 *
 * Exit codes: 0 for an answer, a recorded seed, an installed, built or
 * uploaded build, or a script that succeeded; 1 for a question that cannot
 * be answered, a refused preflight or script, a no at the question, or a
 * failed build or script; 2 for a bad argument, a build already running, or
 * no terminal to ask at; 130 when the watching was stopped.
 */
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import {
  atRev, devicePreflight, exportAtRev, gitRead, iosBuildLogPath, iosQuestion, listBuilds, memoroCheckout, memoroRepo,
  readIosDeclaration, reasonLine, recordShipped, runSync, secretsEnv,
} from '../ios-build.js';
import { defaultRepos } from '../brief-collect.js';
import {
  BUILT, DEVICE, FAILED, INSTALLED, readIosBuilds, recordEnd, recordPid, recordStart, REFUSED, runningIosBuild,
  TESTFLIGHT, UPLOADED,
} from '../ios-builds.js';
import { processAlive } from '../lease-owner.js';
import { workRoot } from '../paths.js';
import { ask as realAsk, interactive as realInteractive } from '../prompt.js';
import { followLog, startDetached } from './deploy.js';
import { scanArgs } from './flags.js';
import { commandUsage } from '../command-help.js';

const BUILDER_RUN = fileURLToPath(new URL('../ios-build-run.js', import.meta.url));

/**
 * The subverbs that run a declared script: the declaration key, whether it
 * writes (and so takes --dry-run), and whether it is a person's act.
 */
export const SCRIPT_SUBVERBS = {
  status: { key: 'status', writes: false },
  metadata: { key: 'metadata', writes: true },
  screenshots: { key: 'screenshots', writes: true },
  'review-notes': { key: 'review_notes', writes: true },
  iap: { key: 'iap', writes: true },
  submit: { key: 'submit', writes: true, act: true },
  release: { key: 'release', writes: true, act: true },
};

export function usage() {
  return commandUsage('asc');
}

/** What `run` refuses before it reads anything: the subverb, then its own words. */
export function parseArgs(argv) {
  const [subverb, ...rest] = argv;
  if (subverb === 'build') return parseBuildArgs(rest);
  if (Object.hasOwn(SCRIPT_SUBVERBS, subverb || '')) return parseScriptArgs(subverb, rest);
  return { error: subverb ? `mc asc has no ${subverb}` : 'mc asc needs a subverb' };
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
    booleans: ['--device', '--testflight', '--no-upload', '--yes', '--follow', '--json'],
    strictValues: ['--sha', '--device-id'],
  });
  if (scanned.error) return { error: scanned.error };
  if (scanned.positional.length) return { error: `mc asc build takes no further arguments (${scanned.positional[0]})` };
  const { flags } = scanned;
  return {
    device: flags.device,
    testflight: flags.testflight,
    noUpload: flags['no-upload'],
    yes: flags.yes,
    follow: flags.follow,
    json: flags.json,
    sha: flags.sha,
    deviceId: flags['device-id'],
    shipped,
  };
}

/**
 * A script subverb's words: `submit` takes a version and a build, `release`
 * a version and `--phased`, `status` at most a version and `--json`; the
 * sync subverbs pass their words through to the script (`--locale=sv`,
 * `--version=1.1.2`), which refuses what it does not take.
 */
export function parseScriptArgs(subverb, argv) {
  const spec = SCRIPT_SUBVERBS[subverb];
  const dryRun = argv.includes('--dry-run');
  if (dryRun && !spec.writes) return { error: `mc asc ${subverb} only reads — it has no --dry-run` };
  const rest = argv.filter((word) => word !== '--dry-run');
  if (subverb === 'submit' || subverb === 'release' || subverb === 'status') {
    const flags = { status: ['--json'], submit: [], release: ['--phased'] }[subverb];
    const unknown = rest.find((word) => word.startsWith('-') && !flags.includes(word));
    if (unknown) return { error: `mc asc ${subverb} does not take ${unknown}` };
    const positional = rest.filter((word) => !word.startsWith('-'));
    const wanted = { status: [0, 1], submit: [2, 2], release: [1, 1] }[subverb];
    if (positional.length < wanted[0] || positional.length > wanted[1]) {
      const shape = { status: '[<version>]', submit: '<version> <build>', release: '<version>' }[subverb];
      return { error: `mc asc ${subverb} takes ${shape}` };
    }
    return { dryRun, args: rest, positional };
  }
  return { dryRun, args: rest, positional: [] };
}

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const [subverb, ...rest] = argv;
  if (subverb === 'build') return runBuild(rest, { ...deps, env, stdout, stderr });
  if (Object.hasOwn(SCRIPT_SUBVERBS, subverb || '')) return runScriptSubverb(subverb, rest, { ...deps, env, stdout, stderr });
  stderr.write(subverb ? `mc: mc asc has no ${subverb}\n` : 'mc: mc asc needs a subverb\n');
  stderr.write(usage());
  return 2;
}

async function runBuild(argv, deps) {
  const { env, stdout, stderr } = deps;
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
    opts.yes && !opts.testflight && '--yes goes with --testflight',
    opts.yes && opts.noUpload && '--yes and --no-upload contradict each other — one or the other',
    opts.deviceId && !opts.device && '--device-id goes with --device',
    opts.sha && !opts.device && !opts.testflight && '--sha goes with --device or --testflight',
  ].find(Boolean);
  if (misplaced) {
    stderr.write(`mc: ${misplaced}\n`);
    stderr.write(usage());
    return 2;
  }
  if (opts.device) return buildDevice(opts, deps);
  if (opts.testflight) return buildTestflight(opts, deps);
  if (opts.follow) return followRunning(deps);
  return iosQuestion({
    env, repos: deps.repos, git: deps.git, fetchVersion: deps.fetchVersion, lastShipped: deps.lastShipped,
    stdout, stderr, json: opts.json,
  });
}

/** A command with this terminal's output: `{ code }`. The scripts' own words are the answer. */
export function runLive(argv, { cwd, env = process.env, timeoutMs = 60 * 60_000 } = {}) {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'inherit', 'inherit'], timeout: timeoutMs });
  return { code: r.error ? 127 : (r.status ?? 1), error: r.error?.message || null };
}

/**
 * The declared script for `key`, ready to run as origin/main has it:
 * `{ ok: true, command, env, cleanup }` or `{ ok: false, line }`. Fetches
 * memoro first, so origin/main is the one GitHub has.
 */
export function declaredScript(key, deps) {
  const { env } = deps;
  const git = deps.git || gitRead;
  const repos = deps.repos || defaultRepos(env);
  const repoPath = memoroRepo(env, repos);
  if (!repoPath) return { ok: false, line: 'no checkout of memoro on this machine — mc asc runs its scripts' };
  const checkout = memoroCheckout(env, repos);
  git(repoPath, ['fetch', 'origin', '--quiet'], { timeoutMs: 30_000 });
  const read = readIosDeclaration(repoPath, { git });
  if (!read.ok) return { ok: false, line: read.reason };
  const declared = read.declaration[key];
  if (!Array.isArray(declared) || !declared.length) {
    return { ok: false, line: `memoro's .mc/ios.json on origin/main declares no ${key} script` };
  }
  const paths = Array.isArray(read.declaration.script_paths) ? read.declaration.script_paths : [];
  const command = atRev(declared, {
    repoPath, checkout, rev: 'origin/main', git, exportTree: deps.exportTree || exportAtRev, paths,
  });
  if (command.missing) return { ok: false, line: command.missing };
  return {
    ok: true,
    command,
    env: secretsEnv(env, checkout),
    cleanup: () => { if (command.dir) rmSync(command.dir, { recursive: true, force: true }); },
  };
}

/** The question for an act, from the dry run's JSON. */
export function actQuestion(subverb, positional, plan) {
  const [version, build] = positional;
  const what = subverb === 'submit'
    ? `submit memoro me ${version} with build ${build} for App Review`
    : `release memoro me ${version} to the App Store`;
  return `${what}${plan ? ` (${[].concat(plan).join(', then ')})` : ''}? [y/N]`;
}

async function runScriptSubverb(subverb, argv, deps) {
  const { env, stdout, stderr } = deps;
  const spec = SCRIPT_SUBVERBS[subverb];
  const opts = parseScriptArgs(subverb, argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write(usage());
    return 2;
  }
  const interactive = deps.interactive || realInteractive;
  if (spec.act && !opts.dryRun && !interactive(env)) {
    stderr.write(`mc: mc asc ${subverb} asks before it ${subverb === 'submit' ? 'submits' : 'releases'}, and there is no terminal here to ask — run it in one, or add --dry-run\n`);
    return 2;
  }
  const script = declaredScript(spec.key, deps);
  if (!script.ok) {
    stderr.write(`mc: ${script.line}\n`);
    return 1;
  }
  const { command, cleanup } = script;
  const live = deps.runLive || runLive;
  const capture = deps.run || runSync;
  const argvFor = (extra) => [...command.argv, ...opts.args, ...extra];
  try {
    if (!spec.act) {
      return live(argvFor(opts.dryRun ? ['--dry-run'] : []), { cwd: command.cwd, env: script.env }).code;
    }
    if (opts.dryRun) return live(argvFor(['--dry-run']), { cwd: command.cwd, env: script.env }).code;

    const reading = capture(argvFor(['--dry-run', '--json']), { cwd: command.cwd, env: script.env, timeoutMs: 5 * 60_000 });
    let result = null;
    try { result = JSON.parse(reading.stdout); } catch { /* said below */ }
    if (!result) {
      stderr.write(`mc: ${reasonLine(reading.error || reading.stderr || reading.stdout) || `the ${spec.key} script printed no reading`}\n`);
      return 1;
    }
    if (result.refused || reading.code !== 0) {
      stderr.write(`mc: refused — ${result.refused || `exit ${reading.code}`}; nothing was sent\n`);
      return 1;
    }
    const answer = (deps.ask || realAsk)(actQuestion(subverb, opts.positional, result.plan), { stdout });
    if (!/^y(es)?$/iu.test(String(answer || '').trim())) {
      stdout.write(`mc: nothing was ${subverb === 'submit' ? 'submitted' : 'released'}\n`);
      return 1;
    }
    return live(argvFor([]), { cwd: command.cwd, env: script.env }).code;
  } finally {
    cleanup();
  }
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
    log, pid, stdout, deps, stopped: `the build goes on (pid ${pid}); mc asc build --follow watches again`,
  });
  if (stopped !== null) return stopped;
  const rows = readIosBuilds(env);
  const row = key
    ? rows.findLast((r) => r.started === key.started && r.sha === key.sha)
    : rows.findLast((r) => String(r.pid) === String(pid));
  return [INSTALLED, BUILT, UPLOADED].includes(row?.outcome) ? 0 : 1;
}

/** `mc asc build --follow`: the build going on now, watched; or a line saying none is. */
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
 * `mc asc build --device`: the preflights, the row, the builder started in
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
    stderr.write(`mc: an iOS build is running (pid ${other.pid}) — mc asc build --follow\n`);
    return 2;
  }
  const { sha, device, live, repoPath, declaration } = pre;
  const key = recordStart({ sha, kind: DEVICE, live_commit: live, pid: '' }, env);
  const job = { key, sha, live, repoPath, declaration, device };
  return startAndFollow(job, `for ${device.name}`, deps);
}

/**
 * `mc asc build --testflight`: the terminal first (the question needs one,
 * unless `--yes` or `--no-upload`), the preflights, the number from App Store Connect,
 * the question, the row, and the builder started and followed as
 * `--device`'s is.
 */
async function buildTestflight(opts, deps) {
  const { env, stdout, stderr } = deps;
  const alive = deps.alive || processAlive;
  const interactive = deps.interactive || realInteractive;
  if (!opts.noUpload && !opts.yes && !interactive(env)) {
    stderr.write('mc: mc asc build --testflight asks before it uploads — run it in a terminal, or add --yes or --no-upload\n');
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
  const { sha, live, repoPath, checkout, declaration } = pre;
  const asc = (deps.listBuilds || listBuilds)({
    repoPath, ...(checkout === undefined ? {} : { checkout }), declaration, rev: 'origin/main', run: deps.run, git: deps.git,
    exportTree: deps.exportTree, env,
  });
  if (!asc.ok) {
    stderr.write(`mc: ${asc.line}\n`);
    return 1;
  }
  const { next } = asc;
  stdout.write(`mc: App Store Connect has up to build ${next - 1} — this one is ${next}\n`);

  let upload = false;
  if (opts.yes) {
    upload = true;
  } else if (!opts.noUpload) {
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
    stderr.write(`mc: an iOS build is running (pid ${other.pid}) — mc asc build --follow\n`);
    return 2;
  }
  const key = recordStart({ sha, kind: TESTFLIGHT, build: String(next), live_commit: live, pid: '' }, env);
  const job = {
    key, sha, live, repoPath, ...(checkout === undefined ? {} : { checkout }), declaration, kind: TESTFLIGHT, build: next, upload,
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
  stdout.write(`mc: building memoro ${short(sha)} ${what} in its own process (pid ${builder.pid}) — ^C stops watching, not the build; mc asc build --follow watches again\n`);
  if (builder.inline) await builder.inline;
  return followBuild({
    log: builder.log || iosBuildLogPath(root), pid: builder.pid, key, env, stdout, deps,
  });
}
