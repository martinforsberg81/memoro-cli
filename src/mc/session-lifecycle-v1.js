import {
  deleteSessionHomeSync,
  readSessionHomeSync,
  writeSessionProjectionSync,
} from './session-home.js';
import {
  abortRuntimeGenerationSync,
  inspectSessionRuntimeSync,
} from './session-runtime-journal.js';
import { listOwnedResourcesSync } from './owned-resource.js';
import { readDevServerInventorySync, teardownV1SessionDevServers } from './dev-servers.js';
import { stopLocalSessionRuntime } from '../runtime/session-host/terminal-client.js';
import {
  inspectSessionRuntimeArtifactsSync,
  removeStaleSessionRuntimeArtifactsSync,
} from './session-maintenance-v1.js';

export async function endLocalSession({
  mcHomeDir,
  session,
  now,
  deps = {},
} = {}) {
  const mcSessionId = session.mc_session_id;
  let runtime = (deps.inspectRuntime || inspectSessionRuntimeSync)({ mcHomeDir, mcSessionId });
  if (runtime.kind !== 'present') return failure(runtime.reason || 'runtime-state-unavailable');
  let runtimeResult = { ok: true, stopped: false, reason: 'already-stopped' };
  if (runtime.active_generation?.phase === 'planned') {
    try {
      (deps.abortGeneration || abortRuntimeGenerationSync)({
        mcHomeDir,
        mcSessionId,
        generationId: runtime.active_generation.intent.generation_id,
        reason: 'session-ended-before-launch',
        ...(now ? { now } : {}),
      });
      runtimeResult = { ok: true, stopped: false, reason: 'planned-generation-aborted' };
    } catch (error) {
      return failure(error?.reason || 'runtime-abort-failed');
    }
  } else if (runtime.active_generation) {
    runtimeResult = await (deps.stopRuntime || stopLocalSessionRuntime)({
      mcHomeDir,
      mcSessionId,
      generationId: runtime.active_generation.intent.generation_id,
      ...(deps.stopOptions || {}),
    });
    if (!runtimeResult.ok) return failure(runtimeResult.reason || 'runtime-stop-failed');
  }
  runtime = await waitForTerminalRuntime({ mcHomeDir, mcSessionId, deps });
  if (runtime.kind !== 'present' || runtime.active_generation !== null) {
    return failure(runtime.reason || 'runtime-terminal-state-unconfirmed');
  }

  let devServers;
  try {
    devServers = await (deps.teardownDevServers || teardownV1SessionDevServers)({
      mcHomeDir,
      mcSessionId,
    }, deps.devServerDeps || {});
  } catch (error) {
    devServers = {
      ok: false,
      reason: error?.reason || 'dev-server-teardown-failed',
      results: [],
    };
  }
  let archived;
  try {
    archived = archiveSessionProjection({ mcHomeDir, mcSessionId, now, deps });
  } catch (error) {
    return failure(error?.reason || 'session-archive-failed');
  }

  const devServerVerification = verifyDevServerTeardown({ mcHomeDir, mcSessionId, deps });

  let runtimeCleanup = inspectSessionRuntimeArtifactsSync({
    mcHomeDir,
    mcSessionId,
    ...(deps.processIsAlive ? { processIsAlive: deps.processIsAlive } : {}),
  });
  if (runtimeCleanup.state === 'stale') {
    runtimeCleanup = (deps.removeRuntimeArtifacts || removeStaleSessionRuntimeArtifactsSync)({
      mcHomeDir,
      mcSessionId,
      ...(deps.processIsAlive ? { processIsAlive: deps.processIsAlive } : {}),
    });
  }
  const runtimeCleanupOk = runtimeCleanup.state !== 'unsafe' && runtimeCleanup.ok !== false;
  const ok = devServers.ok && devServerVerification.ok && runtimeCleanupOk;
  return {
    ok,
    mc_session_id: mcSessionId,
    name: archived.metadata.name,
    lifecycle: archived.projection.lifecycle,
    runtime: runtimeResult,
    dev_servers: devServers,
    dev_server_verification: devServerVerification,
    runtime_cleanup: runtimeCleanup,
    ...(ok ? {} : {
      reason: !devServers.ok || !devServerVerification.ok
        ? 'dev-server-cleanup-incomplete'
        : (runtimeCleanup.reason || 'runtime-artifact-cleanup-incomplete'),
    }),
  };
}

function verifyDevServerTeardown({ mcHomeDir, mcSessionId, deps }) {
  let inventory;
  try {
    inventory = deps.verifyDevServers
      ? deps.verifyDevServers({ mcHomeDir, mcSessionId })
      : readDevServerInventorySync({ mcHomeDir });
  } catch {
    return { ok: false, reason: 'dev-server-state-unsafe' };
  }
  if (!Array.isArray(inventory?.manifests) || (inventory.issues || []).length > 0) {
    return {
      ok: false,
      reason: 'dev-server-state-unsafe',
      issues: inventory?.issues || [],
    };
  }
  // Whether *this* session still has dev servers registered is the only
  // question teardown asks. It used to also require every manifest on the
  // machine to carry a V1 id, so one pre-V1 record — belonging to some other
  // session entirely — made `mc end` fail for every session, forever. Records
  // that belong to nobody are real, and `mc doctor` is where they are
  // reported; they are not this session's exit condition.
  const remaining = inventory.manifests
    .filter((item) => item.mc_session_id === mcSessionId)
    .map((item) => item.instance_id);
  return remaining.length === 0
    ? { ok: true, remaining: [] }
    : { ok: false, reason: 'dev-server-still-registered', remaining };
}

async function waitForTerminalRuntime({ mcHomeDir, mcSessionId, deps }) {
  const inspect = deps.inspectRuntime || inspectSessionRuntimeSync;
  const wait = deps.wait || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutMs = deps.terminalStateTimeoutMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  let runtime = inspect({ mcHomeDir, mcSessionId });
  while (runtime.kind === 'present' && runtime.active_generation !== null && Date.now() < deadline) {
    await wait(Math.min(25, Math.max(1, deadline - Date.now())));
    runtime = inspect({ mcHomeDir, mcSessionId });
  }
  return runtime;
}

/**
 * Bring an archived session back to open.
 *
 * `mc end` archives; it does not destroy — `mc delete` does. So an archived
 * session that the user asks to open again is a resting session being picked
 * back up, not an error. Refusing left the session permanently unusable with
 * no verb to undo it, which made `end` behave like a delete nobody asked for.
 */
export function reopenLocalSession({ mcHomeDir, mcSessionId, now, deps = {} }) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = (deps.readSession || readSessionHomeSync)({ mcHomeDir, mcSessionId });
    if (current.kind !== 'present') throw lifecycleError(current.reason || current.kind);
    if (current.projection.lifecycle === 'open') return current;
    try {
      return (deps.writeProjection || writeSessionProjectionSync)({
        mcHomeDir,
        mcSessionId,
        expectedRevision: current.projection.revision,
        lifecycle: 'open',
        runtimeState: current.projection.runtime_state,
        activeRuntimeGeneration: current.projection.active_runtime_generation,
        tool: current.projection.tool,
        ...(now ? { now } : {}),
      });
    } catch (error) {
      if (error?.reason !== 'projection-revision-conflict' || attempt === 2) throw error;
    }
  }
  throw lifecycleError('projection-revision-conflict');
}

export function deleteLocalSession({
  mcHomeDir,
  session,
  deps = {},
} = {}) {
  const mcSessionId = session.mc_session_id;
  const current = (deps.readSession || readSessionHomeSync)({ mcHomeDir, mcSessionId });
  if (current.kind !== 'present') return failure(current.reason || current.kind);
  if (current.projection.lifecycle !== 'archived') return failure('session-not-archived');
  const runtime = (deps.inspectRuntime || inspectSessionRuntimeSync)({ mcHomeDir, mcSessionId });
  if (runtime.kind !== 'present' || runtime.active_generation !== null) {
    return failure(runtime.reason || 'session-runtime-active');
  }
  const resources = (deps.listResources || listOwnedResourcesSync)({ mcHomeDir, mcSessionId });
  if ((resources.issues || []).length > 0) return failure('session-resource-state-unsafe');
  const pending = resources.resources.filter((item) => item.cleanup_receipt === null);
  if (pending.length > 0) {
    return failure('owned-resource-cleanup-required', {
      resources: pending.map((item) => item.intent.resource_id),
    });
  }
  let devServerInventory;
  try {
    devServerInventory = deps.listDevServers
      ? { manifests: deps.listDevServers({ mcHomeDir }), issues: [] }
      : (deps.readDevServerInventory || readDevServerInventorySync)({ mcHomeDir });
  } catch {
    return failure('session-dev-server-state-unsafe');
  }
  if (!Array.isArray(devServerInventory?.manifests)
    || (devServerInventory.issues || []).length > 0) {
    return failure('session-dev-server-state-unsafe');
  }
  // Deleting one session is not the moment to audit every other session's
  // records. Requiring all of them to carry a V1 id meant a single pre-V1
  // manifest — owned by somebody else, or by nobody — blocked deletion of
  // every session on the machine. What matters here is this session's own
  // dev servers, checked just below.
  if (devServerInventory.manifests.some((item) => item.mc_session_id === mcSessionId)) {
    return failure('session-dev-server-cleanup-required');
  }
  const runtimeArtifacts = inspectSessionRuntimeArtifactsSync({
    mcHomeDir,
    mcSessionId,
    ...(deps.processIsAlive ? { processIsAlive: deps.processIsAlive } : {}),
  });
  if (runtimeArtifacts.state === 'active' || runtimeArtifacts.state === 'unsafe') {
    return failure(runtimeArtifacts.reason || 'session-runtime-artifacts-active');
  }
  if (runtimeArtifacts.state === 'stale') {
    const removed = (deps.removeRuntimeArtifacts || removeStaleSessionRuntimeArtifactsSync)({
      mcHomeDir,
      mcSessionId,
      ...(deps.processIsAlive ? { processIsAlive: deps.processIsAlive } : {}),
    });
    if (!removed.ok) return failure(removed.reason || 'runtime-artifact-cleanup-failed');
  }
  try {
    const deleted = (deps.deleteSession || deleteSessionHomeSync)({
      mcHomeDir,
      mcSessionId,
      expectedMetadataRevision: current.metadata.revision,
      expectedProjectionRevision: current.projection.revision,
    });
    return { ok: true, ...deleted };
  } catch (error) {
    return failure(error?.reason || 'session-delete-failed');
  }
}

function archiveSessionProjection({ mcHomeDir, mcSessionId, now, deps }) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = (deps.readSession || readSessionHomeSync)({ mcHomeDir, mcSessionId });
    if (current.kind !== 'present') throw lifecycleError(current.reason || current.kind);
    if (current.projection.lifecycle === 'archived') return current;
    try {
      return (deps.writeProjection || writeSessionProjectionSync)({
        mcHomeDir,
        mcSessionId,
        expectedRevision: current.projection.revision,
        lifecycle: 'archived',
        runtimeState: current.projection.runtime_state,
        activeRuntimeGeneration: current.projection.active_runtime_generation,
        tool: current.projection.tool,
        ...(now ? { now } : {}),
      });
    } catch (error) {
      if (error?.reason !== 'projection-revision-conflict' || attempt === 2) throw error;
    }
  }
  throw lifecycleError('projection-revision-conflict');
}

function failure(reason, fields = {}) {
  return { ok: false, reason, ...fields };
}

function lifecycleError(reason) {
  const error = new Error(`mc session lifecycle error (${reason})`);
  error.reason = reason;
  return error;
}
