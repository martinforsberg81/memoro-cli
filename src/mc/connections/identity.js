/**
 * The only connected-capability module allowed to read the first-party
 * Memoro device identity. Provider modules receive only short-lived grants.
 */
import { getSecret as keychainGet } from '../../lib/keychain.js';
import { ACCOUNTS } from '../../commands/auth.js';
import { readConfig } from '../../lib/config.js';
import { memoroFetch } from '../../lib/api.js';
import { decodeBrokerGrant } from './contract.js';

export function createLocalIdentityBroker(deps = {}) {
  const getSecret = deps.getSecret || keychainGet;
  const fetch = deps.memoroFetch || memoroFetch;
  const loadConfig = deps.readConfig || readConfig;

  return Object.freeze({
    async withGrant(request, use) {
      if (typeof use !== 'function') throw new TypeError('grant consumer is required');
      const token = await getSecret(ACCOUNTS.TOKEN).catch(() => null);
      if (!token) throw new Error('Memoro device sign-in is required.');
      const config = await loadConfig();
      const apiUrl = deps.apiUrl || config?.apiUrl;
      if (!apiUrl) throw new Error('Memoro API URL is unavailable.');
      return exchange({ request, use, token, apiUrl, fetch });
    },
  });
}

/**
 * Identity broker for a trusted runtime that already received a Memoro device
 * or workload bootstrap identity. The token remains closed over here and is
 * never handed to provider code.
 */
export function createBoundIdentityBroker({ token, apiUrl, memoroFetch: fetch = memoroFetch } = {}) {
  if (typeof token !== 'string' || !token || typeof apiUrl !== 'string' || !apiUrl) {
    throw new TypeError('bound Memoro identity and apiUrl are required');
  }
  return Object.freeze({
    withGrant: (request, use) => exchange({ request, use, token, apiUrl, fetch }),
  });
}

export async function resolveBootstrapIdentity({
  env = process.env,
  apiUrl,
  getSecret = keychainGet,
} = {}) {
  const envToken = typeof env?.MEMORO_TOKEN === 'string' ? env.MEMORO_TOKEN.trim() : '';
  const token = envToken || await getSecret(ACCOUNTS.TOKEN).catch(() => null);
  if (!token || typeof apiUrl !== 'string' || !apiUrl) return null;
  return Object.freeze({ token, apiUrl });
}

async function exchange({ request, use, token, apiUrl, fetch }) {
  if (typeof use !== 'function') throw new TypeError('grant consumer is required');
  const codingSessionId = request.codingSessionId ?? null;
  const raw = await fetch(apiUrl, '/api/mc/capability-grants', {
    token,
    method: 'POST',
    body: {
      schema: 1,
      provider: request.provider,
      purpose: request.purpose,
      ...(codingSessionId ? { coding_session_id: codingSessionId } : {}),
    },
  });
  const grant = decodeBrokerGrant(raw, {
    provider: request.provider,
    purpose: request.purpose,
    codingSessionId,
  });
  if (!grant) throw new Error('Connected capability grant could not be verified.');
  return use(Object.freeze({ ...grant, apiUrl }));
}
