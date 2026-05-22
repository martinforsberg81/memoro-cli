/**
 * Lightweight git-context detection. The coordinator only tracks coding
 * sessions that are inside a git repository — code outside any repo is out
 * of scope.
 *
 * Pure shell-outs, no native deps. Returns null when not in a repo so
 * callers can early-out without throwing.
 */

import { spawn } from 'node:child_process';

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
