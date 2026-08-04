import { ACCOUNTS } from '../commands/auth.js';
import { memoroFetch } from '../lib/api.js';
import { getApiUrl, readConfig } from '../lib/config.js';
import { getSecret } from '../lib/keychain.js';

export const V1_CLOUD_SOURCE_ID = 'memoro-cloud';

export async function fetchCloudSessionProjections({ argv = [], deps = {} } = {}) {
  const loadConfig = deps.readConfig || readConfig;
  const loadSecret = deps.getSecret || getSecret;
  const fetchJson = deps.memoroFetch || memoroFetch;
  let config = {};
  try { config = await loadConfig(); } catch {}
  const apiUrl = deps.apiUrl || (deps.getApiUrl || getApiUrl)(argv) || config.apiUrl;
  if (!apiUrl) return unavailable('cloud sessions unavailable: no Memoro API URL configured');
  let token;
  try {
    token = Object.hasOwn(deps, 'token') ? deps.token : await loadSecret(ACCOUNTS.TOKEN);
  } catch {
    return unavailable('cloud sessions unavailable: Memoro credentials could not be read');
  }
  if (!token) return unavailable('cloud sessions unavailable: not logged in to Memoro');
  try {
    const source = encodeURIComponent(V1_CLOUD_SOURCE_ID);
    const result = await fetchJson(apiUrl, `/api/mc/v1/sources/${source}/sessions?limit=1000`, {
      token,
    });
    if (result?.ok !== true || !Array.isArray(result.sessions)) {
      return unavailable('cloud sessions unavailable: invalid V1 response');
    }
    return {
      ok: true,
      sessions: result.sessions.map(projectCloudSession).filter(Boolean),
      warning: null,
    };
  } catch (error) {
    return unavailable(`cloud sessions unavailable: ${error?.message || 'request failed'}`);
  }
}

export function projectCloudSession(session) {
  if (!session || session.source_id !== V1_CLOUD_SOURCE_ID || !session.mc_session_id) return null;
  const workspaces = Array.isArray(session.workspaces) ? session.workspaces : [];
  const workspace = workspaces.find((item) => item.preferred_launch) || workspaces[0] || null;
  const generation = plain(session.active_runtime_generation)
    ? session.active_runtime_generation
    : (Array.isArray(session.runtime_generations)
      ? session.runtime_generations.find((item) => (
        item && ['planned', 'starting', 'live', 'stopping'].includes(item.lifecycle)
      )) || null
      : null);
  return {
    source_kind: 'cloud',
    source_id: session.source_id,
    mc_session_id: session.mc_session_id,
    name: session.name,
    objective: session.objective || null,
    lifecycle: session.lifecycle,
    runtime_state: generation?.lifecycle || session.runtime_state || 'unknown',
    runtime_generation: generation?.generation_id || null,
    tool: generation?.tool || session.tool || null,
    updated_at: session.updated_at || null,
    workspace_id: workspace?.workspace_id || null,
    workspace_path: workspace?.current_path || null,
    workspace_state: workspace ? (workspace.present === false ? 'missing' : 'present') : null,
    workspace_count: workspaces.length,
    workspaces,
  };
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unavailable(warning) {
  return { ok: false, sessions: [], warning };
}
