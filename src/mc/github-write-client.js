/**
 * Provider-neutral preparation for the two allowlisted GitHub PR writes.
 *
 * Authority stays outside this module: the session broker supplies user,
 * source, session, installation, and repository identity. Local git is read
 * only to provide exact branch/SHA preconditions for the typed request.
 */
import { spawn } from 'node:child_process';

import { makeGitHubRequestId } from './github-session.js';

const SHA_RE = /^[a-fA-F0-9]{40}$/;
const REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,254}$/;

export async function executeGitHubWriteCommand(parsed, deps = {}) {
  const execute = deps.executeGitHubOperation;
  if (typeof execute !== 'function') return localFailure('unavailable');
  const makeRequestId = deps.makeRequestId || makeGitHubRequestId;

  if (parsed.operation === 'pull_request.create') {
    let base = parsed.params.base || null;
    if (!base) {
      const metadata = await execute({
        operation: 'repository.metadata',
        params: {},
        requestId: makeRequestId(),
      });
      if (!metadata?.ok) return metadata || localFailure('unavailable');
      base = gitRef(metadata.data?.default_branch);
      if (!base) return localFailure('unavailable');
    }

    const resolveContext = deps.resolveGitHubCreateContext || resolveGitHubCreateContext;
    const context = await resolveContext({
      base,
      cwd: deps.cwd || process.cwd(),
      runGit: deps.runGit,
    }).catch(() => null);
    if (!context) return localFailure('stale_head');
    return executeWriteWithRetry(execute, {
      operation: parsed.operation,
      params: {
        title: parsed.params.title.trim(),
        body: parsed.params.body,
        head: context.head,
        base: context.base,
        draft: parsed.params.draft,
        expected_head_sha: context.expected_head_sha,
        expected_base_sha: context.expected_base_sha,
      },
      requestId: makeRequestId(),
    });
  }

  if (parsed.operation === 'pull_request.update') {
    const current = await execute({
      operation: 'pull_request.view',
      params: { pull_number: parsed.params.pull_number },
      requestId: makeRequestId(),
    });
    if (!current?.ok) return current || localFailure('unavailable');
    const expectedHead = sha(current.data?.head?.sha);
    const expectedUpdatedAt = iso(current.data?.updated_at);
    if (!expectedHead || !expectedUpdatedAt) return localFailure('stale_state');
    return executeWriteWithRetry(execute, {
      operation: parsed.operation,
      params: {
        pull_number: parsed.params.pull_number,
        ...(Object.hasOwn(parsed.params, 'title') ? { title: parsed.params.title.trim() } : {}),
        ...(Object.hasOwn(parsed.params, 'body') ? { body: parsed.params.body } : {}),
        expected_head_sha: expectedHead,
        expected_updated_at: expectedUpdatedAt,
      },
      requestId: makeRequestId(),
    });
  }

  return localFailure('operation_not_allowed');
}

export async function resolveGitHubCreateContext({
  base,
  cwd = process.cwd(),
  runGit = runGitCommand,
} = {}) {
  const normalizedBase = gitRef(base);
  if (!normalizedBase) return null;
  const head = gitRef(await runGit(['symbolic-ref', '--short', 'HEAD'], cwd));
  const expectedHead = sha(await runGit(['rev-parse', 'HEAD'], cwd));
  if (!head || !expectedHead) return null;

  let expectedBase = sha(await runGit(
    ['rev-parse', '--verify', `refs/remotes/origin/${normalizedBase}`],
    cwd,
  ));
  if (!expectedBase) {
    expectedBase = sha(await runGit(
      ['rev-parse', '--verify', `refs/heads/${normalizedBase}`],
      cwd,
    ));
  }
  if (!expectedBase) return null;
  return {
    head,
    base: normalizedBase,
    expected_head_sha: expectedHead,
    expected_base_sha: expectedBase,
  };
}

async function executeWriteWithRetry(execute, exactRequest) {
  const first = await execute(exactRequest);
  if (first?.ok || first?.error?.code !== 'unavailable') return first;
  return execute(exactRequest);
}

function runGitCommand(args, cwd) {
  return new Promise((resolve) => {
    let stdout = '';
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? stdout.trim() : null));
  });
}

function localFailure(code) {
  const messages = {
    operation_not_allowed: 'GitHub operation is not allowed.',
    stale_head: 'Local Git branch state is unavailable or stale.',
    stale_state: 'The pull request state is unavailable or stale.',
    unavailable: 'GitHub is temporarily unavailable through Memoro.',
  };
  return {
    ok: false,
    request_id: makeGitHubRequestId(),
    error: {
      code,
      message: messages[code] || messages.unavailable,
      repair_action: code === 'operation_not_allowed' ? null : 'retry',
    },
  };
}

function gitRef(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && REF_RE.test(normalized)
    && !normalized.includes('..')
    && !normalized.endsWith('.lock')
    ? normalized
    : null;
}

function sha(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return SHA_RE.test(normalized) ? normalized : null;
}

function iso(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
