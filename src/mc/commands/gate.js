/**
 * `mc gate` — run the tests a change reaches and read only the verdict.
 *
 *   mc gate <files…> [--test-name-pattern <p>]
 *                             the named test files, with the node --test flags the repository declares
 *                             (pr_tests_flags), else those of its test script
 *   mc gate                   affected tests and command gates against origin/main
 *   mc gate --base <ref>      … against another base
 *   mc gate --json            the summary as one object
 *   mc gate --budget <s>      answer after at most s seconds (default 540); the tests keep running
 *   mc gate --wait            wait for the gate running here and print its verdict
 *
 * With no files named, the repository selector maps the complete branch and
 * local changes to tests and command gates. Named files run explicitly, with
 * the selector's resource classes when available. There is no file-count cap:
 * the shared runner bounds concurrency and test duration. The final merge
 * still verifies the candidate with the current base.
 *
 * No lane and no queue: the detached worker starts at once, at low priority,
 * beside any merge round (only a deploy or iOS build of memoro goes first).
 * With no files named, the selection's costly files are left to the merge
 * round by measured time (test-times.js): a green here says so, and the round
 * measures them. The tests this change touches always run, and so does all of
 * a goal's measured gate.
 *
 * The output goes to a file — under `$MC_SCRATCH` in a runner session, the
 * system temp directory otherwise — as it is written; when the tests end the
 * worker writes their exit code beside the log. This verb answers within the
 * budget: GREEN or RED, the counts, the failing lines with their locations,
 * and the file's path, at most 2 KB. Past the budget it answers `RUNNING` and
 * exits 3; the tests run on, and `mc gate --wait` prints the verdict from the
 * same log.
 *
 * One gate per worktree: a lock beside the git directory names the running
 * gate's pid and log, and a second `mc gate` there refuses while that pid lives.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { changedAgainst, declaredTestFlags, primaryCheckoutDeclaration } from '../gate-fast.js';
import { selectorCommand } from '../session-gate-run.js';
import { gateLines, namedCommand, rerunLine, summarizeGate, testFlags } from '../gate-local.js';
import { tryGit } from '../git.js';
import { mcHome } from '../paths.js';
import { declarationFor, gateLaneOf } from '../repo-gate-table.js';
import { repositoryDir } from '../repos.js';
import { captureWorktree } from '../session-gate-evidence.js';
import { gateConfiguration } from '../gate-greens.js';
import { testLanes } from '../repo-gate.js';
import { scanArgs } from './flags.js';
import { takeClaim, releaseClaim } from '../resource-claim.js';

/** How long the answer waits for the gate, in seconds, unless `--budget` says otherwise. */
export const DEFAULT_BUDGET = 540;
/** How often the answer looks for the gate's exit code. */
const POLL_MS = 2000;
/** What a test file is called: `….test.js`, `.mjs`, `.cjs`, `.ts`. */
const TEST_FILE = /\.test\.[cm]?[jt]s$/u;

/** The worker owns the test children from selection through completion. */
const SESSION_RUN = fileURLToPath(new URL('../session-gate-run.js', import.meta.url));

/** The machine the verb runs on; a test hands in its own. */
const SYSTEM = {
  git: tryGit,
  snapshot: captureWorktree,
  read: readFileSync,
  write: writeFileSync,
  exists: existsSync,
  isFile: (path) => { try { return statSync(path).isFile(); } catch { return false; } },
  remove: (path) => rmSync(path, { force: true }),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  open: (path) => openSync(path, 'a'),
  close: closeSync,
  spawn,
  alive: (pid) => {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
  id: randomUUID,
  claim: takeClaim,
  release: releaseClaim,
  declaration: (repoPath, { env }) => declarationFor(repoPath, { root: mcHome(env), env }),
};

/** Whose gate this is: the primary checkout's repository. A worktree of memoro is memoro. */
export function gateOwner(cwd, env = process.env, io = SYSTEM) {
  const common = io.git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return { root: mcHome(env), repo: gateLaneOf(common ? repositoryDir(common) : cwd) };
}

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const cwd = deps.cwd || process.cwd();
  const io = { ...SYSTEM, ...deps };
  const scanned = scanArgs(argv, { booleans: ['--json', '--wait', '--full'], strictValues: ['--base', '--budget', '--test-name-pattern'] });
  if (scanned.error) { stderr.write(`mc: ${scanned.error}\n${usage()}`); return 2; }
  if (scanned.flags.full) {
    stderr.write('mc: there is no whole gate in a worktree — the merger measures the pull request once, in its lane (mc publish queues it); mc gate <files…> runs the tests your change reaches\n');
    return 2;
  }
  const named = scanned.positional;
  const pattern = scanned.flags['test-name-pattern'];
  if (named.length && scanned.flags.wait) { stderr.write(`mc: --wait takes no test files — it waits for the gate running here\n${usage()}`); return 2; }
  if (named.length && scanned.flags.base) { stderr.write(`mc: --base selects checks for the changed code — it takes no named files\n${usage()}`); return 2; }
  if (pattern != null && !named.length) { stderr.write(`mc: --test-name-pattern goes with named test files (mc gate <files…> --test-name-pattern <p>)\n${usage()}`); return 2; }
  const budget = scanned.flags.budget == null ? DEFAULT_BUDGET : Number(scanned.flags.budget);
  if (!(budget > 0)) { stderr.write(`mc: --budget takes seconds, a positive number (${scanned.flags.budget})\n${usage()}`); return 2; }

  const root = io.git(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) { stderr.write('mc: not inside a git worktree — mc gate runs tests in the tree you stand in\n'); return 2; }
  const gitDir = io.git(root, ['rev-parse', '--absolute-git-dir']);
  if (!gitDir) { stderr.write(`mc: cannot find the git directory of ${root}\n`); return 2; }
  const lockPath = join(gitDir, 'mc-gate.json');

  if (scanned.flags.wait) {
    const lock = readLock(io, lockPath);
    if (!lock) { stderr.write('mc: no gate running here — mc gate <files…> starts one\n'); return 2; }
    return answer(io, { lock, lockPath, budget, waitedFrom: io.now(), json: scanned.flags.json, stdout });
  }

  const files = named;
  const baseRef = scanned.flags.base || 'origin/main';
  const frozenBase = io.git(root, ['rev-parse', `${baseRef}^{commit}`]);
  const base = frozenBase || baseRef;
  let candidate = null;
  try { candidate = io.snapshot(root); } catch { /* v1 may run without reusable evidence */ }
  let select = null;
  let declaration = null;
  let addedTests = [];
  if (!files.length) {
    const mergeBase = io.git(root, ['merge-base', 'HEAD', base]);
    const changed = mergeBase ? changedAgainst(io, root, mergeBase) : null;
    if (changed === null) { stderr.write(`mc: git cannot say what this branch changes against ${baseRef} — name the test files: mc gate <files…>\n`); return 2; }
    if (!changed.length) {
      stdout.write(`NOTHING CHANGED — no changes against ${baseRef}\n`);
      return 0;
    }
    const declared = primaryCheckoutDeclaration(io, { root, env });
    declaration = declared?.declaration ?? null;
    if (!declared?.declaration.select) {
      stderr.write('mc: no repository test selector declared — name the tests explicitly; nothing was verified\n');
      return 2;
    }
    select = selectorCommand(declared.declaration.select, { base, changed });
    addedTests = changed.filter((file) => TEST_FILE.test(file) && io.exists(join(root, file)));
  }
  const missing = files.find((file) => !io.exists(join(root, file)));
  if (missing) { stderr.write(`mc: no such test file: ${missing}\n`); return 2; }
  const notTest = files.find((file) => !TEST_FILE.test(file) || !io.isFile(join(root, file)));
  if (notTest) { stderr.write(`mc: ${notTest} is not a test file (….test.js) — mc gate runs named test files, not directories or the suite\n`); return 2; }

  let manifest = null;
  try { manifest = JSON.parse(io.read(join(root, 'package.json'), 'utf8')); } catch { manifest = null; }
  const flags = declaredTestFlags(io, { root, env });
  const effectiveFlags = flags || testFlags(manifest?.scripts?.test);
  if (files.length) {
    const declared = primaryCheckoutDeclaration(io, { root, env });
    declaration = declared?.declaration ?? null;
    if (declared?.declaration.select) select = selectorCommand(declared.declaration.select, { base, changed: files });
  }
  const configuration = gateConfiguration(declaration, effectiveFlags);
  const command = files.length ? namedCommand(manifest, files, { pattern, flags })
    : { run: `affected tests and command gates against ${baseRef}`, source: 'selection' };

  const launchPath = `${lockPath}.launch`;
  const launch = io.claim(launchPath, { pid: process.pid });
  if (!launch.ok) { stderr.write(`mc: ${launch.error || 'a gate is starting here — use mc gate --wait'}\n`); return 2; }
  let lock;
  let startedAt;
  try {
    const held = readLock(io, lockPath);
    if (held && isRunning(io, held)) {
      stderr.write(`mc: a gate is already running here (pid ${held.pid}, since ${held.started}) — mc gate --wait\n`);
      return 2;
    }

    const gate = gateOwner(root, env, io);
    // The free cores, not the core count: a session's gate has no round mode, so
    // `testLanes` answers the free cores here (a merge round takes at least four).
    const childEnv = { MC_TEST_LANES: String(testLanes({ env })), ...env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' };

    startedAt = io.now();
    const stamp = startedAt.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
    const dir = env.MC_SCRATCH || join(tmpdir(), 'mc-gate');
    const run = io.id();
    const logPath = join(dir, `gate-${stamp}-${run}.log`);
    const requestPath = `${logPath}.request.json`;
    let child;
    try {
      io.mkdir(dir);
      io.write(requestPath, JSON.stringify({ cwd: root, files: files.length ? files : null, addedTests, flags: effectiveFlags, pattern, select, base, mainOnly: declaration?.main_only ?? [],
        log: logPath, defer: !files.length && !deps.measurementBinding && !deps.wholeSelection && !declaration?.session_whole,
        measurement: candidate && frozenBase ? { repo: gate.repo, run, base: frozenBase, candidate, configuration,
          session_run: deps.measurementBinding?.session_run ?? null, goal_revision: deps.measurementBinding?.goal_revision ?? null } : null, gate }));
      const fd = io.open(logPath);
      // The worker owns the test children and the result.
      child = io.spawn(process.execPath, [SESSION_RUN, requestPath], {
        cwd: root, env: childEnv, detached: true, stdio: ['ignore', fd, fd],
      });
      io.close(fd);
    } catch (error) {
      stderr.write(`mc: could not start the gate, log ${logPath}: ${error.message}\n`);
      return 2;
    }
    child.unref();
    io.write(`${logPath}.pid`, `${child.pid}\n`);
    lock = { pid: child.pid, log: logPath, request: requestPath, started: startedAt.toISOString(), command };
    io.write(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  } finally { io.release(launchPath, launch.marker); }
  return answer(io, { lock, lockPath, budget, waitedFrom: startedAt, json: scanned.flags.json, stdout });
}

/**
 * Waits for the gate to end or the budget to run out, then answers: the
 * verdict (and the lock goes), a red for a process that ended without an exit
 * code (and the lock goes), or RUNNING with exit 3 (and the lock stays).
 */
async function answer(io, { lock, lockPath, budget, waitedFrom, json, stdout }) {
  const outcome = await waitForExit(io, { log: lock.log, pid: lock.pid, since: waitedFrom, budget });
  const seconds = Math.round((io.now().getTime() - Date.parse(lock.started)) / 1000);
  const shown = lock.command.shown || lock.command.run;
  if (outcome.budget) {
    stdout.write(`RUNNING — ${shown} — ${seconds}s so far, still running (pid ${lock.pid})\nlog: ${lock.log} — mc gate --wait waits for it and prints the verdict\n`);
    return 3;
  }
  const current = readLock(io, lockPath);
  if (current?.log === lock.log && current?.pid === lock.pid) io.remove(lockPath);
  if (outcome.dead) {
    stdout.write(`RED — the gate's process ended without an exit code — log: ${lock.log}\n`);
    return 1;
  }
  const output = readText(io, lock.log);
  const summary = summarizeGate(output, { exitCode: outcome.code });
  let result = null;
  try { result = JSON.parse(readText(io, `${lock.request}.result`)); } catch { /* an older gate or interrupted worker */ }
  if (result?.files) lock.command.files = result.files;
  if (result?.red_tests?.length) summary.failures = result.red_tests.slice(0, 5).flatMap((test) => [
    `✖ ${test.name}`, ...(test.at ? [`    at ${test.at}`] : []), ...(test.error || []).map((line) => `    ${line}`),
  ]);
  const deferred = result?.deferred?.length || 0;
  const left = deferred ? `\n${deferred} costly test files left to the merge round, which runs them all — this green does not cover them` : '';
  if (json) {
    stdout.write(`${JSON.stringify({ ...summary, command: lock.command.run, script: lock.command.script, files: lock.command.files, red_tests: result?.red_tests, commands: result?.commands, evidence: result?.evidence, seconds, log: lock.log, exit: outcome.code }, null, 2)}\n`);
  } else {
    stdout.write(`${gateLines(summary, { command: shown, seconds, logPath: lock.log, rerun: rerunLine(lock.command.files, output) })}${left}\n`);
  }
  return summary.ok ? 0 : 1;
}

/** Polls for the exit code until it is written, the process is gone, or the budget is spent. */
async function waitForExit(io, { log, pid, since, budget }) {
  for (;;) {
    const code = exitCodeOf(io, log);
    if (code !== null) return { code };
    if (!io.alive(pid)) {
      // The process may have written its code just before it ended.
      const late = exitCodeOf(io, log);
      return late === null ? { dead: true } : { code: late };
    }
    const left = budget * 1000 - (io.now().getTime() - since.getTime());
    if (left <= 0) return { budget: true };
    await io.sleep(Math.min(POLL_MS, left));
  }
}

/** The gate's exit code, once its exit file has been written; null while it has not. */
function exitCodeOf(io, log) {
  const text = readText(io, `${log}.exit`).trim();
  return /^\d+$/u.test(text) ? Number(text) : null;
}

/** A lock whose pid lives and whose gate has not written its exit code. */
function isRunning(io, lock) {
  return io.alive(lock.pid) && !io.exists(`${lock.log}.exit`);
}

function readLock(io, lockPath) {
  if (!io.exists(lockPath)) return null;
  try { return JSON.parse(io.read(lockPath, 'utf8')); } catch { return null; }
}

function readText(io, path) {
  try { return io.read(path, 'utf8'); } catch { return ''; }
}

export function usage() {
  return [
    'usage — mc gate <test files…> [--test-name-pattern <p>]   the named test files, with repository flags and bounded concurrency\n',
    '        mc gate                       affected tests and command gates against origin/main, including local changes\n',
    '        mc gate --base <ref>          … against another base\n',
    '        mc gate --json                the summary as one object\n',
    '        mc gate --budget <s>          answer after at most s seconds, default 540; the tests keep running\n',
    '        mc gate --wait                wait for the gate running here and print its verdict\n',
    '\n',
    'The merge gate still verifies the candidate with the current base; --full is refused.\n',
    'The gate starts at once at low priority, beside merge rounds; a deploy or iOS build of memoro goes first.\nCostly affected tests are left to the merge round by measured time; those this change touches always run.\n',
    'Prints at most 2 KB — GREEN/RED, counts, the failing lines and their locations, and the path of the whole output.\n',
    'Exit 0 green (or no changes), 1 red, 2 refused or already running, 3 still running.\n',
  ].join('');
}
