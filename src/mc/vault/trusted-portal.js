/**
 * Resolve the trusted, host-owned portal used for vault custody operations.
 *
 * Provider adapters receive the resulting object only in their trusted host
 * process. It is never serialized into a launch descriptor or broker message.
 */
import { ACCOUNTS } from '../../lib/auth-accounts.js';
import { memoroFetch } from '../../lib/api.js';
import { getApiUrl, readConfig } from '../../lib/config.js';
import { getSecret as keychainGet } from '../../lib/keychain.js';

export async function resolveTrustedVaultPortal({ deps = {} } = {}) {
  const token = await (deps.getSecret || keychainGet)(ACCOUNTS.TOKEN)
    .catch(() => null);
  if (!token) return null;
  const config = await (deps.readConfig || readConfig)().catch(() => ({}));
  return {
    apiUrl: (deps.getApiUrl || getApiUrl)([])
      || config.apiUrl
      || 'https://meetmemoro.app',
    token,
    memoroFetch: deps.memoroFetch || memoroFetch,
  };
}
