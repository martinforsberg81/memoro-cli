import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { posix as pathPosix } from 'node:path';
import { tmpdir } from 'node:os';

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILES = 20_000;
const SNAPSHOT_ID_RE = /^cbsnap_[a-z0-9_-]{6,}$/i;
export const SNAPSHOT_MANIFEST_PATH = '.mc-coding-bin-snapshot.json';
export const SNAPSHOT_MANIFEST_VERSION = 2;

export async function restoreCodingBinSnapshot(snapshot, {
  root,
  token,
  fetchImpl = globalThis.fetch,
  extractArchive = extractTarZstdArchive,
  tempDir = tmpdir(),
  now = () => new Date().toISOString(),
} = {}) {
  const payload = snapshot?.payload && typeof snapshot.payload === 'object' ? snapshot.payload : null;
  const url = typeof payload?.url === 'string' && payload.url.trim() ? payload.url.trim() : null;
  if (!url) return { ok: true, skipped: true, reason: 'no_payload_url' };
  if (!root || typeof root !== 'string') return { ok: false, error: 'restore root missing' };
  if (!token || typeof token !== 'string') return { ok: false, error: 'runtime token missing' };
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch unavailable' };

  await mkdir(root, { recursive: true });
  const startedAt = now();
  const res = await fetchImpl(url, {
    method: payload.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: payload.content_type || 'application/zstd',
    },
  });
  if (!res?.ok) {
    return { ok: false, error: `snapshot download failed: HTTP ${res?.status || 'unknown'}`, status: res?.status || null };
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) return { ok: false, error: 'snapshot payload is empty' };

  const path = join(tempDir, `${safeSnapshotFileId(snapshot.id)}.tar.zst`);
  await writeFile(path, bytes, { mode: 0o600 });
  try {
    const extracted = await extractArchive({ archivePath: path, root });
    if (!extracted?.ok) return { ok: false, error: extracted?.error || 'snapshot extract failed' };
    const applied = await applySnapshotManifest(root, {
      rmImpl: extracted.rmImpl || rm,
      readFileImpl: extracted.readFileImpl || readFile,
    });
    if (!applied.ok) return { ok: false, error: applied.error || 'snapshot manifest apply failed' };
    return {
      ok: true,
      restored: true,
      snapshot_id: snapshot.id || null,
      byte_count: bytes.byteLength,
      manifest_version: applied.manifest_version,
      deleted_count: applied.deleted_count,
      started_at: startedAt,
      restored_at: now(),
    };
  } finally {
    await rm(path, { force: true }).catch(() => {});
  }
}

function safeSnapshotFileId(value) {
  const id = typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
    ? value
    : 'coding-bin-snapshot';
  return id;
}

export async function captureCodingBinSnapshot(policy, {
  root,
  token,
  fetchImpl = globalThis.fetch,
  createArchive = createTarZstdArchive,
  collectFiles = collectCodingBinSnapshotFiles,
  tempDir = tmpdir(),
  now = () => new Date().toISOString(),
  makeSnapshotId = defaultSnapshotId,
  spawn = spawnSync,
} = {}) {
  if (!policy?.enabled) return { ok: true, skipped: true, reason: 'snapshot_disabled' };
  const upload = policy.upload && typeof policy.upload === 'object' ? policy.upload : null;
  const urlTemplate = typeof upload?.url_template === 'string' && upload.url_template.trim()
    ? upload.url_template.trim()
    : null;
  if (!urlTemplate) return { ok: true, skipped: true, reason: 'upload_url_missing' };
  if (!root || typeof root !== 'string') return { ok: false, error: 'snapshot root missing' };
  if (!token || typeof token !== 'string') return { ok: false, error: 'runtime token missing' };
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch unavailable' };

  const snapshotId = normalizeSnapshotId(makeSnapshotId());
  const startedAt = now();
  const maxBytes = positiveInteger(policy.max_bytes, DEFAULT_MAX_BYTES);
  const maxFiles = positiveInteger(policy.max_files, DEFAULT_MAX_FILES);
  const archivePath = join(tempDir, `${snapshotId}.tar.zst`);
  const listPath = join(tempDir, `${snapshotId}.files`);

  try {
    await mkdir(tempDir, { recursive: true });
    const listed = await collectFiles(root, { policy, maxFiles });
    if (!listed.ok) return { ok: false, snapshot_id: snapshotId, error: listed.error || 'snapshot file collection failed' };
    const refs = await readGitSnapshotState(root, { policy, spawn });
    if (listed.files.length === 0 && refs.deleted_paths.length === 0) {
      return { ok: true, skipped: true, reason: 'no_snapshot_files', snapshot_id: snapshotId };
    }

    const manifest = buildSnapshotManifest({
      snapshotId,
      root,
      policy,
      files: listed.file_entries || listed.files.map((path) => ({ path })),
      skippedCount: listed.skipped_count,
      refs,
      capturedAt: startedAt,
    });
    await writeFile(join(root, SNAPSHOT_MANIFEST_PATH), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    const archiveFiles = [...listed.files, SNAPSHOT_MANIFEST_PATH];
    await writeFile(listPath, Buffer.from(archiveFiles.join('\0') + '\0', 'utf8'), { mode: 0o600 });
    const archived = await createArchive({ root, archivePath, listPath });
    if (!archived?.ok) return { ok: false, snapshot_id: snapshotId, error: archived?.error || 'snapshot archive failed' };

    const info = await stat(archivePath);
    if (!info.isFile() || info.size <= 0) return { ok: false, snapshot_id: snapshotId, error: 'snapshot archive is empty' };
    if (info.size > maxBytes) {
      return {
        ok: false,
        snapshot_id: snapshotId,
        error: `snapshot archive exceeds ${maxBytes} bytes`,
        byte_count: info.size,
        file_count: listed.files.length,
        skipped_count: listed.skipped_count,
      };
    }

    const archive = await readFile(archivePath);
    const uploadUrl = urlTemplate.replace('{snapshot_id}', encodeURIComponent(snapshotId));
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': upload.content_type || 'application/zstd',
      'Content-Length': String(archive.byteLength),
      'X-MC-Snapshot-File-Count': String(listed.files.length),
      'X-MC-Snapshot-Skipped-Count': String(listed.skipped_count),
    };
    if (refs.base_ref) headers['X-MC-Snapshot-Base-Ref'] = refs.base_ref;
    if (refs.head_ref) headers['X-MC-Snapshot-Head-Ref'] = refs.head_ref;

    const res = await fetchImpl(uploadUrl, {
      method: upload.method || 'PUT',
      headers,
      body: archive,
    });
    if (!res?.ok) {
      const text = typeof res?.text === 'function' ? await res.text().catch(() => '') : '';
      return {
        ok: false,
        snapshot_id: snapshotId,
        error: `snapshot upload failed: HTTP ${res?.status || 'unknown'}${text ? ` ${text.slice(0, 160)}` : ''}`,
        status: res?.status || null,
        byte_count: archive.byteLength,
        file_count: listed.files.length,
        skipped_count: listed.skipped_count,
      };
    }

    return {
      ok: true,
      uploaded: true,
      snapshot_id: snapshotId,
      byte_count: archive.byteLength,
      file_count: listed.files.length,
      skipped_count: listed.skipped_count,
      base_ref: refs.base_ref,
      head_ref: refs.head_ref,
      manifest_version: SNAPSHOT_MANIFEST_VERSION,
      deleted_count: refs.deleted_paths.length,
      started_at: startedAt,
      uploaded_at: now(),
    };
  } finally {
    await rm(join(root || '', SNAPSHOT_MANIFEST_PATH), { force: true }).catch(() => {});
    await rm(archivePath, { force: true }).catch(() => {});
    await rm(listPath, { force: true }).catch(() => {});
  }
}

export async function collectCodingBinSnapshotFiles(root, {
  policy = {},
  maxFiles = DEFAULT_MAX_FILES,
  readdirImpl = readdir,
} = {}) {
  if (!root || typeof root !== 'string') return { ok: false, error: 'snapshot root missing' };
  const excludes = buildExcludeMatcher(policy.exclude);
  const files = [];
  let skipped = 0;

  async function walk(relativeDir = '') {
    let entries;
    try {
      entries = await readdirImpl(join(root, relativeDir), { withFileTypes: true });
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = normalizeRelativePath(pathPosix.join(relativeDir.split(/[\\/]+/).filter(Boolean).join('/'), entry.name));
      if (!relative || excludes(relative, entry.isDirectory())) {
        skipped += 1;
        continue;
      }
      if (entry.isSymbolicLink()) {
        skipped += 1;
        continue;
      }
      if (entry.isDirectory()) {
        const next = await walk(relative);
        if (!next.ok) return next;
        continue;
      }
      if (!entry.isFile()) {
        skipped += 1;
        continue;
      }
      if (files.length >= maxFiles) {
        skipped += 1;
        continue;
      }
      files.push(relative);
    }
    return { ok: true };
  }

  const walked = await walk('');
  if (!walked.ok) return walked;
  const fileEntries = await Promise.all(files.map(async (path) => {
    const info = await stat(join(root, path)).catch(() => null);
    return {
      path,
      size: info?.isFile?.() ? info.size : null,
    };
  }));
  return { ok: true, files, file_entries: fileEntries, skipped_count: skipped };
}

export async function createTarZstdArchive({ archivePath, root, listPath, spawn = spawnSync } = {}) {
  if (!archivePath || !root || !listPath) return { ok: false, error: 'archivePath, root, and listPath are required' };
  const res = spawn('tar', ['--zstd', '--null', '-cf', archivePath, '-C', root, '-T', listPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.status !== 0) {
    return {
      ok: false,
      error: (res.stderr || res.stdout || `tar exited ${res.status}`).trim(),
      exit_code: res.status,
    };
  }
  return { ok: true, spawn };
}

export async function extractTarZstdArchive({ archivePath, root, spawn = spawnSync } = {}) {
  if (!archivePath || !root) return { ok: false, error: 'archivePath and root are required' };
  const res = spawn('tar', ['--zstd', '-xf', archivePath, '-C', root], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.status !== 0) {
    return {
      ok: false,
      error: (res.stderr || res.stdout || `tar exited ${res.status}`).trim(),
      exit_code: res.status,
    };
  }
  return { ok: true };
}

async function readGitSnapshotState(root, { policy = {}, spawn = spawnSync } = {}) {
  const excludes = buildExcludeMatcher(policy.exclude);
  return {
    base_ref: gitOutput(root, ['rev-parse', '--abbrev-ref', 'HEAD'], spawn),
    head_ref: gitOutput(root, ['rev-parse', 'HEAD'], spawn),
    deleted_paths: gitDeletedPaths(root, spawn).filter((path) => !excludes(path, false)),
  };
}

function gitOutput(root, args, spawn) {
  const res = spawn('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.status !== 0) return null;
  const out = String(res.stdout || '').trim();
  return out && out !== 'HEAD' ? out.slice(0, 256) : out || null;
}

function gitDeletedPaths(root, spawn) {
  const res = spawn('git', ['ls-files', '-d', '-z'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.status !== 0) return [];
  return String(res.stdout || '')
    .split('\0')
    .map(normalizeRelativePath)
    .filter(Boolean)
    .filter(isSafeSnapshotPath);
}

function buildSnapshotManifest({
  snapshotId,
  policy,
  files,
  skippedCount,
  refs,
  capturedAt,
} = {}) {
  return {
    manifest_version: SNAPSHOT_MANIFEST_VERSION,
    snapshot_id: snapshotId,
    format: 'tar.zst',
    captured_at: capturedAt || null,
    git: {
      base_ref: refs?.base_ref || null,
      head_ref: refs?.head_ref || null,
    },
    files: (Array.isArray(files) ? files : [])
      .map((file) => ({
        path: normalizeRelativePath(file?.path),
        size: Number.isInteger(file?.size) && file.size >= 0 ? file.size : null,
      }))
      .filter((file) => file.path && isSafeSnapshotPath(file.path)),
    deleted_paths: (Array.isArray(refs?.deleted_paths) ? refs.deleted_paths : [])
      .map(normalizeRelativePath)
      .filter(Boolean)
      .filter((path) => isSafeSnapshotPath(path) && !buildExcludeMatcher(policy?.exclude)(path, false)),
    skipped_count: Number.isInteger(skippedCount) && skippedCount >= 0 ? skippedCount : 0,
  };
}

async function applySnapshotManifest(root, {
  readFileImpl = readFile,
  rmImpl = rm,
} = {}) {
  const manifestPath = join(root, SNAPSHOT_MANIFEST_PATH);
  let manifest = null;
  let raw = null;
  try {
    raw = await readFileImpl(manifestPath, 'utf8');
  } catch {
    return { ok: true, skipped: true, reason: 'manifest_missing', manifest_version: null, deleted_count: 0 };
  }
  try {
    manifest = JSON.parse(raw);
  } catch {
    await rmImpl(manifestPath, { force: true }).catch(() => {});
    return { ok: false, error: 'snapshot manifest is invalid JSON' };
  }

  const version = Number.isInteger(manifest?.manifest_version) ? manifest.manifest_version : null;
  const deletedPaths = Array.isArray(manifest?.deleted_paths) ? manifest.deleted_paths : [];
  let deletedCount = 0;
  for (const path of deletedPaths) {
    const relative = normalizeRelativePath(path);
    if (!isSafeSnapshotDeletionPath(relative)) continue;
    await rmImpl(join(root, relative), { force: true }).then(() => {
      deletedCount += 1;
    }).catch(() => {});
  }
  await rmImpl(manifestPath, { force: true }).catch(() => {});
  return {
    ok: true,
    manifest_version: version,
    deleted_count: deletedCount,
  };
}

function buildExcludeMatcher(exclude = {}) {
  const rawPaths = Array.isArray(exclude.paths) ? exclude.paths : [];
  const rawGlobs = Array.isArray(exclude.globs) ? exclude.globs : [];
  const pathMatchers = rawPaths.map((value) => normalizeRelativePath(value)).filter(Boolean);
  const globMatchers = [...rawPaths.filter((value) => String(value).includes('*')), ...rawGlobs]
    .map((value) => globToRegExp(normalizeRelativePath(value)))
    .filter(Boolean);

  return (relative, isDirectory = false) => {
    const rel = normalizeRelativePath(relative);
    if (!rel) return false;
    for (const path of pathMatchers) {
      if (path.includes('*')) continue;
      if (rel === path || rel.startsWith(`${path}/`)) return true;
      if (!isDirectory && rel.split('/').includes(path)) return true;
    }
    return globMatchers.some((matcher) => matcher.test(rel));
  };
}

function globToRegExp(glob) {
  if (!glob) return null;
  let source = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        source += slash ? '(?:.*\\/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        source += '[^/]*';
      }
      continue;
    }
    source += escapeRegExp(char);
  }
  source += '$';
  return new RegExp(source);
}

function normalizeRelativePath(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter((part) => part && part !== '.')
    .join('/');
}

function isSafeSnapshotPath(relative) {
  const rel = normalizeRelativePath(relative);
  if (!rel || rel.includes('..')) return false;
  if (rel === '.git' || rel.startsWith('.git/')) return false;
  return true;
}

function isSafeSnapshotDeletionPath(relative) {
  const rel = normalizeRelativePath(relative);
  if (!isSafeSnapshotPath(rel)) return false;
  const parts = rel.split('/');
  if (['.memoro', '.mc', '.codex', '.claude'].includes(parts[0])) return false;
  if (parts.some((part) => /^\.env(?:\.|$)/.test(part))) return false;
  if (parts.some((part) => /token|secret|credential/i.test(part))) return false;
  if (/auth.*\.json$/i.test(parts.at(-1) || '')) return false;
  if (['id_rsa', 'id_ed25519'].includes(parts.at(-1) || '')) return false;
  return true;
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeSnapshotId(value) {
  return typeof value === 'string' && SNAPSHOT_ID_RE.test(value) ? value : defaultSnapshotId();
}

function defaultSnapshotId() {
  return `cbsnap_${randomBytes(9).toString('hex')}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}
