/**
 * `mc asc build --sim [--release-check]`: memoro built for the simulator from
 * the worktree the caller stands in — a branch's own native code, which the
 * device build (production's commit, in mc's own worktree) never sees.
 *
 * Before it, every session that changed native code hand-rolled the build:
 * copied a stale `ios/` over, linked `node_modules` by hand, passed an empty
 * packages directory and sat for 27 minutes at "Checking out ion-ios-camera"
 * (proposal 2026-10-25-mc-build-ios-simulator). So this is the device
 * build's own steps from the worktree's `.mc/ios.json` — `npm ci`, setup,
 * sync — and then `xcodebuild build -sdk iphonesimulator`, Debug, with:
 *
 * - **One place per session.** Derived data is `$MC_SCRATCH/DerivedData` in
 *   a runner session (tidy rule S reclaims it once the session has ended)
 *   and `<mcHome>/build/ios-sim-derived` outside one. Fixed, because
 *   xcodebuild keys its caches by path: a second build there is incremental.
 * - **Packages without the network.** Its cloned packages are an APFS clone
 *   of the shared `ios-spm` the device build keeps warm, its package cache is
 *   its own (never `~/Library/Caches/org.swift.swiftpm`), the binary
 *   artifacts are prefetched and verified (swiftpm.js), and resolution is
 *   switched off when `Package.resolved` pins what the seed holds.
 * - **A stall stop.** Five minutes of silence stops the xcodebuild tree and
 *   names the stage it stood at (`makeStep`'s `silenceMs`).
 * - **The build lane.** One build at a time machine-wide, the device build's
 *   own lock (`holdBuildLane`), with a line that says who holds it.
 *
 * `--release-check` builds Release for the simulator too, unsigned, into the
 * same derived data: whether Release compiles without the DEBUG code becomes
 * a fact rather than a reading. Nothing here signs, uploads, installs or
 * boots a simulator.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { IOS_BUILD_MODE } from './await-deploy.js';
import { holdBuildLane } from './commands/deploy.js';
import { BUILD_LANE, releaseGateLock } from './gate-lock.js';
import {
  buildPaths, checkIosDeclaration, checkXcode, DECLARATION_PATH, gitRead, makeStep, runSync, STALL_MS, stepNote, xcodeHint,
} from './ios-build.js';
import { BUILT, FAILED, RUNNING, readIosBuilds, recordEnd } from './ios-builds.js';
import { processAlive } from './lease-owner.js';
import { mcHome } from './paths.js';
import { prefetchArtifacts, packageManifests, resolvedMatchesSeed, seedPackages } from './swiftpm.js';

const MIN = 60 * 1000;

/** The register's kind for a simulator build. */
export const SIM = 'sim';

const short = (sha) => String(sha || '').slice(0, 7);

/**
 * Where a simulator build keeps what stays between builds: derived data, its
 * cloned packages and package cache inside it, the log beside it, and the
 * shared seed it is cloned from.
 */
export function simPaths(env = process.env) {
  const derived = env.MC_SCRATCH ? join(env.MC_SCRATCH, 'DerivedData') : join(mcHome(env), 'build', 'ios-sim-derived');
  return {
    derived,
    spm: join(derived, 'SourcePackages'),
    packageCache: join(derived, 'PackageCache'),
    log: simLogPath(derived),
    seed: buildPaths(env).spm,
  };
}

/** The builder's log for the derived data at `derived`: one build there at a time, so one file. */
export function simLogPath(derived) {
  return `${derived}.log`;
}

/** The app a simulator build leaves. */
export function simApp(derived, configuration = 'Debug') {
  return join(derived, 'Build', 'Products', `${configuration}-iphonesimulator`, 'App.app');
}

/** The `xcodebuild build` for the simulator. */
export function simXcodebuild({ declaration, paths, configuration = 'Debug', offline = false }) {
  return [
    'xcodebuild', '-project', declaration.project, '-scheme', declaration.scheme, '-configuration', configuration,
    '-sdk', 'iphonesimulator', '-destination', 'generic/platform=iOS Simulator',
    '-derivedDataPath', paths.derived, '-clonedSourcePackagesDirPath', paths.spm, '-packageCachePath', paths.packageCache,
    ...(offline ? ['-disableAutomaticPackageResolution', '-skipPackageUpdates'] : []),
    ...(configuration === 'Release' ? ['CODE_SIGNING_ALLOWED=NO'] : []),
    'build',
  ];
}

/** A simulator build running in the derived data at `derived`, or null. */
export function runningSimBuild(env, derived, { alive = processAlive } = {}) {
  return readIosBuilds(env).filter((row) => row.kind === SIM && row.outcome === RUNNING && !row.ended
    && row.artifact === derived && Number(row.pid) > 0 && alive(Number(row.pid)) === true).at(-1) || null;
}

/**
 * What `mc asc build --sim` checks before it starts anything: a git worktree
 * at `cwd` with memoro's declaration in it (read from the working tree — the
 * branch's own), Xcode, and its HEAD. `{ ok: true, worktree, sha,
 * declaration, paths }` or `{ ok: false, code, lines }`.
 */
export function simPreflight({ cwd = process.cwd(), env = process.env, run = runSync, git = gitRead } = {}) {
  const refuse = (line, code = 1) => ({ ok: false, code, lines: [line] });
  const worktree = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!worktree) return refuse(`mc asc build --sim builds the worktree you stand in, and ${cwd} is not in one`);
  let text = null;
  try { text = readFileSync(join(worktree, DECLARATION_PATH), 'utf8'); } catch { text = null; }
  if (text === null) return refuse(`${worktree} has no ${DECLARATION_PATH} — mc asc build --sim builds a memoro worktree`);
  const read = checkIosDeclaration(text, `in ${worktree}`);
  if (!read.ok) return refuse(read.reason);
  const xcode = checkXcode({ run, env });
  if (xcode) return refuse(xcode);
  const sha = git(worktree, ['rev-parse', 'HEAD']);
  if (!sha) return refuse(`${worktree} has no commit to build`);
  return { ok: true, worktree, sha, declaration: read.declaration, paths: simPaths(env) };
}

function duration(ms) {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

function lockHash(worktree) {
  try { return createHash('sha256').update(readFileSync(join(worktree, 'package-lock.json'))).digest('hex'); } catch { return null; }
}

/** The stamp a simulator build leaves in `node_modules` after `npm ci`: the lockfile's hash. */
const INSTALL_STAMP = '.mc-sim-install';

/**
 * The simulator builder, in its own process (`ios-build-run.js`) as the
 * device builder is: the build lane held, then in the caller's worktree
 * `npm ci` (only when `node_modules` is not this lockfile's own install — a
 * reinstall would make every package's sources new and the build cold; a
 * link to a shared cache is removed first, since the sync patches packages in
 * place), the declaration's setup (only when the project is not there yet:
 * `npx cap add ios` refuses an existing one), the sync, the packages seeded
 * and prefetched, and `xcodebuild` with the stall stop. The row `recordStart`
 * wrote is completed `built` or `failed` with where it stopped.
 */
export async function buildSim(job, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const step = deps.step || makeStep({ stdout });
  const now = deps.now || Date.now;
  const exists = deps.exists || existsSync;
  const { key, worktree, sha, declaration, paths } = job;
  const started = now();
  let at = 'build lane';
  let holding = false;

  const fail = (stoppedAt, note) => {
    recordEnd(key, { outcome: FAILED, stopped_at: stoppedAt, note }, env);
    stderr.write(`mc: the simulator build stopped at ${stoppedAt} — ${note}\n`);
    return 1;
  };
  const run = (label, argv, options = {}) => {
    at = options.stoppedAt || label;
    return step(label, argv, { cwd: worktree, env, ...options });
  };
  const failed = (label, r, timeoutMs, stoppedAt = label) => {
    const hint = r.stalled ? null : xcodeHint(r.output);
    return fail(stoppedAt, hint ? `${label} failed — ${hint}` : stepNote(label, r, timeoutMs));
  };

  try {
    holding = await (deps.holdBuildLane || holdBuildLane)(job, { ...deps, stdout, env, mode: IOS_BUILD_MODE });
    stdout.write(`mc: building ${worktree} at ${short(sha)} for the simulator, derived data ${paths.derived}\n`);

    // (a) The packages, installed for real and only when they are not this lockfile's.
    const modules = join(worktree, 'node_modules');
    let linked = false;
    try { linked = lstatSync(modules).isSymbolicLink(); } catch { linked = false; }
    if (linked) {
      unlinkSync(modules);
      stdout.write(`mc: ${modules} was a link to a shared install — removed (the link only); the sync patches packages in place\n`);
    }
    const lock = lockHash(worktree);
    let stamp = null;
    try { stamp = readFileSync(join(modules, INSTALL_STAMP), 'utf8').trim(); } catch { stamp = null; }
    if (!lock || stamp !== lock) {
      const install = await run('npm ci', ['npm', 'ci'], { timeoutMs: 30 * MIN });
      if (!install.ok) return failed('npm ci', install, 30 * MIN);
      if (lock) {
        try { writeFileSync(join(modules, INSTALL_STAMP), `${lock}\n`); } catch { /* the next build installs again */ }
      }
    } else {
      stdout.write(`mc: ${modules} is this package-lock.json's install — npm ci skipped\n`);
    }

    // (b) The declaration's setup, when the project is not there yet.
    if (exists(join(worktree, declaration.project))) {
      stdout.write(`mc: ${declaration.project} exists — setup skipped, the sync brings it up to date\n`);
    } else {
      for (const command of [].concat(declaration.setup)) {
        const r = await run(command, ['sh', '-c', command], { timeoutMs: 10 * MIN });
        if (!r.ok) return failed(command, r, 10 * MIN);
      }
    }

    // (c) The sync, told the commit and no build number, as a device build.
    const syncEnv = { ...env, [declaration.env.build_commit]: sha };
    delete syncEnv[declaration.env.build_number];
    const sync = await run(declaration.sync, ['sh', '-c', declaration.sync], { env: syncEnv, timeoutMs: 20 * MIN });
    if (!sync.ok) return failed(declaration.sync, sync, 20 * MIN);

    // (d) The packages: the seed cloned once, the artifacts prefetched into this build's own cache.
    at = 'packages';
    const seeded = await (deps.seedPackages || seedPackages)({ seed: paths.seed, spm: paths.spm, step: run, cwd: worktree, env });
    if (!seeded.ok) return fail('packages', seeded.line);
    stdout.write(`mc: packages: ${seeded.line}\n`);
    at = 'prefetch';
    const fetched = await prefetchArtifacts({
      manifests: packageManifests({ worktree, project: declaration.project, spm: paths.spm }),
      cachePath: paths.packageCache, step: (label, argv, options) => run(label, argv, { ...options, stoppedAt: 'prefetch' }),
      cwd: worktree, env, stdout,
    });
    if (!fetched.ok) return fail('prefetch', fetched.line);
    const offline = resolvedMatchesSeed({ worktree, project: declaration.project, seed: paths.seed });
    stdout.write(offline
      ? 'mc: Package.resolved pins what the seed holds — package resolution off\n'
      : 'mc: Package.resolved is missing or differs from the seed — SwiftPM resolves\n');

    // (e) The builds, each stopped after five silent minutes.
    const configurations = job.releaseCheck ? ['Debug', 'Release'] : ['Debug'];
    for (const configuration of configurations) {
      const label = `xcodebuild ${configuration}`;
      const began = now();
      const r = await run(label, simXcodebuild({ declaration, paths, configuration, offline }), {
        timeoutMs: 60 * MIN, silenceMs: STALL_MS, group: true,
      });
      if (!r.ok) return failed(label, r, 60 * MIN);
      stdout.write(`mc: ${label} for the simulator took ${duration(now() - began)}\n`);
    }

    const app = simApp(paths.derived);
    recordEnd(key, { outcome: BUILT, artifact: app, stopped_at: '', note: `${worktree}${job.releaseCheck ? '; Release checked' : ''}` }, env);
    stdout.write(`mc: built ${app} from ${short(sha)}${job.releaseCheck ? ', and Release compiles' : ''} in ${duration(now() - started)}\n`);
    return 0;
  } catch (error) {
    recordEnd(key, { outcome: FAILED, stopped_at: at, note: `mc: ${error?.message || error}` }, env);
    throw error;
  } finally {
    if (holding) (deps.releaseGateLock || releaseGateLock)({ root: job.lockRoot || mcHome(env), lane: BUILD_LANE });
  }
}
