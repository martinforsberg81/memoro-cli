import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

import { derivePublicRepoRef, deriveRepoName, getRepoContext } from '../lib/git-context.js';
import {
  canonicalizeRemoteUrl,
  repositoryIdForCanonicalRemote,
} from './repository-identity.js';
import { buildHandoff } from './handoff.js';

const LEGACY_OBJECTIVE = 'Continue the existing mc coding session.';
const MAX_CHANGED_PATHS = 64;

export async function buildDeterministicHandoff({
  entry,
  source,
  sequence,
  parentDigest,
  cwd = entry?.worktree_path,
  repoContext = null,
  deps = {},
} = {}) {
  const context = repoContext || await (deps.getRepoContext || getRepoContext)(cwd);
  if (!context) return failure('handoff-workspace-unavailable');
  const git = deps.git || runGit;
  const [head, status] = await Promise.all([
    git(['rev-parse', 'HEAD'], context.toplevel),
    git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], context.toplevel),
  ]);
  if (!/^[a-f0-9]{40,64}$/i.test(head || '') || typeof status !== 'string') {
    return failure('handoff-workspace-unavailable');
  }
  const parsed = parseChangedPaths(status);
  if (!parsed.ok) return parsed;
  const publicRepo = derivePublicRepoRef(context);
  const repoName = deriveRepoName(context);
  const publicRepoSlug = typeof publicRepo === 'string'
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(publicRepo)
    ? publicRepo
    : null;
  const canonicalRemote = canonicalizeRemoteUrl(context.remoteUrl);
  const repoId = validRepositoryId(entry?.repository_id)
    ? entry.repository_id
    : canonicalRemote
      ? repositoryIdForCanonicalRemote(canonicalRemote)
      : `repo_${sha256(`mc-legacy-repo:${publicRepoSlug || repoName}`).slice(0, 24)}`;
  const branch = safeBranch(context.branch);
  if (!branch) return failure('handoff-workspace-invalid');
  const changedPaths = parsed.paths.slice(0, MAX_CHANGED_PATHS);
  const workspaceProjection = {
    repo_id: repoId,
    ref: head.toLowerCase(),
    branch,
    changed_paths: changedPaths,
    changed_paths_truncated: parsed.paths.length > MAX_CHANGED_PATHS,
  };
  const workspaceDigest = sha256(canonicalJson(workspaceProjection));
  const objective = explicitObjective(entry) || LEGACY_OBJECTIVE;
  const state = parsed.paths.length === 0
    ? 'The source provider ended with a clean workspace.'
    : parsed.paths.length > MAX_CHANGED_PATHS
      ? `The source provider ended with more than ${MAX_CHANGED_PATHS} changed workspace paths; the bounded path list is truncated.`
      : `The source provider ended with ${parsed.paths.length} changed workspace path${parsed.paths.length === 1 ? '' : 's'}.`;
  return buildHandoff({
    codingSessionId: entry?.coding_session_id,
    sequence,
    parentDigest,
    source,
    workspace: {
      anchor: { repoId, ref: head.toLowerCase(), branch },
      digest: workspaceDigest,
    },
    content: {
      goal: objective,
      state,
      ...(changedPaths.length ? { changedPaths } : {}),
    },
  });
}

export function parseChangedPaths(raw) {
  if (typeof raw !== 'string') return failure('handoff-git-status-invalid');
  if (!raw) return { ok: true, paths: [] };
  const records = raw.split('\0');
  if (records.at(-1) === '') records.pop();
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4 || record[2] !== ' ') {
      return failure('handoff-git-status-invalid');
    }
    const status = record.slice(0, 2);
    paths.push(record.slice(3));
    if (/[RC]/.test(status)) {
      index += 1;
      if (!records[index]) return failure('handoff-git-status-invalid');
      paths.push(records[index]);
    }
  }
  return { ok: true, paths: [...new Set(paths)].sort() };
}

function explicitObjective(entry) {
  const value = entry?.session_objective;
  return value?.authority === 'explicit' && typeof value.text === 'string'
    && value.text.trim() === value.text && value.text
    ? value.text
    : null;
}

function safeBranch(value) {
  return typeof value === 'string' && value.trim() === value && value
    && Buffer.byteLength(value) <= 256 && !/[\0-\x1f\x7f]/.test(value)
    ? value
    : null;
}

function validRepositoryId(value) {
  return typeof value === 'string' && /^repo_[a-f0-9]{24}$/u.test(value);
}

function runGit(args, cwd) {
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? stdout.replace(/\n$/, '') : null));
  });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function failure(code) {
  return { ok: false, code };
}
