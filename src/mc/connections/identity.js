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
    },
  });
}
