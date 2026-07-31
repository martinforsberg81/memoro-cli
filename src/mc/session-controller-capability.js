import { readConfig, getApiUrl } from '../lib/config.js';
import { resolveBootstrapIdentity } from './connections/identity.js';
import { deriveHandoffControllerRoot } from './handoff-controller-capability.js';

/**
 * Resolve controller authority inside a trusted mc process.
 *
 * The Memoro token is consumed only to derive a session-scoped HMAC and is
 * never returned. Callers may send the derived capability over broker IPC,
 * but must not persist it or copy it into a provider environment/argv.
 */
export async function resolveSessionControllerCapability({
  codingSessionId,
  apiArgv = [],
  env = process.env,
  deps = {},
} = {}) {
  if (typeof codingSessionId !== 'string' || codingSessionId.length === 0) {
    return { ok: false, reason: 'session-controller-id-required' };
  }
  try {
    const config = await (deps.readConfig || readConfig)();
    const apiUrl = (deps.getApiUrl || getApiUrl)(apiArgv) || config.apiUrl;
    const identity = await (deps.resolveBootstrapIdentity
      || resolveBootstrapIdentity)({
      env,
      apiUrl,
      getSecret: deps.getSecret,
    });
    const capability = deriveHandoffControllerRoot({
      token: identity?.token,
      codingSessionId,
    });
    return capability
      ? { ok: true, capability }
      : { ok: false, reason: 'session-controller-capability-unavailable' };
  } catch {
    return { ok: false, reason: 'session-controller-capability-unavailable' };
  }
}
