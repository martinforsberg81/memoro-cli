#!/usr/bin/env node
/** Strict, session-scoped compatibility surface for allowlisted GitHub operations. */
import { fileURLToPath } from 'node:url';

import { executeGitHubSessionOperation } from './github-session.js';
import { githubOperationEffect } from './github-contract.js';
import { executeGitHubWriteCommand } from './github-write-client.js';

export async function runGitHubShim(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const parsed = parseGitHubShimArgs(argv, {
    allowUpdate: deps.allowUpdate === true,
  });
  if (!parsed.ok) {
    stderr.write('mc github: this gh command is not available in a managed session. Use `mc github` instead.\n');
    return 2;
  }
  const execute = deps.executeGitHubOperation || executeGitHubSessionOperation;
  const response = githubOperationEffect(parsed.operation) === 'write'
    ? await executeGitHubWriteCommand(parsed, { ...deps, executeGitHubOperation: execute })
    : await execute({ operation: parsed.operation, params: parsed.params });
  if (!response?.ok) {
    // The wire error message survived the strict response decode (bounded,
    // stable contract) — surface it. Collapsing every failure into the
    // generic per-code text made real causes ("GitHub authentication could
    // not be prepared.") undiagnosable in the field.
    const mapped = safeOperationError(response?.error?.code);
    const message = typeof response?.error?.message === 'string'
      ? response.error.message.trim()
      : '';
    const detail = message && !mapped.includes(message) ? ` (${message})` : '';
    stderr.write(`${mapped}${detail} Run \`mc github status\` to repair.\n`);
    return 1;
  }
  renderGitHubResult(parsed, response.data, stdout);
  return 0;
}

export function parseGitHubShimArgs(argv = [], { allowUpdate = false } = {}) {
  const values = [...argv];
  if (values[0] === 'auth' && values[1] === 'status') {
    const rest = values.slice(2);
    if (rest.length === 0) return operation('connection.status', {});
    if (rest.length === 2 && rest[0] === '--hostname' && rest[1] === 'github.com') {
      return operation('connection.status', {});
    }
    return denied();
  }
  if (values[0] !== 'pr') return denied();
  if (values[1] === 'list') return parseList(values.slice(2));
  if (values[1] === 'view') return parseNumberCommand('pull_request.view', values.slice(2));
  if (values[1] === 'checks') return parseNumberCommand('checks.list', values.slice(2));
  if (values[1] === 'create') return parseCreate(values.slice(2));
  if (allowUpdate && values[1] === 'update') return parseUpdate(values.slice(2));
  return denied();
}

export function renderGitHubResult(parsed, data, stdout) {
  if (parsed.json) {
    stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  if (parsed.operation === 'connection.status') {
    const repository = data?.repository?.full_name || 'the bound repository';
    stdout.write('github.com\n');
    stdout.write(`  ✓ Connected to ${repository} through the Memoro GitHub App\n`);
    stdout.write(`  - Acting as ${data?.actor?.login || 'the installation bot'}\n`);
    return;
  }
  if (parsed.operation === 'pull_request.list') {
    const pulls = Array.isArray(data?.pull_requests) ? data.pull_requests : [];
    for (const pull of pulls) {
      stdout.write(`${pull.number}\t${pull.title || ''}\t${pull.state || ''}\t${pull.url || ''}\n`);
    }
    return;
  }
  if (parsed.operation === 'pull_request.view') {
    stdout.write(`#${data?.number || ''} ${data?.title || ''}\n`);
    if (data?.state) stdout.write(`state: ${data.state}${data.draft ? ' · draft' : ''}\n`);
    if (data?.url) stdout.write(`${data.url}\n`);
    if (data?.body) stdout.write(`\n${data.body}\n`);
    return;
  }
  if (parsed.operation === 'checks.list') {
    for (const check of Array.isArray(data?.checks) ? data.checks : []) {
      stdout.write(`${check.name || ''}\t${check.conclusion || check.status || ''}\n`);
    }
    for (const status of Array.isArray(data?.statuses) ? data.statuses : []) {
      stdout.write(`${status.context || ''}\t${status.state || ''}\n`);
    }
    return;
  }
  if (parsed.operation === 'pull_request.create') {
    if (data?.url) stdout.write(`${data.url}\n`);
    else stdout.write(`Created pull request #${data?.number || ''}.\n`);
    return;
  }
  if (parsed.operation === 'pull_request.update') {
    stdout.write(`Updated pull request #${data?.number || ''}${data?.title ? `: ${data.title}` : ''}\n`);
    if (data?.url) stdout.write(`${data.url}\n`);
  }
}

export const renderGitHubReadResult = renderGitHubResult;

function parseList(values) {
  const params = {};
  let json = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--json') { json = true; continue; }
    if (value === '--state' && values[index + 1]) { params.state = values[++index]; continue; }
    if (value === '--author' && values[index + 1]) { params.author = values[++index]; continue; }
    if (value === '--limit' && values[index + 1] && /^[0-9]+$/.test(values[index + 1])) {
      params.limit = Number(values[++index]);
      continue;
    }
    return denied();
  }
  return operation('pull_request.list', params, json);
}

function parseNumberCommand(name, values) {
  if (!/^[1-9][0-9]*$/.test(values[0] || '')) return denied();
  if (values.length > 2 || (values.length === 2 && values[1] !== '--json')) return denied();
  return operation(name, { pull_number: Number(values[0]) }, values[1] === '--json');
}

function parseCreate(values) {
  const params = { draft: false };
  let json = false;
  let hasTitle = false;
  let hasBody = false;
  let hasBase = false;
  let hasDraft = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--json') { json = true; continue; }
    if (value === '--draft' && !hasDraft) {
      params.draft = true;
      hasDraft = true;
      continue;
    }
    if (value === '--title' && !hasTitle && values[index + 1] !== undefined) {
      params.title = values[++index];
      hasTitle = true;
      continue;
    }
    if (value === '--body' && !hasBody && values[index + 1] !== undefined) {
      params.body = values[++index];
      hasBody = true;
      continue;
    }
    if (value === '--base' && !hasBase && values[index + 1] !== undefined) {
      params.base = values[++index];
      hasBase = true;
      continue;
    }
    return denied();
  }
  if (!hasTitle || !hasBody || !validTitle(params.title) || !validBody(params.body)
      || (hasBase && !validGitRef(params.base))) return denied();
  return operation('pull_request.create', params, json);
}

function parseUpdate(values) {
  if (!/^[1-9][0-9]*$/.test(values[0] || '')) return denied();
  const params = { pull_number: Number(values[0]) };
  let json = false;
  let mutations = 0;
  let hasTitle = false;
  let hasBody = false;
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--json') { json = true; continue; }
    if (value === '--title' && !hasTitle && values[index + 1] !== undefined) {
      params.title = values[++index];
      hasTitle = true;
      mutations += 1;
      continue;
    }
    if (value === '--body' && !hasBody && values[index + 1] !== undefined) {
      params.body = values[++index];
      hasBody = true;
      mutations += 1;
      continue;
    }
    return denied();
  }
  if (mutations === 0 || (hasTitle && !validTitle(params.title))
      || (hasBody && !validBody(params.body))) return denied();
  return operation('pull_request.update', params, json);
}

function validTitle(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 512;
}

function validBody(value) {
  return typeof value === 'string' && value.length <= 16_000;
}

function validGitRef(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,254}$/.test(normalized)
    && !normalized.includes('..')
    && !normalized.endsWith('.lock');
}

function operation(name, params, json = false) {
  return {
    ok: true,
    operation: name,
    effect: githubOperationEffect(name),
    params,
    json,
  };
}

function denied() {
  return { ok: false };
}

export function safeOperationError(code) {
  return {
    not_connected: 'mc github: GitHub is not connected through Memoro.',
    repo_not_installed: 'mc github: this repository is not selected.',
    permission_missing: 'mc github: required App permissions are missing.',
    operation_not_allowed: 'mc github: this operation is disabled.',
    invalid_params: 'mc github: the request is invalid.',
    rate_limited: 'mc github: GitHub is temporarily rate limited.',
    conflict: 'mc github: GitHub rejected the current resource state.',
    stale_head: 'mc github: the Git branch state changed before execution.',
    stale_state: 'mc github: the pull request state changed before execution.',
    not_found: 'mc github: the requested item was not found.',
    // Local-only code (the wire's STABLE_ERROR_SET rejects it): there is
    // no session GitHub broker in this environment, so retrying is futile.
    no_session_broker: 'mc github: GitHub commands are session-scoped — run this inside an mc session (`mc open <name>` or `mc new <name>`).',
  }[code] || 'mc github: GitHub is temporarily unavailable through Memoro.';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const managedMcMode = process.argv[2] === '--mc-session-shim';
  process.exitCode = await runGitHubShim(
    process.argv.slice(managedMcMode ? 3 : 2),
    { allowUpdate: managedMcMode },
  );
}
