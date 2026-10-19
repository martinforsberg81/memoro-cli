/**
 * `mc gate` — run this worktree's own gate, and read only the verdict.
 *
 *   mc gate                   the repository's gate on the tree you stand in
 *   mc gate --full            the whole gate, never a fast path
 *   mc gate --base <ref>      measured against another base than origin/main
 *   mc gate --json            the summary as one object
 *   mc gate --budget <s>      answer after at most s seconds (default 540); the gate keeps running
 *   mc gate --wait            wait for the gate running here and print its verdict
 *   mc gate <files…> [--test-name-pattern <p>]
 *                             the named test files, with the node --test flags the repository declares
 *                             (pr_tests_flags), else those of its test script
 *
 * What runs is the repository's, read from its `package.json` (`gate-local.js`):
 * `npm run ci -- --base-ref origin/main` where there is a `ci` script, else
 * `npm test`; named files run `node --test` with the declared `pr_tests_flags`
 * (read from the primary checkout, as the incremental gate reads it), else the
 * flags of its `test` script.
 * The gate is a detached child whose output goes to a file — under
 * `$MC_SCRATCH` in a runner session, the system temp directory otherwise — as
 * it is written, so the log is readable while the gate runs; when it ends it
 * writes its exit code beside the log. This verb answers within the budget:
 * GREEN or RED, the counts, the failing lines with their locations, and the
 * file's path, at most 2 KB. Past the budget it answers `RUNNING` and exits 3;
 * the gate runs on, and `mc gate --wait` (or a later call) prints the verdict
 * from the same log.
 *
 * Before it starts one, it looks for a fast path (`gate-fast.js`): nothing
 * changed against the base, a docs-only change, a tree a whole gate already
 * measured green, or — after a red — an INCREMENTAL run of the red files and
 * what the change since selects. `--full` skips them. The whole gate's child
 * gets `MC_GATE_FAIL_FAST=1`, which a repository's runner may honour.
 *
 * One gate per worktree: a lock beside the git directory names the running
 * gate's pid and log, and a second `mc gate` there refuses while that pid lives.
 *
 * It answers "is my tree red?" before the push, and a green is remembered
 * (ruling 44, `gate-greens.js`). The whole gate against origin/main, on a
 * clean tree, in a repository that declares `select`: the tree, the hash of
 * what the declared `select` prints here and the measurement version go in
 * `gate-greens.jsonl`, and a merge round whose candidate is that tree with
 * that selection runs only the pull request's own tests. The selection is
 * asked exactly as the merger asks it — the primary checkout's declaration,
 * its selection state directory, the same `origin/main` — and the gate runs
 * with that state too. Anything else, and `mc merge` measures again.
 *
 * A selection that names a command with `needs: ['docker']` (the whole gate's,
 * or an INCREMENTAL run's) leases the container runtime for the detached gate's
 * pid (`docker.js`), and the gate exports `MC_DOCKER_HOLDER`. Nothing here
 * releases that lease: it ends with the gate's pid.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deployHolding, IOS_BUILD_MODE } from '../await-deploy.js';
import { ensure, needsDocker } from '../docker.js';
import { declaredTestFlags, planGate, recordLast, snapshotTree } from '../gate-fast.js';
import { gateCommand, gateLines, namedCommand, rerunLine, summarizeGate } from '../gate-local.js';
import { GATE_MEASUREMENT_VERSION, recordGreen, selectionHash } from '../gate-greens.js';
import { tryGit } from '../git.js';
import { mcHome } from '../paths.js';
import { declarationFor } from '../repo-gate-table.js';
import { selectionStateDir } from '../repo-gate.js';
import { currentHolder } from '../work-identity.js';
import { scanArgs } from './flags.js';

/** How long the answer waits for the gate, in seconds, unless `--budget` says otherwise. */
const DEFAULT_BUDGET = 540;
/** How often the answer looks for the gate's exit code. */
const POLL_MS = 2000;

/** What a gate started while a deploy or an iOS build holds the heavy lane runs first (`await-deploy.js`). */
const AWAIT_DEPLOY = fileURLToPath(new URL('../await-deploy.js', import.meta.url));

/** The machine the verb runs on; a test hands in its own. */
const SYSTEM = {
  git: tryGit,
  read: readFileSync,
  write: writeFileSync,
  exists: existsSync,
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
  select: (command, { cwd, env }) => spawnSync('sh', ['-c', command], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
  recordGreen: (entry, { env }) => recordGreen({ root: mcHome(env), entry }),
  holder: ({ cwd, env }) => currentHolder({ cwd, env }).name,
  snapshotTree,
  dockerEnsure: (options) => ensure(options),
  deployHolding: ({ env }) => deployHolding({ root: mcHome(env) }),
};

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const cwd = deps.cwd || process.cwd();
  const io = { ...SYSTEM, ...deps };
  const scanned = scanArgs(argv, { booleans: ['--json', '--wait', '--full'], strictValues: ['--base', '--budget', '--test-name-pattern'] });
  if (scanned.error) { stderr.write(`mc: ${scanned.error}\n${usage()}`); return 2; }
  const files = scanned.positional;
  const pattern = scanned.flags['test-name-pattern'];
  if (pattern != null && !files.length) { stderr.write(`mc: --test-name-pattern goes with test files (mc gate <files…> --test-name-pattern <p>)\n${usage()}`); return 2; }
  if (files.length && scanned.flags.full) { stderr.write(`mc: --full is the whole gate — it takes no test files\n${usage()}`); return 2; }
  if (files.length && scanned.flags.wait) { stderr.write(`mc: --wait takes no test files — it waits for the gate running here\n${usage()}`); return 2; }
  const budget = scanned.flags.budget == null ? DEFAULT_BUDGET : Number(scanned.flags.budget);
  if (!(budget > 0)) { stderr.write(`mc: --budget takes seconds, a positive number (${scanned.flags.budget})\n${usage()}`); return 2; }

  const root = io.git(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) { stderr.write('mc: not inside a git worktree — mc gate runs the gate of the tree you stand in\n'); return 2; }
  const gitDir = io.git(root, ['rev-parse', '--absolute-git-dir']);
  if (!gitDir) { stderr.write(`mc: cannot find the git directory of ${root}\n`); return 2; }
  const lockPath = join(gitDir, 'mc-gate.json');

  if (scanned.flags.wait) {
    const lock = readLock(io, lockPath);
    if (!lock) { stderr.write('mc: no gate running here — mc gate starts one\n'); return 2; }
    return answer(io, { lock, lockPath, budget, waitedFrom: io.now(), json: scanned.flags.json, stdout, root, env });
  }

  const missing = files.find((file) => !io.exists(join(root, file)));
  if (missing) { stderr.write(`mc: no such test file: ${missing}\n`); return 2; }

  let manifest = null;
  try { manifest = JSON.parse(io.read(join(root, 'package.json'), 'utf8')); } catch { manifest = null; }
  const base = scanned.flags.base || 'origin/main';
  const command = files.length ? namedCommand(manifest, files, { pattern, flags: declaredTestFlags(io, { root, env }) }) : gateCommand(manifest, { base });
  if (!command) { stderr.write(`mc: ${root} has no ci or test script in package.json — nothing to run\n`); return 2; }

  const held = readLock(io, lockPath);
  if (held && isRunning(io, held)) {
    stderr.write(`mc: a gate is already running here (pid ${held.pid}, since ${held.started}) — mc gate --wait\n`);
    return 2;
  }

  const fast = files.length ? {} : planGate(io, { root, gitDir, base, full: scanned.flags.full, env, manifest });
  if (fast.answer) {
    stdout.write(scanned.flags.json ? `${JSON.stringify(fast.answer.json, null, 2)}\n` : `${fast.answer.text}\n`);
    return 0;
  }
  const chosen = fast.incremental?.command || command;
  const whole = !files.length && !fast.incremental;

  // The whole gate against origin/main is the one a merge round can take.
  const recordable = whole ? greenToRecord(io, { root, env, base }) : null;
  // A dirty tree or another base leaves `green` null: the selector is not run
  // there, so such a whole gate does not ensure the runtime.
  const wantsDocker = whole ? Boolean(recordable?.green?.docker) : Boolean(fast.incremental?.docker);
  const childEnv = { ...(recordable?.env || env), CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', ...(whole ? { MC_GATE_FAIL_FAST: '1' } : {}) };
  if (wantsDocker) {
    childEnv.MC_DOCKER_RUN = `gate ${basename(root)}`;
    childEnv.MC_DOCKER_REPO = recordable?.green?.repo || basename(root);
  }

  const deploying = io.deployHolding({ env });
  if (deploying) {
    const what = deploying.mode === IOS_BUILD_MODE ? 'an iOS build' : 'a deploy';
    stderr.write(`mc: ${what} holds the heavy lane (pid ${deploying.pid}) — this gate starts its tests when it is done\n`);
  }

  const startedAt = io.now();
  const stamp = startedAt.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
  const dir = env.MC_SCRATCH || join(tmpdir(), 'mc-gate');
  const logPath = join(dir, `gate-${stamp}.log`);
  let child;
  try {
    io.mkdir(dir);
    const fd = io.open(logPath);
    // `$$` is this shell's own pid, which is `child.pid`: the lease holder.
    // A deploy holding the heavy lane is waited for inside the child, so the
    // verb answers within its budget as ever and the wait is in the log.
    const waitDeploy = deploying ? `'${process.execPath}' '${AWAIT_DEPLOY}'; ` : '';
    const script = `${wantsDocker ? 'export MC_DOCKER_HOLDER=$$; ' : ''}${waitDeploy}${chosen.run}; echo $? > '${logPath}.exit'`;
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
  // The ensure runs after the spawn: memoro's heavy command gates start only
  // after the test batches, so a start of up to 60 s falls inside the gate's
  // own time. Nothing is released here; the lease ends with the child's pid.
  if (wantsDocker) {
    let up;
    try {
      up = await io.dockerEnsure({ pid: child.pid, run: childEnv.MC_DOCKER_RUN, repo: childEnv.MC_DOCKER_REPO, root: mcHome(env), env });
    } catch (error) {
      up = { ok: false, reason: error.message };
    }
    if (!up.ok) stderr.write(`mc: docker could not be started — ${up.reason}; the gate runs on, and a gate that needs docker will say unavailable\n`);
    else if (up.started) stderr.write(`docker: started for this gate (lease for pid ${child.pid})\n`);
  }
  const lock = {
    pid: child.pid, log: logPath, started: startedAt.toISOString(), command: { ...chosen, base },
    ...(whole && fast.snapshot ? { snapshot: fast.snapshot } : {}),
    ...(recordable?.green ? { green: recordable.green } : {}),
  };
  io.write(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return answer(io, { lock, lockPath, budget, waitedFrom: startedAt, json: scanned.flags.json, stdout, root, env });
}

/**
 * What a green of this gate would record, asked before it starts: `{ env,
 * green }`, or null when the repository declares no `select` — then the gate
 * runs as it always did and nothing is recorded.
 *
 * `env` is the environment the merger's round selects with: the selection
 * state directory of the primary checkout, read-only. `green` is set only on
 * a clean tree against origin/main whose `select` answered: the repository's
 * name as the merger reads it, the tree, and the selection's hash.
 */
function greenToRecord(io, { root, env, base }) {
  const common = io.git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common) return null;
  const primary = dirname(common);
  let declared = null;
  try { declared = io.declaration(primary, { env }); } catch { return null; }
  const select = declared?.ok ? declared.declaration?.select : null;
  if (!select) return null;
  const state = selectionStateDir({ root: mcHome(env), repoPath: primary });
  try { io.mkdir(state); } catch { /* a selector without it selects as before */ }
  const selectEnv = { ...env, MC_SELECTION_STATE: state };
  delete selectEnv.MC_SELECTION_STATE_WRITE;
  if (base !== 'origin/main' || io.git(root, ['status', '--porcelain']) !== '') return { env: selectEnv, green: null };
  const tree = io.git(root, ['rev-parse', 'HEAD^{tree}']);
  if (!tree) return { env: selectEnv, green: null };
  let parsed = null;
  try {
    const ran = io.select(select, { cwd: root, env: selectEnv });
    parsed = ran?.status === 0 ? JSON.parse(ran.stdout) : null;
  } catch { parsed = null; }
  if (!Array.isArray(parsed?.files)) return { env: selectEnv, green: null };
  // What the delta reuse (ruling 47) reads beside the hash: the commit of
  // main this tree was measured from, and what the selection reached by name.
  // `base` is null when git cannot say, and such a record is only ever an
  // exact match.
  const measuredFrom = io.git(root, ['merge-base', 'HEAD', 'origin/main']) || null;
  return {
    env: selectEnv,
    green: {
      repo: basename(primary), tree, selection: selectionHash(parsed), base: measuredFrom,
      files: parsed.files.map(String).filter(Boolean).sort(),
      commands: [...new Set((Array.isArray(parsed.commands) ? parsed.commands : [])
        .map((entry) => String(entry?.packageScript ?? '')).filter(Boolean))].sort(),
      docker: (Array.isArray(parsed.commands) ? parsed.commands : []).some(needsDocker),
    },
  };
}

/**
 * The green, written down once the gate is green — and only while the tree is
 * still the clean tree it measured. A record that cannot be written is said
 * nowhere and changes no verdict; the merger then measures again.
 */
function remember(io, { lock, root, env }) {
  const green = lock.green;
  if (!green) return false;
  if (io.git(root, ['status', '--porcelain']) !== '' || io.git(root, ['rev-parse', 'HEAD^{tree}']) !== green.tree) return false;
  try {
    io.recordGreen({
      repo: green.repo, tree: green.tree, selection: green.selection, gate_version: GATE_MEASUREMENT_VERSION,
      at: io.now().toISOString(), session: io.holder({ cwd: root, env }),
      // The delta reuse's half (ruling 47, `findGreenForHead`): the same tree
      // under the name the merger looks it up by, the base it was measured
      // from, and the selection by name rather than by hash.
      head_tree: green.tree, base: green.base ?? null, files: green.files ?? [], commands: green.commands ?? [],
    }, { env });
    return true;
  } catch { return false; }
}

/**
 * Waits for the gate to end or the budget to run out, then answers: the
 * verdict (and the lock goes), a red for a process that ended without an exit
 * code (and the lock goes), or RUNNING with exit 3 (and the lock stays).
 */
async function answer(io, { lock, lockPath, budget, waitedFrom, json, stdout, root, env }) {
  const outcome = await waitForExit(io, { log: lock.log, pid: lock.pid, since: waitedFrom, budget });
  const seconds = Math.round((io.now().getTime() - Date.parse(lock.started)) / 1000);
  if (outcome.budget) {
    stdout.write(`RUNNING${lock.command.label ? ' INCREMENTAL' : ''} — ${lock.command.shown || lock.command.run} — ${seconds}s so far, still running (pid ${lock.pid})\nlog: ${lock.log} — mc gate --wait waits for it and prints the verdict\n`);
    return 3;
  }
  io.remove(lockPath);
  if (outcome.dead) {
    stdout.write(`RED — the gate's process ended without an exit code — log: ${lock.log}\n`);
    return 1;
  }
  const output = readText(io, lock.log);
  const summary = summarizeGate(output, { exitCode: outcome.code });
  const recorded = summary.ok ? remember(io, { lock, root, env }) : false;
  if (lock.snapshot) recordLast(io, { lock, lockPath, root, output, code: outcome.code, gates: summary.gates });
  const shown = lock.command.shown || lock.command.run;
  if (json) {
    stdout.write(`${JSON.stringify({ ...summary, command: lock.command.run, ...(lock.command.label ? { incremental: lock.command.label } : {}), script: lock.command.script, base: lock.command.base, seconds, log: lock.log, exit: outcome.code, recorded }, null, 2)}\n`);
  } else {
    stdout.write(`${gateLines(summary, { command: shown, label: lock.command.label, seconds, logPath: lock.log, rerun: rerunLine(lock.command.files, output) })}\n`);
    if (recorded) stdout.write(`recorded: tree ${lock.green.tree.slice(0, 7)} green — mc merge does not measure it again while the tree and selection match\n`);
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
    'usage — mc gate                       this worktree\'s own gate: npm run ci -- --base-ref origin/main, or npm test\n',
    '        mc gate --full                the whole gate: no docs-only, unchanged or incremental fast path\n',
    '        mc gate --base <ref>          measured against another base\n',
    '        mc gate --json                the summary as one object\n',
    '        mc gate --budget <s>          answer after at most s seconds, default 540; the gate keeps running\n',
    '        mc gate --wait                wait for the gate running here and print its verdict\n',
    '        mc gate <test files…> [--test-name-pattern <p>]   the named test files, with the node --test flags the repository declares (pr_tests_flags), else those of its test script; the same log, budget and summary\n',
    '\n',
    'Fast paths, without --full: nothing changed against the base, or only docs/ (no scripts), answers GREEN at once;\n',
    'a tree the last whole gate here measured green answers GREEN (unchanged since …); after a red whole gate, only the\n',
    'red files plus what the declared select picks for the paths changed since run, marked INCREMENTAL — never the whole gate.\n',
    'Prints at most 2 KB — GREEN/RED, counts, the failing lines and their locations, and the path of the whole output.\n',
    'Exit 0 green, 1 red, 2 nothing to run or already running, 3 still running.\n',
  ].join('');
}
