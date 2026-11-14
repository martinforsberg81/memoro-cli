/**
 * `mc gate` — run the tests a change reaches and read only the verdict.
 *
 *   mc gate <files…> [--test-name-pattern <p>]
 *                             the named test files, with the node --test flags the repository declares
 *                             (pr_tests_flags), else those of its test script
 *   mc gate                   the change's own tests against origin/main
 *   mc gate --base <ref>      … against another base
 *   mc gate --whole-selection run the optional wide selection with command gates
 *   mc gate --fresh           run the whole request again, reusing nothing from earlier attempts
 *   mc gate --command <id>    one command gate of this change's selection, alone, reusing nothing
 *   mc gate --json            the summary as one object
 *   mc gate --budget <s>      answer after at most s seconds (default 540); the tests keep running
 *   mc gate --wait            wait for the gate running here and print its verdict
 *
 * With no files named, the repository selector maps the complete branch and
 * local changes to the change's own tests, without command gates. Named files run explicitly, with
 * the selector's resource classes when available. There is no file-count cap:
 * the shared runner bounds concurrency and test duration. The final merge
 * still verifies the candidate with the current base.
 *
 * No lane and no queue: the detached worker starts at once, at low priority,
 * beside any merge round (only a deploy or iOS build of memoro goes first).
 * A bare gate and a merge round measure the same change scope, without cost
 * deferral or command gates. --whole-selection opts into wide regression.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { changedAgainst, flagsOf, measuredDeclaration } from '../gate-fast.js';
import { selectorCommand } from '../session-gate-run.js';
import { gateLines, namedCommand, rerunLine, summarizeGate, timedTestLines } from '../gate-local.js';
import { changedRanges, slowTestLines } from '../test-times.js';
import { tryGit } from '../git.js';
import { mcHome } from '../paths.js';
import { declarationFor, gateLaneOf } from '../repo-gate-table.js';
import { repositoryDir } from '../repos.js';
import { captureWorktree } from '../session-gate-evidence.js';
import { gateConfiguration } from '../gate-greens.js';
import { executionIdentity, resolveTestPlan } from '../repo-gate.js';
import { testLanes } from '../repo-gate.js';
import { scanArgs } from './flags.js';
import { takeClaim, releaseClaim } from '../resource-claim.js';
import { commandUsage } from '../command-help.js';

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
  declaration: (repoPath, { env, contentDir }) => declarationFor(repoPath, { root: mcHome(env), env, contentDir }),
};

/** Whose gate this is: the primary checkout's repository. A worktree of memoro is memoro. */
export function gateOwner(cwd, env = process.env, io = SYSTEM) {
  const common = io.git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return { root: mcHome(env), repo: gateLaneOf(common ? repositoryDir(common) : cwd) };
}

/** Each subcommand and the scan it is read with; '' is the bare verb, '*' a first word that names something. help-routes.test.js walks the help with it. */
export const ROUTES = { '': { booleans: ['--json', '--wait', '--full', '--whole-selection', '--fresh'], strictValues: ['--base', '--budget', '--test-name-pattern', '--command'] } };
ROUTES['*'] = ROUTES[''];

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const cwd = deps.cwd || process.cwd();
  const io = { ...SYSTEM, ...deps };
  const scanned = scanArgs(argv, ROUTES['']);
  if (scanned.error) { stderr.write(`mc: ${scanned.error}\n${usage()}`); return 2; }
  if (scanned.flags.full) {
    stderr.write('mc: there is no whole gate in a worktree — the merger measures the pull request once, in its lane (mc publish queues it); mc gate <files…> runs the tests your change reaches\n');
    return 2;
  }
  const named = scanned.positional;
  const pattern = scanned.flags['test-name-pattern'];
  const commandId = scanned.flags.command;
  if (commandId != null && named.length) { stderr.write(`mc: --command runs one command gate of the selection and takes no test files\n${usage()}`); return 2; }
  if (commandId != null && scanned.flags.wait) { stderr.write(`mc: --command cannot be combined with --wait\n${usage()}`); return 2; }
  if (commandId != null && scanned.flags['whole-selection']) { stderr.write(`mc: --command cannot be combined with --whole-selection\n${usage()}`); return 2; }
  if (commandId != null && pattern != null) { stderr.write(`mc: --command cannot be combined with --test-name-pattern\n${usage()}`); return 2; }
  if (scanned.flags['whole-selection'] && named.length) {
    stderr.write(`mc: --whole-selection runs the affected selector and takes no named files\n${usage()}`); return 2;
  }
  if (scanned.flags['whole-selection'] && pattern != null) {
    stderr.write(`mc: --whole-selection runs the affected selector and cannot be combined with --test-name-pattern\n${usage()}`); return 2;
  }
  if (scanned.flags['whole-selection'] && scanned.flags.wait) {
    stderr.write(`mc: --whole-selection starts a complete affected-selection request; --wait only observes the already-started request and cannot start or broaden it\n${usage()}`); return 2;
  }
  if (scanned.flags.fresh && scanned.flags.wait) {
    stderr.write(`mc: --fresh starts a new request; --wait only observes the one already running\n${usage()}`); return 2;
  }
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
  const mergeBase = io.git(root, ['merge-base', 'HEAD', base]);
  const changed = mergeBase ? changedAgainst(io, root, mergeBase) : null;
  if (!files.length) {
    if (changed === null) { stderr.write(`mc: git cannot say what this branch changes against ${baseRef} — name the test files: mc gate <files…>\n`); return 2; }
    if (!changed.length) {
      stdout.write(`NOTHING CHANGED — no changes against ${baseRef}\n`);
      return 0;
    }
  }
  // The declaration of the tree this gate measures: the worktree's own
  // `.mc/test.json`, under the repository's name (`measuredDeclaration`). A
  // malformed one, or a layer that drops or loosens its timeout
  // ambiguously, is a stop here, before anything is spawned.
  const measured = measuredDeclaration(io, { root, env });
  if (measured?.stop) { stderr.write(`mc: ${measured.stop}\n`); return 2; }
  if (measured?.notice) stdout.write(`${measured.notice}\n`);
  if (!files.length) {
    const declared = measured;
    declaration = declared?.declaration ?? null;
    if (!declared?.declaration.select) {
      stderr.write('mc: no repository test selector declared — name the tests explicitly; nothing was verified\n');
      return 2;
    }
    const wide = scanned.flags['whole-selection'] || commandId != null;
    select = selectorCommand(wide ? (declaration.select_whole || declaration.select) : declaration.select, { base, changed });
    addedTests = changed.filter((file) => TEST_FILE.test(file) && io.exists(join(root, file)));
  }
  const missing = files.find((file) => !io.exists(join(root, file)));
  if (missing) { stderr.write(`mc: no such test file: ${missing}\n`); return 2; }
  const notTest = files.find((file) => !TEST_FILE.test(file) || !io.isFile(join(root, file)));
  if (notTest) { stderr.write(`mc: ${notTest} is not a test file (….test.js) — mc gate runs named test files, not directories or the suite\n`); return 2; }

  let manifest = null;
  try { manifest = JSON.parse(io.read(join(root, 'package.json'), 'utf8')); } catch { manifest = null; }
  const flags = flagsOf(measured?.declaration);
  // The one resolution (`resolveTestPlan`) the worker spawns with: the requested
  // flags, and the effective timeout with its provenance (declaration, script or default).
  const plan = resolveTestPlan({ flags: flags ?? [], script: manifest?.scripts?.test ?? null });
  if (plan.invalid) { stderr.write(`mc: timeout policy: ${plan.invalid} — nothing was run\n`); return 2; }
  const effectiveFlags = plan.flags;
  if (files.length) {
    declaration = measured?.declaration ?? null;
    if (declaration?.select) select = selectorCommand(declaration.select, { base, changed: files });
  }
  const configuration = gateConfiguration(declaration, effectiveFlags, executionIdentity(plan));
  const command = commandId != null ? { run: `command gate ${commandId} against ${baseRef}`, source: 'selection' } : files.length ? namedCommand(manifest, files, { pattern, flags })
    : { run: `${scanned.flags['whole-selection'] ? 'wide tests and command gates' : "the change's own tests"} against ${baseRef}`, source: 'selection' };
  // The test files this change adds or changes, with the changed lines of each: the tests
  // among them are timed in the verdict (`touchedTests`). Nothing here decides the verdict.
  const timed = {};
  if (mergeBase && changed) {
    for (const file of (files.length ? files : addedTests).filter((one) => changed.includes(one))) timed[file] = timedRanges(io, root, mergeBase, file);
  }

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
    startedAt = io.now();
    const stamp = startedAt.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
    const dir = env.MC_SCRATCH || join(tmpdir(), 'mc-gate');
    const run = io.id();
    // `MC_GATE_ROUND` marks a dev server the gate's tests start as a gate
    // round's in the admission queue, which goes first after two minutes.
    const childEnv = {
      MC_TEST_LANES: String(testLanes({ env })), ...env, MC_GATE_ROUND: env.MC_GATE_ROUND || `gate-${run}`, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1',
    };
    const logPath = join(dir, `gate-${stamp}-${run}.log`);
    const requestPath = `${logPath}.request.json`;
    let child;
    try {
      io.mkdir(dir);
      io.write(requestPath, JSON.stringify({ cwd: root, files: commandId != null ? null : files.length ? files : null, commands: commandId != null ? [commandId] : undefined, addedTests, timed, flags: effectiveFlags, declared: flags ?? [], pattern, select, base, mainOnly: scanned.flags['whole-selection'] ? declaration?.main_only ?? [] : [],
        round_timeout_ms: declaration?.round_timeout_ms ?? null,
        log: logPath, fresh: commandId != null || Boolean(scanned.flags.fresh), defer: false,
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
  let result = null;
  try { result = JSON.parse(readText(io, `${lock.request}.result`)); } catch { /* an older gate or interrupted worker */ }
  const summary = summarizeGate(output, { exitCode: outcome.code, unavailableCommands: result?.unavailable_commands || [] });
  if (result?.files) lock.command.files = result.files;
  // A gate that reached the repository's ceiling was stopped, not failed: its
  // verdict names what did not finish and the slowest files that did, and the
  // worker's own "interrupted" lines are its stop, not its cause.
  const ceiling = result?.stopped_at === 'timeout';
  if (ceiling) {
    summary.failures = [result.reason || 'the gate reached its repository ceiling'];
    summary.more = 0;
  } else if (result?.red_tests?.length) summary.failures = result.red_tests.slice(0, 5).flatMap((test) => [
    `✖ ${test.name}${stallGuardOf(test)}`, ...(test.at ? [`    at ${test.at}`] : []), ...(test.error || []).map((line) => `    ${line}`),
  ]);
  const deferredFiles = result?.deferred || [];
  const left = deferredFiles.length ? `\nPARTIAL COVERAGE — deferred files were not measured; the merge round or mc gate --whole-selection measures them: ${deferredFiles.join(' ')}` : '';
  const resumed = resumedLine(result);
  const settled = settledLine(result);
  const receipt = summary.ok && !summary.incomplete ? settledReceiptLine(result) : null;
  const resumedText = `${resumed ? `\n${resumed}` : ''}${settled ? `\n${settled}` : ''}${receipt ? `\n${receipt}` : ''}`;
  if (json) {
    const verdict = ceiling ? { stopped_at: 'timeout', reason: result.reason, red_files: result.red_files || [], slowest_files: result.slowest_files || [] } : {};
    stdout.write(`${JSON.stringify({ ...summary, ...verdict, command: lock.command.run, script: lock.command.script, files: lock.command.files, deferred: deferredFiles,
      coverage: result?.coverage ?? null, resumed: result?.resumed ?? null, settled: result?.settled ?? null, red_tests: result?.red_tests, commands: result?.commands, evidence: result?.evidence, timed_tests: result?.timed_tests, slow_tests: result?.slow_tests || [], seconds, log: lock.log, exit: outcome.code }, null, 2)}\n`);
  } else {
    stdout.write(`${gateLines(summary, { command: shown, seconds, logPath: lock.log, rerun: rerunLine(lock.command.files, output), timed: timedTestLines(result?.timed_tests), slow: slowTestLines(result?.slow_tests), reused: reusedOf(result?.resumed) })}${resumedText}${left}\n`);
  }
  return (summary.process_ok ?? summary.ok) ? 0 : 1;
}

/** ` — reached the 30 s stall guard` for a test node cut at its limit, and nothing for any other red. */
export function stallGuardOf(test) {
  const cut = /(?:test )?timed out after\s+(\d+)\s*ms/iu.exec((test?.error || []).join(' '));
  return cut ? ` — reached the ${Math.ceil(Number(cut[1]) / 1000)} s stall guard` : '';
}

/**
 * What the gate settled before calling a red the change's (`gate-settle.js`):
 * `SETTLED — green alone: …; command gates green alone: …`; null when nothing was.
 * The counts above it are the round's own, failures included: this line is why it is green.
 */
export function settledLine(result) {
  const settled = result?.settled;
  if (!settled || (!settled.alone?.length && !settled.main?.length && !settled.commands_alone?.length)) return null;
  const parts = [];
  if (settled.alone?.length) parts.push(`green alone (red in the round under load): ${settled.alone.join(' ')}`);
  if (settled.commands_alone?.length) parts.push(`command gates green alone (red in the round under load): ${settled.commands_alone.join(' ')}`);
  if (settled.main?.length) parts.push(`red on main ${String(settled.base || '').slice(0, 7)} too, untouched by this change: ${settled.main.join(' ')}`);
  if (settled.red?.length) parts.push(`still red: ${settled.red.join(' ')}`);
  return `SETTLED — ${parts.join('; ')}`;
}

/**
 * What a settled green does not grant (`mc-gate-evidence.md`, Settling a red):
 * its receipt is not a reusable complete green, so the text verdict says so
 * under the SETTLED line. Null unless something was settled and the receipt is
 * not green. The caller shows it only for a green verdict.
 */
export function settledReceiptLine(result) {
  if (!settledLine(result) || result?.evidence?.outcome === 'green') return null;
  return `RECEIPT — not a reusable complete green (evidence ${result?.evidence?.outcome ?? 'absent'}): its round had a failure, so it grants reuse only to its members; a rerun on the same content resumes its passed members and measures the rest`;
}

/**
 * What a resumed verdict says it reused: `RESUMED — reused N files and M
 * commands from <runs>`, on content identical to those runs; null when nothing was.
 */
export function resumedLine(result) {
  const reused = reusedOf(result?.resumed);
  if (!reused) return null;
  const word = (count, one) => `${count} ${one}${count === 1 ? '' : 's'}`;
  return `RESUMED — reused ${word(reused.files, 'file')} and ${word(reused.commands, 'command')} from ${reused.from.join(', ')} on identical content; mc gate --fresh reruns them`;
}

/**
 * What a resumed run reused, counted: `{ files, commands, from }`, the runs it
 * came from; null when it resumed nothing (the same condition as the RESUMED line).
 */
export function reusedOf(resumed) {
  if (!resumed?.from?.length) return null;
  return { files: Object.keys(resumed.files || {}).length, commands: (resumed.commands || []).length, from: resumed.from };
}

/**
 * The changed ranges of one test file against the merge base (`changedRanges`),
 * or null when the file is new to the branch: the whole file is then touched.
 */
function timedRanges(io, root, mergeBase, file) {
  if (io.git(root, ['cat-file', '-e', `${mergeBase}:${file}`]) === null) return null;
  return changedRanges(io.git(root, ['diff', '-U0', '--no-color', mergeBase, '--', file]) || '');
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
  return commandUsage('gate');
}
