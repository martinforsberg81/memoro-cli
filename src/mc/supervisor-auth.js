import { ACCOUNTS } from '../commands/auth.js';
import {
  deleteSecret as defaultDeleteSecret,
  getSecret as defaultGetSecret,
} from '../lib/keychain.js';
import { runDeviceFlow } from '../lib/device-flow.js';
import { memoroFetch as defaultMemoroFetch } from '../lib/api.js';
import { readConfig, getApiUrl } from '../lib/config.js';

export const SUPERVISOR_SCOPE = 'mc.supervisor';
export const SUPERVISOR_AUDIENCE = 'mc.supervisor';
export const SUPERVISOR_CLIENT = 'mc-supervisor';

const SUPERVISOR_API_PREFIXES = [
  '/api/mc/supervisor',
];

export async function ensureSupervisorAuth({
  argv = [],
  getSecret = defaultGetSecret,
  runScopedDeviceFlow = runSupervisorDeviceFlow,
  stderr = process.stderr,
} = {}) {
  const apiUrl = await resolveSupervisorApiUrl(argv);
  const token = await getSecret(ACCOUNTS.SUPERVISOR_TOKEN);
  if (token) {
    return {
      ok: true,
      token,
      apiUrl,
      account: ACCOUNTS.SUPERVISOR_TOKEN,
      scope: SUPERVISOR_SCOPE,
      audience: SUPERVISOR_AUDIENCE,
      source: 'keychain',
    };
  }

  stderr.write('mc supervisor requires scoped Memoro authorization for online sync.\n');
  const code = await runScopedDeviceFlow({ argv, stderr });
  if (code !== 0) return { ok: false, code, error: 'supervisor authorization failed' };

  const stored = await getSecret(ACCOUNTS.SUPERVISOR_TOKEN);
  if (!stored) {
    return { ok: false, code: 1, error: 'supervisor token was not stored' };
  }
  return {
    ok: true,
    token: stored,
    apiUrl,
    account: ACCOUNTS.SUPERVISOR_TOKEN,
    scope: SUPERVISOR_SCOPE,
    audience: SUPERVISOR_AUDIENCE,
    source: 'device-flow',
  };
}

export async function runSupervisorDeviceFlow({
  argv = [],
  stderr = process.stderr,
  runDeviceFlowFn = runDeviceFlow,
} = {}) {
  const apiUrl = await resolveSupervisorApiUrl(argv);
  return runDeviceFlowFn({
    apiUrl,
    stderr,
    account: ACCOUNTS.SUPERVISOR_TOKEN,
    scope: SUPERVISOR_SCOPE,
    audience: SUPERVISOR_AUDIENCE,
    client: SUPERVISOR_CLIENT,
    initPath: '/api/mc/supervisor/device/init',
    pollPath: '/api/mc/supervisor/device/poll',
    successLabel: 'Supervisor',
    nextMessage: 'Starting mc supervisor.',
  });
}

export async function getSupervisorConversation({
  auth,
  apiUrl = auth?.apiUrl,
  token = auth?.token,
  supervisorFetchFn = supervisorFetch,
} = {}) {
  if (!apiUrl || !token) return { ok: false, error: 'supervisor auth is required' };
  return supervisorFetchFn(apiUrl, '/api/mc/supervisor', { token });
}

export async function syncSupervisorSnapshot(snapshot, {
  auth,
  apiUrl = auth?.apiUrl,
  token = auth?.token,
  supervisorFetchFn = supervisorFetch,
  client = defaultSupervisorClient(),
} = {}) {
  if (!apiUrl || !token) return { ok: false, error: 'supervisor auth is required' };
  return supervisorFetchFn(apiUrl, '/api/mc/supervisor/snapshot', {
    token,
    method: 'POST',
    body: {
      client,
      snapshot,
    },
  });
}

export async function appendSupervisorMessage(message, {
  auth,
  apiUrl = auth?.apiUrl,
  token = auth?.token,
  supervisorFetchFn = supervisorFetch,
  client = defaultSupervisorClient(),
} = {}) {
  if (!apiUrl || !token) return { ok: false, error: 'supervisor auth is required' };
  return supervisorFetchFn(apiUrl, '/api/mc/supervisor/messages', {
    token,
    method: 'POST',
    body: {
      client,
      ...message,
    },
  });
}

export async function logoutSupervisor({
  argv = [],
  getSecret = defaultGetSecret,
  deleteSecret = defaultDeleteSecret,
  supervisorFetchFn = supervisorFetch,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const apiUrl = await resolveSupervisorApiUrl(argv);
  const token = await getSecret(ACCOUNTS.SUPERVISOR_TOKEN);
  if (!token) {
    stdout.write('No supervisor token stored.\n');
    return 0;
  }
  try {
    await supervisorFetchFn(apiUrl, '/api/mc/supervisor/revoke-current', {
      token,
      method: 'POST',
    });
  } catch (err) {
    stderr.write(`mc: supervisor token revoke failed (${err.message || String(err)}); removing local token anyway.\n`);
  }
  await deleteSecret(ACCOUNTS.SUPERVISOR_TOKEN);
  stdout.write('Supervisor token removed.\n');
  return 0;
}

export async function supervisorFetch(apiUrl, path, {
  token,
  memoroFetch = defaultMemoroFetch,
  ...opts
} = {}) {
  if (!isSupervisorApiPath(path)) {
    throw new Error(`supervisor token cannot call non-supervisor endpoint: ${path}`);
  }
  return memoroFetch(apiUrl, path, { token, ...opts });
}

export function isSupervisorApiPath(path) {
  return SUPERVISOR_API_PREFIXES.some((prefix) => (
    path === prefix || String(path || '').startsWith(`${prefix}/`)
  ));
}

async function resolveSupervisorApiUrl(argv = []) {
  const config = await readConfig();
  return getApiUrl(argv) || config.apiUrl;
}

function defaultSupervisorClient() {
  return {
    name: SUPERVISOR_CLIENT,
    version: process.env.npm_package_version || null,
    platform: process.platform,
  };
}
