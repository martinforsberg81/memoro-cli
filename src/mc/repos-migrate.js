/**
 * `mc repos migrate` — the move from the primary checkouts to the bare layout
 * (repos.js): `~/<name>/.git` becomes `~/mc/repos/<name>.git`, a worktree of it
 * on main is made at `~/mc/self/<name>`, the npm link runs from there, and the
 * old working files go. Shaped as `layout-migrate.js` is.
 *
 * Three parts: `gatherReposFacts` reads what is on disk and what is running,
 * every read through `deps` so a test can point it at a temporary root;
 * `planReposMove` is pure and turns the facts into an ordered list of moves and
 * the refusals that keep any of them from happening; `applyReposMove` carries a
 * plan with no refusal out one move at a time, and stops at the first that fails.
 *
 * A repository is finished when nothing of its primary checkout is left. Not
 * when it is bare: `defaultRepos` says `bare` as soon as the git directory has
 * moved, so a run that stopped between two moves reads bare and would skip the
 * rest. Every move is therefore planned from what is still there, and a second
 * `--apply` continues where the first stopped.
 *
 * A person runs it, from a terminal outside both checkouts, with the runner, the
 * merger and the dev servers stopped. Nothing in mc calls it.
 */
import { execFileSync } from 'node:child_process';
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { listServers } from './dev-servers.js';
import { tildePath } from './layout-migrate.js';
import { readMerger } from './merger.js';
import { RUNNER_HOME, reposHome, selfHome, workRoot } from './paths.js';
import { sourceLinkedInstallations } from './repo-status.js';
import { defaultRepos } from './repos.js';
import { controlPaths, runnerState } from './run-control.js';
import { pidAlive } from './status-collect.js';

/** The npm global link `mc` runs from: `npm link` made it, and `deployPull` follows it. */
export const NPM_LINK = '/opt/homebrew/lib/node_modules/memoro-cli';

/** The repository the npm link runs. It is relinked to its self checkout, and no other. */
const LINKED = 'memoro-cli';

/** Where `--apply` writes one JSON line per move: `{ at, name, how, from, to, ok, error }`. */
export const REPOS_LOG = join(RUNNER_HOME, 'log', 'repos-migrate.log');

/** `path` is `dir` or lies under it. */
const underOf = (path, dir) => typeof path === 'string' && (path === dir || path.startsWith(`${dir}/`));

const nonEmpty = (text) => String(text || '').split('\n').filter(Boolean);

/** `git worktree list --porcelain`: `{ path, branch, bare }` per entry, the main worktree first. */
export function parseWorktrees(text) {
  const entries = [];
  for (const line of String(text || '').split('\n')) {
    const last = entries.at(-1);
    if (line.startsWith('worktree ')) entries.push({ path: line.slice('worktree '.length), branch: null, bare: false });
    else if (last && line.startsWith('branch ')) last.branch = line.slice('branch refs/heads/'.length);
    else if (last && line === 'bare') last.bare = true;
  }
  return entries;
}

const realRun = (command, args, { cwd } = {}) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** The filesystem, git, the process table and the clock, as the facts read them. */
export function realReposDeps() {
  return {
    run: realRun,
    exists: existsSync,
    isDir: (path) => { try { return statSync(path).isDirectory(); } catch { return false; } },
    readlink: (path) => { try { return readlinkSync(path); } catch { return null; } },
    realpath: (path) => { try { return realpathSync(path); } catch { return path; } },
    read: (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } },
    alive: pidAlive,
    servers: () => listServers({ reap: false }).servers.filter((server) => server.live),
    installs: (env) => sourceLinkedInstallations(env),
    cwd: () => process.cwd(),
    npmLink: NPM_LINK,
  };
}

/** git's answer, or null when git says no: a probe whose failure is an answer, not an error. */
function tryRun(io, args, cwd) {
  try { return io.run('git', args, { cwd }); } catch { return null; }
}

/**
 * What the move is planned from: each repository still to move (`repos`), the
 * npm link, the processes that must not be running (`live`, one line each),
 * the dev servers (`servers`), the installations that run from a checkout, and
 * the directory this process stands in (`cwd`).
 */
export function gatherReposFacts({ env = process.env, root = workRoot(env), deps = {} } = {}) {
  const io = { ...realReposDeps(), ...deps };
  const homeDir = env.MC_REPOS_HOME || homedir();
  const reposDir = reposHome(env);
  const selfDir = selfHome(env);

  const target = io.readlink(io.npmLink);
  const link = { path: io.npmLink, target, present: target !== null || io.exists(io.npmLink) };

  const repos = [];
  for (const { name } of defaultRepos(env, { exists: io.exists })) {
    const primary = join(homeDir, name);
    const bare = join(reposDir, `${name}.git`);
    const self = join(selfDir, name);
    const gitDir = io.isDir(join(primary, '.git'));
    const bareExists = io.exists(bare);
    if (!gitDir && !bareExists) continue;

    const bareIsBare = bareExists && tryRun(io, ['--git-dir', bare, 'config', '--bool', 'core.bare'], bare)?.trim() === 'true';
    const worktrees = parseWorktrees(io.run('git', gitDir ? ['-C', primary, 'worktree', 'list', '--porcelain'] : ['--git-dir', bare, 'worktree', 'list', '--porcelain'], { cwd: gitDir ? primary : bare }));
    const selfExists = io.exists(self);
    const selfOwned = bareExists && !gitDir && worktrees.some((worktree) => worktree.path === io.realpath(self));
    const primaryDir = io.exists(primary);
    const finished = !gitDir && bareIsBare && selfExists && !primaryDir
      && !(name === LINKED && link.present && link.target !== self);
    if (finished) continue;

    const dirty = gitDir && io.run('git', ['-C', primary, 'status', '--porcelain'], { cwd: primary }).trim() !== '';
    const stashes = gitDir ? nonEmpty(io.run('git', ['-C', primary, 'stash', 'list'], { cwd: primary })).length : 0;
    const branch = gitDir ? io.run('git', ['-C', primary, 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: primary }).trim() : null;
    const taken = [];
    if (gitDir && bareExists) taken.push(bare);
    if (selfExists && !selfOwned) taken.push(self);
    repos.push({
      name, primary, bare, self, gitDir, bareExists, bareIsBare, selfExists, selfOwned, primaryDir,
      branch, dirty, stashes, worktrees, taken,
    });
  }

  const live = [];
  const runner = runnerState({ paths: controlPaths(root), deps: { read: io.read, alive: io.alive, exists: io.exists } });
  if (runner.live) live.push(`the runner is running (pid ${runner.live.pid}) — mc run stop, and wait for it to finish`);
  const merger = readMerger({ root, read: io.read, alive: io.alive });
  if (merger) live.push(`the merger is running (pid ${merger.pid}) — wait for its queue to empty, or end it`);
  const servers = io.servers()
    .filter((server) => typeof server.worktree_path === 'string')
    .map((server) => ({ pid: server.pid ?? null, path: server.worktree_path }));

  return {
    root, reposDir, selfDir, link, repos, live, servers,
    reposHomeExists: io.exists(reposDir),
    cwd: io.cwd(),
    installs: io.installs(env),
  };
}

/**
 * The move, in order, and what refuses it: `{ moves, refusals }`. Pure.
 *
 * Each move is `{ name, how, from, to }`, in the order it runs, per repository
 * in `defaultRepos` order: `mkdir` (the repositories directory, once, when it is
 * missing), `rename` (the git directory into `~/mc/repos`), `config` (`core.bare
 * true`), `repair` (`git worktree repair`, so every linked worktree points at the
 * moved repository), `worktree` (`git worktree add ~/mc/self/<name> main`),
 * `relink` (memoro-cli only: the npm link moves to its self checkout) and
 * `remove` (the old working files, last of all). Each step appears only while it
 * is still to do, so a half-run plans its remainder.
 */
export function planReposMove(facts) {
  const moves = [];
  const refusals = [];
  if (!facts.repos.length) return { moves, refusals };
  refusals.push(...facts.live);

  let homeMade = facts.reposHomeExists;
  for (const repo of facts.repos) {
    const { name, primary, bare, self } = repo;
    if (repo.gitDir && repo.dirty) refusals.push(`${primary} has uncommitted changes — commit, stash or discard them, then run it again`);
    if (underOf(facts.cwd, primary)) refusals.push(`you stand in ${facts.cwd} — run it from outside ${primary}, which the move removes`);
    for (const path of repo.taken) refusals.push(`${path} already exists — ${name} cannot move there`);
    for (const server of facts.servers) {
      if (underOf(server.path, primary) || underOf(server.path, self)) refusals.push(`a dev server serves ${server.path} — mc test dev --stop in that worktree`);
    }

    const step = (how, from, to) => moves.push({ name, how, from, to });
    if (!homeMade) {
      moves.push({ name, how: 'mkdir', from: null, to: facts.reposDir });
      homeMade = true;
    }
    if (repo.gitDir) step('rename', join(primary, '.git'), bare);
    if (!repo.bareIsBare) step('config', bare, null);
    step('repair', bare, null);
    if (!repo.selfExists) step('worktree', bare, self);
    if (name === LINKED && facts.link.present) {
      if (facts.link.target === null) refusals.push(`${facts.link.path} is not a symlink — mc cannot relink it; move it aside, then run it again`);
      else if (facts.link.target !== self) step('relink', facts.link.path, self);
    }
    if (repo.primaryDir) step('remove', primary, null);
  }
  return { moves, refusals };
}

/* ------------------------------------------------------------------- lines */

const VERBS = { mkdir: 'make', rename: 'move', config: 'set', repair: 'repair', worktree: 'add', relink: 'link', remove: 'remove' };
const PAST = { mkdir: 'made', rename: 'moved', config: 'set', repair: 'repaired', worktree: 'added', relink: 'linked', remove: 'removed' };
const WHAT = {
  mkdir: (move, at) => at(move.to),
  rename: (move, at) => `${at(move.from)} → ${at(move.to)} (the git directory)`,
  config: (move, at) => `core.bare true in ${at(move.from)}`,
  repair: (move, at) => `the worktrees of ${at(move.from)}`,
  worktree: (move, at) => `${at(move.to)} on main`,
  relink: (move, at) => `${at(move.from)} → ${at(move.to)}`,
  remove: (move, at) => `${at(move.from)} (the working files)`,
};

/** One move as the dry run says it. */
export function moveLine(move, home = homedir()) {
  const at = (path) => tildePath(path, home);
  return `would ${VERBS[move.how]} ${WHAT[move.how](move, at)}`;
}

/** One move as `--apply` says it once it is done. */
export function movedLine(move, home = homedir()) {
  const at = (path) => tildePath(path, home);
  return `${PAST[move.how]} ${WHAT[move.how](move, at)}`;
}

/** The dry run whole: the moves in order, the installations, the refusals, a count. */
export function dryRunLines({ moves, refusals, installs = [] }, home = homedir()) {
  if (!moves.length) return ['repos — nothing to move'];
  const lines = ['repos: primary checkouts → bare — dry run, nothing is written', '', 'MOVES'];
  lines.push(...moves.map((move) => `  ${move.name.padEnd(11)} ${moveLine(move, home)}`));
  if (installs.length) {
    lines.push('', 'INSTALLED FROM A CHECKOUT', ...installs.map((install) => `  ${install.command.padEnd(11)} runs from ${tildePath(install.root, home)}`));
  }
  if (refusals.length) lines.push('', 'REFUSED', ...refusals.map((line) => `  ${tildePath(line, home)}`));
  lines.push('', refusals.length
    ? `${moves.length} moves, ${refusals.length} refused — nothing moves until every refusal is resolved`
    : `${moves.length} moves, none refused`);
  return lines;
}

/** What `--apply` says when the plan it made again is refused. */
export function refusedLines(refusals, home = homedir()) {
  return [
    'repos — refused, nothing moved',
    '', 'REFUSED', ...refusals.map((line) => `  ${tildePath(line, home)}`),
    '', `${refusals.length} refused — mc repos migrate shows the whole plan`,
  ];
}

/* ------------------------------------------------------------------- apply */

/** git, the filesystem and the clock, as the moves use them. */
export function realApplyDeps() {
  return {
    run: realRun,
    mkdirSync,
    renameSync,
    symlinkSync,
    rmSync,
    now: () => new Date(),
  };
}

const pathExists = (path) => { try { lstatSync(path); return true; } catch { return false; } };

/** One move, or a throw saying why not. */
function carryOut(move, io) {
  const { from, to } = move;
  switch (move.how) {
    case 'mkdir':
      io.mkdirSync(to, { recursive: true });
      return;
    case 'rename':
      if (pathExists(to)) throw new Error(`${to} already exists`);
      io.renameSync(from, to);
      return;
    case 'config':
      io.run('git', ['--git-dir', from, 'config', 'core.bare', 'true'], { cwd: from });
      return;
    case 'repair':
      io.run('git', ['--git-dir', from, 'worktree', 'repair'], { cwd: from });
      return;
    case 'worktree':
      io.run('git', ['--git-dir', from, 'worktree', 'add', to, 'main'], { cwd: from });
      return;
    case 'relink': {
      // Made beside the old link and renamed over it: there is never a moment without one.
      const next = `${from}.repos-migrate`;
      io.symlinkSync(to, next);
      io.renameSync(next, from);
      return;
    }
    case 'remove':
      io.rmSync(from, { recursive: true, force: true });
      return;
    default:
      throw new Error(`no way to carry out a move by ${move.how}`);
  }
}

/**
 * Carry out a plan with no refusal: each move in order, logged and said as it
 * is done. Stops at the first that fails, says so, and returns 1; 0 when every
 * move is done. Never forces, never overwrites.
 */
export function applyReposMove({ moves }, { root, home = homedir(), stdout, stderr, deps = {} }) {
  const io = { ...realApplyDeps(), ...deps };
  const log = join(root, REPOS_LOG);
  for (const [index, move] of moves.entries()) {
    let error = null;
    try {
      carryOut(move, io);
    } catch (caught) {
      error = String(caught?.stderr || '').trim() || caught?.message || String(caught);
    }
    mkdirSync(dirname(log), { recursive: true });
    appendFileSync(log, `${JSON.stringify({ at: io.now().toISOString(), name: move.name, how: move.how, from: move.from, to: move.to, ok: !error, error })}\n`);
    if (error) {
      stderr.write(`mc: move ${index + 1} of ${moves.length} failed — ${moveLine(move, home).replace(/^would /u, '')}: ${error}\n`);
      stderr.write(`mc: stopped there; the ${index} before it are done — mc repos migrate --apply again continues from there\n`);
      return 1;
    }
    stdout.write(`${movedLine(move, home)}\n`);
  }
  stdout.write(`repos — ${moves.length} moves\n`);
  stdout.write('next: mc repos to see the layout, then mc run start\n');
  return 0;
}
