export const CONNECTION_STATES = Object.freeze([
  'unsupported', 'disconnected', 'connecting', 'ready',
  'resource_not_selected', 'permission_missing', 'suspended',
  'revoked', 'unavailable',
]);

export const REPAIR_ACTIONS = Object.freeze([
  'connect', 'resume', 'select_resource', 'accept_permissions',
  'reconnect', 'retry', 'contact_admin',
]);

const CUSTODY = new Set(['control_plane', 'native_runtime', 'workload']);
const EFFECTS = new Set(['read', 'write']);
const FORBIDDEN_KEY = /(token|secret|credential|authorization|cookie|private_key|url|path|executable)/i;
const ID_RE = /^[a-z][a-z0-9._-]{0,63}$/;

export function decodeConnectionDescriptor(value, { providerId = null } = {}) {
  if (!plain(value) || value.schema !== 1 || Object.keys(value).some((key) => (
    !['schema', 'provider', 'state', 'repair_action', 'account', 'resources', 'sources', 'capabilities'].includes(key)
  ))) return null;
  if (containsForbiddenKey(value)) return null;
  const provider = value.provider;
  if (!plain(provider) || !ID_RE.test(provider.id || '') || provider.id !== (providerId || provider.id)
      || typeof provider.label !== 'string' || !provider.label
      || !CUSTODY.has(provider.custody)) return null;
  if (!CONNECTION_STATES.includes(value.state)) return null;
  if (value.repair_action !== null && !REPAIR_ACTIONS.includes(value.repair_action)) return null;
  if (value.account !== null && (!plain(value.account)
      || typeof value.account.id !== 'string' || !value.account.id
      || typeof value.account.label !== 'string' || !value.account.label)) return null;
  if (!Array.isArray(value.resources) || !value.resources.every(validResource)) return null;
  if (!plain(value.sources)
      || !['local', 'cloud'].every((key) => CONNECTION_STATES.includes(value.sources[key]))
      || Object.keys(value.sources).some((key) => !['local', 'cloud'].includes(key))) return null;
  if (!Array.isArray(value.capabilities) || !value.capabilities.every((item) => (
    plain(item) && Object.keys(item).every((key) => ['name', 'effect'].includes(key))
      && ID_RE.test(item.name || '') && EFFECTS.has(item.effect)
  ))) return null;
  return structuredClone(value);
}

export function decodeBrokerGrant(value, { provider, purpose, codingSessionId = null } = {}) {
  if (!plain(value) || value.ok !== true || value.schema !== 1
      || typeof value.grant !== 'string' || !/^mcg_[a-f0-9]{64}$/.test(value.grant)
      || value.provider !== provider || value.purpose !== purpose
      || (value.coding_session_id ?? null) !== codingSessionId
      || !Number.isFinite(Date.parse(value.expires_at))
      || !Array.isArray(value.capability_families)
      || !value.capability_families.every((item) => typeof item === 'string')) return null;
  return {
    token: value.grant,
    expiresAt: value.expires_at,
    source: structuredClone(value.source),
    capabilityFamilies: [...value.capability_families],
    resource: value.resource ? structuredClone(value.resource) : null,
  };
}

function validResource(value) {
  return plain(value)
    && typeof value.id === 'string' && value.id
    && typeof value.label === 'string' && value.label
    && Object.keys(value).every((key) => ['id', 'label', 'selected'].includes(key))
    && (value.selected === undefined || typeof value.selected === 'boolean');
}

function containsForbiddenKey(value) {
  if (Array.isArray(value)) return value.some(containsForbiddenKey);
  if (!plain(value)) return false;
  return Object.entries(value).some(([key, child]) => FORBIDDEN_KEY.test(key) || containsForbiddenKey(child));
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
