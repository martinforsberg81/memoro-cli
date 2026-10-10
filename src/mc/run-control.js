/**
 * The runner's switch — `mc run start`, `mc run stop [--force]` and
 * `mc run --update`.
 *
 * `mc run` is the one process that lives all day, and until now the only way
 * to work it was a terminal to start it in and `touch ~/mc/runner/STOP` to end
 * it. Three verbs replace that, and all three have the same shape: a file left
 * in `~/mc/runner/` which the runner reads **at a round boundary**. So an
 * order can be given to a runner that is ninety minutes into a headless
 * session without interrupting it, and the session it is holding is never
 * abandoned halfway.
 *
 *   start      spawn `mc run` detached, its output appended to runner.log;
 *              on a runner that is stopping, a new one takes over at once
 *              and the old one only finishes the steps it holds; every
 *              start that spawns writes the login agent (`agentPlist`)
 *   start --if-was-running  the agent's start: only after a runner that died
 *   stop       write STOP; the steps in flight finish, then the runner exits
 *   stop --force  end it now — the runner and the session it is holding
 *   --update   write UPDATE; mc's own checkout is fast-forwarded, a new
 *              runner starts on the new code at once, and the old one only
 *              finishes the steps it holds
 *
 * **Any order, in any sequence.** Each verb starts by reading where the runner
 * stands — not running, running, stopping, or handing over (`runnerState`) —
 * and every answer says so in the same words. Measured 2026-10-10 in the shell
 * history: `stop`, `start` (refused), `--update` (refused), `start` (refused),
 * `stop --force` — the sessions killed mid-step, only to get a runner going
 * again. A stopping runner is now one `start` away from a running one, and
 * nothing in between ends a session.
 *
 * **Why `--update` has to exist.** Node reads its whole module graph at
 * process start and never looks at the disk again. The runner merges pull
 * requests — including pull requests that change the runner — so a runner that
 * has been up all day is running the code it was started with, however much of
 * itself it has improved since. Measured 2026-08-29: four merged improvements
 * to `mc run` sat unused for two hours. Measured 2026-08-30: the round that
 * could first have closed a finished workarea ran for eighteen hours in a
 * process started ninety minutes *before* the closing code was merged, so
 * nothing was ever closed and no line said why. New code needs a new process.
 * This is the order that asks for one, at a moment that costs nothing.
 *
 * **Why `stop --force` has to exist.** STOP is polite: it waits for the round,
 * and a round can be an hour and a half. `--force` does not wait. It ends the
 * runner and the session under it now, and then removes the two files a killed
 * runner never gets to remove itself — `runner.json` and `current-<repo>.json`
 * — which the page would otherwise draw as a step that is still running.
 *
 * Every process boundary is a key on `deps`, so all of this is driven in tests
 * with no processes, no files and no `ps`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultRepos } from './brief-collect.js';
import { readLaneCount } from './lane-count.js';
import { ageWords } from './page-cache.js';
import { workRoot } from './paths.js';
import { pidAlive } from './status-collect.js';

/** How long a forced stop waits for a signal to be obeyed before the next one. */
export const FORCE_WAIT_MS = 2000;
/** A runner younger than this is a successor the stop was probably not aimed at. */
export const YOUNG_RUNNER_SECONDS = 30;
const FORCE_POLL_MS = 100;

/**
 * The environment a background runner gets: this one, without the shell
 * wrapper's flag.
 *
 * `mc run start` typed at a terminal arrives through the wrapper `mc
 * install-shell` writes, which sets `MC_EMIT_SHELL_DIRECTIVES=1` and holds
 * fd 3 open for the `cd` lines it evals. That pipe closes the moment this
 * command returns, and the runner outlives the shell by hours — so it is
 * started without the flag rather than carrying a claim about a pipe that is
 * no longer there.
 */
export function childEnv(env) {
  const { MC_EMIT_SHELL_DIRECTIVES: _wrapper, ...rest } = env;
  return rest;
}

/** The four files the switch reads and writes, under one work root. */
export function controlPaths(root) {
  const dir = join(root, 'runner');
  return {
    dir,
    runner: join(dir, 'runner.json'),
    stop: join(dir, 'STOP'),
    update: join(dir, 'UPDATE'),
    log: join(dir, 'log', 'runner.log'),
    agentLog: join(dir, 'log', 'login-agent.log'),
  };
}

export function realControlDeps(env = process.env) {
  return {
    env,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    exists: existsSync,
    read: (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } },
    write: (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); },
    remove: (path) => { try { rmSync(path, { force: true }); } catch { /* already gone */ } },
    list: (path) => { try { return readdirSync(path); } catch { return []; } },
    alive: pidAlive,
    kill: (pid, signal) => process.kill(pid, signal),
    ps: (args) => {
      const r = spawnSync('ps', args, { encoding: 'utf8' });
      return r.status === 0 ? (r.stdout || '') : '';
    },
    // Appended to, never truncated: the runner's log is one story across
    // however many processes have told it.
    openLog: (path) => { mkdirSync(dirname(path), { recursive: true }); return openSync(path, 'a'); },
    spawn: ({ bin, args, stdio, env: extra = {} }) => {
      const child = spawn(bin, args, { detached: true, stdio, env: { ...childEnv(env), ...extra } });
      child.unref();
      return child.pid ?? null;
    },
    git: (cwd, args) => {
      const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
      return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
    },
    // How many lanes the runner has in all: `per_repo` on every repository,
    // and never more than `total` (run.js `runLoop`).
    laneCount: () => laneSlots(readLaneCount(), defaultRepos(env).length),
    // The login agent, written only when its text differs, and only on the
    // machine that has a launchd to read it.
    writeAgent: (path, text) => {
      if (process.platform !== 'darwin') return false;
      try { if (readFileSync(path, 'utf8') === text) return false; } catch { /* not there yet */ }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      return true;
    },
    execPath: process.execPath,
    entry: process.argv[1],
  };
}

/* -------------------------------------------------------------- login agent */

/** The launchd label of the agent that starts the runner at login. */
export const AGENT_LABEL = 'se.memoro.mc-runner';
/** The flag the agent starts `mc run start` with. */
export const IF_WAS_RUNNING = '--if-was-running';

/** Where the login agent lives: a file there is loaded at the next login. */
export function agentPath(env) {
  return join(env.HOME || homedir(), 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
}

function xml(text) {
  return String(text).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

/**
 * The login agent's plist, as text: `mc run start --if-was-running` at load,
 * once. No `KeepAlive` — the agent answers a restart, not a runner that
 * exits; a runner that was stopped must stay stopped.
 *
 * launchd hands a login agent neither the shell's PATH nor homebrew's, and
 * `claude` and `codex` live in `/opt/homebrew/bin` and `~/.local/bin`, so the
 * PATH and HOME of the runner that wrote it go in with it.
 */
export function agentPlist({ execPath, entry, env = {}, log }) {
  const string = (value) => `<string>${xml(value)}</string>`;
  const vars = [['PATH', env.PATH], ['HOME', env.HOME]].filter(([, value]) => value);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  ${string(AGENT_LABEL)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...[execPath, entry, 'run', 'start', IF_WAS_RUNNING].map((arg) => `    ${string(arg)}`),
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    ...(vars.length ? [
      '  <key>EnvironmentVariables</key>',
      '  <dict>',
      ...vars.flatMap(([name, value]) => [`    <key>${name}</key>`, `    ${string(value)}`]),
      '  </dict>',
    ] : []),
    '  <key>StandardOutPath</key>',
    `  ${string(log)}`,
    '  <key>StandardErrorPath</key>',
    `  ${string(log)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** The lanes a runner starts: `per_repo` per repository, capped by `total`. */
export function laneSlots({ per_repo: perRepo = 1, total = null } = {}, repos = 1) {
  const all = perRepo * repos;
  return total == null ? all : Math.min(all, total);
}

/**
 * `runner.json` as a fact rather than a claim: the pid it names, and whether
 * that pid is alive. A file naming a dead pid is its own answer — a runner
 * that was killed, or one that died — and the callers say so rather than
 * treating it as nothing.
 */
export function readRunner({ paths, read, alive }) {
  let value = null;
  try { value = JSON.parse(read(paths.runner) ?? ''); } catch { return null; }
  const pid = Number(value?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  // A successor names the runner it took over from while that one still
  // finishes the steps it held (run.js `runLoop`, ruling 28).
  const before = Number(value.predecessor?.pid);
  const predecessor = Number.isInteger(before) && before > 0
    ? { pid: before, started: value.predecessor.started || null, alive: alive(before) }
    : null;
  return {
    pid, started: value.started || null, ...(value.commit ? { commit: value.commit } : {}),
    ...(Array.isArray(value.args) ? { args: value.args.map(String) } : {}),
    // A runner that reads runner.json for a successor's pid, and so stands
    // down when one appears (run.js `replaced`). One that predates it would
    // go on taking steps beside the runner that took over from it.
    ...(value.takeover ? { takeover: true } : {}),
    ...(predecessor ? { predecessor } : {}), alive: alive(pid),
  };
}

/**
 * Where the runner stands, the one reading all three verbs start from:
 *
 *   none       no runner.json, or one naming a pid that is gone
 *   running    a live runner, no order waiting
 *   stopping   STOP is written and a runner it reaches is still alive
 *   draining   UPDATE is written to a live runner that has not read it yet
 *   finishing  only the runner a handover replaced is alive, finishing steps
 *
 * `live` is the runner a new one would take over from: the holder of
 * runner.json when it is alive, else the predecessor it names.
 */
export function runnerState({ paths, deps }) {
  const held = readRunner({ paths, read: deps.read, alive: deps.alive });
  const finishing = held?.predecessor?.alive ? held.predecessor : null;
  const live = held?.alive ? held : finishing;
  const stop = deps.exists(paths.stop);
  const update = deps.exists(paths.update);
  let kind = 'none';
  if (live && stop) kind = 'stopping';
  else if (held?.alive && update) kind = 'draining';
  else if (held?.alive) kind = 'running';
  else if (finishing) kind = 'finishing';
  return { kind, held, finishing, live, stop, update };
}

/** The `started` stamp run.js writes: an ISO time to the second. */
function stampOf(date) {
  return date.toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

/** The `current-<repo>.json` files a killed runner leaves behind, removed. */
function clearCurrents(paths, deps) {
  const names = deps.list(paths.dir).filter((name) => /^current-.+\.json$/u.test(name));
  for (const name of names) deps.remove(join(paths.dir, name));
  return names;
}

/* -------------------------------------------------------------------- start */

/**
 * `mc run start` — a runner running, in the background, with its output
 * appended to `runner.log`.
 *
 * It clears the STOP left by the last stop rather than refusing on it: `start`
 * and `stop` are one switch, and a switch that will not turn back on is not
 * one. That includes a runner that is still *on its way* off: a stop waits for
 * the steps in flight, which can be ninety minutes, and until 2026-10-10 a
 * `start` in that time was refused with nothing to do but wait or force-kill
 * the sessions. Now the stopping runner is taken over (`takeOver`): a new one
 * starts every lane at once, the old one finishes what it holds and exits.
 *
 * It refuses only on the thing a second runner would actually break — a
 * first runner that is running and was not told to stop.
 *
 * `--if-was-running` is the login agent's start (`agentPlist`): a runner only
 * when runner.json names a pid that is gone and no STOP is written — the state
 * a restart leaves, and not the one `mc run stop` leaves. Every other state is
 * a line saying why not, and exit 0: at login nothing to start is not an
 * error. The runner it starts runs with the flags the dead one ran with.
 */
export async function startRunner({ argv = [], root = null, deps = realControlDeps() } = {}) {
  const paths = controlPaths(root ?? workRoot(deps.env));
  const state = runnerState({ paths, deps });
  const { held, live } = state;
  if (argv.includes(IF_WAS_RUNNING)) {
    const why = notRestarted(state, paths, deps);
    if (why) return { ok: true, code: 0, lines: why };
    argv = argv.filter((arg) => arg !== IF_WAS_RUNNING);
    if (!argv.length && held.args) argv = held.args;
  }
  if (state.kind === 'running' || state.kind === 'draining') {
    return {
      ok: false,
      code: 2,
      lines: [
        `a runner is already running — pid ${held.pid}${held.started ? `, started ${held.started}` : ''}`,
        ...progressLines(state, paths, deps),
        state.kind === 'draining'
          ? 'it hands over to a new runner on its own — nothing to start'
          : 'mc run --update restarts it on the newest code · mc run stop stops it',
      ],
    };
  }
  if (live) return takeOver({ state, argv, paths, deps });

  const lines = [];
  if (held) {
    deps.remove(paths.runner);
    clearCurrents(paths, deps);
    lines.push(`cleared runner.json — the pid it named (${held.pid}) is gone`);
  }
  if (state.stop) {
    deps.remove(paths.stop);
    lines.push('removed the STOP the last stop left');
  }
  deps.remove(paths.update);
  return spawnRunner({ argv, paths, deps, lines });
}

/**
 * Why `--if-was-running` starts nothing, or null when the runner was running
 * when it went down: runner.json naming a dead pid, no STOP, nobody alive.
 */
function notRestarted(state, paths, deps) {
  const { kind, held, live } = state;
  if (state.stop) return ['not started — the runner was stopped (STOP present)'];
  if (kind === 'running' || kind === 'draining') {
    return [`a runner is already running — pid ${held.pid}${held.started ? `, started ${held.started}` : ''}`, ...progressLines(state, paths, deps)];
  }
  if (live) return [`a runner is already running — pid ${live.pid}, finishing the steps a handover left it`];
  if (!held) return ['not started — no runner was running'];
  return null;
}

/**
 * The spawn every start ends in, and runner.json written for the child the
 * moment its pid is known.
 *
 * The child writes runner.json itself once it has loaded, but that is a
 * second or so later, and until 2026-10-10 that second was a window: a
 * second `start` in it saw no runner and started another, and a `stop` in it
 * said nothing was running. Written here, the file is true before this
 * command returns; the child finds its own pid in it and carries on
 * (run.js `runLoop`).
 */
function spawnRunner({ argv, paths, deps, lines, predecessor = null }) {
  let fd = null;
  try { fd = deps.openLog(paths.log); } catch (error) {
    return { ok: false, code: 1, lines: [...lines, `could not open ${paths.log} — ${error?.message || error}`] };
  }
  // stderr to the log, stdout to nothing. The runner's own `say()` already
  // appends every line it prints to `runner.log`, so a background runner whose
  // stdout is that same file writes the whole round twice — measured, and the
  // first thing a reader of the log sees. What stdout would add beyond the
  // duplicates is nothing; what stderr adds is the crash that explains a
  // runner that is suddenly gone, which is the reason to keep a handle at all.
  const pid = deps.spawn({
    bin: deps.execPath,
    args: [deps.entry, 'run', ...argv],
    stdio: ['ignore', 'ignore', fd],
    ...(predecessor ? { env: { MC_RUN_SUCCESSOR_OF: String(predecessor.pid) } } : {}),
  });
  if (!pid) return { ok: false, code: 1, lines: [...lines, 'the runner did not start'] };
  deps.write(paths.runner, `${JSON.stringify({
    pid,
    started: stampOf(deps.now()),
    args: argv,
    ...(predecessor ? { predecessor: { pid: predecessor.pid, started: predecessor.started || null } } : {}),
  }, null, 2)}\n`);
  lines.push(`runner started — pid ${pid}${argv.length ? ` (mc run ${argv.join(' ')})` : ''}`);
  lines.push(`log: ${paths.log}`);
  lines.push(...writeLoginAgent(paths, deps));
  return { ok: true, code: 0, pid, lines };
}

/**
 * The login agent, rewritten on every start that spawns, so it always names
 * the node and the mc the last runner ran on. Written only when its text
 * differs; a failure to write it is said and does not undo the start.
 */
function writeLoginAgent(paths, deps) {
  if (!deps.writeAgent) return [];
  const path = agentPath(deps.env);
  const text = agentPlist({ execPath: deps.execPath, entry: deps.entry, env: deps.env, log: paths.agentLog });
  try {
    return deps.writeAgent(path, text) ? [`login agent: ${path}`] : [];
  } catch (error) {
    return [`could not write the login agent ${path} — ${error?.message || error}`];
  }
}

/**
 * A new runner beside one that is on its way out — stopping, or finishing
 * the steps a handover left it — the way `--update` hands over (ruling 28):
 * the new one starts every lane the old one does not hold, the old one takes
 * nothing new and exits when its last step does.
 *
 * Order matters. runner.json is written for the new runner *before* STOP is
 * removed: the old runner stands down the moment runner.json names somebody
 * else (run.js `replaced`), so there is no instant in which it sees neither a
 * STOP nor a successor and picks a step.
 *
 * A stopping runner that predates `replaced` would not stand down — with its
 * STOP gone it would go on taking steps beside the new one — so it is not
 * taken over: it is waited for, and the answer says so.
 */
function takeOver({ state, argv, paths, deps }) {
  const { live } = state;
  if (!canTakeOver(state)) {
    return {
      ok: false,
      code: 2,
      lines: [
        `pid ${live.pid} is stopping, and it is older than take-over — it would not stand down for a new runner`,
        ...progressLines(state, paths, deps),
        'mc run start starts one the moment it exits · mc run stop --force ends it now',
      ],
    };
  }
  const own = (stepsOf(paths, deps).filter((step) => step.pid === live.pid));
  const lines = [
    state.kind === 'stopping'
      ? `pid ${live.pid} was stopping — a new runner takes over every lane now, and pid ${live.pid} only finishes ${own.length ? `${own.length} step${own.length === 1 ? '' : 's'} in flight (${own.map((s) => s.name).join(', ')})` : 'what it is in'}`
      : `pid ${live.pid} is finishing the steps a handover left it — a new runner takes every other lane now`,
  ];
  const out = spawnRunner({ argv, paths, deps, lines, predecessor: live });
  if (!out.ok) return out;
  deps.remove(paths.stop);
  deps.remove(paths.update);
  return out;
}

/** Whether the runner on its way out stands down for a new one (`takeOver`). */
function canTakeOver({ kind, live, held }) {
  return !(kind === 'stopping' && live === held && !held.takeover);
}

/** The lane files, as `drainState` reads them. */
function stepsOf(paths, deps) {
  return drainState({ paths, read: deps.read, list: deps.list, now: deps.now() }).inFlight;
}

/**
 * The line under a state that has something in progress: the drain an
 * UPDATE started, or the stop a STOP did. Empty when nothing is.
 */
function progressLines(state, paths, deps) {
  const reading = drainState({ paths, read: deps.read, list: deps.list, now: deps.now(), lanes: deps.laneCount?.() ?? null });
  const line = state.kind === 'stopping' ? stopLine(reading) : drainLine(reading);
  return line ? [line] : [];
}

/* --------------------------------------------------------------------- stop */

/**
 * `mc run stop [--force]`.
 *
 * STOP is written first and in every case, `--force` or not: if the kill only
 * half works, or the runner is between rounds and this misses it, the file is
 * still there to be read at the next boundary. A stop that has to be repeated
 * because the first one silently did nothing is the failure this avoids.
 */
export async function stopRunner({ force = false, root = null, deps = realControlDeps() } = {}) {
  const paths = controlPaths(root ?? workRoot(deps.env));
  const held = readRunner({ paths, read: deps.read, alive: deps.alive });
  const lines = [];
  // A second stop keeps the first one's time: the stop line says how long the
  // runner has been on its way out, and that began with the first.
  const again = deps.exists(paths.stop);
  if (!again) deps.write(paths.stop, `${deps.now().toISOString()}\n`);
  deps.remove(paths.update);

  if (!held) {
    lines.push('no runner.json — nothing here says a runner is running');
    lines.push(`STOP written anyway, so one started by hand exits at its next round boundary: ${paths.stop}`);
    lines.push('mc run start removes it again');
    return { ok: true, code: 0, lines };
  }
  // The runner a handover replaced, while it finishes what it held: STOP
  // reaches it as it reaches any runner, and `--force` ends it too.
  const finishing = held.predecessor?.alive ? held.predecessor : null;
  if (!held.alive && !finishing) {
    deps.remove(paths.runner);
    const ghosts = clearCurrents(paths, deps);
    lines.push(`no runner is running — runner.json named pid ${held.pid}, which is gone`);
    lines.push(`cleared runner.json${ghosts.length ? ` and ${ghosts.length} current-*.json the page would have drawn as a running step` : ''}`);
    return { ok: true, code: 0, lines };
  }
  // A runner seconds old is a successor: the stop was most likely aimed at
  // the one it replaced (2026-10-07, three seconds after a handover).
  const age = held.started ? (deps.now().getTime() - Date.parse(held.started)) / 1000 : null;
  if (held.alive && !finishing && age != null && age >= 0 && age < YOUNG_RUNNER_SECONDS) {
    lines.push(`note: pid ${held.pid} started ${Math.round(age)}s ago — if you meant the runner it replaced, that one is already gone; this STOP ends the new one`);
  }
  const live = [held.alive ? held : null, finishing].filter(Boolean);
  if (!force) {
    const written = again ? 'STOP was already written' : 'STOP written';
    if (held.alive) lines.push(`${written} — pid ${held.pid} takes no new step, finishes the ones in flight, then exits`);
    if (finishing) lines.push(`${written} — pid ${finishing.pid}, the runner ${held.alive ? 'it replaced' : 'a handover replaced'}, finishes the steps it holds, then exits`);
    const reading = stopLine(drainState({ paths, read: deps.read, list: deps.list, now: deps.now(), lanes: deps.laneCount?.() ?? null }));
    if (reading) lines.push(reading);
    lines.push(`no session is abandoned · mc run stop --force ends ${live.length > 1 ? 'all of it' : 'it'} now · mc run start takes over at once instead`);
    return { ok: true, code: 0, lines };
  }

  const ended = [];
  for (const runner of live) ended.push({ pid: runner.pid, ...(await endNow(runner.pid, deps)) });
  deps.remove(paths.runner);
  const ghosts = clearCurrents(paths, deps);
  const failed = ended.filter((end) => !end.ok);
  if (failed.length) {
    for (const end of failed) lines.push(`pid ${end.pid} is still alive after SIGKILL to ${end.what} — end it by hand`);
    lines.push(`STOP is written, so it exits at its next round boundary either way: ${paths.stop}`);
    return { ok: false, code: 1, lines };
  }
  for (const end of ended) lines.push(`runner ended now — ${end.signal} to ${end.what}, pid ${end.pid} is gone`);
  lines.push(`cleared runner.json${ghosts.length ? ` and ${ghosts.length} current-*.json` : ''} — a killed runner never removes its own`);
  return { ok: true, code: 0, lines };
}

/**
 * The runner and the session under it, ended: SIGTERM, and SIGKILL to whatever
 * is left of it after `FORCE_WAIT_MS`.
 *
 * The session is a child of the runner and shares its process group, so the
 * group is the thing to signal — kill the runner alone and a headless `claude`
 * carries on for another eighty minutes with nobody left to read its output.
 * A negative pid is only a process group when the pid *is* the group leader,
 * which it is for a runner `mc run start` spawned (detached, so it leads its
 * own session) and for one started as a shell job. When it is not, the
 * descendants are found and signalled by name instead.
 */
export async function endNow(pid, deps) {
  const group = groupOf(pid, deps.ps);
  const targets = group === pid ? [-pid] : [pid, ...descendants(pid, deps.ps)];
  const what = group === pid ? `process group ${pid}` : `pid ${pid} and ${targets.length - 1} descendant(s)`;
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const target of targets) {
      try { deps.kill(target, signal); } catch { /* already gone, or not ours */ }
    }
    for (let waited = 0; waited < FORCE_WAIT_MS && deps.alive(pid); waited += FORCE_POLL_MS) {
      await deps.sleep(FORCE_POLL_MS);
    }
    if (!deps.alive(pid)) return { ok: true, signal, what, targets };
  }
  return { ok: false, signal: 'SIGKILL', what, targets };
}

/** A process's group id, or null when `ps` cannot say. */
function groupOf(pid, ps) {
  const value = Number(String(ps(['-o', 'pgid=', '-p', String(pid)]) || '').trim());
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** Every process below `pid`, depth first, from one `ps` of the whole table. */
function descendants(pid, ps) {
  const children = new Map();
  for (const line of String(ps(['-eo', 'pid=,ppid=']) || '').split('\n')) {
    const [child, parent] = line.trim().split(/\s+/u).map(Number);
    if (!Number.isInteger(child) || !Number.isInteger(parent)) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(child);
  }
  const out = [];
  const walk = (from) => {
    for (const child of children.get(from) || []) {
      if (out.includes(child) || child === pid) continue;
      out.push(child);
      walk(child);
    }
  };
  walk(pid);
  return out;
}

/* ------------------------------------------------------------------- update */

/**
 * Where a drain stands: when UPDATE was written, the commit the runner runs,
 * and the steps it is still waiting on — one per `current-*.json`, which
 * exists exactly as long as that lane's session does (run.js `runStep`).
 *
 * `lanes` is how many lanes the runner has in all (`laneSlots`), so the lanes
 * done are the ones not in flight. Measured 2026-10-07: UPDATE written with
 * six lanes busy, four said so as their steps landed, and nothing said what
 * the other two were doing — so the person force-stopped the runner.
 */
export function drainState({ paths, read, list, now, lanes = null }) {
  const at = (iso) => { const t = Date.parse(String(iso ?? '').trim()); return Number.isNaN(t) ? null : t; };
  const since = (t) => (t == null ? null : Math.max(0, Math.round((now.getTime() - t) / 1000)));
  const text = read(paths.update);
  const asked = at(text);
  const stopText = paths.stop ? read(paths.stop) : null;
  const stopped = at(stopText);
  let runner = null;
  try { runner = JSON.parse(read(paths.runner) ?? ''); } catch { runner = null; }
  const inFlight = list(paths.dir)
    .filter((name) => /^current-.+\.json$/u.test(name))
    .sort()
    .map((file) => {
      let current = null;
      try { current = JSON.parse(read(join(paths.dir, file)) ?? ''); } catch { current = null; }
      // `current-<repo>.json` is a repository's first lane and
      // `current-<repo>-<n>.json` its lane n+1, the way run.js names them.
      const base = file.replace(/^current-/u, '').replace(/\.json$/u, '');
      const numbered = /^(.+)-(\d+)$/u.exec(base);
      const lane = numbered ? `${numbered[1]}#${Number(numbered[2]) + 1}` : `${base}#1`;
      const started = at(current?.started);
      return {
        name: current?.name || base,
        step: Number.isInteger(current?.step) ? current.step : null,
        lane,
        // The runner holding the lane: after a handover the old runner's steps
        // and its successor's are told apart by it (run.js `runLoop`).
        ...(Number.isInteger(current?.pid) ? { pid: current.pid } : {}),
        started: started == null ? null : new Date(started).toISOString(),
        elapsed_seconds: since(started),
      };
    });
  return {
    draining: text != null,
    requested: asked == null ? null : new Date(asked).toISOString(),
    since_seconds: since(asked),
    commit: runner?.commit || null,
    // STOP the same way: since when, for `stopLine`.
    stopping: stopText != null,
    stop_requested: stopped == null ? null : new Date(stopped).toISOString(),
    stop_since_seconds: since(stopped),
    inFlight,
    lanes: Number.isInteger(lanes) ? lanes : null,
  };
}

/**
 * The one line that says where a drain stands — `mc run --update`, the
 * refusal `mc run start` gives a live runner, and the page's MC line all print
 * this, so the three cannot disagree. Null when no UPDATE is waiting.
 *
 *   draining since 18:56 (14 min) — waiting on gmail-ready step 1 (memoro#5, 14 min); 6 lanes done
 */
export function drainLine(state) {
  if (!state?.draining) return null;
  return progress('draining', state.requested, state.since_seconds, state, drainWaiting(state));
}

/**
 * The same line for a STOP: since when, the steps the runner still waits on,
 * and how many lanes have already left. Null when no STOP is written.
 *
 *   stopping since 08:47 (39 min) — waiting on video-window step 1 (memoro#6, 80 min); 11 lanes done
 *
 * Until 2026-10-10 a stop said `STOP requested` and nothing else, so a runner
 * that had let eleven lanes go and was ninety minutes into its last step
 * looked like one that had ignored the order.
 */
export function stopLine(state) {
  if (!state?.stopping) return null;
  const steps = state.inFlight || [];
  const waiting = steps.length
    ? waitingOn(steps)
    : 'nothing in flight, it exits at its next look (within a minute)';
  return progress('stopping', state.stop_requested, state.stop_since_seconds, state, waiting);
}

function progress(word, requested, sinceSeconds, state, waiting) {
  const clock = (iso) => {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const since = requested
    ? `since ${clock(requested)}${sinceSeconds == null ? '' : ` (${ageWords(sinceSeconds)})`}`
    : 'since an unknown time';
  const steps = state.inFlight || [];
  const done = state.lanes == null ? '' : `; ${Math.max(0, state.lanes - steps.length)} lane${state.lanes - steps.length === 1 ? '' : 's'} done`;
  return `${word} ${since} — ${waiting}${done}`;
}

/**
 * The in-flight half of `drainLine`, alone: what a draining runner writes to
 * runner.log every ten minutes (run.js, `update: still waiting on …`), in the
 * same words `mc run --update` prints.
 */
export function drainWaiting(state) {
  const steps = state?.inFlight || [];
  return steps.length ? waitingOn(steps) : 'nothing in flight, the handover comes at the next pick';
}

function waitingOn(steps) {
  return `waiting on ${steps.map((s) => `${s.name}${s.step == null ? '' : ` step ${s.step}`} (${s.lane}${s.elapsed_seconds == null ? '' : `, ${ageWords(s.elapsed_seconds)}`})`).join(', ')}`;
}

/**
 * `mc run --update` — the order, left where the runner reads it. Three
 * answers: nothing to update (the runner already runs origin/main), already
 * draining (the drain, not a second UPDATE), or UPDATE written. A second
 * UPDATE is not harmless: measured 2026-10-07, one written to a runner that
 * had just started on origin/main drained all six lanes for nothing.
 * `force` writes it on a current runner, for a restart wanted for another
 * reason — a new `lanes.json`, say.
 */
export function requestUpdate({ root = null, force = false, checkout = null, deps = realControlDeps() } = {}) {
  const paths = controlPaths(root ?? workRoot(deps.env));
  const state = () => drainState({ paths, read: deps.read, list: deps.list, now: deps.now(), lanes: deps.laneCount?.() ?? null });
  const reading = runnerState({ paths, deps });
  const { held } = reading;
  // A runner on its way out — stopping, or finishing what a handover left it
  // — is not told to update: it is never going to pick again. A new runner on
  // the newest code takes over from it instead, the way `mc run start` does,
  // with the flags the old one was started with. Until 2026-10-10 this was a
  // refusal that said to remove STOP, which did nothing: a STOP once read is
  // read for the rest of that runner's life.
  if (reading.kind === 'stopping' || reading.kind === 'finishing') {
    const dir = checkout ?? mcCheckout({ exists: deps.exists });
    const moved = dir && canTakeOver(reading) ? fastForward(dir, deps) : null;
    const out = takeOver({ state: reading, argv: reading.live.args || [], paths, deps });
    return moved ? { ...out, lines: [moved, ...out.lines] } : out;
  }
  if (!held?.alive) {
    return {
      ok: false,
      code: 2,
      lines: [
        held
          ? `no runner is running — runner.json names pid ${held.pid}, which is gone`
          : 'no runner is running — there is nothing to hand over to',
        'mc run start starts one, and a runner that starts now reads the newest code anyway',
      ],
    };
  }
  if (deps.exists(paths.update)) {
    return { ok: true, code: 0, lines: [`UPDATE is already written — pid ${held.pid} is draining`, drainLine(state())] };
  }
  const dir = checkout ?? mcCheckout({ exists: deps.exists });
  const lines = [];
  if (dir && held.commit && !force) {
    const fetched = deps.git(dir, ['fetch', '-q', 'origin']);
    const main = deps.git(dir, ['rev-parse', '--short', 'origin/main']);
    const sha = main.ok ? String(main.stdout ?? '').trim() : '';
    // Short shas of two lengths name one commit when one starts the other.
    if (fetched.ok && sha && (sha.startsWith(held.commit) || held.commit.startsWith(sha))) {
      return {
        ok: true,
        code: 0,
        lines: [
          `runner pid ${held.pid} is already on ${held.commit} — nothing to update`,
          'mc run --update --force restarts it anyway',
        ],
      };
    }
    if (!fetched.ok) lines.push(`could not fetch origin in ${dir} — writing UPDATE without knowing whether there is anything new`);
  }
  deps.write(paths.update, `${deps.now().toISOString()}\n`);
  lines.unshift(`UPDATE written — pid ${held.pid} hands over to a new runner at its next look, and only finishes the steps in flight`);
  lines.push(dir
    ? `it fast-forwards ${dir} first, so the new runner is the newest code`
    : 'mc is not running from a git checkout, so there is nothing to fast-forward — it restarts on what it holds');
  lines.push(drainLine(state()));
  return { ok: true, code: 0, lines };
}

/**
 * The git checkout `mc` itself runs from, or null when it is not one. An
 * install from the registry has no `origin/main` to fast-forward, and saying
 * so is a better answer than a git error nobody asked for.
 */
export function mcCheckout({ exists = existsSync } = {}) {
  const dir = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/u, '');
  return exists(join(dir, '.git')) ? dir : null;
}

/**
 * The runner's half of `--update`, run the moment a lane reads UPDATE:
 * fast-forward the checkout mc is running from, then start a fresh `mc run`
 * beside this one. `predecessor` is this runner's pid, handed to the
 * successor as `MC_RUN_SUCCESSOR_OF`; `finishing` is how many steps this one
 * still holds, for the line that says so (ruling 28).
 *
 * Fast-forward only, never a merge and never a reset — a checkout with local
 * work in it is left exactly as it is, and the handover still happens, because
 * a restart the person asked for is not something to swallow over a dirty
 * tree. Whatever the git half did, the say() line states what was actually
 * measured: the sha before and the sha after.
 */
export async function handOver({ paths, deps, say, checkout = null, predecessor = null, finishing = null }) {
  deps.remove(paths.update);
  const dir = checkout ?? mcCheckout({ exists: deps.exists });
  say(dir ? `update: ${fastForward(dir, deps)}` : 'update: mc is not running from a git checkout — nothing to fast-forward');
  // The successor is told whose runner.json it will find: the one start
  // that does not refuse on a live holder (run.js `runLoop`).
  const pid = deps.respawn(predecessor ? { env: { MC_RUN_SUCCESSOR_OF: String(predecessor) } } : {});
  if (!pid) {
    say('update: the new runner did not start — this one stays up and keeps going');
    return { ok: false, why: 'respawn failed' };
  }
  // runner.json names the successor from this moment, not from when it has
  // loaded: in the second between, a second `mc run --update` found this
  // runner's old commit, no UPDATE (removed above) and wrote another — and
  // the successor handed over again the moment it started. With the new
  // commit in the file it is told there is nothing to update.
  if (predecessor && deps.write) {
    let mine = null;
    try { mine = JSON.parse(deps.read?.(paths.runner) ?? ''); } catch { mine = null; }
    const commit = dir ? head(dir, deps) : null;
    deps.write(paths.runner, `${JSON.stringify({
      pid,
      started: stampOf(deps.now()),
      ...(commit ? { commit } : {}),
      ...(Array.isArray(mine?.args) ? { args: mine.args } : {}),
      predecessor: { pid: predecessor, started: mine?.started || null },
    }, null, 2)}\n`);
  }
  say(finishing == null
    ? `update: handed over to pid ${pid} — this runner is done`
    : `update: handed over to pid ${pid} — finishing ${finishing} step(s) in flight, taking nothing new`);
  return { ok: true, pid };
}

/**
 * Fast-forward only, never a merge and never a reset — a checkout with local
 * work in it is left exactly as it is. The line states what was measured: the
 * sha before and the sha after.
 */
function fastForward(dir, deps) {
  const before = head(dir, deps);
  deps.git(dir, ['fetch', '-q', 'origin']);
  const ff = deps.git(dir, ['merge', '--ff-only', '-q', 'origin/main']);
  const after = head(dir, deps);
  if (!ff.ok) return `${dir} would not fast-forward (local work, or diverged) — the new runner is ${after || 'what it holds'}`;
  if (before && before === after) return `${dir} is already at ${after}`;
  return `${dir} ${before || '?'} -> ${after || '?'}`;
}

function head(dir, deps) {
  const r = deps.git(dir, ['rev-parse', '--short', 'HEAD']);
  return r.ok ? String(r.stdout ?? '').trim() : null;
}
