import * as claude from '../../adapters/claude-code.js';
import * as codex from '../../adapters/codex.js';
import {
  decodeGitHubConnectResponse,
  decodeGitHubConnectionResponse,
  githubOperationEffect,
} from '../github/github-contract.js';
import { decodeConnectionDescriptor } from './contract.js';

const DEFINITIONS = Object.freeze([
  controlPlaneGitHub(),
  nativeTool('codex', 'Codex CLI', codex),
  nativeTool('claude', 'Claude Code', claude),
]);

export function listConnectionProviders({ providers = DEFINITIONS } = {}) {
  return providers.filter(validateProviderDefinition).map(publicProvider);
}

export function getConnectionProvider(id, { providers = DEFINITIONS } = {}) {
  const provider = providers.find((candidate) => candidate.id === id) || null;
  return validateProviderDefinition(provider) ? provider : null;
}

export function validateProviderDefinition(provider) {
  if (!provider || !/^[a-z][a-z0-9._-]{0,63}$/.test(provider.id || '')
      || typeof provider.label !== 'string'
      || !['control_plane', 'native_runtime', 'workload'].includes(provider.custody)
      || typeof provider.status !== 'function') return false;
  return true;
}

function publicProvider(provider) {
  return {
    id: provider.id,
    label: provider.label,
    custody: provider.custody,
    onboarding: provider.onboarding === true,
  };
}

function controlPlaneGitHub() {
  return {
    id: 'github',
    label: 'GitHub',
    custody: 'control_plane',
    onboarding: true,
    async status({ grant, apiUrl, memoroFetch }) {
      const raw = await this.legacyStatus({ grant, apiUrl, memoroFetch });
      const decoded = decodeGitHubConnectionResponse(raw);
      const github = decoded.github;
      return descriptor(this, {
        state: normalizeGitHubState(github.state),
        repair_action: normalizeGitHubRepair(github.repair_action),
        // The server currently exposes account labels but not a stable account
        // id. A renameable login must not become an authority identifier.
        account: null,
        resources: github.repositories.map((repo) => ({
          id: String(repo.id), label: repo.full_name,
          selected: github.repository?.id === repo.id,
        })),
        capabilities: github.operations.map((name) => ({
          name,
          effect: githubOperationEffect(name),
        })),
      });
    },
    async legacyStatus({ grant, apiUrl, memoroFetch, params = {} }) {
      const repository = typeof params.repository === 'string' ? params.repository : null;
      const path = repository
        ? `/api/mc/github/status?repository=${encodeURIComponent(repository)}`
        : '/api/mc/github/status';
      return memoroFetch(apiUrl, path, { token: grant });
    },
    async repositories({ grant, apiUrl, memoroFetch }) {
      return memoroFetch(apiUrl, '/api/mc/github/repositories', { token: grant });
    },
    async connect({ grant, apiUrl, memoroFetch }) {
      return decodeGitHubConnectResponse(await memoroFetch(
        apiUrl, '/api/mc/github/connect', { token: grant, method: 'POST' },
      ));
    },
  };
}

function nativeTool(id, label, adapter) {
  return {
    id, label, custody: 'native_runtime', onboarding: false,
    async status() {
      const status = await adapter.getStatus();
      const ready = status?.installed && status?.authenticated !== false;
      return descriptor(this, {
        state: ready ? 'ready' : (status?.installed ? 'disconnected' : 'unsupported'),
        repair_action: ready ? null : (status?.installed ? 'connect' : 'contact_admin'),
      });
    },
  };
}

function descriptor(provider, values = {}) {
  return decodeConnectionDescriptor({
    schema: 1,
    provider: { id: provider.id, label: provider.label, custody: provider.custody },
    state: values.state || 'unavailable',
    repair_action: values.repair_action ?? null,
    account: values.account ?? null,
    resources: values.resources || [],
    sources: values.sources || { local: values.state || 'unavailable', cloud: 'unavailable' },
    capabilities: values.capabilities || [],
  }, { providerId: provider.id });
}

function normalizeGitHubState(state) {
  return state === 'repo_not_installed' ? 'resource_not_selected' : state;
}

function normalizeGitHubRepair(action) {
  return {
    continue_connect: 'connect',
    select_repository: 'select_resource',
    update_installation: 'accept_permissions',
    resume_installation: 'resume',
  }[action] || action;
}
