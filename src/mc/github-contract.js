/**
 * Token-free GitHub capability schemas shared by local and cloud mc.
 *
 * These codecs deliberately do not carry authenticated identity, repository
 * choice, transport credentials, or an executable surface. Session
 * descriptors are informational; the server-side session binding remains the
 * authority for every operation.
 */

export const GITHUB_CONNECTION_SCHEMA = 1;
export const GITHUB_SESSION_SCHEMA = 1;
export const GITHUB_OPERATION_SCHEMA = 1;
export const GITHUB_OPERATION_TYPE = 'github_operation';
export const GITHUB_SESSION_TRANSPORT = 'mc-broker-v1';

export const GITHUB_CONNECTION_STATES = Object.freeze([
  'disconnected',
  'connecting',
  'ready',
  'repo_not_installed',
  'permission_missing',
  'suspended',
  'revoked',
  'unavailable',
]);

export const GITHUB_REPAIR_ACTIONS = Object.freeze([
  'connect',
  'continue_connect',
  'select_repository',
  'update_installation',
  'resume_installation',
  'reconnect',
  'retry',
]);

export const GITHUB_READ_OPERATIONS = Object.freeze([
  'connection.status',
  'repository.metadata',
  'pull_request.list',
  'pull_request.view',
  'checks.list',
]);

export const GITHUB_STABLE_ERRORS = Object.freeze([
  'not_connected',
  'repo_not_installed',
  'permission_missing',
  'operation_not_allowed',
  'invalid_params',
  'approval_required',
  'approval_expired',
  'rate_limited',
  'conflict',
  'stale_head',
  'not_found',
  'unavailable',
]);

const CONNECTION_STATE_SET = new Set(GITHUB_CONNECTION_STATES);
const REPAIR_ACTION_SET = new Set(GITHUB_REPAIR_ACTIONS);
const READ_OPERATION_SET = new Set(GITHUB_READ_OPERATIONS);
const STABLE_ERROR_SET = new Set(GITHUB_STABLE_ERRORS);
const REQUEST_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/;
const CONNECT_STATE_RE = /^gha_[a-zA-Z0-9_-]{8,200}$/;
const FULL_NAME_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const LOGIN_RE = /^[a-zA-Z0-9_.-]+$/;
const FORBIDDEN_CREDENTIAL_VALUE_RE = /(?:github_pat_|gh[opusr]_[a-zA-Z0-9_]+|Bearer\s+[a-zA-Z0-9._~-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
const MAX_RESPONSE_BYTES = 256 * 1024;

const EXPECTED_REPAIR = Object.freeze({
  disconnected: 'connect',
  connecting: 'continue_connect',
  ready: null,
  repo_not_installed: 'select_repository',
  permission_missing: 'update_installation',
  suspended: 'resume_installation',
  revoked: 'reconnect',
  unavailable: 'retry',
});

export class GitHubContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GitHubContractError';
    this.code = code;
  }
}

/** Decode the exact GET /api/mc/github/status envelope. */
export function decodeGitHubConnectionResponse(value, { expectedRepository = null } = {}) {
  assertNoForbiddenDescriptorFields(value);
  exactObject(value, ['ok', 'github'], 'GitHub connection response');
  if (value.ok !== true) invalid('GitHub connection response is invalid.');
  let github = decodeConnectionDescriptor(value.github);

  const expected = normalizeExpectedRepository(expectedRepository);
  if (expected && github.state === 'ready' && (
    !github.repository || github.repository.full_name.toLowerCase() !== expected
  )) {
    github = {
      ...github,
      state: 'repo_not_installed',
      repair_action: 'select_repository',
      repository: null,
      operations: [],
    };
  }

  return { ok: true, github };
}

export function decodeGitHubRepositoriesResponse(value) {
  assertNoForbiddenDescriptorFields(value);
  exactObject(value, ['ok', 'state', 'repair_action', 'repositories'], 'GitHub repositories response');
  if (value.ok !== true) invalid('GitHub repositories response is invalid.');
  const state = connectionState(value.state);
  const repairAction = connectionRepairAction(state, value.repair_action);
  return {
    ok: true,
    state,
    repair_action: repairAction,
    repositories: repositoryList(value.repositories),
  };
}

export function decodeGitHubConnectResponse(value) {
  exactObject(value, ['ok', 'schema', 'state', 'connect_url', 'expires_at'], 'GitHub connect response');
  if (value.ok !== true || value.schema !== GITHUB_CONNECTION_SCHEMA || value.state !== 'connecting') {
    invalid('GitHub connect response is invalid.');
  }
  const connectUrl = safeConnectUrl(value.connect_url);
  const expiresAt = isoTimestamp(value.expires_at);
  if (!connectUrl || !expiresAt) invalid('GitHub connect response is invalid.');
  return {
    ok: true,
    schema: GITHUB_CONNECTION_SCHEMA,
    state: 'connecting',
    connect_url: connectUrl,
    expires_at: expiresAt,
  };
}

export function decodeConnectionDescriptor(value) {
  assertNoForbiddenDescriptorFields(value);
  exactObject(value, [
    'schema',
    'state',
    'repair_action',
    'actor',
    'accounts',
    'repository',
    'repositories',
    'operations',
    'approval_mode',
  ], 'GitHub connection descriptor');
  if (value.schema !== GITHUB_CONNECTION_SCHEMA) invalid('GitHub connection descriptor schema is invalid.');
  const state = connectionState(value.state);
  const repairAction = connectionRepairAction(state, value.repair_action);
  const actor = installationActor(value.actor);
  const accounts = accountList(value.accounts);
  const repository = value.repository === null ? null : githubRepository(value.repository);
  const repositories = repositoryList(value.repositories);
  const operations = operationList(value.operations);
  if (value.approval_mode !== 'prompt') invalid('GitHub approval mode is invalid.');
  if (state !== 'ready' && repository !== null) invalid('An unready GitHub connection cannot bind a repository.');
  return {
    schema: GITHUB_CONNECTION_SCHEMA,
    state,
    repair_action: repairAction,
    actor,
    accounts,
    repository,
    repositories,
    operations: state === 'ready' ? operations : [],
    approval_mode: 'prompt',
  };
}

/**
 * Derive the descriptor shown to a prospective coding session. No source,
 * provider, user, session, installation, or credential input is accepted.
 */
export function buildSessionCapabilities(connection) {
  const decoded = decodeConnectionDescriptor(connection);
  const account = decoded.repository?.account || decoded.accounts[0]?.login || null;
  const state = decoded.state === 'ready' && decoded.repository === null
    ? 'repo_not_installed'
    : decoded.state;
  return {
    schema: GITHUB_SESSION_SCHEMA,
    github: {
      state,
      transport: GITHUB_SESSION_TRANSPORT,
      actor: 'installation',
      account,
      repository: decoded.repository,
      operations: state === 'ready' ? decoded.operations : [],
      approval_mode: 'prompt',
    },
  };
}

export function decodeSessionCapabilities(value) {
  assertNoForbiddenDescriptorFields(value);
  exactObject(value, ['schema', 'github'], 'GitHub session capabilities');
  if (value.schema !== GITHUB_SESSION_SCHEMA) invalid('GitHub session capability schema is invalid.');
  exactObject(value.github, [
    'state',
    'transport',
    'actor',
    'account',
    'repository',
    'operations',
    'approval_mode',
  ], 'GitHub session capability');
  const state = connectionState(value.github.state);
  if (value.github.transport !== GITHUB_SESSION_TRANSPORT
      || value.github.actor !== 'installation'
      || value.github.approval_mode !== 'prompt') {
    invalid('GitHub session capability is invalid.');
  }
  const account = value.github.account === null ? null : boundedString(value.github.account, 255);
  if (value.github.account !== null && (!account || !LOGIN_RE.test(account))) {
    invalid('GitHub session account is invalid.');
  }
  const repository = value.github.repository === null ? null : githubRepository(value.github.repository);
  const operations = operationList(value.github.operations);
  if (state === 'ready' && repository === null) {
    invalid('A ready GitHub session requires repository binding metadata.');
  }
  if (state !== 'ready' && (repository !== null || operations.length > 0)) {
    invalid('An unready GitHub session cannot advertise repository operations.');
  }
  return {
    schema: GITHUB_SESSION_SCHEMA,
    github: {
      state,
      transport: GITHUB_SESSION_TRANSPORT,
      actor: 'installation',
      account,
      repository,
      operations,
      approval_mode: 'prompt',
    },
  };
}

export function encodeGitHubOperationRequest({ requestId, operation, params = {} } = {}) {
  return decodeGitHubOperationRequest({
    type: GITHUB_OPERATION_TYPE,
    schema: GITHUB_OPERATION_SCHEMA,
    request_id: requestId,
    operation,
    params,
  });
}

export function decodeGitHubOperationRequest(value) {
  assertNoForbiddenDescriptorFields(value);
  exactObject(value, ['type', 'schema', 'request_id', 'operation', 'params'], 'GitHub operation request');
  if (value.type !== GITHUB_OPERATION_TYPE || value.schema !== GITHUB_OPERATION_SCHEMA) {
    invalid('GitHub operation type and schema are invalid.');
  }
  const requestId = boundedString(value.request_id, 128);
  if (!requestId || !REQUEST_ID_RE.test(requestId)) invalid('GitHub operation request_id is invalid.');
  const operation = boundedString(value.operation, 128);
  if (!operation || !READ_OPERATION_SET.has(operation)) {
    throw new GitHubContractError('operation_not_allowed', 'GitHub operation is not allowed.');
  }
  if (!isPlainObject(value.params)) invalid('GitHub operation params must be an object.');
  return {
    type: GITHUB_OPERATION_TYPE,
    schema: GITHUB_OPERATION_SCHEMA,
    request_id: requestId,
    operation,
    params: operationParams(operation, value.params),
  };
}

export function decodeGitHubOperationResponse(value) {
  assertNoForbiddenDescriptorFields(value);
  ensureBoundedJson(value, 'GitHub operation response');
  if (!isPlainObject(value) || typeof value.ok !== 'boolean') invalid('GitHub operation response is invalid.');
  const requestId = boundedString(value.request_id, 128);
  if (!requestId || !REQUEST_ID_RE.test(requestId)) invalid('GitHub operation response request_id is invalid.');

  if (value.ok) {
    exactObject(value, ['ok', 'request_id', 'data'], 'GitHub operation success response');
    if (!isJsonValue(value.data)) invalid('GitHub operation data is invalid.');
    return { ok: true, request_id: requestId, data: cloneJson(value.data) };
  }

  exactObject(value, ['ok', 'request_id', 'error'], 'GitHub operation failure response');
  exactObject(value.error, [
    'code',
    'message',
    'repair_action',
    'approval_id',
    'retry_after_seconds',
  ], 'GitHub operation error', { optional: ['approval_id', 'retry_after_seconds'] });
  const code = boundedString(value.error.code, 64);
  const message = boundedString(value.error.message, 512);
  const repairAction = value.error.repair_action === null
    ? null
    : boundedString(value.error.repair_action, 64);
  if (!code || !STABLE_ERROR_SET.has(code) || !message
      || (repairAction !== null && !REPAIR_ACTION_SET.has(repairAction) && repairAction !== 'approve')) {
    invalid('GitHub operation error is invalid.');
  }
  const error = { code, message, repair_action: repairAction };
  if (value.error.approval_id !== undefined) {
    const approvalId = boundedString(value.error.approval_id, 128);
    if (!approvalId) invalid('GitHub approval id is invalid.');
    error.approval_id = approvalId;
  }
  if (value.error.retry_after_seconds !== undefined) {
    const retry = value.error.retry_after_seconds;
    if (!Number.isSafeInteger(retry) || retry < 1 || retry > 3600) invalid('GitHub retry interval is invalid.');
    error.retry_after_seconds = retry;
  }
  return { ok: false, request_id: requestId, error };
}

export function repairForGitHubState(state) {
  const normalized = connectionState(state);
  const action = EXPECTED_REPAIR[normalized];
  if (!action) return null;
  const command = action === 'retry' ? 'mc github status' : 'mc github connect';
  const messages = {
    connect: 'Connect GitHub through Memoro.',
    continue_connect: 'Continue the GitHub connection through Memoro.',
    select_repository: 'Select this repository for the Memoro GitHub App.',
    update_installation: 'Update the Memoro GitHub App connection permissions.',
    resume_installation: 'Resume the Memoro GitHub App connection.',
    reconnect: 'Reconnect GitHub through Memoro.',
    retry: 'Retry the Memoro GitHub readiness check.',
  };
  return { action, command, message: messages[action] };
}

function operationParams(operation, params) {
  if (operation === 'connection.status' || operation === 'repository.metadata') {
    exactObject(params, [], 'GitHub operation params');
    return {};
  }
  if (operation === 'pull_request.list') {
    exactObject(params, ['state', 'author', 'limit'], 'GitHub pull request list params', {
      optional: ['state', 'author', 'limit'],
    });
    const state = params.state === undefined ? 'open' : params.state;
    const author = params.author === undefined || params.author === null
      ? null
      : boundedString(params.author, 255);
    const limit = params.limit === undefined ? 30 : params.limit;
    if (!['open', 'closed', 'all'].includes(state)) invalid('GitHub pull request state is invalid.');
    if (params.author !== undefined && params.author !== null
        && (!author || !/^[a-zA-Z0-9-]+$/.test(author))) {
      invalid('GitHub pull request author is invalid.');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      invalid('GitHub pull request limit is invalid.');
    }
    return { state, author, limit };
  }
  exactObject(params, ['pull_number'], 'GitHub pull request params');
  if (!Number.isSafeInteger(params.pull_number) || params.pull_number < 1) {
    invalid('GitHub pull request number is invalid.');
  }
  return { pull_number: params.pull_number };
}

function installationActor(value) {
  exactObject(value, ['type', 'login'], 'GitHub actor');
  const login = boundedString(value.login, 255);
  if (value.type !== 'installation' || !login) invalid('GitHub actor is invalid.');
  return { type: 'installation', login };
}

function accountList(value) {
  if (!Array.isArray(value) || value.length > 1000) invalid('GitHub accounts are invalid.');
  return value.map((account) => {
    exactObject(account, ['login', 'type'], 'GitHub account');
    const login = boundedString(account.login, 255);
    const type = boundedString(account.type, 64);
    if (!login || !LOGIN_RE.test(login) || !type) invalid('GitHub account is invalid.');
    return { login, type };
  });
}

function repositoryList(value) {
  if (!Array.isArray(value) || value.length > 10_000) invalid('GitHub repositories are invalid.');
  return value.map(githubRepository);
}

function githubRepository(value) {
  exactObject(value, ['id', 'full_name', 'owner', 'name', 'private', 'archived', 'account'], 'GitHub repository');
  const id = value.id;
  const fullName = boundedString(value.full_name, 512);
  const owner = boundedString(value.owner, 255);
  const name = boundedString(value.name, 255);
  const account = boundedString(value.account, 255);
  if (!Number.isSafeInteger(id) || id < 1 || !fullName || !FULL_NAME_RE.test(fullName)
      || !owner || !LOGIN_RE.test(owner) || !name || !LOGIN_RE.test(name)
      || !account || !LOGIN_RE.test(account)
      || typeof value.private !== 'boolean' || typeof value.archived !== 'boolean') {
    invalid('GitHub repository is invalid.');
  }
  if (fullName.toLowerCase() !== `${owner}/${name}`.toLowerCase()) invalid('GitHub repository identity is inconsistent.');
  return { id, full_name: fullName, owner, name, private: value.private, archived: value.archived, account };
}

function operationList(value) {
  if (!Array.isArray(value) || value.length > GITHUB_READ_OPERATIONS.length) {
    invalid('GitHub operations are invalid.');
  }
  const operations = [];
  for (const item of value) {
    if (typeof item !== 'string' || !READ_OPERATION_SET.has(item) || operations.includes(item)) {
      invalid('GitHub operations are invalid.');
    }
    operations.push(item);
  }
  return operations;
}

function connectionState(value) {
  if (typeof value !== 'string' || !CONNECTION_STATE_SET.has(value)) invalid('GitHub connection state is invalid.');
  return value;
}

function connectionRepairAction(state, value) {
  const expected = EXPECTED_REPAIR[state];
  if (value !== expected) invalid('GitHub connection repair action is invalid.');
  if (value !== null && !REPAIR_ACTION_SET.has(value)) invalid('GitHub connection repair action is invalid.');
  return value;
}

function normalizeExpectedRepository(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = boundedString(value, 512)?.replace(/\.git$/i, '').toLowerCase();
  if (!normalized || !FULL_NAME_RE.test(normalized)) invalid('Local GitHub repository identity is invalid.');
  return normalized;
}

function safeConnectUrl(value) {
  const text = boundedString(value, 2000);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password
        || !/^\/apps\/[a-zA-Z0-9-]+\/installations\/new$/.test(url.pathname)) return null;
    const keys = [...url.searchParams.keys()];
    const state = boundedString(url.searchParams.get('state'), 220);
    if (keys.length !== 1 || keys[0] !== 'state' || !state || !CONNECT_STATE_RE.test(state)) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function isoTimestamp(value) {
  if (typeof value !== 'string' || !value || value.length > 64) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function exactObject(value, allowed, label, { optional = [] } = {}) {
  if (!isPlainObject(value)) invalid(`${label} must be an object.`);
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) invalid(`${label} contains unknown fields.`);
  const optionalSet = new Set(optional);
  if (allowed.some((key) => !optionalSet.has(key) && !Object.prototype.hasOwnProperty.call(value, key))) {
    invalid(`${label} is missing required fields.`);
  }
}

function assertNoForbiddenDescriptorFields(value, seen = new Set()) {
  if (typeof value === 'string' && FORBIDDEN_CREDENTIAL_VALUE_RE.test(value)) {
    throw new GitHubContractError('forbidden_descriptor_field', 'GitHub capability data contains credential-shaped material.');
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) invalid('GitHub descriptor contains a cycle.');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenDescriptorFields(item, seen);
    seen.delete(value);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (isForbiddenDescriptorKey(key)) {
      throw new GitHubContractError('forbidden_descriptor_field', 'GitHub capability data contains a forbidden authority field.');
    }
    assertNoForbiddenDescriptorFields(nested, seen);
  }
  seen.delete(value);
}

function isForbiddenDescriptorKey(key) {
  const text = String(key);
  const canonical = text.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  const words = text
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());

  // Token metrics/types are ordinary structured metadata. Every other key
  // with a semantic token component is credential-shaped and fails closed.
  if (canonical !== 'tokencount' && canonical !== 'tokentype'
      && (words.includes('token') || words.includes('tokens')
        || canonical.endsWith('token') || canonical.endsWith('tokens'))) {
    return true;
  }

  if (words.some((word) => [
    'credential',
    'credentials',
    'authorization',
    'cookie',
    'secret',
    'password',
    'passphrase',
  ].includes(word))) {
    return true;
  }

  const hasPair = (left, right) => words.some((word, index) => (
    word === left && words[index + 1] === right
  ));
  return hasPair('private', 'key')
    || hasPair('installation', 'id')
    || hasPair('app', 'id')
    || hasPair('client', 'id')
    || canonical.endsWith('privatekey')
    || canonical.endsWith('installationid')
    || canonical.endsWith('appid')
    || canonical.endsWith('clientid');
}

function ensureBoundedJson(value, label) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { invalid(`${label} is invalid.`); }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_RESPONSE_BYTES) {
    invalid(`${label} is too large.`);
  }
}

function isJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen));
  if (!isPlainObject(value)) return false;
  return Object.values(value).every((item) => isJsonValue(item, seen));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function boundedString(value, max) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= max ? normalized : null;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(message) {
  throw new GitHubContractError('invalid_descriptor', message);
}
