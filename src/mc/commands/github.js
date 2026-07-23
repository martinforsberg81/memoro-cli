/**
 * `mc github status|connect|repos|pr` — central Memoro GitHub App UX.
 *
 * Connection metadata uses the control plane directly. Repository operations
 * use the session-bound broker and never accept repository or authority input.
 */

import { getRepoContext, derivePublicRepoRef } from '../../lib/git-context.js';
import { openBrowser } from '../../lib/device-flow.js';
import { createConnectionClient } from '../connections/client.js';
import {
  decodeGitHubConnectResponse,
  decodeGitHubConnectionResponse,
  decodeGitHubRepositoriesResponse,
  githubOperationEffect,
  repairForGitHubState,
} from '../github-contract.js';
import { executeGitHubSessionOperation } from '../github-session.js';
import { executeGitHubWriteCommand } from '../github-write-client.js';
import {
  parseGitHubShimArgs,
  renderGitHubResult,
  safeOperationError,
} from '../github-shim.js';

const GITHUB_REPOSITORY_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

export async function run(argv, deps = {}) {
  const parsed = parseArgs(argv);
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  if (parsed.error) {
    stderr.write(`mc: ${parsed.error}\n`);
    return 2;
  }

  try {
    if (parsed.subcommand === 'connect') return await runConnect(parsed, deps, { stdout, stderr });
    if (parsed.subcommand === 'repos') return await runRepos(parsed, deps, { stdout, stderr });
    if (parsed.subcommand === 'operation') return await runOperation(parsed, deps, { stdout, stderr });
    return await runStatus(parsed, deps, { stdout, stderr });
  } catch {
    return emitSafeFailure(parsed, { stdout, stderr });
  }
}

export function parseArgs(argv) {
  const values = [...argv];
  if (values[0] === 'pr') {
    const operation = parseGitHubShimArgs(values, { allowUpdate: true });
    if (!operation.ok || operation.operation === 'connection.status') {
      return { error: 'unsupported GitHub command. Try `mc github pr list|view|checks|create|update`.' };
    }
    return { subcommand: 'operation', ...operation };
  }
  let subcommand = values[0] || 'status';
  if (subcommand.startsWith('-')) subcommand = 'status';
  else values.shift();
  if (!['status', 'connect', 'repos'].includes(subcommand)) {
    return { error: `unknown github subcommand "${subcommand}". Try \`mc github status\`.` };
  }
  let json = false;
  for (const value of values) {
    if (value === '--json') { json = true; continue; }
    return { error: `unknown flag: ${value}` };
  }
  return { subcommand, json };
}

async function runOperation(opts, deps, io) {
  const execute = deps.executeGitHubOperation || executeGitHubSessionOperation;
  const response = githubOperationEffect(opts.operation) === 'write'
    ? await executeGitHubWriteCommand(opts, { ...deps, executeGitHubOperation: execute })
    : await execute({ operation: opts.operation, params: opts.params });
  if (!response?.ok) {
    if (opts.json) io.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    else io.stderr.write(`${safeOperationError(response?.error?.code)} Run \`mc github status\` to repair.\n`);
    return 1;
  }
  renderGitHubResult(opts, response.data, io.stdout);
  return 0;
}

export async function readGitHubConnectionStatus(deps = {}) {
  const expectedRepository = await deriveCurrentGitHubRepository(deps);
  const response = await client(deps).call('github', 'legacyStatus', {
    repository: expectedRepository,
  });
  return decodeGitHubConnectionResponse(response, { expectedRepository });
}

async function runStatus(opts, deps, io) {
  const response = await readGitHubConnectionStatus(deps);
  if (opts.json) {
    io.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  } else {
    renderStatus(response.github, io.stdout);
  }
  return response.github.state === 'ready' ? 0 : 1;
}

async function runRepos(opts, deps, io) {
  const raw = await client(deps).call('github', 'repositories');
  const response = decodeGitHubRepositoriesResponse(raw);
  if (opts.json) {
    io.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  } else {
    renderRepositories(response, io.stdout);
  }
  return response.state === 'ready' ? 0 : 1;
}

async function runConnect(opts, deps, io) {
  const response = decodeGitHubConnectResponse(await client(deps).connect('github'));

  // JSON is always machine-only. Human non-TTY output is also side-effect
  // free. The explicit interactive `mc github connect` invocation is the one
  // place this slice may ask the OS to open the verified URL.
  if (opts.json) {
    io.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return 0;
  }
  const interactive = deps.isInteractive
    ?? Boolean((deps.stdin || process.stdin)?.isTTY && io.stdout?.isTTY);
  if (interactive) {
    const opened = await (deps.openBrowser || openBrowser)(response.connect_url);
    if (opened) {
      io.stdout.write('Opened the Memoro GitHub connection flow in your browser.\n');
      io.stdout.write('When it is complete, run `mc github status`.\n');
      return 0;
    }
  }
  io.stdout.write('Open this URL to connect GitHub through Memoro:\n');
  io.stdout.write(`${response.connect_url}\n`);
  io.stdout.write('When it is complete, run `mc github status`.\n');
  return 0;
}

export async function deriveCurrentGitHubRepository(deps = {}) {
  const context = await (deps.getRepoContext || getRepoContext)(deps.cwd || process.cwd());
  const ref = derivePublicRepoRef(context);
  return typeof ref === 'string' && GITHUB_REPOSITORY_RE.test(ref) ? ref : null;
}

function renderStatus(github, stdout) {
  stdout.write('Memoro GitHub App:\n');
  if (github.state === 'ready') {
    if (github.repository) stdout.write(`  ✓ ready for ${github.repository.full_name}\n`);
    else stdout.write('  ✓ connected\n');
    stdout.write(`  actor: ${github.actor.login}\n`);
    if (github.operations.length) stdout.write(`  operations: ${github.operations.join(', ')}\n`);
    return;
  }
  stdout.write(`  ✗ ${humanState(github.state)}\n`);
  const repair = repairForGitHubState(github.state);
  if (repair) stdout.write(`  → ${repair.message} Run \`${repair.command}\`.\n`);
}

function renderRepositories(response, stdout) {
  stdout.write('Repositories available through the Memoro GitHub App:\n');
  if (response.repositories.length === 0) stdout.write('  none\n');
  for (const repository of response.repositories) {
    const flags = [repository.private ? 'private' : 'public'];
    if (repository.archived) flags.push('archived');
    stdout.write(`  ${repository.full_name} · ${flags.join(' · ')}\n`);
  }
  if (response.state !== 'ready') {
    const repair = repairForGitHubState(response.state);
    if (repair) stdout.write(`  → ${repair.message} Run \`${repair.command}\`.\n`);
  }
}

function humanState(state) {
  return {
    disconnected: 'not connected',
    connecting: 'connection is incomplete',
    repo_not_installed: 'this repository is not selected',
    permission_missing: 'required permissions are missing',
    suspended: 'connection is suspended',
    revoked: 'connection was revoked',
    unavailable: 'readiness is temporarily unavailable',
  }[state] || 'not ready';
}

function client(deps) {
  return deps.connectionClient || createConnectionClient(deps);
}

function emitSafeFailure(opts, { stdout, stderr }) {
  const error = {
    code: 'unavailable',
    message: 'GitHub readiness could not be verified through Memoro.',
    repair_action: 'retry',
  };
  if (opts.json) {
    stdout.write(`${JSON.stringify({ ok: false, error }, null, 2)}\n`);
  } else {
    stderr.write(`mc github: ${error.message} Run \`mc github status\` to retry.\n`);
  }
  return 1;
}
