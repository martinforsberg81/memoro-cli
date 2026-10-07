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
 *   start      spawn `mc run` detached, its output appended to runner.log
 *   stop       write STOP; the round in flight finishes, then the runner exits
 *   stop --force  end it now — the runner and the session it is holding
 *   --update   write UPDATE; the round in flight finishes, mc's own checkout
 *              is fast-forwarded, and the runner restarts itself on the new
 *              code
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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultRepos } from './brief-collect.js';
import { readLaneCount } from './lane-count.js';
import { ageWords } from './page-cache.js';
import { workRoot } from './paths.js';
import { pidAlive } from './status-collect.js';

/** How long a forced stop waits for a signal to be obeyed before the next one. */
export const FORCE_WAIT_MS = 2000;
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
    spawn: ({ bin, args, stdio }) => {
      const child = spawn(bin, args, { detached: true, stdio, env: childEnv(env) });
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
    execPath: process.execPath,
    entry: process.argv[1],
  };
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
  return { pid, started: value.started || null, ...(value.commit ? { commit: value.commit } : {}), alive: alive(pid) };
}

/** The `current-<repo>.json` files a killed runner leaves behind, removed. */
function clearCurrents(paths, deps) {
  const names = deps.list(paths.dir).filter((name) => /^current-.+\.json$/u.test(name));
  for (const name of names) deps.remove(join(paths.dir, name));
  return names;
}

/* -------------------------------------------------------------------- start */

/**
 * `mc run start` — the runner, in the background, with its output appended to
 * `runner.log`.
 *
 * It clears the STOP left by the last stop rather than refusing on it: `start`
 * and `stop` are one switch, and a switch that will not turn back on is not
 * one. It refuses only on the thing a second runner would actually break — a
 * first runner that is still alive.
 */
export async function startRunner({ argv = [], root = null, deps = realControlDeps() } = {}) {
  const paths = controlPaths(root ?? workRoot(deps.env));
  const held = readRunner({ paths, read: deps.read, alive: deps.alive });
  if (held?.alive) {
    const drain = drainLine(drainState({ paths, read: deps.read, list: deps.list, now: deps.now(), lanes: deps.laneCount?.() ?? null }));
    return {
      ok: false,
      code: 2,
      lines: [
        `a runner is already running — pid ${held.pid}${held.started ? `, started ${held.started}` : ''}`,
        ...(drain ? [drain] : []),
        'mc run stop ends it · mc run --update restarts it on the newest code',
      ],
    };
  }

  const lines = [];
  if (held) {
    deps.remove(paths.runner);
    clearCurrents(paths, deps);
    lines.push(`cleared runner.json — the pid it named (${held.pid}) is gone`);
  }
  if (deps.exists(paths.stop)) {
    deps.remove(paths.stop);
    lines.push('removed the STOP the last stop left');
  }
  deps.remove(paths.update);

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
  const pid = deps.spawn({ bin: deps.execPath, args: [deps.entry, 'run', ...argv], stdio: ['ignore', 'ignore', fd] });
  if (!pid) return { ok: false, code: 1, lines: [...lines, 'the runner did not start'] };
  lines.push(`runner started — pid ${pid}${argv.length ? ` (mc run ${argv.join(' ')})` : ''}`);
  lines.push(`log: ${paths.log}`);
  return { ok: true, code: 0, pid, lines };
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
  deps.write(paths.stop, `${deps.now().toISOString()}\n`);
  deps.remove(paths.update);

  if (!held) {
    lines.push('no runner.json — nothing here says a runner is running');
    lines.push(`STOP written anyway, so one started by hand exits at its next round boundary: ${paths.stop}`);
    lines.push('mc run start removes it again');
    return { ok: true, code: 0, lines };
  }
  if (!held.alive) {
    deps.remove(paths.runner);
    const ghosts = clearCurrents(paths, deps);
    lines.push(`no runner is running — runner.json named pid ${held.pid}, which is gone`);
    lines.push(`cleared runner.json${ghosts.length ? ` and ${ghosts.length} current-*.json the page would have drawn as a running step` : ''}`);
    return { ok: true, code: 0, lines };
  }
  if (!force) {
    lines.push(`STOP written — pid ${held.pid} finishes the round it is in, then exits`);
    lines.push('the session it is holding is not abandoned; mc run stop --force ends both now');
    return { ok: true, code: 0, lines };
  }

  const ended = await endNow(held.pid, deps);
  deps.remove(paths.runner);
  const ghosts = clearCurrents(paths, deps);
  if (!ended.ok) {
    lines.push(`pid ${held.pid} is still alive after SIGKILL to ${ended.what} — end it by hand`);
    lines.push(`STOP is written, so it exits at its next round boundary either way: ${paths.stop}`);
    return { ok: false, code: 1, lines };
  }
  lines.push(`runner ended now — ${ended.signal} to ${ended.what}, pid ${held.pid} is gone`);
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
        started: started == null ? null : new Date(started).toISOString(),
        elapsed_seconds: since(started),
      };
    });
  return {
    draining: text != null,
    requested: asked == null ? null : new Date(asked).toISOString(),
    since_seconds: since(asked),
    commit: runner?.commit || null,
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
  const clock = (iso) => {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const since = state.requested
    ? `since ${clock(state.requested)}${state.since_seconds == null ? '' : ` (${ageWords(state.since_seconds)})`}`
    : 'since an unknown time';
  const steps = state.inFlight || [];
  const waiting = steps.length
    ? `waiting on ${steps.map((s) => `${s.name}${s.step == null ? '' : ` step ${s.step}`} (${s.lane}${s.elapsed_seconds == null ? '' : `, ${ageWords(s.elapsed_seconds)}`})`).join(', ')}`
    : 'nothing in flight, the handover comes at the next pick';
  const done = state.lanes == null ? '' : `; ${Math.max(0, state.lanes - steps.length)} lane${state.lanes - steps.length === 1 ? '' : 's'} done`;
  return `draining ${since} — ${waiting}${done}`;
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
  const held = readRunner({ paths, read: deps.read, alive: deps.alive });
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
  if (deps.exists(paths.stop)) {
    return {
      ok: false,
      code: 2,
      lines: [
        `STOP is already written — pid ${held.pid} is on its way out, not round again`,
        `remove ${paths.stop}, or mc run start after it has exited`,
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
  lines.unshift(`UPDATE written — pid ${held.pid} finishes the round it is in, then restarts itself`);
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
 * The runner's half of `--update`, run at a round boundary: fast-forward the
 * checkout mc is running from, then start a fresh `mc run` and let this one
 * go.
 *
 * Fast-forward only, never a merge and never a reset — a checkout with local
 * work in it is left exactly as it is, and the handover still happens, because
 * a restart the person asked for is not something to swallow over a dirty
 * tree. Whatever the git half did, the say() line states what was actually
 * measured: the sha before and the sha after.
 */
export async function handOver({ paths, deps, say, checkout = null }) {
  deps.remove(paths.update);
  const dir = checkout ?? mcCheckout({ exists: deps.exists });
  if (!dir) {
    say('update: mc is not running from a git checkout — nothing to fast-forward');
  } else {
    const before = head(dir, deps);
    deps.git(dir, ['fetch', '-q', 'origin']);
    const ff = deps.git(dir, ['merge', '--ff-only', '-q', 'origin/main']);
    const after = head(dir, deps);
    if (!ff.ok) say(`update: ${dir} would not fast-forward (local work, or diverged) — handing over on ${after || 'what it holds'}`);
    else if (before && before === after) say(`update: ${dir} is already at ${after}`);
    else say(`update: ${dir} ${before || '?'} -> ${after || '?'}`);
  }
  const pid = deps.respawn();
  if (!pid) {
    say('update: the new runner did not start — this one stays up and keeps going');
    return { ok: false, why: 'respawn failed' };
  }
  say(`update: handed over to pid ${pid} — this runner is done`);
  return { ok: true, pid };
}

function head(dir, deps) {
  const r = deps.git(dir, ['rev-parse', '--short', 'HEAD']);
  return r.ok ? String(r.stdout ?? '').trim() : null;
}
