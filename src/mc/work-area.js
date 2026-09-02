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
  rmdirSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { homedir } from 'node:os';

import { deleteConversations, listConversations } from './conversations.js';
import { PLAN_HOME, workAreaPath, workAreaStatePath, workRoot } from './paths.js';
import { installPushGuard } from './push-guard.js';
import { areaRoleName, reservedRoleName } from './roles.js';
import { STOP_MARK } from './work-stop-marker.js';
import { branchLanded } from './branch-landed.js';

/**
 * `PLAN_HOME` — `~/mc/plan/` — is skipped, because it is not a work area and
 * holds none: what is under it are programmes, each with its own checkouts one
 * level down (`paths.js`). Listed as an area it read as a directory called
 * `plan` whose "repositories" were programme names, which is the same nonsense
 * a role home's filing is already kept out of. `mc plan` opens what is under
 * there; nothing else has business listing it.
 */
export function listWorkAreas(env = process.env, options = {}) {
  const root = workRoot(env);
  let names = [];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .filter((name) => name !== PLAN_HOME)
      .sort();
  } catch { return []; }
  return names.map((name) => inspectWorkArea(name, env, options));
}

/**
 * A workarea is a directory that holds checkouts, and nothing else.
 *
 * There was a list here — `FILING_DIRECTORIES` — filtering `inbox/` and
 * `handoff/` out of an area's worktrees so they would not turn up on the board
 * as repositories that are not repositories. Both concepts are gone (Martin,
 * 2026-09-02: a workarea is reduced to a folder for repositories, with no
 * special directories at all), and the filter goes with the second of them,
 * not before it — a filter removed while the thing it filters is still being
 * written is exactly the failure it existed to prevent.
 *
 * What remains is the ordinary rule, which was always enough: a directory that
 * is not a checkout is not a worktree, and `inspectWorktree` says so for
 * itself.
 */

/** mc's own marks in an area: state, never litter, and never what keeps an area alive. */
const OWN_MARKS = new Set(['.mc-role', STOP_MARK]);

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
  // A singleton role's home has no worktrees by design (K3.2) — its
  // subdirectories are the role's filing (inbox, queues, sweeps…), and
  // listing them as repositories would put nonsense on every status page.
  // Gated on the mark, not the name alone: a pre-reservation ordinary area
  // that happens to wear the name keeps its worktrees visible.
  const roleHome = reservedRoleName(name) && Boolean(areaRoleName(path));
  try {
    entries = roleHome ? [] : readdirSync(path, { withFileTypes: true })
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
  const unmergedCommits = upstreamMerged ? upstreamMerged.split('\n').filter(Boolean).length : 0;
  return {
    repo,
    path,
    is_git: Boolean(common),
    branch: branch && branch !== 'HEAD' ? branch : null,
    git_common_dir: common,
    uncommitted: dirty ? dirty.split('\n').filter(Boolean).length : 0,
    unmerged_commits: unmergedCommits,
    // Content, not commits (2026-08-24): every merge here is a squash, so
    // ahead-counting alone calls every landed branch unmerged forever.
    landed: unmergedCommits > 0 && branch && branch !== 'HEAD' ? branchLanded(path, branch) : null,
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
 * Undo an area that was made for a checkout that never arrived.
 *
 * The area comes first — `git worktree add` wants its parent to exist — so a
 * failed add left `~/mc/<name>/` behind, empty. `mc plan mc` failing on a
 * branch name git would not take still made `~/mc/mc/`, and the next `mc`
 * counted it among the workareas nobody is working on. A directory that only
 * exists because something went wrong is not a piece of work.
 *
 * `rmdirSync` is the guard rather than a check before it: it refuses a
 * directory that is not empty, so anything that did arrive — another
 * repository's worktree, a file somebody put there — keeps the area. Failing
 * to tidy up is never worth reporting over the failure that caused it.
 */
export function dropEmptyArea(path) {
  try { rmdirSync(path); return true; } catch { return false; }
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
  // Content, not commits: a landed branch is a squash artefact, not work.
  const branchKept = worktree.unmerged_commits > 0 && worktree.landed !== 'landed';
  if (worktree.branch && !branchKept) {
    run(['--git-dir', worktree.git_common_dir, 'branch', '-D', worktree.branch]);
  }
  pruneWorktrees(knownRepositories(env));
  return {
    ok: true,
    removed: 'worktree',
    branch: worktree.branch,
    branch_kept: branchKept,
    branch_kept_why: branchKept
      ? (worktree.landed === 'ahead'
        ? `it has ${worktree.unmerged_commits} commit${worktree.unmerged_commits === 1 ? '' : 's'} main lacks`
        : 'mc cannot tell whether main has this content — its merge against origin/main conflicts')
      : null,
  };
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
  // Whether the area was already there decides who has to clean up after a
  // failure: an area this call made and could not fill is this call's litter.
  const madeTheArea = !existsSync(workAreaPath(name, env));
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
    if (madeTheArea) dropEmptyArea(workAreaPath(name, env));
    return { ok: false, reason: whyItFailed(error), path: target };
  }
  // The pre-push guard (push-guard.js) rides along with every worktree mc
  // adds: one file in the repository's common hooks, covering all of them.
  // Its failure is reported, never fatal — the worktree is the deliverable.
  let guard = null;
  try { guard = installPushGuard(repo); } catch (error) { guard = { ok: false, reason: error?.message || String(error) }; }
  return {
    ok: true,
    path: target,
    branch: branch || null,
    base: base.ref || (exists ? 'the existing branch' : null),
    base_note: base.why,
    push_guard: guard,
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
  // By prefix (standing.js): a shell one directory down is still standing
  // here, and removing the worktree would still pull the ground from it.
  let pids = [];
  try {
    pids = [...new Set(processesStandingIn([path]).map((item) => String(item.pid)))];
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
    // Content, not commits: a squash-merged branch has commits main lacks
    // and nothing main lacks. Kept only for real work or a real doubt, and
    // the why says which (2026-08-24: twelve landed areas refused cleaning).
    if (worktree.unmerged_commits > 0 && worktree.landed === 'ahead') {
      kept.push({ ...worktree, why: `${worktree.unmerged_commits} commit${worktree.unmerged_commits === 1 ? '' : 's'} main lacks` });
      continue;
    }
    if (worktree.unmerged_commits > 0 && worktree.landed !== 'landed') {
      kept.push({ ...worktree, why: `cannot tell whether main has this content — its merge against origin/main conflicts; left for a person` });
      continue;
    }
    if (!dryRun) {
      const common = worktree.git_common_dir;
      run(['--git-dir', common, 'worktree', 'remove', '--', worktree.path]);
      // -D, not -d: a squash-merged branch is never ancestor-merged, so git's
      // own safety check would refuse the exact branches this exists to
      // clean. The content check above is the safety.
      if (worktree.branch) run(['--git-dir', common, 'branch', '-D', worktree.branch]);
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
  //
  // ONE forecast for both modes (2026-08-24): the dry run used to promise
  // "would remove <conversation>" whenever git kept nothing, while the
  // apply then found inbox/ files, kept everything, and said "nothing to
  // release" — a dry run that promises more than the command does. The
  // emptiness question is now asked the same way in both modes: what would
  // be left once the removable worktrees are gone, own marks aside — and
  // whatever holds the area is named instead of implied.
  const goneDirs = new Set(removed.map((item) => basename(item.path)));
  let heldBy = [];
  try {
    heldBy = readdirSync(area.path)
      .filter((entry) => !OWN_MARKS.has(entry) && !goneDirs.has(entry))
      .sort();
  } catch { /* the area may not exist */ }
  const wouldBeEmpty = kept.length === 0 && heldBy.length === 0;
  const conversations = wouldBeEmpty ? area.conversations : [];
  let removedConversations = conversations;
  let failedConversations = [];
  if (!dryRun && wouldBeEmpty && area.exists) {
    // An earlier mc wrote a copy of the conversation id here. Nothing reads it
    // any more; it goes out with the area rather than being migrated.
    try { rmSync(workAreaStatePath(name, env), { force: true }); } catch { /* absent */ }
    if (conversations.length) {
      const outcome = deleteConversations(conversations, env);
      removedConversations = outcome.removed;
      failedConversations = outcome.failed;
    }
    rmSync(area.path, { recursive: true, force: true });
  }
  return {
    name,
    removed,
    kept,
    conversations: removedConversations,
    conversations_failed: failedConversations,
    // What keeps the area (and its conversations) in place when nothing
    // above did: the user's own files, named so the dry run and the apply
    // tell the same story — and so the way forward (mc work discard) has
    // an object.
    held_by: kept.length === 0 ? heldBy : [],
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

/**
 * What went wrong, out of the noise a command made on its way there.
 *
 * `git worktree add` narrates before it fails. Its first line of stderr is
 * always `Preparing worktree (new branch '<name>')`, so taking the first
 * non-empty line reported every worktree failure as the progress message that
 * preceded it — `mc plan mc` said *"could not add memoro to mc (Preparing
 * worktree (new branch 'mc'))"*, which names no cause and suggests nothing to
 * do. The line under it was the answer:
 *
 *     fatal: 'refs/heads/mc/github-write-flag' exists; cannot create 'refs/heads/mc'
 *
 * — a branch called `mc` cannot exist while `mc/` is a directory in the ref
 * namespace, which is a real and fixable thing to be told.
 *
 * So the diagnosis is asked for by name: git prefixes one with `fatal:` or
 * `error:`, and only when there is none does the narration stand in for it.
 * A thrown error with no stderr at all still answers from its message.
 */
function whyItFailed(error) {
  const text = error?.stderr?.toString?.() || error?.message || String(error);
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const said = lines.find((line) => /^(fatal|error):/iu.test(line));
  return (said || lines[0] || 'unknown').slice(0, 200);
}
