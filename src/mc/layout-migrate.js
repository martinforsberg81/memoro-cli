/**
 * `mc layout migrate` — the one-time move from layout 1 to layout 2 (ruling 51).
 *
 * Three parts, in the shape of `tidy.js`: `gatherLayoutFacts` reads what is on
 * disk and what is running, every read through `deps` so a test can hand it a
 * temporary root; `planLayoutMove` is pure and turns the facts into an ordered
 * list of moves and the refusals that keep any of them from happening; the
 * verb (`commands/layout.js`) prints them. The move itself — `--apply` — is
 * the next step's; nothing here writes.
 *
 * A person runs it, from a terminal standing outside every area it moves, with
 * the runner stopped. Nothing in mc calls it. Everything that would make a
 * move unsafe — a runner, a step session, the merger, a merge in flight, an
 * open planning session, a process standing in an old area, a dev server
 * serving one — is a refusal naming what to do about it, never a wait.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { claudeHome, encodePath, readHead } from './conversations.js';
import { listServers } from './dev-servers.js';
import { mergesPath, parseQueue } from './merge-queue.js';
import { readMerger } from './merger.js';
import {
  LAYOUT_FILE, PLAN_HOME, PROGRAMS_HOME, RUNNER_DEPS, RUNNER_HOME, RUNNER_STEP, STEP_HOME,
  areaKindOf, areaOfPath, layoutVersion, workRoot,
} from './paths.js';
import { NAME_RE } from './plan-schema.js';
import { findProjectDir } from './plan-write.js';
import { REGISTER_DIR, STATE_FILE } from './register.js';
import { controlPaths, drainState, runnerState } from './run-control.js';
import { processesStandingIn } from './standing.js';
import { pidAlive } from './status-collect.js';
import { listStepAreas } from './work-area.js';

/** Where a register with no project directory goes: kept, out of the way. */
export const CLOSED_REGISTERS = join(RUNNER_HOME, 'log', 'closed', 'registers');

/** What may stay in `runner/projects/` besides the registers without keeping it. */
const REGISTER_DIR_MARKS = new Set(['.lock', '.keep']);

/** How much of a standing process's command line a refusal shows. */
const COMMAND_SHOWN = 60;

/** The heading each kind of move is printed under, in the order they run. */
export const MOVE_HEADINGS = Object.freeze([
  ['plan', 'PLANNING SESSIONS'],
  ['step', 'STEP AREAS'],
  ['register', 'REGISTERS'],
  ['transcript', 'TRANSCRIPTS'],
  ['hooks', 'HOOKS'],
  ['layout', 'LAYOUT'],
]);

/** The filesystem, the process table and the clock, as the facts read them. */
export function realLayoutDeps() {
  return {
    entries: (path) => {
      try {
        return readdirSync(path, { withFileTypes: true }).map((entry) => ({ name: entry.name, isDir: entry.isDirectory() }));
      } catch { return []; }
    },
    exists: existsSync,
    isFile: (path) => { try { return lstatSync(path).isFile(); } catch { return false; } },
    read: (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } },
    mtime: (path) => { try { return statSync(path).mtimeMs; } catch { return 0; } },
    head: readHead,
    alive: pidAlive,
    standing: (paths) => processesStandingIn(paths),
    commandOf: (pid) => {
      try {
        return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch { return null; }
    },
    // Not reaped: the dry run writes nothing at all, not even a sweep.
    servers: () => listServers({ reap: false }).servers.filter((server) => server.live),
    now: () => new Date(),
  };
}

/**
 * An old area's name in layout 2: `plan/<p>` is `programs/<p>`, `step/<x>`
 * is `runner/step/<x>` — or `runner/deps/<x>` for a `deps-` area — and a
 * legacy `<x>` directly under the root is `runner/step/<x>`.
 */
export function newAreaName(oldArea) {
  const area = areaKindOf(oldArea);
  if (!area) return null;
  if (area.kind === 'plan') return `${PROGRAMS_HOME}/${area.name}`;
  if (area.kind === 'deps') return `${RUNNER_DEPS}/${area.name}`;
  return `${RUNNER_STEP}/${area.name}`;
}

/* ------------------------------------------------------------------- facts */

/**
 * What the move is planned from: the old areas and their entries, the
 * registers and where their projects are, the transcripts launched in an old
 * area, what already stands where a move would go (`taken`), and what is
 * running that must not be (`live`, one line each).
 */
export function gatherLayoutFacts({ root = workRoot(), env = process.env, deps = {} } = {}) {
  const io = { ...realLayoutDeps(), ...deps };
  const layout = layoutVersion({ root, read: (path) => io.read(path) });
  const claude = join(claudeHome(env), 'projects');
  const dirsOf = (path) => io.entries(path).filter((entry) => entry.isDir && !entry.name.startsWith('.')).map((entry) => entry.name).sort();
  const entriesOf = (path) => io.entries(path)
    .map((entry) => ({
      name: entry.name,
      isDir: entry.isDir,
      isGitWorktree: entry.isDir && io.isFile(join(path, entry.name, '.git')),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const planHome = join(root, PLAN_HOME);
  const planHomeEntries = io.entries(planHome).map((entry) => entry.name).sort();
  const planAreas = dirsOf(planHome).map((name) => ({ name, path: join(planHome, name), entries: entriesOf(join(planHome, name)) }));

  const stepHome = join(root, STEP_HOME);
  const stepHomeEntries = io.entries(stepHome).map((entry) => entry.name).sort();
  const stepAreas = dirsOf(stepHome).map((name) => ({
    name, kind: name.startsWith('deps-') ? 'deps' : 'step', path: join(stepHome, name), entries: entriesOf(join(stepHome, name)),
  }));
  // The areas from before `step/`, by layout 1's rule (`listStepAreas`): a
  // directory directly under the root holding a checkout.
  const legacy = listStepAreas({
    root,
    list: (path) => io.entries(path).map((entry) => entry.name),
    exists: (path) => io.exists(path),
    read: () => null,
  }).filter((area) => area.path === join(root, area.name) && areaKindOf(area.name)?.kind === 'legacy');
  for (const area of legacy) stepAreas.push({ name: area.name, kind: 'legacy', path: area.path, entries: entriesOf(area.path) });

  const registerHome = join(root, RUNNER_HOME, REGISTER_DIR);
  const registerDirEntries = io.entries(registerHome).map((entry) => entry.name).sort();
  const programs = join(root, PROGRAMS_HOME);
  const registers = io.entries(registerHome)
    .filter((entry) => !entry.isDir && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort()
    .map((file) => {
      const project = file.slice(0, -'.json'.length);
      const path = join(registerHome, file);
      let parses = true;
      try { JSON.parse(io.read(path) ?? ''); } catch { parses = false; }
      const found = findProjectDir(programs, project, { list: dirsOf, exists: (p) => io.exists(p) });
      const closed = !found && NAME_RE.test(project)
        ? dirsOf(programs).map((programme) => join(programs, programme, project)).find((dir) => io.exists(join(dir, 'CLOSEOUT.json')))
        : null;
      return { project, path, dir: found?.dir ?? closed ?? null, parses };
    });

  const oldAreaNames = new Set([
    ...planAreas.map((area) => `${PLAN_HOME}/${area.name}`),
    ...stepAreas.map((area) => (area.kind === 'legacy' ? area.name : `${STEP_HOME}/${area.name}`)),
  ]);
  const legacyNames = new Set(stepAreas.filter((area) => area.kind === 'legacy').map((area) => area.name));
  /** The old area a path or an area name is in, or null: `plan/<p>`, `step/<x>`, or a legacy `<x>`. */
  const oldAreaOf = (area) => {
    if (!area) return null;
    if (area.kind === 'plan' && area.area.startsWith(`${PLAN_HOME}/`)) return area.area;
    if ((area.kind === 'step' || area.kind === 'deps') && area.area.startsWith(`${STEP_HOME}/`)) return area.area;
    if (area.kind === 'legacy' && legacyNames.has(area.name)) return area.area;
    return null;
  };

  // A transcript directory is named after its cwd, so only the ones whose
  // name starts with the root's are worth opening; the cwd inside decides.
  const prefix = encodePath(root);
  const claudeDirs = {};
  const transcripts = [];
  for (const name of dirsOf(claude).filter((dir) => dir.startsWith(prefix))) {
    const dir = join(claude, name);
    const files = io.entries(dir).filter((entry) => !entry.isDir && entry.name.endsWith('.jsonl')).map((entry) => entry.name).sort();
    claudeDirs[name] = files;
    if (!files.length) continue;
    const newest = [...files].sort((a, b) => io.mtime(join(dir, b)) - io.mtime(join(dir, a)))[0];
    const { cwd } = io.head(join(dir, newest));
    const area = typeof cwd === 'string' ? oldAreaOf(areaOfPath(cwd, root)) : null;
    if (area) transcripts.push({ name, dir, cwd, area, files });
  }

  const taken = [];
  const note = (path) => { if (io.exists(path)) taken.push(path); };
  const childrenOf = (dir) => { for (const entry of io.entries(dir)) taken.push(join(dir, entry.name)); };
  for (const area of planAreas) childrenOf(join(programs, area.name));
  for (const area of stepAreas) {
    childrenOf(join(root, newAreaName(area.kind === 'legacy' ? area.name : `${STEP_HOME}/${area.name}`)));
  }
  for (const register of registers) {
    note(register.dir ? join(register.dir, STATE_FILE) : join(root, CLOSED_REGISTERS, `${register.project}.json`));
  }

  return {
    root, claude, layout,
    planHomeEntries, planAreas,
    stepHomeEntries, stepAreas,
    registerDirEntries, registers,
    transcripts, claudeDirs,
    taken: [...new Set(taken)].sort(),
    live: layout === 2 ? [] : liveFacts({ root, io, oldAreaNames, oldAreaOf }),
  };
}

/** What must not be running while the areas move, each `{ what, pid, line }`. */
function liveFacts({ root, io, oldAreaNames, oldAreaOf }) {
  const live = [];
  const paths = controlPaths(root);
  const read = (path) => io.read(path);
  const list = (path) => io.entries(path).map((entry) => entry.name);
  const alive = (pid) => io.alive(pid);

  const runner = runnerState({ paths, deps: { read, alive, exists: (path) => io.exists(path) } });
  if (runner.live) {
    live.push({ what: 'runner', pid: runner.live.pid, line: `the runner is running (pid ${runner.live.pid}) — mc run stop, and wait for it to finish` });
  }
  for (const step of drainState({ paths, read, list, now: io.now(), alive }).inFlight) {
    if (!Number.isInteger(step.pid)) continue;
    const which = step.step == null ? step.name : `${step.name} step ${step.step + 1}`;
    live.push({ what: 'step', pid: step.pid, line: `a step session is running: ${which} (lane ${step.lane}, runner pid ${step.pid}) — mc run stop, and wait for it to finish` });
  }
  const merger = readMerger({ root, read, alive });
  if (merger) live.push({ what: 'merger', pid: merger.pid, line: `the merger is running (pid ${merger.pid}) — wait for its queue to empty, or end it` });
  for (const job of parseQueue(read(mergesPath(root)))) {
    if (job.state !== 'mending' && job.state !== 'landing') continue;
    live.push({ what: 'merge', pid: null, line: `${job.repo ?? 'a repository'}#${job.pr} is ${job.state} in merges.json — wait for the merger to finish it` });
  }

  const foreground = join(root, RUNNER_HOME, 'foreground');
  for (const file of list(foreground).sort()) {
    const match = /^(\d+)\.json$/u.exec(file);
    if (!match || !alive(Number(match[1]))) continue;
    let record = null;
    try { record = JSON.parse(read(join(foreground, file)) ?? ''); } catch { continue; }
    const area = areaKindOf(record?.area ?? '');
    if (!oldAreaOf(area)) continue;
    const pid = Number(match[1]);
    live.push({
      what: 'foreground', pid,
      line: area.kind === 'plan'
        ? `a planning session for ${area.name} is open (pid ${pid}) — close it`
        : `a session in ~/mc/${area.area} is open (pid ${pid}) — close it`,
    });
  }

  const areaPaths = [...oldAreaNames].map((name) => join(root, name));
  const standingIn = [join(root, PLAN_HOME), join(root, STEP_HOME), ...areaPaths];
  for (const { pid, directory } of io.standing(standingIn)) {
    // A session's command line runs to kilobytes; its start names it.
    const command = io.commandOf(pid) || 'unknown command';
    const shown = command.length > COMMAND_SHOWN ? `${command.slice(0, COMMAND_SHOWN)}…` : command;
    live.push({ what: 'standing', pid, line: `pid ${pid} (${shown}) stands in ${directory}` });
  }

  for (const server of io.servers()) {
    const path = server.worktree_path;
    if (typeof path !== 'string' || !oldAreaOf(areaOfPath(path, root))) continue;
    live.push({ what: 'dev-server', pid: server.pid ?? null, line: `a dev server serves ${path} — mc test dev --stop in that worktree` });
  }
  return live;
}

/* -------------------------------------------------------------------- plan */

/**
 * The move, in order, and what refuses it: `{ moves, refusals }`. Pure.
 *
 * Each move is `{ kind, from, to, how }`: `worktree` (a git worktree, moved
 * by git), `rename` (anything else, moved whole), `rmdir` (an emptied
 * directory, `to: null`), `transcripts` (a Claude project directory, with
 * `rewrite: { old, new }` the area's two absolute paths), `hooks` (`mc hook
 * install` into `from`) and `layout` (the layout file, always last). The
 * refusals are lines, each naming its path or its pid: everything `live`
 * found, and what the plan itself cannot do.
 */
export function planLayoutMove(facts, { root = facts.root, claude = facts.claude } = {}) {
  const moves = [];
  const refusals = facts.live.map((fact) => fact.line);
  const taken = new Set(facts.taken);
  const destinations = new Set();
  const move = (kind, from, to, how, extra = {}) => {
    if (to && how !== 'hooks' && how !== 'layout') {
      if (taken.has(to)) refusals.push(`${to} already exists — ${from} cannot move there`);
      else if (destinations.has(to)) refusals.push(`two moves go to ${to} — ${from} is the second`);
      destinations.add(to);
    }
    moves.push({ kind, from, to, how, ...extra });
  };
  const howOf = (entry) => (entry.isGitWorktree ? 'worktree' : 'rename');

  const planHome = join(root, PLAN_HOME);
  let planEmptied = true;
  for (const area of facts.planAreas) {
    if (!NAME_RE.test(area.name)) {
      refusals.push(`${area.path}: ${area.name} is not a programme name — rename it, or move it out of ${planHome}`);
      planEmptied = false;
      continue;
    }
    const to = join(root, newAreaName(`${PLAN_HOME}/${area.name}`));
    for (const entry of area.entries) move('plan', join(area.path, entry.name), join(to, entry.name), howOf(entry));
    move('plan', area.path, null, 'rmdir');
  }
  const planAreaNames = new Set(facts.planAreas.map((area) => area.name));
  if (facts.planHomeEntries.length && planEmptied && facts.planHomeEntries.every((name) => planAreaNames.has(name))) {
    move('plan', planHome, null, 'rmdir');
  }

  const stepHome = join(root, STEP_HOME);
  for (const area of facts.stepAreas) {
    const to = join(root, newAreaName(area.kind === 'legacy' ? area.name : `${STEP_HOME}/${area.name}`));
    for (const entry of area.entries) move('step', join(area.path, entry.name), join(to, entry.name), howOf(entry));
    move('step', area.path, null, 'rmdir');
  }
  const stepAreaNames = new Set(facts.stepAreas.filter((area) => area.kind !== 'legacy').map((area) => area.name));
  if (facts.stepHomeEntries.length && facts.stepHomeEntries.every((name) => stepAreaNames.has(name))) {
    move('step', stepHome, null, 'rmdir');
  }

  for (const register of facts.registers) {
    if (!register.parses) refusals.push(`${register.path} does not parse — mend it, or move it out of ${dirname(register.path)}`);
    const to = register.dir ? join(register.dir, STATE_FILE) : join(root, CLOSED_REGISTERS, `${register.project}.json`);
    move('register', register.path, to, 'rename');
  }
  const registerFiles = new Set(facts.registers.map((register) => `${register.project}.json`));
  if (facts.registerDirEntries.length
    && facts.registerDirEntries.every((name) => registerFiles.has(name) || REGISTER_DIR_MARKS.has(name))) {
    move('register', join(root, RUNNER_HOME, REGISTER_DIR), null, 'rmdir');
  }

  for (const transcript of facts.transcripts) {
    const old = join(root, transcript.area);
    const fresh = join(root, newAreaName(transcript.area));
    const name = encodePath(fresh + transcript.cwd.slice(old.length));
    const to = join(claude, name);
    const clash = (facts.claudeDirs[name] || []).find((file) => transcript.files.includes(file));
    if (clash) refusals.push(`${join(to, clash)} already exists — ${join(transcript.dir, clash)} cannot move there`);
    else if (destinations.has(to)) refusals.push(`two moves go to ${to} — ${transcript.dir} is the second`);
    destinations.add(to);
    moves.push({ kind: 'transcript', from: transcript.dir, to, how: 'transcripts', rewrite: { old, new: fresh } });
  }

  const settings = join(dirname(claude), 'settings.json');
  moves.push({ kind: 'hooks', from: settings, to: settings, how: 'hooks' });
  const layoutFile = join(root, RUNNER_HOME, LAYOUT_FILE);
  moves.push({ kind: 'layout', from: layoutFile, to: layoutFile, how: 'layout' });
  return { moves, refusals };
}

/* ------------------------------------------------------------------- lines */

/** `path` with `$HOME` as `~`. */
export function tildePath(path, home = homedir()) {
  if (typeof path !== 'string') return path;
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

/** One move as the dry run says it. */
export function moveLine(move, home = homedir()) {
  const at = (path) => tildePath(path, home);
  if (move.how === 'rmdir') return `would remove ${at(move.from)} (rmdir)`;
  if (move.how === 'hooks') return `would run mc hook install into ${at(move.to)} (hooks)`;
  if (move.how === 'layout') return `would write ${at(move.to)} (layout)`;
  return `would move ${at(move.from)} → ${at(move.to)} (${move.how})`;
}

/** The dry run whole: the moves under their headings, the refusals, a count. */
export function dryRunLines({ moves, refusals }, home = homedir()) {
  const lines = ['layout 1 → 2 — dry run, nothing is written'];
  for (const [kind, heading] of MOVE_HEADINGS) {
    const own = moves.filter((move) => move.kind === kind);
    if (!own.length) continue;
    lines.push('', heading, ...own.map((move) => `  ${moveLine(move, home)}`));
  }
  if (refusals.length) lines.push('', 'REFUSED', ...refusals.map((line) => `  ${tildePath(line, home)}`));
  lines.push('', refusals.length
    ? `${moves.length} moves, ${refusals.length} refused — nothing moves until every refusal is resolved`
    : `${moves.length} moves, none refused`);
  return lines;
}
