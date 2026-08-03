import { memoroFetch } from '../../lib/api.js';
import { createLocalIdentityBroker } from './identity.js';
import { decodeConnectionDescriptor } from './contract.js';
import { getConnectionProvider, listConnectionProviders } from './registry.js';

export function createConnectionClient(deps = {}) {
  const identity = deps.identityBroker || createLocalIdentityBroker(deps);
  const fetch = deps.memoroFetch || memoroFetch;
  const registryDeps = deps.providers ? { providers: deps.providers } : {};

  async function status(id) {
    const provider = requireProvider(id);
    let value;
    if (provider.custody === 'control_plane') {
      value = await identity.withGrant(
        { provider: id, purpose: 'connection' },
        ({ token, apiUrl }) => provider.status({ grant: token, apiUrl, memoroFetch: fetch }),
      );
    } else {
      value = await provider.status();
    }
    const descriptor = decodeConnectionDescriptor(value, { providerId: id });
    if (!descriptor) throw new Error('Connection descriptor could not be verified.');
    return descriptor;
  }

  async function connect(id) {
    const provider = requireProvider(id);
    if (typeof provider.connect !== 'function') {
      throw new Error(`${provider.label} owns sign-in in its native runtime.`);
    }
    return identity.withGrant(
      { provider: id, purpose: 'connection' },
      ({ token, apiUrl }) => provider.connect({ grant: token, apiUrl, memoroFetch: fetch }),
    );
  }

  async function withGrant(id, {
    purpose = 'connection',
    codingSessionId = null,
    sourceId = null,
    workspaceId = null,
  } = {}, use) {
    const provider = requireProvider(id);
    if (provider.custody !== 'control_plane') {
      throw new Error(`${provider.label} does not use control-plane grants.`);
    }
    return identity.withGrant({
      provider: id,
      purpose,
      codingSessionId,
      sourceId,
      workspaceId,
    }, use);
  }

  async function call(id, operation, params = {}) {
    const provider = requireProvider(id);
    const invoke = provider[operation];
    if (typeof invoke !== 'function' || ['status', 'connect', 'disconnect'].includes(operation)) {
      throw new Error(`Unsupported ${provider.label} connection operation.`);
    }
    return withGrant(id, { purpose: 'connection' }, ({ token, apiUrl }) => (
      invoke.call(provider, { grant: token, apiUrl, memoroFetch: fetch, params })
    ));
  }

  async function repair(id) {
    const current = await status(id);
    if (current.state === 'ready') return { descriptor: current, action: null };
    if (['connect', 'resume', 'select_resource', 'accept_permissions', 'reconnect'].includes(current.repair_action)) {
      return { descriptor: current, action: current.repair_action, result: await connect(id) };
    }
    if (current.repair_action === 'retry') return { descriptor: await status(id), action: 'retry' };
    throw new Error(`No automatic repair is available for ${id}.`);
  }

  function requireProvider(id) {
    const provider = getConnectionProvider(id, registryDeps);
    if (!provider || !provider.id || typeof provider.status !== 'function') {
      throw new Error(`Unsupported connection provider: ${id}`);
    }
    return provider;
  }

  return Object.freeze({
    providers: () => listConnectionProviders(registryDeps),
    status,
    connect,
    call,
    withGrant,
    repair,
    async disconnect(id) {
      const provider = requireProvider(id);
      if (typeof provider.disconnect !== 'function') {
        throw new Error(`${provider.label} disconnect is not available in this release.`);
      }
      if (provider.custody !== 'control_plane') return provider.disconnect();
      return identity.withGrant(
        { provider: id, purpose: 'connection' },
        ({ token, apiUrl }) => provider.disconnect({ grant: token, apiUrl, memoroFetch: fetch }),
      );
    },
  });
}
