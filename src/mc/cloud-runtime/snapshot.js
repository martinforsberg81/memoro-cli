import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
