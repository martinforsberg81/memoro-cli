import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { posix as pathPosix } from 'node:path';
import { tmpdir } from 'node:os';

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILES = 20_000;
const SNAPSHOT_ID_RE = /^cbsnap_[a-z0-9_-]{6,}$/i;

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
    return {
      ok: true,
      restored: true,
      snapshot_id: snapshot.id || null,
      byte_count: bytes.byteLength,
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
    if (listed.files.length === 0) {
      return { ok: true, skipped: true, reason: 'no_snapshot_files', snapshot_id: snapshotId };
    }

    await writeFile(listPath, Buffer.from(listed.files.join('\0') + '\0', 'utf8'), { mode: 0o600 });
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
    const refs = await readGitRefs(root, { spawn: archived.spawn || spawnSync });
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
      started_at: startedAt,
      uploaded_at: now(),
    };
  } finally {
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
  return { ok: true, files, skipped_count: skipped };
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

async function readGitRefs(root, { spawn = spawnSync } = {}) {
  return {
    base_ref: gitOutput(root, ['rev-parse', '--abbrev-ref', 'HEAD'], spawn),
    head_ref: gitOutput(root, ['rev-parse', 'HEAD'], spawn),
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
