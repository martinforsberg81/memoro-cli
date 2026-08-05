import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  inspectSessionCatalogSync,
  listSessionHomesSync,
  repairSessionCatalogSync,
} from './session-home.js';
import { sessionHomePaths } from './session-home-paths.js';
import { MC_SESSION_ID_RE } from './session-home-schema.js';
import { inspectPrivateDirectoryChainSync } from './private-state.js';
import { readRuntimeHostManifestSync } from '../runtime/session-host/ephemeral-state.js';

export function inspectSessionRuntimeArtifactsSync({
  mcHomeDir,
  mcSessionId,
  processIsAlive = defaultProcessIsAlive,
} = {}) {
  const paths = sessionHomePaths({ mcHomeDir, mcSessionId });
  const safety = inspectPrivateDirectoryChainSync({
    trustedRoot: paths.mcHomeDir,
    directory: paths.ephemeralRunPath,
  });
  if (!safety.ok) {
    return safety.missing
      ? { state: 'absent', mc_session_id: mcSessionId, path: paths.ephemeralRunPath }
      : { state: 'unsafe', mc_session_id: mcSessionId, path: paths.ephemeralRunPath, reason: safety.reason };
  }
  const manifest = readRuntimeHostManifestSync({ mcHomeDir: paths.mcHomeDir, mcSessionId });
  if (manifest.kind !== 'present') {
    return {
      state: 'unsafe',
      mc_session_id: mcSessionId,
      path: paths.ephemeralRunPath,
      reason: manifest.reason || 'runtime-host-manifest-missing',
    };
  }
  const activeState = ['starting', 'live'].includes(manifest.value.state);
  const hostAlive = processIsAlive(manifest.value.host_pid);
  if (hostAlive) {
    return {
      state: 'active',
      mc_session_id: mcSessionId,
      path: paths.ephemeralRunPath,
      host_state: manifest.value.state,
      host_pid: manifest.value.host_pid,
      host_alive: hostAlive,
    };
  }
  if (activeState) {
    // The manifest says the host is starting or live and the host process is
    // gone: it crashed, was killed, or the machine lost power. That is stale
    // bookkeeping, not a live runtime to protect — and calling it unsafe made
    // `mc end` refuse a session whose terminal had simply been closed, with
    // nothing able to clear it. `unsafe` is for a state mc cannot read, which
    // this is not: the process table already answered.
    return {
      state: 'stale',
      mc_session_id: mcSessionId,
      path: paths.ephemeralRunPath,
      host_state: manifest.value.state,
      host_pid: manifest.value.host_pid,
      updated_at: manifest.value.updated_at,
      reason: 'runtime-host-process-absent',
    };
  }
  return {
    state: 'stale',
    mc_session_id: mcSessionId,
    path: paths.ephemeralRunPath,
    host_state: manifest.value.state,
    host_pid: manifest.value.host_pid,
    updated_at: manifest.value.updated_at,
  };
}

export function removeStaleSessionRuntimeArtifactsSync(options = {}) {
  const inspected = inspectSessionRuntimeArtifactsSync(options);
  if (inspected.state === 'absent') return { ok: true, removed: false, ...inspected };
  if (inspected.state !== 'stale') {
    return { ok: false, removed: false, ...inspected, reason: inspected.reason || 'runtime-artifacts-not-stale' };
  }
  rmSync(inspected.path, { recursive: true, force: false });
  return { ok: true, removed: true, ...inspected };
}

export function scanSessionMaintenanceSync({
  mcHomeDir,
  processIsAlive = defaultProcessIsAlive,
} = {}) {
  const catalog = inspectSessionCatalogSync({ mcHomeDir });
  const listed = listSessionHomesSync({ mcHomeDir });
  const known = new Set(listed.sessions.map((session) => session.mc_session_id));
  const root = join(sessionHomePaths({ mcHomeDir }).runRoot, 'sessions');
  const safety = inspectPrivateDirectoryChainSync({
    trustedRoot: sessionHomePaths({ mcHomeDir }).mcHomeDir,
    directory: root,
  });
  const runtime = [];
  const issues = [...(catalog.issues || [])];
  if (safety.ok) {
    let names = [];
    try { names = readdirSync(root).sort(); } catch { issues.push({ scope: 'runtime', reason: 'unreadable-run-root' }); }
    for (const name of names) {
      if (!MC_SESSION_ID_RE.test(name)) {
        issues.push({ scope: 'runtime', entry: name, reason: 'unexpected-runtime-entry' });
        continue;
      }
      let stat;
      try { stat = lstatSync(join(root, name)); } catch { stat = null; }
      if (!stat?.isDirectory() || stat.isSymbolicLink()) {
        issues.push({ scope: 'runtime', mc_session_id: name, reason: 'unsafe-runtime-entry' });
        continue;
      }
      const item = inspectSessionRuntimeArtifactsSync({ mcHomeDir, mcSessionId: name, processIsAlive });
      const sessionPresent = known.has(name);
      runtime.push({ ...item, session_present: sessionPresent });
      if (!sessionPresent) {
        issues.push({ scope: 'runtime', mc_session_id: name, reason: 'runtime-session-absent' });
      }
      if (item.state === 'unsafe') {
        issues.push({ scope: 'runtime', mc_session_id: name, reason: item.reason });
      }
    }
  } else if (!safety.missing) {
    issues.push({ scope: 'runtime', reason: safety.reason });
  }
  return {
    ok: issues.length === 0,
    catalog,
    runtime,
    issues,
    summary: {
      sessions: listed.sessions.length,
      archived: listed.sessions.filter((item) => item.projection.lifecycle === 'archived').length,
      runtime_active: runtime.filter((item) => item.state === 'active').length,
      runtime_stale: runtime.filter((item) => item.state === 'stale').length,
      runtime_unsafe: runtime.filter((item) => item.state === 'unsafe').length,
    },
  };
}

export function repairSessionMaintenanceSync({
  mcHomeDir,
  apply = false,
  processIsAlive = defaultProcessIsAlive,
} = {}) {
  const before = scanSessionMaintenanceSync({ mcHomeDir, processIsAlive });
  if (!apply) {
    return {
      ...before,
      applied: false,
      actions: [
        ...(before.catalog.actions || []),
        ...before.runtime.filter((item) => item.state === 'stale').map((item) => ({
          action: 'remove-stale-runtime-artifacts',
          mc_session_id: item.mc_session_id,
          safe: true,
        })),
      ],
    };
  }
  const catalog = repairSessionCatalogSync({ mcHomeDir, apply: true });
  const runtime = [];
  for (const item of before.runtime.filter((entry) => entry.state === 'stale')) {
    runtime.push(removeStaleSessionRuntimeArtifactsSync({
      mcHomeDir,
      mcSessionId: item.mc_session_id,
      processIsAlive,
    }));
  }
  const after = scanSessionMaintenanceSync({ mcHomeDir, processIsAlive });
  return {
    ...after,
    ok: catalog.ok && runtime.every((item) => item.ok) && after.issues.length === 0,
    applied: true,
    catalog_result: catalog,
    runtime_results: runtime,
  };
}

function defaultProcessIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}
