/**
 * A piece of work is a directory under `~/mc`.
 *
 * Everything about it is derived, never stored: the worktrees it spans are the
 * directories under it, their branches come from git, and whether a thing can
 * be released is a question git answers at the moment of asking. The only file
 * mc writes is `.mc.json` at the work-area root — the tool conversation, which
 * is the one fact no other system holds. It sits above the worktrees, so it is
 * never inside a repository.
 *
 * There are no gates here. Nothing refuses. `release` removes what git says is
 * safe to remove and reports what it left, because a tool that blocks on its
 * own bookkeeping is what made the previous design unusable.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { homedir } from 'node:os';

import { workAreaPath, workAreaStatePath, workRoot } from './paths.js';

export function listWorkAreas(env = process.env) {
  const root = workRoot(env);
  let names = [];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch { return []; }
  return names.map((name) => inspectWorkArea(name, env));
}

export function inspectWorkArea(name, env = process.env) {
  const path = workAreaPath(name, env);
  const worktrees = [];
  let entries = [];
  try {
    entries = readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch { /* the work area may not exist yet */ }
  for (const entry of entries) {
    worktrees.push(inspectWorktree(join(path, entry), entry));
  }
  return { name, path, exists: existsSync(path), state: readState(name, env), worktrees };
}

/** Everything here is asked of git now, not remembered from before. */
export function inspectWorktree(path, repo) {
  const branch = git(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const dirty = git(path, ['status', '--porcelain']);
  const common = git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const upstreamMerged = branch && branch !== 'HEAD'
    ? git(path, ['log', '--oneline', `origin/main..${branch}`])
    : null;
  return {
    repo,
    path,
    is_git: Boolean(common),
    branch: branch && branch !== 'HEAD' ? branch : null,
    git_common_dir: common,
    uncommitted: dirty ? dirty.split('\n').filter(Boolean).length : 0,
    unmerged_commits: upstreamMerged ? upstreamMerged.split('\n').filter(Boolean).length : 0,
  };
}

/**
 * Turn what the user typed into a repository.
 *
 * `mc work add x memoro-cli` means the repository called memoro-cli, not a
 * directory of that name below wherever the shell happens to be. Resolving it
 * as a path found nothing and said so in git's words, which is a poor way to
 * learn that mc looked in the wrong place.
 *
 * A path that exists wins. Otherwise the name is looked for beside the home
 * directory, which is where repository roots live. With nothing given at all,
 * the repository the shell is already inside is the obvious answer.
 */
export function resolveRepository(input, { cwd = process.cwd(), env = process.env } = {}) {
  const tried = [];
  const candidates = [];
  if (input) {
    candidates.push(resolvePath(cwd, input));
    if (!input.includes('/')) candidates.push(join(homedir(), input));
  } else {
    const root = git(cwd, ['rev-parse', '--show-toplevel']);
    if (root) candidates.push(root);
  }
  for (const candidate of candidates) {
    tried.push(candidate);
    if (!existsSync(candidate)) continue;
    const common = git(candidate, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (!common) continue;
    // A worktree is not the repository. Running this from inside one named the
    // work after the worktree — `mc-v2` instead of `memoro-cli` — so the
    // common directory decides: its parent is the repository root, whichever
    // checkout the shell happened to be standing in.
    return { ok: true, path: dirname(common) };
  }
  return { ok: false, tried };
}

function resolvePath(cwd, input) {
  return input.startsWith('/') ? input : join(cwd, input);
}

export function createWorkArea(name, env = process.env) {
  const path = workAreaPath(name, env);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

/**
 * Take one repository out of a piece of work, leaving the rest of it alone.
 *
 * Doing this by hand — `git worktree remove` and then a branch delete — is
 * what people did because mc had no verb for it, and it is how a shell ends
 * up standing in a directory that no longer exists.
 */
export function removeWorktree({ name, repo, env = process.env } = {}) {
  const area = inspectWorkArea(name, env);
  const worktree = area.worktrees.find((item) => item.repo === repo);
  if (!worktree) return { ok: false, reason: 'no-such-worktree' };
  const inUse = directoryInUse(worktree.path);
  if (inUse) return { ok: false, reason: `in use by ${inUse.join(', ')}` };
  if (worktree.uncommitted > 0) return { ok: false, reason: `${worktree.uncommitted} uncommitted` };
  if (!worktree.is_git) {
    rmSync(worktree.path, { recursive: true, force: true });
    return { ok: true, removed: 'directory' };
  }
  run(['--git-dir', worktree.git_common_dir, 'worktree', 'remove', '--', worktree.path]);
  const branchKept = worktree.unmerged_commits > 0;
  if (worktree.branch && !branchKept) {
    run(['--git-dir', worktree.git_common_dir, 'branch', '-d', worktree.branch]);
  }
  pruneWorktrees(knownRepositories(env));
  return { ok: true, removed: 'worktree', branch: worktree.branch, branch_kept: branchKept };
}

export function addWorktree({ name, repo, branch, from = null, env = process.env } = {}) {
  const area = createWorkArea(name, env);
  const target = join(area, repoName(repo));
  if (existsSync(target)) return { ok: false, reason: 'worktree-already-there', path: target };
  // A branch that already exists is checked out, not recreated. That is also
  // how a user who does not want mc minting branches gets what they want:
  // name one that exists and mc uses it.
  const exists = branch
    ? Boolean(git(repo, ['rev-parse', '--verify', `refs/heads/${branch}`]))
    : false;
  const args = ['-C', repo, 'worktree', 'add'];
  if (!branch) args.push('--detach', target);
  else if (exists) args.push(target, branch);
  else args.push('-b', branch, target, ...(from ? [from] : []));
  try {
    execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    return { ok: false, reason: firstLine(error), path: target };
  }
  return { ok: true, path: target, branch: branch || null };
}

/**
 * Remove what git says can go, keep what it says cannot, and say which.
 *
 * A worktree with uncommitted work stays. A branch with commits that are not
 * on `origin/main` stays. Neither stops the rest from being released, and
 * neither is an error — it is the work still being work.
 */
/**
 * Is something standing in this directory right now?
 *
 * A worktree can be the working directory of a running tool session — often
 * the very session asking for the release. Removing it leaves that shell and
 * that tool with no ground under them: the terminal falls back to the home
 * directory and every relative path afterwards is wrong.
 *
 * Asked of the operating system, not remembered. A directory nobody is
 * standing in answers immediately; there is nothing to keep in sync.
 */
export function directoryInUse(path) {
  try {
    const out = execFileSync('lsof', ['-a', '-d', 'cwd', '--', path], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lines = out.split('\n').slice(1).filter(Boolean);
    return lines.length ? [...new Set(lines.map((line) => line.split(/\s+/u)[0]))] : null;
  } catch { return null; }
}

export function releaseWorkArea(name, { env = process.env, dryRun = false } = {}) {
  const area = inspectWorkArea(name, env);
  const removed = [];
  const kept = [];
  for (const worktree of area.worktrees) {
    if (!worktree.is_git) {
      if (!dryRun) rmSync(worktree.path, { recursive: true, force: true });
      removed.push({ ...worktree, what: 'directory' });
      continue;
    }
    const inUse = directoryInUse(worktree.path);
    if (inUse) {
      kept.push({ ...worktree, why: `in use by ${inUse.join(', ')}` });
      continue;
    }
    if (worktree.uncommitted > 0) {
      kept.push({ ...worktree, why: `${worktree.uncommitted} uncommitted` });
      continue;
    }
    if (worktree.unmerged_commits > 0) {
      kept.push({ ...worktree, why: `${worktree.unmerged_commits} unmerged` });
      continue;
    }
    if (!dryRun) {
      const common = worktree.git_common_dir;
      run(['--git-dir', common, 'worktree', 'remove', '--', worktree.path]);
      if (worktree.branch) run(['--git-dir', common, 'branch', '-d', worktree.branch]);
    }
    removed.push({ ...worktree, what: 'worktree and branch' });
  }
  // A directory removed outside mc leaves git holding a registration for it.
  // That is git's own bookkeeping and git's own broom — mc calls it rather
  // than policing it, which is the difference between tidying and guarding.
  if (!dryRun) pruneWorktrees(knownRepositories(env));
  // When everything is released the work area has nothing left to be, so it
  // goes too — but only if it is genuinely empty. Anything the user put there
  // by hand keeps the directory alive.
  if (!dryRun && kept.length === 0 && area.exists) {
    try { rmSync(workAreaStatePath(name, env), { force: true }); } catch { /* absent */ }
    try {
      if (readdirSync(area.path).length === 0) rmSync(area.path, { recursive: true, force: true });
    } catch { /* leave it */ }
  }
  return { name, removed, kept, dry_run: dryRun };
}

/**
 * The tool sessions a work area holds.
 *
 * One piece of work can carry several conversations — one per repository it
 * spans, one per line of enquiry, a throwaway beside the main one. Each has a
 * name, a tool, and a conversation id, and nothing else: where it opens is
 * decided when it opens, not remembered.
 *
 * The first shape mc wrote was one id per tool, `{ "codex": "019f…" }`. That
 * is read as a session named after the tool, so nothing written earlier is
 * lost.
 */
/**
 * Throw work away on purpose.
 *
 * `release` keeps whatever is unfinished, which is right as a default and
 * useless when the work itself was the mistake: a failed experiment holds
 * exactly the uncommitted files and unmerged commits that release protects.
 * Without this the only way out was git by hand, which is how a shell ends up
 * standing in a directory that no longer exists.
 *
 * So this removes them, and it says what it is about to destroy first — the
 * dry run is the default and `--apply` is the user saying they meant it. The
 * one thing it still will not do is pull the ground from under a running
 * process; that is not protecting the work, it is not breaking the tool.
 */
export function discardWorkArea(name, { repo = null, env = process.env, dryRun = true } = {}) {
  const area = inspectWorkArea(name, env);
  const targets = repo
    ? area.worktrees.filter((item) => item.repo === repo)
    : area.worktrees;
  const discarded = [];
  const kept = [];
  for (const worktree of targets) {
    const inUse = directoryInUse(worktree.path);
    if (inUse) {
      kept.push({ ...worktree, why: `in use by ${inUse.join(', ')}` });
      continue;
    }
    if (!dryRun) {
      if (worktree.is_git) {
        run(['--git-dir', worktree.git_common_dir, 'worktree', 'remove', '--force', '--', worktree.path]);
        if (worktree.branch) run(['--git-dir', worktree.git_common_dir, 'branch', '-D', worktree.branch]);
      } else {
        rmSync(worktree.path, { recursive: true, force: true });
      }
    }
    discarded.push(worktree);
  }
  if (!dryRun) pruneWorktrees(knownRepositories(env));
  const wholeArea = !repo && kept.length === 0;
  if (!dryRun && wholeArea && area.exists) {
    rmSync(area.path, { recursive: true, force: true });
  }
  return { name, discarded, kept, removes_area: wholeArea, dry_run: dryRun };
}

export function readState(name, env = process.env) {
  let raw = {};
  try { raw = JSON.parse(readFileSync(workAreaStatePath(name, env), 'utf8')); } catch { return { sessions: {} }; }
  if (raw && typeof raw.sessions === 'object' && raw.sessions) return raw;
  // The first shape held one conversation per tool. The first of them becomes
  // `main`, because that is the name `mc work open` reaches for; naming it
  // after its tool left it there but unreachable.
  const sessions = {};
  const legacy = Object.entries(raw || {}).filter(([, value]) => typeof value === 'string');
  legacy.forEach(([tool, conversation], index) => {
    sessions[index === 0 ? 'main' : tool] = { tool, conversation };
  });
  return { sessions };
}

export function readToolSession(area, sessionName, env = process.env) {
  const state = readState(area, env);
  return state.sessions?.[sessionName] || null;
}

export function writeToolSession(area, sessionName, entry, env = process.env) {
  const state = readState(area, env);
  const sessions = { ...state.sessions, [sessionName]: { ...state.sessions?.[sessionName], ...entry } };
  return writeState(area, { sessions }, env);
}

export function writeState(name, patch, env = process.env) {
  const current = readState(name, env);
  const next = { ...current, ...patch };
  createWorkArea(name, env);
  writeFileSync(workAreaStatePath(name, env), `${JSON.stringify(next, null, 2)}\n`, {
    encoding: 'utf8', mode: 0o600,
  });
  return next;
}

/**
 * The repositories mc can see: the roots beside the home directory, which is
 * where `mc work add <name>` already looks. Deriving them here means prune
 * works even when the worktree directory is already gone — which is exactly
 * when a registration is left dangling.
 */
export function knownRepositories(env = process.env) {
  const home = homedir();
  let entries = [];
  try {
    entries = readdirSync(home, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => join(home, entry.name));
  } catch { return []; }
  return entries.filter((path) => existsSync(join(path, '.git')));
}

/** Let git tidy its own registrations rather than mc policing them. */
export function pruneWorktrees(repos = []) {
  for (const repo of repos) run(['-C', repo, 'worktree', 'prune']);
}

function repoName(repo) {
  return repo.replace(/\/+$/u, '').split('/').pop() || 'repo';
}

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch { return null; }
}

function run(args) {
  try { execFileSync('git', args, { stdio: ['ignore', 'ignore', 'ignore'] }); return true; } catch { return false; }
}

function firstLine(error) {
  const text = error?.stderr?.toString?.() || error?.message || String(error);
  return text.split('\n').find(Boolean)?.slice(0, 200) || 'unknown';
}
