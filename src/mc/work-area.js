/**
 * A piece of work is a directory under `~/mc`.
 *
 * Everything about it is derived, never stored: the worktrees it spans are the
 * directories under it, their branches come from git, whether a thing can be
 * released is a question git answers at the moment of asking, and the
 * conversations are the tools' own, found by the directory they were launched
 * in. mc writes no file at all. The directory is the record.
 *
 * There are no gates here. Nothing refuses. `release` removes what git says is
 * safe to remove and reports what it left, because a tool that blocks on its
 * own bookkeeping is what made the previous design unusable.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { homedir } from 'node:os';

import { deleteConversations, listConversations } from './conversations.js';
import { workAreaPath, workAreaStatePath, workRoot } from './paths.js';

export function listWorkAreas(env = process.env, options = {}) {
  const root = workRoot(env);
  let names = [];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch { return []; }
  return names.map((name) => inspectWorkArea(name, env, options));
}

/**
 * `conversations: false` and `git: false` leave those lookups out. Both cost
 * real time — a sqlite query and a directory walk for the first, four git
 * commands per checkout for the second — and a caller that is about to ask
 * for every area at once should ask once rather than once per area.
 */
export function inspectWorkArea(name, env = process.env, { conversations = true, git: askGit = true } = {}) {
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
    // `git: false` returns the directory and nothing asked of git. A caller
    // gathering facts for every area at once asks git itself, in parallel;
    // asking here as well ran the same four commands twice per checkout.
    worktrees.push(askGit
      ? inspectWorktree(join(path, entry), entry)
      : { repo: entry, path: join(path, entry) });
  }
  return {
    name,
    path,
    exists: existsSync(path),
    worktrees,
    conversations: conversations ? listConversations(path, env) : [],
  };
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

/**
 * Where new work starts from.
 *
 * `git worktree add -b <branch> <path>` with no start point branches from the
 * repository's HEAD — whatever the user's main checkout happens to be sitting
 * on. That is almost never what starting a new piece of work means. On this
 * machine `~/memoro` was 35 commits behind `origin/main`, so every work area
 * created from it began 35 commits in the past, and a session found its tests
 * failing against a baseline that had already been fixed.
 *
 * mc already treats `origin/main` as the baseline everywhere else: release and
 * discard both count a branch's commits as `origin/main..branch`. Starting
 * somewhere else was mc disagreeing with itself.
 *
 * The remote's own default branch is asked for rather than assumed, and it is
 * refreshed first — a stale `origin/main` is the same bug one step removed.
 * Both steps degrade quietly: no remote, no network, or a repository with no
 * origin at all falls back to HEAD, which is where it used to start always.
 */
function baseFor(repo) {
  const head = git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const ref = head || (git(repo, ['rev-parse', '--verify', 'origin/main']) ? 'origin/main' : null);
  if (!ref) return { ref: null, why: 'no origin — started from this repository\'s current HEAD' };
  const remote = ref.split('/')[0];
  const branch = ref.slice(remote.length + 1);
  const fetched = run(['-C', repo, 'fetch', '--quiet', remote, branch]);
  return { ref, why: fetched ? null : `could not reach ${remote} — using the last ${ref} it saw` };
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
  const base = exists || !branch ? { ref: null, why: null } : (from ? { ref: from, why: null } : baseFor(repo));
  const args = ['-C', repo, 'worktree', 'add'];
  if (!branch) args.push('--detach', target);
  else if (exists) args.push(target, branch);
  else args.push('-b', branch, target, ...(base.ref ? [base.ref] : []));
  try {
    execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    return { ok: false, reason: firstLine(error), path: target };
  }
  return {
    ok: true,
    path: target,
    branch: branch || null,
    base: base.ref || (exists ? 'the existing branch' : null),
    base_note: base.why,
  };
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
  let pids = [];
  try {
    // `-F pn` asks lsof for one field per line rather than a table. The table's
    // COMMAND column is truncated and splits on spaces, so a process holding
    // this directory was reported as being called `2.1.223` — a fragment of
    // its own version string. A pid is unambiguous; the name comes from `ps`.
    const out = execFileSync('lsof', ['-a', '-d', 'cwd', '-F', 'pn', '--', path], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    pids = [...new Set(out.split('\n')
      .filter((line) => line.startsWith('p'))
      .map((line) => line.slice(1).trim())
      .filter(Boolean))];
  } catch { return null; }
  if (pids.length === 0) return null;
  const names = pids.map((pid) => {
    try {
      return execFileSync('ps', ['-o', 'comm=', '-p', pid], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim().split('/').pop() || `pid ${pid}`;
    } catch { return `pid ${pid}`; }
  });
  return [...new Set(names)];
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
  // goes too — and its conversations with it, because a piece of work that is
  // finished is finished in both places. Only if it is genuinely empty:
  // anything the user put there by hand keeps the directory alive, and keeps
  // the conversations too.
  const conversations = kept.length === 0 ? area.conversations : [];
  let removedConversations = conversations;
  let failedConversations = [];
  if (!dryRun && kept.length === 0 && area.exists) {
    // An earlier mc wrote a copy of the conversation id here. Nothing reads it
    // any more; it goes out with the area rather than being migrated.
    try { rmSync(workAreaStatePath(name, env), { force: true }); } catch { /* absent */ }
    // The role mark is the area's own state, not litter: it must not keep an
    // otherwise-empty area alive, and it must survive whenever the area does —
    // an area quietly demoted from its role would run every future
    // conversation without the overlay and have no way to warn about it.
    let empty = false;
    try {
      empty = readdirSync(area.path).filter((entry) => entry !== '.mc-role').length === 0;
    } catch { /* leave it */ }
    if (empty) {
      if (conversations.length) {
        const outcome = deleteConversations(conversations, env);
        removedConversations = outcome.removed;
        failedConversations = outcome.failed;
      }
      rmSync(area.path, { recursive: true, force: true });
    } else {
      removedConversations = [];
    }
  }
  return {
    name,
    removed,
    kept,
    conversations: removedConversations,
    conversations_failed: failedConversations,
    dry_run: dryRun,
  };
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

  // The conversations go with the work. Leaving them would mean the user has to
  // find and delete them by hand in two different tools, which is the chore mc
  // exists to end. They are deleted through the tools that own them — mc has no
  // copy to delete, and makes none.
  const conversations = wholeArea ? area.conversations : [];
  let removedConversations = conversations;
  let failedConversations = [];
  if (!dryRun && conversations.length) {
    const outcome = deleteConversations(conversations, env);
    removedConversations = outcome.removed;
    failedConversations = outcome.failed;
  }

  if (!dryRun && wholeArea && area.exists) {
    rmSync(area.path, { recursive: true, force: true });
  }
  return {
    name,
    discarded,
    kept,
    conversations: removedConversations,
    conversations_failed: failedConversations,
    removes_area: wholeArea,
    dry_run: dryRun,
  };
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
