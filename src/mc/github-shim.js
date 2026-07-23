#!/usr/bin/env node
/** Strict, session-scoped compatibility surface for allowlisted gh reads. */
import { fileURLToPath } from 'node:url';

import { executeGitHubSessionOperation } from './github-session.js';

export async function runGitHubShim(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const parsed = parseGitHubShimArgs(argv);
  if (!parsed.ok) {
    stderr.write('mc github: this gh command is not available in a managed session. Use `mc github` instead.\n');
    return 2;
  }
  const execute = deps.executeGitHubOperation || executeGitHubSessionOperation;
  const response = await execute({ operation: parsed.operation, params: parsed.params });
  if (!response?.ok) {
    stderr.write(`${safeOperationError(response?.error?.code)} Run \`mc github status\` to repair.\n`);
    return 1;
  }
  renderGitHubReadResult(parsed, response.data, stdout);
  return 0;
}

export function parseGitHubShimArgs(argv = []) {
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
  return denied();
}

export function renderGitHubReadResult(parsed, data, stdout) {
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
  }
}

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

function operation(name, params, json = false) {
  return { ok: true, operation: name, params, json };
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
    not_found: 'mc github: the requested item was not found.',
  }[code] || 'mc github: GitHub is temporarily unavailable through Memoro.';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runGitHubShim(process.argv.slice(2));
}
