/**
 * `mc gate` — run the tests a change reaches, in the gate lane, and read only
 * the verdict.
 *
 *   mc gate <files…> [--test-name-pattern <p>]
 *                             the named test files, with the node --test flags the repository declares
 *                             (pr_tests_flags), else those of its test script
 *   mc gate                   the test files this branch adds or changes against origin/main
 *   mc gate --base <ref>      … against another base
 *   mc gate --json            the summary as one object
 *   mc gate --budget <s>      answer after at most s seconds (default 540); the tests keep running
 *   mc gate --wait            wait for the gate running here and print its verdict
 *
 * There is no whole gate here (Martin, 2026-10-24: *"det ska i princip inte gå
 * att köra full gate"*). The whole measurement is the merger's: `mc publish`
 * queues the pull request, and the merge round runs the repository's selection
 * in its lane, once. A session's whole gate measured the same thing minutes
 * before, beside every other session's, and the round reused it in 36 of 300
 * memoro rounds (2026-10-20..24) — the rest it measured again. So `mc gate`
 * runs named test files, at most `MAX_FILES` of them; with none named, the
 * test files the branch itself adds or changes. `--full` is refused.
 *
 * The tests run in the repository's gate lane (`gate-lane-wait.js`): the
 * detached shell takes the lane's lock for its own pid before it starts, and
 * waits while a merge round, a deploy, an iOS build or another session's gate
 * holds it. So no two test runs share the cores of one lane, and the merger
 * waits for a session's few seconds of tests as it waits for any round.
 *
 * The output goes to a file — under `$MC_SCRATCH` in a runner session, the
 * system temp directory otherwise — as it is written; when the tests end the
 * shell writes their exit code beside the log. This verb answers within the
 * budget: GREEN or RED, the counts, the failing lines with their locations,
 * and the file's path, at most 2 KB. Past the budget it answers `RUNNING` and
 * exits 3; the tests run on, and `mc gate --wait` prints the verdict from the
 * same log. Time spent waiting for the lane is in the budget.
 *
 * One gate per worktree: a lock beside the git directory names the running
 * gate's pid and log, and a second `mc gate` there refuses while that pid lives.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { changedAgainst, declaredTestFlags } from '../gate-fast.js';
import { gateLines, namedCommand, rerunLine, summarizeGate } from '../gate-local.js';
import { tryGit } from '../git.js';
import { mcHome } from '../paths.js';
import { declarationFor, gateLaneOf } from '../repo-gate-table.js';
import { repositoryDir } from '../repos.js';
import { testLanes } from '../repo-gate.js';
import { scanArgs } from './flags.js';

/** How long the answer waits for the gate, in seconds, unless `--budget` says otherwise. */
const DEFAULT_BUDGET = 540;
/** How often the answer looks for the gate's exit code. */
const POLL_MS = 2000;
/**
 * The most test files one `mc gate` runs. More than this is a suite, and the
 * suite is the merger's: name the files the change reaches.
 */
export const MAX_FILES = 30;
/** What a test file is called: `….test.js`, `.mjs`, `.cjs`, `.ts`. */
const TEST_FILE = /\.test\.[cm]?[jt]s$/u;

/** What the gate's shell runs before and after the tests: the lane taken and given back. */
const LANE_WAIT = fileURLToPath(new URL('../gate-lane-wait.js', import.meta.url));

/** The machine the verb runs on; a test hands in its own. */
const SYSTEM = {
  git: tryGit,
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
  declaration: (repoPath, { env }) => declarationFor(repoPath, { root: mcHome(env), env }),
  lane: (repoPath, { env }) => gateLaneOf(repoPath, { root: mcHome(env) }),
};

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
  if (named.length && scanned.flags.base) { stderr.write(`mc: --base picks the changed test files — it takes no named files\n${usage()}`); return 2; }
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

  let files = named;
  if (!files.length) {
    const base = scanned.flags.base || 'origin/main';
    const changed = changedTests(io, { root, base });
    if (changed === null) { stderr.write(`mc: git cannot say what this branch changes against ${base} — name the test files: mc gate <files…>\n`); return 2; }
    if (!changed.length) {
      stdout.write(`NOTHING RUN — this branch adds or changes no test file against ${base}. Name the tests your change reaches: mc gate <files…>. The rest is the merger's measurement.\n`);
      return 0;
    }
    files = changed;
  }
  const missing = files.find((file) => !io.exists(join(root, file)));
  if (missing) { stderr.write(`mc: no such test file: ${missing}\n`); return 2; }
  const notTest = files.find((file) => !TEST_FILE.test(file) || !io.isFile(join(root, file)));
  if (notTest) { stderr.write(`mc: ${notTest} is not a test file (….test.js) — mc gate runs named test files, not directories or the suite\n`); return 2; }
  if (files.length > MAX_FILES) {
    stderr.write(`mc: ${files.length} test files is a suite, and the suite is the merger's — name at most ${MAX_FILES}, the ones your change reaches\n`);
    return 2;
  }

  let manifest = null;
  try { manifest = JSON.parse(io.read(join(root, 'package.json'), 'utf8')); } catch { manifest = null; }
  const command = namedCommand(manifest, files, { pattern, flags: declaredTestFlags(io, { root, env }) });

  const held = readLock(io, lockPath);
  if (held && isRunning(io, held)) {
    stderr.write(`mc: a gate is already running here (pid ${held.pid}, since ${held.started}) — mc gate --wait\n`);
    return 2;
  }

  // The lane is the primary checkout's: a worktree of memoro is memoro.
  const common = io.git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const primary = common ? repositoryDir(common) : root;
  const lane = io.lane(primary, { env });
  // The free cores, not the core count: a session's gate has no round mode, so
  // `testLanes` answers the free cores here (a merge round takes at least four).
  const childEnv = { MC_TEST_LANES: String(testLanes({ env })), ...env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' };

  const startedAt = io.now();
  const stamp = startedAt.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
  const dir = env.MC_SCRATCH || join(tmpdir(), 'mc-gate');
  const logPath = join(dir, `gate-${stamp}.log`);
  let child;
  try {
    io.mkdir(dir);
    const fd = io.open(logPath);
    // `$$` is this shell's own pid, which is `child.pid`: the lane's holder.
    // The wait for the lane is inside the child, so the verb answers within
    // its budget as ever and the wait is in the log.
    const lanes = `'${process.execPath}' '${LANE_WAIT}'`;
    const script = `${lanes} take ${lane} $$ ${shellWord(basename(primary))}; ${command.run}; rc=$?; ${lanes} release ${lane} $$; echo $rc > '${logPath}.exit'`;
    child = io.spawn('sh', ['-c', script], {
      cwd: root, env: childEnv, detached: true, stdio: ['ignore', fd, fd],
    });
    io.close(fd);
  } catch (error) {
    stderr.write(`mc: could not start the gate, log ${logPath}: ${error.message}\n`);
    return 2;
  }
  child.unref();
  io.write(`${logPath}.pid`, `${child.pid}\n`);
  const lock = { pid: child.pid, log: logPath, started: startedAt.toISOString(), lane, command };
  io.write(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return answer(io, { lock, lockPath, budget, waitedFrom: startedAt, json: scanned.flags.json, stdout });
}

/**
 * The test files the branch adds or changes against `base`, committed or not,
 * untracked ones included, that still exist; null when git cannot say.
 */
function changedTests(io, { root, base }) {
  const mergeBase = io.git(root, ['merge-base', 'HEAD', base]);
  if (!mergeBase) return null;
  const changed = changedAgainst(io, root, mergeBase);
  if (!changed) return null;
  return changed.filter((path) => TEST_FILE.test(path) && io.exists(join(root, path)));
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
    const log = readText(io, lock.log);
    const queued = log.includes('mc gate: waiting for ') && !log.includes('lane is free — starting');
    stdout.write(`RUNNING — ${shown} — ${seconds}s so far, ${queued ? `still waiting for the ${lock.lane} lane` : 'still running'} (pid ${lock.pid})\nlog: ${lock.log} — mc gate --wait waits for it and prints the verdict\n`);
    return 3;
  }
  io.remove(lockPath);
  if (outcome.dead) {
    stdout.write(`RED — the gate's process ended without an exit code — log: ${lock.log}\n`);
    return 1;
  }
  const output = readText(io, lock.log);
  const summary = summarizeGate(output, { exitCode: outcome.code });
  if (json) {
    stdout.write(`${JSON.stringify({ ...summary, command: lock.command.run, script: lock.command.script, files: lock.command.files, seconds, log: lock.log, exit: outcome.code }, null, 2)}\n`);
  } else {
    stdout.write(`${gateLines(summary, { command: shown, seconds, logPath: lock.log, rerun: rerunLine(lock.command.files, output) })}\n`);
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

function shellWord(text) {
  return /^[\w./:=@%+,-]+$/u.test(text) ? text : `'${String(text).replace(/'/gu, `'\\''`)}'`;
}

export function usage() {
  return [
    `usage — mc gate <test files…> [--test-name-pattern <p>]   the named test files (at most ${MAX_FILES}), with the node --test flags the repository declares (pr_tests_flags), else those of its test script\n`,
    '        mc gate                       the test files this branch adds or changes against origin/main\n',
    '        mc gate --base <ref>          … against another base\n',
    '        mc gate --json                the summary as one object\n',
    '        mc gate --budget <s>          answer after at most s seconds, default 540; the tests keep running\n',
    '        mc gate --wait                wait for the gate running here and print its verdict\n',
    '\n',
    'No whole gate: the merger measures the pull request once, in its lane — mc publish queues it.\n',
    'The tests run in the repository\'s gate lane, one run at a time beside merge rounds, deploys and other sessions\' gates.\n',
    'Prints at most 2 KB — GREEN/RED, counts, the failing lines and their locations, and the path of the whole output.\n',
    'Exit 0 green (or nothing to run), 1 red, 2 refused or already running, 3 still running.\n',
  ].join('');
}
