import { constants } from 'node:fs';
import { lstat, open, readdir, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { mcHome } from '../../mc/paths.js';

const MANIFEST_RE = /^.+-materialised\.json$/;
const MAX_MANIFEST_BYTES = 256 * 1024;
const TOP_KEYS = new Set(['schema', 'sessionId', 'createdAt', 'materialised', 'hooks']);
const ENTRY_KEYS = new Set(['tool', 'label', 'location']);
const LOCATION_KEYS = new Set(['type', 'path', 'name', 'source', 'keys', 'labels']);
const HOOK_KEYS = new Set(['hookScriptPath', 'installedSettingsPath', 'settingsCreated']);

export function vaultManifestDir() {
  return join(mcHome(), 'state');
}

export async function auditVaultExposure({ cleanup = false, deps = {} } = {}) {
  const list = deps.readdir || readdir;
  const inspect = deps.lstat || lstat;
  const readManifest = deps.readManifest || readManifestNoFollow;
  const remove = deps.unlink || unlink;
  const dir = deps.stateDir || vaultManifestDir();
  let entries;
  try {
    entries = await list(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return emptyResult(cleanup);
    return { ...emptyResult(cleanup), ok: false, errors: [{ code: 'state-unreadable' }] };
  }

  const manifests = [];
  for (const entry of entries) {
    if (!MANIFEST_RE.test(entry.name)) continue;
    if (!entry.isFile()) {
      manifests.push(invalid(entry.name, entry.isSymbolicLink() ? 'manifest-symlink' : 'manifest-not-file'));
      continue;
    }
    manifests.push(await auditManifest(join(dir, entry.name), {
      cleanup, inspect, readManifest, remove,
    }));
  }
  return {
    ok: manifests.every((m) => m.ok),
    cleanup,
    manifests,
    summary: {
      manifests: manifests.length,
      artifacts: manifests.reduce((n, m) => n + m.artifacts.length, 0),
      leftovers: manifests.reduce((n, m) => n + m.artifacts.filter((a) => a.state !== 'absent').length, 0),
      cleaned_manifests: manifests.filter((m) => m.cleanup_state === 'removed').length,
      uncertain: manifests.filter((m) => m.cleanup_state === 'uncertain').length,
    },
    errors: manifests.filter((m) => !m.ok).map((m) => ({ manifest: m.manifest, code: m.error })),
  };
}

async function auditManifest(path, { cleanup, inspect, readManifest, remove }) {
  const name = basename(path);
  try {
    const raw = await readManifest(path);
    const validated = validateManifest(JSON.parse(raw));
    if (!validated.ok) return invalid(name, validated.error);

    const artifacts = [];
    for (const item of validated.value.materialised) {
      artifacts.push(await inspectArtifact({
        kind: item.tool === 'repo' ? 'repo-binding' : 'tool-credential',
        tool: item.tool,
        label: item.label,
        destination: item.location.path || item.location.name || null,
        binding_type: item.location.type || null,
      }, inspect));
    }
    for (const [kind, destination] of [
      ['hook-script', validated.value.hooks?.hookScriptPath],
      ['hook-settings', validated.value.hooks?.installedSettingsPath],
    ]) {
      if (destination) artifacts.push(await inspectArtifact({
        kind, tool: 'claude', label: null, destination, binding_type: 'file',
      }, inspect));
    }

    let cleanupState = cleanup ? 'uncertain' : 'not-requested';
    if (cleanup
      && artifacts.every((artifact) => artifact.state === 'absent')
      && await destinationsStillAbsent(artifacts, inspect)) {
      await remove(path);
      cleanupState = 'removed';
    }
    return {
      ok: true,
      manifest: name,
      session_id: validated.value.sessionId,
      created_at: validated.value.createdAt,
      artifacts,
      cleanup_state: cleanupState,
    };
  } catch (err) {
    return invalid(name, err?.code === 'ENOENT' ? 'manifest-raced' : 'manifest-unreadable');
  }
}

async function readManifestNoFollow(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) {
      const error = new Error('manifest-invalid-size');
      error.code = 'MANIFEST_INVALID_SIZE';
      throw error;
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function destinationsStillAbsent(artifacts, inspect) {
  for (const artifact of artifacts) {
    if (!artifact.destination) return false;
    try {
      await inspect(artifact.destination);
      return false;
    } catch (err) {
      if (err?.code !== 'ENOENT') return false;
    }
  }
  return true;
}

async function inspectArtifact(metadata, inspect) {
  if (!metadata.destination) return { ...metadata, state: 'unknown' };
  if (metadata.binding_type === 'env' || metadata.kind === 'hook-settings') {
    return { ...metadata, state: 'unknown' };
  }
  try {
    const info = await inspect(metadata.destination);
    return { ...metadata, state: info.isSymbolicLink() ? 'symlink' : 'leftover' };
  } catch (err) {
    return { ...metadata, state: err?.code === 'ENOENT' ? 'absent' : 'unknown' };
  }
}

function validateManifest(value) {
  if (!plain(value) || unknown(value, TOP_KEYS)) return { ok: false, error: 'manifest-invalid-shape' };
  if (value.schema !== 1 || !safe(value.sessionId) || !Array.isArray(value.materialised)) {
    return { ok: false, error: 'manifest-invalid-shape' };
  }
  if (value.createdAt != null && !safe(value.createdAt)) return { ok: false, error: 'manifest-invalid-shape' };
  if (value.hooks != null && (!plain(value.hooks) || unknown(value.hooks, HOOK_KEYS))) {
    return { ok: false, error: 'manifest-invalid-hooks' };
  }
  const materialised = [];
  for (const item of value.materialised) {
    if (!plain(item) || unknown(item, ENTRY_KEYS) || !safe(item.tool) || !safe(item.label) || !plain(item.location)) {
      return { ok: false, error: 'manifest-invalid-entry' };
    }
    if (unknown(item.location, LOCATION_KEYS)) return { ok: false, error: 'manifest-invalid-location' };
    const location = {};
    for (const key of ['type', 'path', 'name', 'source']) {
      if (item.location[key] != null) {
        if (!safe(item.location[key])) return { ok: false, error: 'manifest-invalid-location' };
        location[key] = item.location[key];
      }
    }
    for (const key of ['keys', 'labels']) {
      if (item.location[key] != null) {
        if (!Array.isArray(item.location[key]) || !item.location[key].every(safe)) {
          return { ok: false, error: 'manifest-invalid-location' };
        }
        location[key] = [...item.location[key]];
      }
    }
    materialised.push({ tool: item.tool, label: item.label, location });
  }
  return {
    ok: true,
    value: {
      sessionId: value.sessionId,
      createdAt: value.createdAt || null,
      materialised,
      hooks: value.hooks ? {
        hookScriptPath: safe(value.hooks.hookScriptPath) ? value.hooks.hookScriptPath : null,
        installedSettingsPath: safe(value.hooks.installedSettingsPath) ? value.hooks.installedSettingsPath : null,
      } : null,
    },
  };
}

function emptyResult(cleanup) {
  return {
    ok: true,
    cleanup,
    manifests: [],
    summary: { manifests: 0, artifacts: 0, leftovers: 0, cleaned_manifests: 0, uncertain: 0 },
    errors: [],
  };
}

function invalid(manifest, error) {
  return {
    ok: false, manifest, session_id: null, created_at: null, artifacts: [], cleanup_state: 'uncertain', error,
  };
}

function plain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function unknown(value, allowlist) {
  return Object.keys(value).some((key) => !allowlist.has(key));
}

function safe(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096;
}
