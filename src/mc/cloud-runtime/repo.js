import { spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

const GITHUB_SHORTHAND_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

export async function prepareCloudRuntimeRepo({
  manifest = {},
  root,
  env = process.env,
  spawn = spawnSync,
  mkdirImpl = mkdir,
  rmImpl = rm,
} = {}) {
  if (!root || typeof root !== 'string') return { ok: false, error: 'repo root missing' };
  const repoRef = safeRepoRef(manifest?.repo?.ref);
  const cloneUrl = repoCloneUrl(repoRef);
  const branch = stringOrNull(manifest?.repo?.workspace_ref);

  await rmImpl(root, { recursive: true, force: true });
  await mkdirImpl(dirname(root), { recursive: true });

  if (!cloneUrl) {
    await mkdirImpl(root, { recursive: true });
    const initialized = runGit(['init'], { cwd: root, env, spawn });
    if (!initialized.ok) return initialized;
    if (repoRef) runGit(['remote', 'add', 'origin', repoRef], { cwd: root, env, spawn });
    if (branch) runGit(['checkout', '-B', branch], { cwd: root, env, spawn });
    return { ok: true, cloned: false, initialized: true, root, repo_ref: repoRef || null, branch: branch || null };
  }

  const cloneArgs = ['clone', '--depth', '1'];
  if (branch) cloneArgs.push('--branch', branch);
  cloneArgs.push(cloneUrl, root);
  const cloned = runGitWithCredential(cloneArgs, { env, spawn });
  if (cloned.ok) {
    return { ok: true, cloned: true, initialized: false, root, repo_ref: cloneUrl, branch: branch || null };
  }

  await rmImpl(root, { recursive: true, force: true });
  await mkdirImpl(root, { recursive: true });
  const initialized = runGit(['init'], { cwd: root, env, spawn });
  if (!initialized.ok) return { ...initialized, clone_error: cloned.error };
  runGit(['remote', 'add', 'origin', cloneUrl], { cwd: root, env, spawn });
  if (branch) runGit(['checkout', '-B', branch], { cwd: root, env, spawn });
  return {
    ok: true,
    cloned: false,
    initialized: true,
    fallback: true,
    root,
    repo_ref: cloneUrl,
    branch: branch || null,
    clone_error: cloned.error,
  };
}

export function repoCloneUrl(repoRef) {
  const ref = stringOrNull(repoRef);
  if (!ref) return null;
  if (GITHUB_SHORTHAND_RE.test(ref)) return `https://github.com/${ref}.git`;
  if (!/^https?:\/\//i.test(ref)) return null;
  try {
    const url = new URL(ref);
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function runGit(args, { cwd = null, env = process.env, spawn = spawnSync } = {}) {
  const res = spawn('git', args, {
    cwd: cwd || undefined,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.status !== 0) {
    return {
      ok: false,
      error: sanitizeGitError(res.stderr || res.stdout || `git exited ${res.status}`),
      exit_code: res.status,
    };
  }
  return { ok: true };
}

function runGitWithCredential(args, { env = process.env, spawn = spawnSync } = {}) {
  const token = stringOrNull(env.MC_CLOUD_GIT_TOKEN);
  const fullArgs = token
    ? ['-c', 'credential.helper=!f() { test "$1" = get || exit 0; echo username=x-access-token; echo password=$MC_CLOUD_GIT_TOKEN; }; f', ...args]
    : args;
  return runGit(fullArgs, { env, spawn });
}

function safeRepoRef(value) {
  const ref = stringOrNull(value);
  if (!ref || !/^https?:\/\//i.test(ref)) return ref;
  try {
    const url = new URL(ref);
    if (url.username || url.password) return null;
    return ref;
  } catch {
    return null;
  }
}

function sanitizeGitError(value) {
  return String(value || '')
    .replace(/\bgh[pousr]_[a-zA-Z0-9_]{8,}\b/g, '[redacted]')
    .replace(/\bmem_[a-zA-Z0-9._:-]{8,}\b/g, '[redacted]')
    .replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/g, '[redacted]')
    .slice(0, 500)
    .trim();
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
