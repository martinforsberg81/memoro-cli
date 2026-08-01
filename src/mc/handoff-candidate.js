import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

import { derivePublicRepoRef, deriveRepoName, getRepoContext } from '../lib/git-context.js';
import {
  canonicalizeRemoteUrl,
  repositoryIdForCanonicalRemote,
} from './repository-identity.js';
import { fetchMcContextData } from './context.js';
import { buildHandoff } from './handoff.js';

const LEGACY_OBJECTIVE = 'Continue the existing mc coding session.';
const MAX_CHANGED_PATHS = 64;
const MAX_STATE_BYTES = 2048;
const MAX_CONTINUITY_ITEMS = 6;

export async function buildDeterministicHandoff({
  entry,
  source,
  sequence,
  parentDigest,
  cwd = entry?.worktree_path,
  repoContext = null,
  auth = null,
  deps = {},
} = {}) {
  const context = repoContext || await (deps.getRepoContext || getRepoContext)(cwd);
  if (!context) return failure('handoff-workspace-unavailable');
  const git = deps.git || runGit;
  const [head, status, latestSubject, aheadRaw] = await Promise.all([
    git(['rev-parse', 'HEAD'], context.toplevel),
    git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], context.toplevel),
    git(['log', '-1', '--format=%s'], context.toplevel),
    git(['rev-list', '--count', '@{upstream}..HEAD'], context.toplevel),
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
  // The switch path launches the target WITHOUT normal grounding, so this
  // content is the only continuity the new provider receives. Ground it in
  // observable facts (git) plus the distilled prior work Memoro already
  // holds for this coding session — never in an unbacked stock phrase.
  const continuity = await fetchDistilledContinuity({ entry, context, source, auth, deps });
  const state = composeGroundedState({
    branch,
    shortRef: head.slice(0, 12).toLowerCase(),
    changedCount: parsed.paths.length,
    truncated: parsed.paths.length > MAX_CHANGED_PATHS,
    latestSubject: sanitizeLine(latestSubject),
    aheadCount: parseCount(aheadRaw),
    continuity,
  });
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

/**
 * Best-effort fetch of the distilled prior-work briefs Memoro holds for
 * this coding session (`session_continuity` on /api/mc/context). The
 * result flows into scanned handoff content, so it stays inside the
 * certified pipeline; any failure degrades to git facts alone and never
 * blocks the switch.
 */
async function fetchDistilledContinuity({ entry, context, source, auth, deps = {} } = {}) {
  if (!auth?.token || !auth?.apiUrl) return [];
  try {
    const mcContext = await (deps.fetchMcContextData || fetchMcContextData)({
      repoContext: context,
      codingSessionId: entry?.coding_session_id,
      sessionName: entry?.name,
      tool: source?.tool || null,
      deps: {
        token: auth.token,
        apiUrl: auth.apiUrl,
        ...(deps.memoroFetch ? { memoroFetch: deps.memoroFetch } : {}),
      },
    });
    const items = Array.isArray(mcContext?.session_continuity)
      ? mcContext.session_continuity
      : [];
    return items
      .map((item) => {
        const brief = sanitizeLine(item?.brief);
        if (!brief) return null;
        const meta = [sanitizeLine(item?.source), sanitizeLine(item?.ended_at) && `ended ${sanitizeLine(item.ended_at)}`]
          .filter(Boolean);
        return meta.length ? `${brief} (${meta.join(', ')})` : brief;
      })
      .filter(Boolean)
      .slice(0, MAX_CONTINUITY_ITEMS);
  } catch {
    return [];
  }
}

function composeGroundedState({
  branch,
  shortRef,
  changedCount,
  truncated,
  latestSubject,
  aheadCount,
  continuity = [],
} = {}) {
  const workspace = changedCount === 0
    ? 'clean working tree'
    : truncated
      ? `more than ${MAX_CHANGED_PATHS} changed paths (bounded list truncated)`
      : `${changedCount} changed path${changedCount === 1 ? '' : 's'}`;
  let line = `Workspace on branch ${branch} at ${shortRef}: ${workspace}`;
  if (Number.isInteger(aheadCount) && aheadCount > 0) {
    line += `; ${aheadCount} commit${aheadCount === 1 ? '' : 's'} ahead of upstream`;
  }
  if (latestSubject) line += `; latest commit: "${latestSubject}"`;
  line += '.';
  // The handoff wire contract requires single-line text fields.
  const parts = [line];
  if (continuity.length) {
    parts.push(`Distilled prior work on this coding session (from Memoro): ${continuity.join(' | ')}`);
  }
  return truncateUtf8(parts.join(' '), MAX_STATE_BYTES);
}

function sanitizeLine(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\0-\x1f\x7f]+/g, ' ').trim();
  if (!cleaned) return null;
  return Buffer.byteLength(cleaned) > 256 ? truncateUtf8(cleaned, 256) : cleaned;
}

function parseCount(value) {
  const count = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(count) && count >= 0 ? count : null;
}

function truncateUtf8(value, maxBytes) {
  let text = String(value);
  if (Buffer.byteLength(text) <= maxBytes) return text;
  // Leave room for the 3-byte ellipsis so the result stays within budget.
  while (Buffer.byteLength(text) > maxBytes - 3 && text.length > 0) {
    text = text.slice(0, -1);
  }
  return `${text.trimEnd()}…`;
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
