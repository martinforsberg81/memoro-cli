/**
 * Shared executor policy for the pinned managed Claude adapter.
 *
 * Both the hostile C1 proof and the ordinary managed runtime import this
 * module. That prevents the proof from certifying one provider/network
 * boundary while production launches a subtly different one.
 */

export const MANAGED_CLAUDE_API_HOST = 'api.anthropic.com';
export const MANAGED_CLAUDE_CREDENTIAL_FD = 3;
export const MANAGED_CLAUDE_SECRET_ENV_NAMES = Object.freeze([
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'MEMORO_API_TOKEN',
  'MEMORO_TOKEN',
]);

const API_ROUTES = new Set([
  'POST /v1/messages',
  'POST /v1/messages/count_tokens',
]);
const MAX_PROVIDER_BODY_BYTES = 8 * 1024 * 1024;
const PROVIDER_ORACLE_HEADER = 'x-mc-c1-oracle-probe';

export function buildManagedClaudeSandboxPolicy({
  deniedReadPaths,
  deniedWritePaths,
  allowedUnixSocketPaths = [],
  getSentinel,
  onDecision = () => {},
} = {}) {
  if (!pathList(deniedReadPaths)
    || !pathList(deniedWritePaths)
    || !pathList(allowedUnixSocketPaths)
    || typeof getSentinel !== 'function'
    || typeof onDecision !== 'function') {
    throw new TypeError('managed Claude sandbox policy input is invalid');
  }
  return {
    network: {
      allowedDomains: ['*'],
      deniedDomains: [],
      strictAllowlist: false,
      allowUnixSockets: [...allowedUnixSocketPaths],
      allowAllUnixSockets: false,
      allowLocalBinding: true,
      allowMachLookup: [],
      tlsTerminate: {},
      filterRequest: async (request) => {
        const decision = await classifyManagedClaudeProviderRequest(request, {
          sentinel: getSentinel(),
        });
        onDecision(decision);
        return { action: decision.action, reason: decision.reason };
      },
    },
    filesystem: {
      denyRead: [...deniedReadPaths],
      allowRead: ['/'],
      allowWrite: ['/'],
      denyWrite: [...deniedWritePaths],
      allowGitConfig: true,
    },
    credentials: {
      envVars: MANAGED_CLAUDE_SECRET_ENV_NAMES
        .map((name) => ({ name, mode: 'deny' })),
      files: deniedReadPaths.map((path) => ({ path, mode: 'deny' })),
    },
    enableWeakerNestedSandbox: true,
    enableWeakerNetworkIsolation: true,
    // Apple Events/Launch Services execute the launched application outside
    // SRT's filesystem and network policy. Managed custody therefore cannot
    // permit them: `open`/`osascript` would otherwise bypass every credential
    // path denial above.
    allowAppleEvents: false,
    allowPty: true,
  };
}

export async function classifyManagedClaudeProviderRequest(request, {
  sentinel = null,
} = {}) {
  const headers = request?.headers;
  const header = (name) => {
    if (headers && typeof headers.get === 'function') return headers.get(name);
    if (headers && typeof headers === 'object') {
      const found = Object.keys(headers).find(
        (key) => key.toLowerCase() === name.toLowerCase(),
      );
      return found ? headers[found] : null;
    }
    return null;
  };
  const oracle = header(PROVIDER_ORACLE_HEADER) === '1';
  const authorization = header('authorization');
  if (oracle) {
    const credentialExposed = typeof sentinel === 'string'
      && sentinel.length > 0
      && authorization === `Bearer ${sentinel}`;
    return requestDecision('deny', credentialExposed
      ? 'provider_oracle_credential_exposed'
      : 'provider_oracle_blocked', {
      provider_oracle_blocked: !credentialExposed,
      provider_oracle_credential_exposed: credentialExposed,
    });
  }
  let url;
  try {
    url = new URL(request?.url);
  } catch {
    return requestDecision('deny', 'provider_url_invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || (url.port !== '' && url.port !== '443')
    || url.username !== ''
    || url.password !== '') {
    return requestDecision('deny', 'host_not_allowed', {
      other_host_blocked: true,
    });
  }
  if (url.hostname !== MANAGED_CLAUDE_API_HOST) {
    return requestDecision('allow', 'host_allowed');
  }
  if (url.protocol !== 'https:') {
    return requestDecision('deny', 'provider_transport_not_allowed');
  }
  if (url.search !== '' || url.hash !== '') {
    return requestDecision('deny', 'provider_route_not_allowed', {
      provider_path_blocked: true,
    });
  }
  const route = `${String(request?.method || '').toUpperCase()} ${url.pathname}`;
  if (!API_ROUTES.has(route)) {
    return requestDecision('deny', 'provider_route_not_allowed', {
      provider_path_blocked: true,
    });
  }
  if (typeof sentinel !== 'string'
    || sentinel.length === 0
    || authorization !== `Bearer ${sentinel}`) {
    return requestDecision('deny', 'provider_credential_sentinel_required');
  }
  const contentType = String(header('content-type') || '').toLowerCase();
  if (!/^application\/json(?:\s*;|$)/u.test(contentType)
    || !await hasBoundedProviderPayload(request)) {
    return requestDecision('deny', 'provider_payload_not_allowed');
  }
  return requestDecision('allow', 'provider_route_allowed', {
    messages_allowed: route === 'POST /v1/messages',
    count_tokens_allowed: route === 'POST /v1/messages/count_tokens',
  });
}

export function managedClaudeExecutorEnvironment({
  home,
  tmp,
  claudeConfigDir = null,
  path = '/usr/bin:/bin:/usr/sbin:/sbin',
  inherited = {},
} = {}) {
  const env = {
    HOME: home,
    TMPDIR: tmp,
    CLAUDE_CODE_TMPDIR: tmp,
    ...(claudeConfigDir ? { CLAUDE_CONFIG_DIR: claudeConfigDir } : {}),
    PATH: path,
    LANG: 'C',
    LC_ALL: 'C',
    SHELL: '/bin/bash',
  };
  for (const name of [
    'MC_CODING_SESSION_ID',
    'MC_RUNTIME_GENERATION',
    'MC_PROVIDER_ARTIFACT_SOCKET',
    'MC_SESSION_CAPABILITIES',
    'MC_GITHUB_BROKER_SOCKET',
  ]) {
    if (typeof inherited[name] === 'string' && inherited[name]) {
      env[name] = inherited[name];
    }
  }
  return env;
}

async function hasBoundedProviderPayload(request) {
  let bytes;
  try {
    if (typeof request?.clone === 'function') {
      bytes = Buffer.from(await request.clone().arrayBuffer());
    } else if (typeof request?.body === 'string'
      || Buffer.isBuffer(request?.body)) {
      bytes = Buffer.from(request.body);
    } else {
      return false;
    }
  } catch {
    return false;
  }
  if (bytes.length === 0 || bytes.length > MAX_PROVIDER_BODY_BYTES) {
    bytes.fill(0);
    return false;
  }
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    bytes.fill(0);
    return false;
  }
  bytes.fill(0);
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.model === 'string'
    && value.model.length > 0
    && value.model.length <= 256
    && Array.isArray(value.messages)
    && value.messages.length <= 4096;
}

function requestDecision(action, reason, flags = {}) {
  return {
    action,
    reason,
    messages_allowed: flags.messages_allowed === true,
    count_tokens_allowed: flags.count_tokens_allowed === true,
    provider_path_blocked: flags.provider_path_blocked === true,
    other_host_blocked: flags.other_host_blocked === true,
    provider_oracle_blocked: flags.provider_oracle_blocked === true,
    provider_oracle_credential_exposed:
      flags.provider_oracle_credential_exposed === true,
  };
}

function pathList(value) {
  return Array.isArray(value)
    && value.every((path) => typeof path === 'string' && path.startsWith('/'));
}
