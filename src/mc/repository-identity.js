import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { primaryWorktree, tryGit } from './git.js';

export const REPOSITORY_ID_RE = /^repo_[a-f0-9]{24}$/u;
export const REPOSITORY_IDENTITY_SCHEMA = 1;

/**
 * Resolve the durable identity for the repository containing `cwd`.
 *
 * Public remotes deliberately produce the same opaque id across clones and
 * devices. Local-only repositories receive a random id in local Git config,
 * which survives directory/worktree relocation without entering commits.
 */
export function resolveRepositoryIdentity(cwd, {
  createLocal = false,
  random = randomBytes,
  git = tryGit,
} = {}) {
  const root = repositoryRoot(cwd, git);
  if (!root) return failure('not-a-git-repository');

  const remote = canonicalRemoteForRepository(root, { git });
  if (remote) {
    return success({
      id: repositoryIdForCanonicalRemote(remote),
      kind: 'remote',
      canonical: remote,
      root,
      source: 'canonical-remote',
    });
  }

  const configured = nonEmpty(git(root, ['config', '--local', '--get', 'mc.repositoryId']));
  if (configured) {
    if (!REPOSITORY_ID_RE.test(configured)) return failure('local-repository-id-invalid', { root });
    return success({
      id: configured,
      kind: 'local',
      canonical: null,
      root,
      source: 'git-config',
    });
  }
  if (!createLocal) return failure('local-repository-id-missing', { root });

  const id = `repo_${random(12).toString('hex')}`;
  try {
    const written = git(root, ['config', '--local', 'mc.repositoryId', id]);
    if (written === null) return failure('local-repository-id-write-failed', { root });
  } catch {
    return failure('local-repository-id-write-failed', { root });
  }
  const verified = nonEmpty(git(root, ['config', '--local', '--get', 'mc.repositoryId']));
  if (verified !== id) return failure('local-repository-id-write-unconfirmed', { root });
  return success({
    id,
    kind: 'local',
    canonical: null,
    root,
    source: 'git-config-created',
  });
}

export function repositoryIdentityProjection(identity) {
  if (!identity?.ok || !REPOSITORY_ID_RE.test(identity.id || '')) return null;
  if (identity.kind === 'remote' && !validCanonicalRemote(identity.canonical)) return null;
  if (identity.kind !== 'remote' && identity.kind !== 'local') return null;
  return {
    schema: REPOSITORY_IDENTITY_SCHEMA,
    kind: identity.kind,
    canonical: identity.kind === 'remote' ? identity.canonical : null,
  };
}

export function repositoryIdForCanonicalRemote(canonical) {
  if (!validCanonicalRemote(canonical)) {
    throw new Error('repositoryIdForCanonicalRemote: canonical remote required');
  }
  const digest = createHash('sha256')
    .update(`mc-repository-v1\0${canonical}`)
    .digest('hex');
  return `repo_${digest.slice(0, 24)}`;
}

/**
 * Return a credential-free canonical remote string, or null for local paths
 * and unsupported URL shapes. Equivalent GitHub SSH/HTTPS spellings collapse
 * to the same case-insensitive host/owner/repository identity.
 */
export function canonicalizeRemoteUrl(value) {
  const raw = nonEmpty(value);
  if (!raw || localRemotePath(raw)) return null;

  const scp = !raw.includes('://')
    ? raw.match(/^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/u)
    : null;
  if (scp && !looksLikeWindowsDrive(raw)) {
    return canonicalNetworkRemote({ host: scp[1], port: '', pathname: scp[2] });
  }

  try {
    const url = new URL(raw);
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) return null;
    return canonicalNetworkRemote({
      host: url.hostname,
      port: url.port,
      pathname: url.pathname,
    });
  } catch {
    return null;
  }
}

export function canonicalRemoteForRepository(repoDir, { git = tryGit } = {}) {
  const remotes = lines(git(repoDir, ['remote']));
  if (remotes.length === 0) return null;
  const urls = new Map(remotes.map((name) => [
    name,
    canonicalizeRemoteUrl(git(repoDir, ['remote', 'get-url', name])),
  ]));

  const configured = nonEmpty(git(repoDir, ['config', '--local', '--get', 'mc.repositoryRemote']));
  if (configured && urls.get(configured)) return urls.get(configured);

  const pushDefault = nonEmpty(git(repoDir, ['config', '--get', 'remote.pushDefault']));
  if (pushDefault && urls.get(pushDefault)) return urls.get(pushDefault);

  if (urls.get('origin')) return urls.get('origin');

  const unique = [...new Set([...urls.values()].filter(Boolean))];
  return unique.length === 1 ? unique[0] : null;
}

function repositoryRoot(cwd, git) {
  const candidate = nonEmpty(cwd);
  if (!candidate) return null;
  const primary = primaryWorktree(candidate);
  if (primary) return safeRealpath(primary);
  const toplevel = nonEmpty(git(candidate, ['rev-parse', '--show-toplevel']));
  return toplevel ? safeRealpath(toplevel) : null;
}

function canonicalNetworkRemote({ host, port, pathname }) {
  const hostname = String(host || '').toLowerCase();
  let path = String(pathname || '')
    .replace(/^\/+|\/+$/gu, '')
    .replace(/\.git$/iu, '');
  if (!hostname || !path || /[\0-\x1f\x7f]/u.test(path)) return null;
  if (hostname === 'github.com') {
    const parts = path.split('/').filter(Boolean);
    if (parts.length !== 2) return null;
    return `github.com/${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
  }
  path = path.split('/').map(encodePathSegment).join('/');
  const authority = port ? `${hostname}:${port}` : hostname;
  return `${authority}/${path}`;
}

function encodePathSegment(segment) {
  try { return encodeURIComponent(decodeURIComponent(segment)); } catch { return encodeURIComponent(segment); }
}

function localRemotePath(value) {
  if (isAbsolute(value) || value.startsWith('./') || value.startsWith('../')) return true;
  try { return new URL(value).protocol === 'file:'; } catch { return false; }
}

function looksLikeWindowsDrive(value) {
  return /^[A-Za-z]:[\\/]/u.test(value);
}

function validCanonicalRemote(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048
    && !/[\0-\x1f\x7f]/u.test(value) && !/@/u.test(value);
}

function lines(value) {
  return typeof value === 'string'
    ? value.split('\n').map((item) => item.trim()).filter(Boolean)
    : [];
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeRealpath(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function success(value) {
  return { ok: true, ...value };
}

function failure(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}
