/**
 * Session-scoped GitHub capability plumbing.
 *
 * The coding-tool child receives a token-free descriptor, a Unix socket path,
 * and an allowlisted `gh` shim. The Memoro credential stays in the broker
 * sidecar and is used only by executeGitHubControlPlaneOperation.
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { memoroFetch } from '../../lib/api.js';
import { requestBroker } from '../../runtime/broker/client.js';
import { sessionHostPaths } from '../../runtime/broker/paths.js';
import {
  GITHUB_SESSION_SCHEMA,
  GITHUB_SESSION_TRANSPORT,
  buildSessionCapabilities,
  decodeGitHubConnectionResponse,
  decodeGitHubOperationRequest,
  decodeGitHubOperationResponse,
  decodeSessionCapabilities,
  encodeGitHubOperationRequest,
  githubOperationEffect,
} from './github-contract.js';
import { mcHome } from '../../mc/paths.js';

export const MC_SESSION_CAPABILITIES_ENV = 'MC_SESSION_CAPABILITIES';
export const MC_GITHUB_BROKER_SOCKET_ENV = 'MC_GITHUB_BROKER_SOCKET';
export const GITHUB_CREDENTIAL_ENV_NAMES = Object.freeze([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
]);

const SHIM_MODULE = fileURLToPath(new URL('./github-shim.js', import.meta.url));
const GITHUB_BROKER_TIMEOUT_MS = 30_000;

export async function fetchGitHubSessionCapabilities({
  connectionClient,
  repository = null,
  memoroFetchImpl = memoroFetch,
} = {}) {
  const result = await fetchGitHubSessionBootstrap({
    connectionClient, repository, memoroFetchImpl,
  });
  return result.capabilities;
}

export async function fetchGitHubSessionBootstrap({
  connectionClient,
  repository = null,
  memoroFetchImpl = memoroFetch,
} = {}) {
  if (!connectionClient?.withGrant) throw new TypeError('connectionClient is required');
  const expectedRepository = normalizeRepository(repository);
  const path = expectedRepository
    ? `/api/mc/github/status?repository=${encodeURIComponent(expectedRepository)}`
    : '/api/mc/github/status';
  return connectionClient.withGrant(
    'github',
    { purpose: 'connection' },
    async ({ token, apiUrl, source }) => {
      const raw = await memoroFetchImpl(apiUrl, path, { token });
      const connection = decodeGitHubConnectionResponse(raw, { expectedRepository });
      return {
        capabilities: buildSessionCapabilities(connection.github),
        source: source || null,
      };
    },
  );
}

export function unavailableGitHubSessionCapabilities() {
  return {
    schema: GITHUB_SESSION_SCHEMA,
    github: {
      state: 'unavailable',
      transport: GITHUB_SESSION_TRANSPORT,
      actor: 'installation',
      account: null,
      repository: null,
      operations: [],
    },
  };
}

export function renderGitHubSessionMarkdown(capabilities) {
  let descriptor;
  try {
    descriptor = decodeSessionCapabilities(capabilities);
  } catch {
    descriptor = unavailableGitHubSessionCapabilities();
  }
  if (descriptor.github.state === 'ready') {
    const operations = new Set(descriptor.github.operations);
    const readsOnly = descriptor.github.operations.every(
      (operation) => githubOperationEffect(operation) === 'read',
    );
    const prCommands = ['list', 'view', 'checks'];
    if (operations.has('pull_request.create')) prCommands.push('create');
    if (operations.has('pull_request.update')) prCommands.push('update');
    if (operations.has('pull_request.merge')) prCommands.push('merge');
    if (readsOnly) {
      return [
        `- GitHub reads for ${descriptor.github.repository.full_name} are brokered through the Memoro GitHub App.`,
        `- Prefer \`mc github pr ${prCommands.join('|')}\`; the session-scoped \`gh\` shim maps only matching advertised commands to the same App broker.`,
        '- Do not run GitHub login, token-export, arbitrary API, extensions, or unsupported write commands in this session.',
      ].join('\n');
    }
    return [
      `- GitHub operations for ${descriptor.github.repository.full_name} are brokered through the Memoro GitHub App.`,
      `- Prefer \`mc github pr ${prCommands.join('|')}\`; the session-scoped \`gh\` shim maps only matching advertised commands to the same App broker.`,
      '- Mutating command invocations use the coding host’s native approval policy; mc adds no second prompt.',
      '- Do not run GitHub login, token-export, arbitrary API, extensions, force, or unsupported write commands in this session.',
    ].join('\n');
  }
  return [
    '- GitHub is not currently ready through the Memoro GitHub App.',
    '- Run `mc github status` for the provider-independent repair action; use `mc github connect` only when it asks you to.',
    '- Do not attempt native GitHub login or credential workarounds in this session.',
  ].join('\n');
}

export async function prepareGitHubSessionForLaunch({
  baseEnv = process.env,
  capabilities = unavailableGitHubSessionCapabilities(),
  sessionId,
  socketPath,
  shimDirectory = null,
  mcHomeDir = mcHome(),
  execPath = process.execPath,
  deps = {},
} = {}) {
  const descriptor = decodeSessionCapabilities(capabilities);
  const env = scrubGitHubCredentialEnv(baseEnv);
  const ensureShim = deps.ensureGitHubShim || ensureGitHubShim;
  const shimPath = await ensureShim({
    sessionId,
    shimDirectory,
    mcHomeDir,
    execPath,
    deps,
  });
  env[MC_SESSION_CAPABILITIES_ENV] = JSON.stringify(descriptor);
  if (typeof socketPath === 'string' && socketPath.trim()) {
    env[MC_GITHUB_BROKER_SOCKET_ENV] = socketPath.trim();
  } else {
    delete env[MC_GITHUB_BROKER_SOCKET_ENV];
  }
  env.PATH = prependPath(dirname(shimPath), env.PATH);
  return { env, capabilities: descriptor, shim_path: shimPath };
}

export function scrubGitHubCredentialEnv(baseEnv = process.env) {
  const env = { ...(baseEnv || {}) };
  for (const name of GITHUB_CREDENTIAL_ENV_NAMES) delete env[name];
  return env;
}

export async function ensureGitHubShim({
  sessionId,
  shimDirectory = null,
  mcHomeDir = mcHome(),
  execPath = process.execPath,
  deps = {},
} = {}) {
  const paths = sessionHostPaths(sessionId);
  const root = shimDirectory == null
    ? (
        mcHomeDir === mcHome()
          ? join(paths.dir, 'tools', 'bin')
          : join(mcHomeDir, 'hosts', safePathPart(sessionId), 'tools', 'bin')
      )
    : requirePrivateShimDirectory(shimDirectory);
  const shimPath = join(root, 'gh');
  const makeDir = deps.mkdir || mkdir;
  const write = deps.writeFile || writeFile;
  const setMode = deps.chmod || chmod;
  await makeDir(dirname(shimPath), { recursive: true, mode: 0o700 });
  await write(shimPath, renderGitHubShim({ execPath, modulePath: SHIM_MODULE }), {
    encoding: 'utf8',
    mode: 0o700,
  });
  await setMode(shimPath, 0o700);
  if (shimDirectory != null) {
    const mcShimPath = join(root, 'mc');
    await write(mcShimPath, renderManagedMcShim({
      execPath,
      modulePath: SHIM_MODULE,
    }), {
      encoding: 'utf8',
      mode: 0o700,
    });
    await setMode(mcShimPath, 0o700);
  }
  return shimPath;
}

function requirePrivateShimDirectory(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new TypeError('absolute GitHub shim directory is required');
  }
  return resolve(value);
}

export function renderGitHubShim({ execPath, modulePath }) {
  return [
    '#!/bin/sh',
    `exec ${shellQuote(execPath)} ${shellQuote(modulePath)} "$@"`,
    '',
  ].join('\n');
}

export function renderManagedMcShim({ execPath, modulePath }) {
  return [
    '#!/bin/sh',
    'if [ "$1" != "github" ]; then',
    '  printf "%s\\n" "mc: only session-scoped GitHub commands are available inside a managed provider" >&2',
    '  exit 126',
    'fi',
    'shift',
    `exec ${shellQuote(execPath)} ${shellQuote(modulePath)} --mc-session-shim "$@"`,
    '',
  ].join('\n');
}

export async function executeGitHubSessionOperation({
  operation,
  params = {},
  requestId = makeGitHubRequestId(),
  env = process.env,
  request = requestBroker,
} = {}) {
  let encoded;
  try {
    encoded = encodeGitHubOperationRequest({ requestId, operation, params });
  } catch {
    return safeOperationFailure(requestId, 'invalid_params');
  }
  const socketPath = stringOrNull(env?.[MC_GITHUB_BROKER_SOCKET_ENV]);
  if (!socketPath) {
    // Not a transient failure: there is no session GitHub broker in this
    // environment at all. Saying "temporarily unavailable — retry" here
    // sent users retrying something that can never succeed. The code is
    // local-only by construction — the wire decode rejects it.
    return {
      ok: false,
      request_id: encoded.request_id,
      error: {
        code: 'no_session_broker',
        message: 'GitHub commands are session-scoped — run this inside an mc session (`mc open <name>` or `mc new <name>`).',
        repair_action: null,
      },
    };
  }
  try {
    const raw = await request(encoded, {
      socketPath,
      timeoutMs: GITHUB_BROKER_TIMEOUT_MS,
    });
    const decoded = decodeGitHubOperationResponse(raw);
    if (decoded.request_id !== encoded.request_id) {
      return safeOperationFailure(encoded.request_id, 'unavailable');
    }
    return decoded;
  } catch {
    return safeOperationFailure(encoded.request_id, 'unavailable');
  }
}

/** Trusted sidecar-only control-plane client. */
export async function executeGitHubControlPlaneOperation({
  connectionClient,
  codingSessionId = null,
  mcSessionId = null,
  sourceId = null,
  workspaceId = null,
  request,
  allowedOperations = null,
  memoroFetchImpl = memoroFetch,
} = {}) {
  let decodedRequest;
  try {
    decodedRequest = decodeGitHubOperationRequest(request);
  } catch (error) {
    return safeOperationFailure(
      validRequestId(request?.request_id),
      error?.code === 'operation_not_allowed' ? 'operation_not_allowed' : 'invalid_params',
    );
  }
  // The allowlist may be provided lazily (a function) so a caller can
  // re-bootstrap capabilities on demand. It resolves only AFTER the wire
  // decode above: malformed or spoofed requests must never trigger any
  // network access. A provider failure resolves to null — the control
  // plane stays the enforcing authority.
  let resolvedAllowedOperations = allowedOperations;
  if (typeof allowedOperations === 'function') {
    try {
      resolvedAllowedOperations = await allowedOperations(decodedRequest);
    } catch {
      resolvedAllowedOperations = null;
    }
  }
  if (
    resolvedAllowedOperations != null
    && (
      !Array.isArray(resolvedAllowedOperations)
      || !resolvedAllowedOperations.includes(decodedRequest.operation)
    )
  ) {
    return safeOperationFailure(decodedRequest.request_id, 'operation_not_allowed');
  }
  const legacySession = stringOrNull(codingSessionId);
  const v1Session = stringOrNull(mcSessionId);
  const v1Source = stringOrNull(sourceId);
  const v1Workspace = stringOrNull(workspaceId);
  const legacy = legacySession !== null
    && /^sess_[a-zA-Z0-9_-]{6,}$/u.test(legacySession)
    && v1Session === null && v1Source === null && v1Workspace === null;
  const v1 = v1Session !== null
    && /^mcs_[a-f0-9]{24}$/u.test(v1Session)
    && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(v1Source || '')
    && v1Source !== 'memoro-cloud'
    && /^mcw_[a-f0-9]{24}$/u.test(v1Workspace || '')
    && legacySession === null;
  if (!connectionClient?.withGrant || (!legacy && !v1)) {
    return safeOperationFailure(decodedRequest.request_id, 'invalid_params');
  }
  const session = v1 ? v1Session : legacySession;
  const grantRequest = v1
    ? {
        purpose: 'session',
        codingSessionId: session,
        sourceId: v1Source,
        workspaceId: v1Workspace,
      }
    : { purpose: 'session', codingSessionId: session };
  const operationPath = v1
    ? `/api/mc/v1/sources/${encodeURIComponent(v1Source)}`
      + `/sessions/${encodeURIComponent(session)}`
      + `/workspaces/${encodeURIComponent(v1Workspace)}/github/operations`
    : `/api/mc/github/sessions/${encodeURIComponent(session)}/operations`;
  let raw;
  try {
    raw = await connectionClient.withGrant(
      'github',
      grantRequest,
      ({ token, apiUrl }) => memoroFetchImpl(
        apiUrl,
        operationPath,
        { token, method: 'POST', body: decodedRequest },
      ),
    );
  } catch (error) {
    raw = error?.data;
  }
  try {
    const decoded = decodeGitHubOperationResponse(raw);
    if (decoded.request_id !== decodedRequest.request_id) {
      return safeOperationFailure(decodedRequest.request_id, 'unavailable');
    }
    return decoded;
  } catch {
    return safeOperationFailure(decodedRequest.request_id, 'unavailable');
  }
}

function safeOperationFailure(requestId, code) {
  const id = validRequestId(requestId);
  const invalid = code === 'invalid_params';
  const denied = code === 'operation_not_allowed';
  return {
    ok: false,
    request_id: id,
    error: {
      code: invalid ? 'invalid_params' : (denied ? 'operation_not_allowed' : 'unavailable'),
      message: invalid
        ? 'GitHub operation parameters are invalid.'
        : (denied
          ? 'GitHub operation is not allowed.'
          : 'GitHub is temporarily unavailable through Memoro.'),
      repair_action: invalid || denied ? null : 'retry',
    },
  };
}

export function makeGitHubRequestId() {
  return `mcr_${randomBytes(12).toString('hex')}`;
}

function validRequestId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/.test(value)
    ? value
    : makeGitHubRequestId();
}

function normalizeRepository(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(normalized) ? normalized : null;
}

function prependPath(dir, current) {
  const parts = String(current || '').split(delimiter).filter(Boolean);
  return [dir, ...parts.filter((part) => part !== dir)].join(delimiter);
}

function safePathPart(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 160) || 'unknown';
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function stringOrNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}
