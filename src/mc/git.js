/**
 * Lightweight git shell-outs used by mc lifecycle commands.
 *
 * Synchronous on purpose — git operations are fast (<50ms each) and the
 * dispatch / command layer is itself synchronous in shape. Async would
 * just add ceremony without latency wins.
 */
import { spawn, spawnSync } from 'node:child_process';

/**
 * How long one git call may take before it is stopped. Five minutes is more
 * than twice the 120 s the runner's own `sh()` gives every fetch, push and
 * `worktree add` it makes in both repositories, so nothing that finishes
 * today is cut off. What it is for is the call that never finishes: with the
 * login keychain locked, `git credential-osxkeychain` waits on a modal nobody
 * is there to answer, and without a limit the mc command under it waited too
 * (2026-09-20). A caller that knows better passes `timeoutMs`.
 */
export const GIT_TIMEOUT_MS = 300_000;

/**
 * The one place a git process is started.
 *
 * Every git call mc makes goes through `run` (synchronous) or `runAsync`, in
 * the raw shape `spawnSync` gives — `{ status, stdout, stderr, error, signal }`
 * with utf8 strings — and the readers above and around reshape it. One
 * entrance so a test can stand in for all of git at once: `useGitRunner`
 * replaces the process with a function of the same shape for this process,
 * and a suite that runs against a repository model never starts git at all
 * (Martin, 2026-11-01: tests make no git call; `tests/_isolate-home.mjs`
 * counts the ones that still do).
 */
let runner = null;

/**
 * Stand in for git in this process: `fn(cwd, args, options)` returns what
 * `spawnSync('git', …)` would — `{ status, stdout, stderr }`, `error` set when
 * the process could not run or timed out. Returns the function that restores
 * the previous runner. A test installs one in `before` and restores it in
 * `after`; production never calls this.
 */
export function useGitRunner(fn) {
  const previous = runner;
  runner = fn;
  return () => { runner = previous; };
}

/** The raw result of `git <args>` in `cwd`, or of the installed runner. */
export function run(cwd, args, { env, input, timeoutMs = GIT_TIMEOUT_MS, maxBuffer, stdio, encoding = 'utf8' } = {}) {
  if (runner) return runner(cwd, args, { env, input, timeoutMs, maxBuffer, encoding });
  const options = { cwd, encoding, timeout: timeoutMs };
  if (env) options.env = env;
  if (input !== undefined) options.input = input;
  if (maxBuffer) options.maxBuffer = maxBuffer;
  if (stdio) options.stdio = stdio;
  return spawnSync('git', args, options);
}

/** `run`, without blocking the event loop: the same shape, as a promise. */
export function runAsync(cwd, args, options = {}) {
  if (runner) return Promise.resolve(runner(cwd, args, { ...options, timeoutMs: options.timeoutMs ?? GIT_TIMEOUT_MS }));
  return new Promise((resolve) => {
    const { env, input, timeoutMs = GIT_TIMEOUT_MS, maxBuffer, encoding = 'utf8' } = options;
    const spawnOptions = { cwd, stdio: ['pipe', 'pipe', 'pipe'] };
    if (env) spawnOptions.env = env;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    try { child = spawn('git', args, spawnOptions); } catch (error) { finish({ status: null, stdout, stderr, error, signal: null }); return; }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      const error = new Error(`git ${args.join(' ')} did not finish in ${seconds(timeoutMs)}`);
      error.code = 'ETIMEDOUT';
      finish({ status: null, stdout, stderr, error, signal: 'SIGKILL' });
    }, timeoutMs);
    child.stdout.setEncoding(encoding);
    child.stderr.setEncoding(encoding);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (maxBuffer && stdout.length > maxBuffer) {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
        const error = new Error(`git ${args.join(' ')} wrote more than ${maxBuffer} bytes`);
        error.code = 'ENOBUFS';
        finish({ status: null, stdout, stderr, error, signal: 'SIGKILL' });
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish({ status: null, stdout, stderr, error, signal: null }));
    child.on('close', (status, signal) => finish({ status, stdout, stderr, error: undefined, signal }));
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

export function git(cwd, args, { allowFailure = false, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const r = run(cwd, args, { timeoutMs });
  if (r.error?.code === 'ETIMEDOUT') {
    if (allowFailure) return null;
    const err = new Error(
      `git ${args.join(' ')} did not finish in ${seconds(timeoutMs)} and was stopped`
      + ' — if it was asking for credentials, a locked keychain does not answer (security unlock-keychain)',
    );
    err.code = 'ETIMEDOUT';
    err.stderr = r.stderr;
    throw err;
  }
  if (r.status !== 0) {
    if (allowFailure) return null;
    const err = new Error(
      `git ${args.join(' ')} failed (${r.status}): ${(r.stderr || '').trim()}`,
    );
    err.code = r.status;
    err.stderr = r.stderr;
    throw err;
  }
  return (r.stdout || '').trim();
}

export function tryGit(cwd, args, { timeoutMs } = {}) {
  return git(cwd, args, { allowFailure: true, timeoutMs });
}

function seconds(ms) {
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
}

export function isInsideRepo(cwd) {
  return tryGit(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

export function observeWorktree(worktreePath, { now = () => new Date().toISOString() } = {}) {
  if (typeof worktreePath !== 'string' || !worktreePath.trim()) {
    return { ok: false, reason: 'missing-worktree-path' };
  }
  if (!isInsideRepo(worktreePath)) {
    return { ok: false, reason: 'not-a-git-worktree', worktree_path: worktreePath };
  }

  const branch = tryGit(worktreePath, ['branch', '--show-current']) || null;
  const head = tryGit(worktreePath, ['rev-parse', 'HEAD']) || null;
  const gitRoot = tryGit(worktreePath, ['rev-parse', '--show-toplevel']) || worktreePath;
  const porcelain = tryGit(worktreePath, ['status', '--porcelain']);
  const upstream = tryGit(worktreePath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  const aheadBehind = upstream
    ? parseAheadBehind(tryGit(worktreePath, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`]))
    : { ahead: null, behind: null };

  return {
    ok: true,
    worktree_path: worktreePath,
    git_root: gitRoot,
    current_branch: branch,
    detached: !branch,
    head,
    dirty_files: countPorcelainFiles(porcelain),
    ahead: aheadBehind.ahead,
    behind: aheadBehind.behind,
    observed_at: now(),
  };
}

/**
 * Return the primary worktree's path. From inside a worktree, git's
 * `worktree list --porcelain` lists the primary first.
 */
export function primaryWorktree(cwd) {
  const out = tryGit(cwd, ['worktree', 'list', '--porcelain']);
  if (!out) return null;
  const first = out.split('\n\n')[0];
  const m = first.match(/^worktree\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

/**
 * The path of the worktree that has `branch` checked out, from the text of
 * `git worktree list --porcelain`, or null when no worktree has it.
 *
 * Pure on purpose: the caller shells out through its own seam and this only
 * reads the answer. Porcelain is stanzas separated by a blank line, each
 * `worktree <path>` then `HEAD <sha>` then one of `branch refs/heads/<name>`,
 * `detached` or `bare` — the last two are stanzas with no branch line and are
 * simply not matched. There is at most one hit: git refuses a second checkout
 * of the same branch, which is the property the deploy worktree rests on.
 */
export function worktreeOnBranch(porcelain, branch) {
  const want = `refs/heads/${branch}`;
  for (const stanza of String(porcelain || '').split(/\n\s*\n/u)) {
    const stanzaLines = stanza.split('\n');
    const path = stanzaLines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
    const ref = stanzaLines.find((line) => line.startsWith('branch '))?.slice('branch '.length).trim();
    if (path && ref === want) return path.replace(/\r$/u, '');
  }
  return null;
}

/** Where `main` is checked out, if anywhere. `mc deploy`'s one question. */
export function mainWorktree(porcelain) {
  return worktreeOnBranch(porcelain, 'main');
}

/**
 * True if the branch exists locally.
 */
export function branchExists(cwd, branch) {
  const r = tryGit(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  return r !== null;
}

/**
 * Resolve the repository's default branch from explicit local metadata or
 * unambiguous Git refs. This is deliberately local-only: lifecycle safety
 * must not depend on network availability, and a missing remote HEAD must not
 * be replaced with a conventional branch-name guess.
 *
 * Repository-local overrides use `mc.defaultBranch` and, when more than one
 * remote exists, optional `mc.defaultRemote`. Callers may supply the same
 * values directly when they already own trusted repository metadata.
 */
export function resolveDefaultBranch(repoDir, {
  defaultBranch = null,
  defaultRemote = null,
} = {}) {
  if (!isInsideRepo(repoDir)) return unresolvedDefaultBranch('not-a-git-repository');

  const remotes = lines(tryGit(repoDir, ['remote']));
  const branch = nonEmpty(defaultBranch)
    || nonEmpty(tryGit(repoDir, ['config', '--local', '--get', 'mc.defaultBranch']));
  const remote = nonEmpty(defaultRemote)
    || nonEmpty(tryGit(repoDir, ['config', '--local', '--get', 'mc.defaultRemote']));

  if (branch && !validBranchName(repoDir, branch)) {
    return unresolvedDefaultBranch('configured-default-branch-invalid');
  }
  if (remote && !remotes.includes(remote)) {
    return unresolvedDefaultBranch('configured-default-remote-missing');
  }
  if (branch) return resolveConfiguredBranch(repoDir, branch, remote, remotes);

  const selectedRemotes = remote ? [remote] : remotes;
  const remoteHeads = selectedRemotes
    .map((name) => remoteHeadCandidate(repoDir, name))
    .filter(Boolean);
  if (remoteHeads.length === 1) return resolvedDefaultBranch(remoteHeads[0], 'remote-head');
  if (remoteHeads.length > 1) {
    return unresolvedDefaultBranch('default-branch-ambiguous', remoteHeads);
  }

  const remoteBranches = remoteBranchCandidates(repoDir, selectedRemotes);
  if (remoteBranches.length === 1) {
    return resolvedDefaultBranch(remoteBranches[0], 'single-remote-branch');
  }
  if (remoteBranches.length > 1) {
    return unresolvedDefaultBranch('default-branch-unknown', remoteBranches);
  }

  if (remotes.length === 0) {
    const localBranches = localBranchCandidates(repoDir);
    if (localBranches.length === 1) {
      return resolvedDefaultBranch(localBranches[0], 'single-local-branch');
    }
    if (localBranches.length > 1) {
      return unresolvedDefaultBranch('default-branch-unknown', localBranches);
    }
  }

  return unresolvedDefaultBranch('default-branch-unknown');
}

/**
 * True if the worktree at `path` has uncommitted changes (tracked +
 * untracked). Cheap: just `git status --porcelain`.
 */
export function isDirty(worktreePath) {
  const r = tryGit(worktreePath, ['status', '--porcelain']);
  if (r === null) return false; // not a repo / inaccessible → treat as clean
  return r.length > 0;
}

/**
 * Count commits on `branch` that are not in the resolved default branch.
 * Returns null when the default branch or revision cannot be proven; callers
 * must not turn that unknown state into a merged/safe classification.
 */
export function commitsAhead(repoDir, branch, baseRef = null) {
  const resolved = baseRef
    ? { ok: true, ref: baseRef }
    : resolveDefaultBranch(repoDir);
  if (!resolved.ok) return null;
  const r = tryGit(repoDir, ['rev-list', '--count', `${resolved.ref}..${branch}`]);
  if (r === null) return null;
  const n = Number(r);
  return Number.isFinite(n) ? n : null;
}

function resolveConfiguredBranch(repoDir, branch, remote, remotes) {
  if (remote) {
    const candidate = remoteBranchCandidate(repoDir, remote, branch);
    return candidate
      ? resolvedDefaultBranch(candidate, 'configured')
      : unresolvedDefaultBranch('configured-default-branch-missing');
  }

  const localRef = `refs/heads/${branch}`;
  if (refExists(repoDir, localRef)) {
    const upstream = nonEmpty(tryGit(repoDir, [
      'for-each-ref', '--format=%(upstream)', localRef,
    ]));
    if (upstream && refExists(repoDir, upstream)) {
      const candidate = preferLocalDefaultRef(repoDir, candidateFromRemoteRef(upstream));
      if (candidate) return resolvedDefaultBranch(candidate, 'configured');
    }
    return resolvedDefaultBranch({ branch, ref: localRef, remote: null }, 'configured');
  }

  const matches = remotes
    .map((name) => remoteBranchCandidate(repoDir, name, branch))
    .filter(Boolean);
  if (matches.length === 1) return resolvedDefaultBranch(matches[0], 'configured');
  if (matches.length > 1) return unresolvedDefaultBranch('default-branch-ambiguous', matches);
  return unresolvedDefaultBranch('configured-default-branch-missing');
}

function remoteHeadCandidate(repoDir, remote) {
  const headRef = `refs/remotes/${remote}/HEAD`;
  const target = nonEmpty(tryGit(repoDir, ['symbolic-ref', '--quiet', headRef]));
  if (!target || !target.startsWith(`refs/remotes/${remote}/`) || !refExists(repoDir, target)) {
    return null;
  }
  return preferLocalDefaultRef(repoDir, candidateFromRemoteRef(target));
}

function remoteBranchCandidates(repoDir, remotes) {
  const allowed = new Set(remotes);
  return lines(tryGit(repoDir, [
    'for-each-ref', '--format=%(refname)', 'refs/remotes',
  ]))
    .filter((ref) => !ref.endsWith('/HEAD'))
    .map(candidateFromRemoteRef)
    .filter((candidate) => candidate && allowed.has(candidate.remote))
    .map((candidate) => preferLocalDefaultRef(repoDir, candidate));
}

function localBranchCandidates(repoDir) {
  return lines(tryGit(repoDir, [
    'for-each-ref', '--format=%(refname)', 'refs/heads',
  ])).map((ref) => ({
    branch: ref.slice('refs/heads/'.length),
    ref,
    remote: null,
  }));
}

function remoteBranchCandidate(repoDir, remote, branch) {
  const ref = `refs/remotes/${remote}/${branch}`;
  return refExists(repoDir, ref)
    ? preferLocalDefaultRef(repoDir, { branch, ref, remote })
    : null;
}

function candidateFromRemoteRef(ref) {
  const match = String(ref || '').match(/^refs\/remotes\/([^/]+)\/(.+)$/);
  return match ? { remote: match[1], branch: match[2], ref } : null;
}

function preferLocalDefaultRef(repoDir, candidate) {
  if (!candidate) return null;
  const localRef = `refs/heads/${candidate.branch}`;
  return refExists(repoDir, localRef)
    ? { ...candidate, ref: localRef, remote_ref: candidate.ref }
    : candidate;
}

function refExists(repoDir, ref) {
  return tryGit(repoDir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null;
}

function validBranchName(repoDir, branch) {
  return tryGit(repoDir, ['check-ref-format', '--branch', branch]) !== null;
}

function resolvedDefaultBranch(candidate, source) {
  return { ok: true, ...candidate, source };
}

function unresolvedDefaultBranch(reason, candidates = []) {
  return {
    ok: false,
    branch: null,
    ref: null,
    remote: null,
    source: null,
    reason,
    candidates: candidates.map(({ branch, ref, remote, remote_ref: remoteRef }) => ({
      branch,
      ref,
      remote,
      ...(remoteRef ? { remote_ref: remoteRef } : {}),
    })),
  };
}

function lines(value) {
  return typeof value === 'string'
    ? value.split('\n').map((item) => item.trim()).filter(Boolean)
    : [];
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function countPorcelainFiles(value) {
  if (typeof value !== 'string' || !value.trim()) return 0;
  return value.split('\n').filter(Boolean).length;
}

function parseAheadBehind(value) {
  if (typeof value !== 'string') return { ahead: null, behind: null };
  const [behindRaw, aheadRaw] = value.trim().split(/\s+/);
  const behind = Number(behindRaw);
  const ahead = Number(aheadRaw);
  return {
    ahead: Number.isFinite(ahead) ? ahead : null,
    behind: Number.isFinite(behind) ? behind : null,
  };
}
