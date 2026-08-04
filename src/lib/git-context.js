/**
 * Lightweight git-context detection. The coordinator only tracks coding
 * sessions that are inside a git repository — code outside any repo is out
 * of scope.
 *
 * Pure shell-outs, no native deps. Returns null when not in a repo so
 * callers can early-out without throwing.
 */

import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';

/**
 * Return `{ toplevel, branch, remoteUrl }` for `cwd`, or `null` if not in
 * a git repo. `remoteUrl` falls back to the toplevel path when the repo
 * has no `origin` remote, so it can still serve as a stable identity key.
 */
export async function getRepoContext(cwd) {
  const toplevel = await runGit(['rev-parse', '--show-toplevel'], cwd);
  if (!toplevel) return null;

  const branch =
    (await runGit(['symbolic-ref', '--short', 'HEAD'], cwd)) ||
    (await runGit(['rev-parse', '--short', 'HEAD'], cwd)) ||
    'detached';

  const remoteUrl =
    (await runGit(['remote', 'get-url', 'origin'], cwd)) || toplevel;

  return { toplevel, branch, remoteUrl };
}

/**
 * Return the repository's top-level git directory as an absolute path.
 * Falls back to null when the command is unavailable or the path is not a repo.
 */
export async function resolveGitCommonDir(cwd) {
  const commonDir = await runGit(
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    cwd,
  );
  if (!commonDir) return null;
  return isAbsolute(commonDir) ? resolve(commonDir) : resolve(cwd, commonDir);
}

/**
 * Derive a short, human-readable repo name from a context. Handles common
 * remote-URL shapes (`git@github.com:user/repo.git`, `https://…/repo.git`)
 * and falls back to the toplevel directory basename.
 */
export function deriveRepoName(context) {
  if (!context) return 'unknown';
  if (context.remoteUrl && context.remoteUrl !== context.toplevel) {
    const match = context.remoteUrl.match(/[:/]([^/]+?)(?:\.git)?$/);
    if (match) return match[1];
  }
  if (context.toplevel) {
    const parts = context.toplevel.split('/');
    return parts[parts.length - 1] || 'unknown';
  }
  return 'unknown';
}

/**
 * Return a credential-free repo reference that can be shown to Memoro Cloud.
 * GitHub remotes use owner/repo shorthand; generic http(s) remotes keep the
 * URL with username/password stripped. Local-only and unparseable remotes
 * intentionally return null.
 */
export function derivePublicRepoRef(context) {
  if (!context) return null;
  const remote = typeof context.remoteUrl === 'string' ? context.remoteUrl.trim() : '';
  if (!remote || remote === context.toplevel) return null;

  const githubSsh = remote.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (githubSsh) return stripGitSuffix(githubSsh[1]);

  try {
    const url = new URL(remote);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    if (url.hostname.toLowerCase() === 'github.com') {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) return `${parts[0]}/${stripGitSuffix(parts[1])}`;
    }
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return stripGitSuffix(url.toString());
    }
  } catch {}

  return null;
}

/**
 * Resolve a credential-free public reference through a bounded chain of local
 * clone origins. This covers isolated worktrees cloned from a local primary
 * repo without changing the local origin used for coding-session identity.
 */
export async function resolvePublicRepoRef(context, {
  getContext = getRepoContext,
  maxDepth = 4,
} = {}) {
  if (typeof getContext !== 'function'
    || !Number.isSafeInteger(maxDepth)
    || maxDepth < 1
    || maxDepth > 8) return null;
  let current = context;
  const visited = new Set();
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const direct = derivePublicRepoRef(current);
    if (direct) return direct;
    const localPath = localRemotePath(current);
    if (!localPath || visited.has(localPath)) return null;
    visited.add(localPath);
    current = await getContext(localPath).catch(() => null);
    if (!current) return null;
  }
  return null;
}

function stripGitSuffix(value) {
  return String(value || '').replace(/\.git$/i, '');
}

function localRemotePath(context) {
  const remote = typeof context?.remoteUrl === 'string'
    ? context.remoteUrl.trim()
    : '';
  if (!remote || remote === context?.toplevel) return null;
  if (isAbsolute(remote)) return resolve(remote);
  if (remote.startsWith('./') || remote.startsWith('../')) {
    return typeof context?.toplevel === 'string' && context.toplevel
      ? resolve(context.toplevel, remote)
      : null;
  }
  try {
    const url = new URL(remote);
    return url.protocol === 'file:' ? resolve(decodeURIComponent(url.pathname)) : null;
  } catch {
    return null;
  }
}

function runGit(args, cwd) {
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? stdout.trim() : null));
  });
}
