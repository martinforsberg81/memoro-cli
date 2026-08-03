import { memoroFetch } from '../../lib/api.js';
import { readSessionHomeSync } from '../../mc/session-home.js';
import {
  listWorkspaceAssociationsSync,
  readWorkspaceAssociationSync,
} from '../../mc/workspace-record.js';

const PROJECTION_TTL_SECONDS = 10 * 60;
const SOURCE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

/**
 * Publish only the expiring facts needed to authorize this exact local
 * session/workspace through the Memoro GitHub App. Local paths, lifecycle
 * authority, tool credentials, and conversation state never leave the
 * machine-owned session home.
 */
export async function publishCertifiedGitHubProjection({
  mcHomeDir,
  mcSessionId,
  generation,
  capabilities,
  portal,
  memoroFetchImpl = memoroFetch,
  deps = {},
} = {}) {
  const workspaceId = generation?.intent?.workspace_id || null;
  if (!/^mcw_[a-f0-9]{24}$/u.test(workspaceId || '')) {
    return failure('certified-github-workspace-required');
  }
  const apiUrl = nonEmpty(portal?.apiUrl);
  const token = nonEmpty(portal?.token);
  if (!apiUrl || !token) {
    return failure('certified-github-projection-identity-unavailable');
  }

  const readSession = deps.readSession || readSessionHomeSync;
  const readWorkspace = deps.readWorkspace || readWorkspaceAssociationSync;
  const listWorkspaces = deps.listWorkspaces || listWorkspaceAssociationsSync;
  let session;
  try {
    session = readSession({ mcHomeDir, mcSessionId });
  } catch {
    return failure('certified-github-session-state-unavailable');
  }
  if (session?.kind !== 'present'
    || session.identity?.mc_session_id !== mcSessionId
    || session.metadata?.mc_session_id !== mcSessionId
    || session.projection?.mc_session_id !== mcSessionId) {
    return failure('certified-github-session-state-unavailable');
  }
  const sourceId = nonEmpty(session.identity?.owner?.source_id);
  if (!SOURCE_ID_RE.test(sourceId || '') || sourceId === 'memoro-cloud') {
    return failure('certified-github-source-invalid');
  }
  let workspaceRead;
  let listed;
  try {
    workspaceRead = readWorkspace({ mcHomeDir, mcSessionId, workspaceId });
    listed = listWorkspaces({ mcHomeDir, mcSessionId });
  } catch {
    return failure('certified-github-workspace-catalog-unavailable');
  }
  const workspace = workspaceRead?.kind === 'present' ? workspaceRead.value : null;
  const repository = capabilities?.github?.repository || null;
  if (!workspace || workspace.mc_session_id !== mcSessionId
    || workspace.workspace_id !== workspaceId
    || workspace.path_state !== 'present') {
    return failure('certified-github-workspace-unavailable');
  }
  if (!Number.isSafeInteger(repository?.id) || repository.id < 1
    || !sameRepository(workspace.repository?.public_ref, repository.full_name)) {
    return failure('certified-github-repository-mismatch');
  }
  if (!Array.isArray(listed?.workspaces) || listed.issues?.length) {
    return failure('certified-github-workspace-catalog-unavailable');
  }
  const projection = session.projection;
  if (projection.lifecycle !== 'open'
    || projection.active_runtime_generation !== generation.intent.generation_id
    || projection.tool !== generation.intent.tool
    || projection.runtime_state !== 'starting') {
    return failure('certified-github-generation-state-mismatch');
  }

  const branch = nonEmpty(workspace.checkout?.branch);
  const sessionBody = {
    source_name: sourceId,
    name: session.metadata.name,
    lifecycle: projection.lifecycle,
    runtime_state: projection.runtime_state,
    work_status: null,
    active_runtime_generation: projection.active_runtime_generation,
    tool: projection.tool,
    workspace_count: listed.workspaces.length,
    preferred_workspace_id: workspaceId,
    repository_label: repository.full_name,
    branch_observation: branch,
    projection_revision: projection.revision,
    observed_at: projection.updated_at,
    ttl_seconds: PROJECTION_TTL_SECONDS,
  };
  const workspaceBody = {
    kind: workspace.kind,
    repository_provider: 'github',
    repository_id: String(repository.id),
    repository_full_name: repository.full_name,
    checkout_ref: nonEmpty(workspace.checkout?.head_sha),
    branch_observation: branch,
    present: true,
    projection_revision: generation.intent.sequence,
    observed_at: generation.intent.recorded_at,
    ttl_seconds: PROJECTION_TTL_SECONDS,
  };
  const sourcePath = encodeURIComponent(sourceId);
  const sessionPath = encodeURIComponent(mcSessionId);
  const workspacePath = encodeURIComponent(workspaceId);
  try {
    const sessionResult = await memoroFetchImpl(
      apiUrl,
      `/api/mc/v1/sources/${sourcePath}/sessions/${sessionPath}/projection`,
      {
        token,
        method: 'PUT',
        sourceId,
        body: sessionBody,
      },
    );
    if (sessionResult?.ok !== true) {
      return failure('certified-github-session-projection-refused');
    }
    const workspaceResult = await memoroFetchImpl(
      apiUrl,
      `/api/mc/v1/sources/${sourcePath}/sessions/${sessionPath}`
        + `/workspaces/${workspacePath}/projection`,
      {
        token,
        method: 'PUT',
        sourceId,
        body: workspaceBody,
      },
    );
    if (workspaceResult?.ok !== true) {
      return failure('certified-github-workspace-projection-refused');
    }
  } catch {
    return failure('certified-github-projection-unavailable');
  }
  return Object.freeze({
    ok: true,
    source_id: sourceId,
    workspace_id: workspaceId,
  });
}

function sameRepository(local, remote) {
  return typeof local === 'string'
    && typeof remote === 'string'
    && local.toLowerCase() === remote.toLowerCase();
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function failure(reason) {
  return { ok: false, reason };
}
