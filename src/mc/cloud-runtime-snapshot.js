import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { redactCredentialText } from './runtime-redaction.js';

const DEFAULT_RUNTIME_DIR = '/workspace/mc-runtime';
const DEFAULT_REPO_CWD = '/workspace/repo';
const CODING_BIN_SNAPSHOT_ID_RE = /^cbsnap_[a-zA-Z0-9_-]{6,}$/;
const DEFAULT_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_SNAPSHOT_MAX_FILES = 5000;
const SNAPSHOT_MANIFEST_FILE = '.mc-coding-bin-snapshot.json';

export async function restoreCodingBinSnapshot(manifest, {
  env = process.env,
  deps = {},
  token = null,
  cwd = runtimeWorkspaceDir(manifest),
  paths = runtimePaths(manifest, env),
  runtimeGeneration = null,
  authorizationDigest = null,
} = {}) {
  const latest = manifest?.coding_bin?.latest_snapshot || null;
  const payload = latest?.payload || null;
  const url = stringOrNull(payload?.url);
  if (!latest || !url) {
    return { ok: true, restored: false, skipped: true, reason: 'no_latest_snapshot' };
  }
  const snapshotId = normalizeCodingBinSnapshotId(latest.id);
  if (!snapshotId) {
    return { ok: false, restored: false, code: 'invalid_coding_bin_snapshot_id', error: 'invalid coding bin snapshot id' };
  }
  const runtimeToken = token || stringOrNull(env.MEMORO_TOKEN);
  if (!runtimeToken) {
    return { ok: false, restored: false, code: 'runtime_token_missing', error: 'runtime token missing for snapshot restore' };
  }
  const mkdir = deps.mkdir || mkdirSync;
  const writeFile = deps.writeFile || writeFileSync;
  const archivePath = join(paths.dir || DEFAULT_RUNTIME_DIR, `${snapshotId}.restore.tar.zst`);
  mkdir(dirname(archivePath), { recursive: true, mode: 0o700 });

  const downloaded = await downloadSnapshotPayload(url, {
    token: runtimeToken,
    maxBytes: snapshotMaxBytes(manifest),
    runtimeGeneration,
    authorizationDigest,
    deps,
  });
  if (!downloaded.ok) {
    return { ok: false, restored: false, code: downloaded.code || 'snapshot_download_failed', error: downloaded.error || 'snapshot download failed' };
  }
  writeFile(archivePath, downloaded.body, { mode: 0o600 });

  const listed = await listTarArchive(archivePath, { deps, cwd });
  if (!listed.ok) {
    return { ok: false, restored: false, code: 'snapshot_archive_invalid', error: listed.error || 'snapshot archive invalid' };
  }
  const unsafe = listed.entries.find((entry) => !isSafeSnapshotPath(entry));
  if (unsafe) {
    return { ok: false, restored: false, code: 'snapshot_archive_unsafe_path', error: `snapshot archive contains unsafe path: ${unsafe}` };
  }

  const extracted = await extractTarArchive(archivePath, cwd, { deps });
  if (!extracted.ok) {
    return { ok: false, restored: false, code: 'snapshot_extract_failed', error: extracted.error || 'snapshot extract failed' };
  }
  const applied = await applySnapshotManifest(cwd, { deps });
  if (!applied.ok) {
    return { ok: false, restored: false, code: applied.code || 'snapshot_manifest_apply_failed', error: applied.error || 'snapshot manifest apply failed' };
  }

  return {
    ok: true,
    restored: true,
    archive_path: archivePath,
    byte_count: downloaded.byteCount,
    file_count: Number.isInteger(latest.file_count) ? latest.file_count : listed.entries.length,
    deleted_count: applied.deletedCount,
    snapshot: codingBinSnapshotMetadata(manifest, {
      id: snapshotId,
      status: 'restored',
      source: latest.source || 'payload_restore',
      baseRef: latest.base_ref,
      headRef: latest.head_ref,
      fileCount: Number.isInteger(latest.file_count) ? latest.file_count : listed.entries.length,
      byteCount: downloaded.byteCount,
      skippedCount: Number.isInteger(latest.skipped_count) ? latest.skipped_count : 0,
    }),
  };
}

export async function captureCodingBinSnapshot(manifest, {
  env = process.env,
  deps = {},
  token = null,
  cwd = runtimeWorkspaceDir(manifest),
  paths = runtimePaths(manifest, env),
  trigger = 'runtime_shutdown',
  runtimeGeneration = null,
  authorizationDigest = null,
} = {}) {
  const policy = manifest?.coding_bin?.snapshot || null;
  const upload = policy?.upload || null;
  const urlTemplate = stringOrNull(upload?.url_template);
  if (!policy?.enabled || !urlTemplate) {
    return { ok: true, captured: false, skipped: true, reason: 'snapshot_policy_disabled' };
  }
  const runtimeToken = token || stringOrNull(env.MEMORO_TOKEN);
  if (!runtimeToken) {
    return snapshotCaptureFailure(manifest, {
      code: 'runtime_token_missing',
      error: 'runtime token missing for snapshot upload',
      trigger,
    });
  }

  const snapshotId = newCodingBinSnapshotId(deps);
  const archivePath = join(paths.dir || DEFAULT_RUNTIME_DIR, `${snapshotId}.tar.zst`);
  const fileListPath = join(paths.dir || DEFAULT_RUNTIME_DIR, `${snapshotId}.files`);
  const mkdir = deps.mkdir || mkdirSync;
  const writeFile = deps.writeFile || writeFileSync;
  mkdir(dirname(archivePath), { recursive: true, mode: 0o700 });

  const candidates = await collectSnapshotFileList(cwd, manifest, { deps });
  if (!candidates.ok) {
    return snapshotCaptureFailure(manifest, {
      id: snapshotId,
      code: candidates.code || 'snapshot_file_list_failed',
      error: candidates.error || 'snapshot file list failed',
      trigger,
    });
  }
  const deleted = await collectDeletedSnapshotPaths(cwd, manifest, { deps });
  const cleanupPaths = [];
  if (deleted.paths.length > 0) {
    const snapshotManifestPath = join(cwd, SNAPSHOT_MANIFEST_FILE);
    const maxFiles = snapshotMaxFiles(manifest);
    try {
      writeFile(snapshotManifestPath, JSON.stringify({
        schema: 'mc-coding-bin-snapshot-v1',
        deleted_paths: deleted.paths,
      }, null, 2), { mode: 0o600 });
    } catch (err) {
      return snapshotCaptureFailure(manifest, {
        id: snapshotId,
        code: 'snapshot_manifest_write_failed',
        error: safeError(err),
        trigger,
      });
    }
    cleanupPaths.push(snapshotManifestPath);
    if (!candidates.files.includes(SNAPSHOT_MANIFEST_FILE)) {
      if (candidates.files.length >= maxFiles) {
        candidates.files.pop();
        candidates.skippedCount += 1;
      }
      candidates.files.push(SNAPSHOT_MANIFEST_FILE);
    }
    candidates.skippedCount += deleted.skippedCount;
  }

  try {
    writeFile(fileListPath, candidates.files.join('\n') + (candidates.files.length ? '\n' : ''), { mode: 0o600 });
  } catch (err) {
    cleanupSnapshotTempFiles(cleanupPaths, deps);
    return snapshotCaptureFailure(manifest, {
      id: snapshotId,
      code: 'snapshot_file_list_write_failed',
      error: safeError(err),
      trigger,
    });
  }

  const created = await createTarArchive(archivePath, cwd, fileListPath, { deps });
  cleanupSnapshotTempFiles(cleanupPaths, deps);
  if (!created.ok) {
    return snapshotCaptureFailure(manifest, {
      id: snapshotId,
      code: 'snapshot_archive_create_failed',
      error: created.error || 'snapshot archive create failed',
      trigger,
    });
  }

  const stat = deps.stat || statSync;
  const size = Number(stat(archivePath)?.size) || 0;
  const maxBytes = snapshotMaxBytes(manifest);
  if (size <= 0) {
    return snapshotCaptureFailure(manifest, {
      id: snapshotId,
      code: 'snapshot_archive_empty',
      error: 'snapshot archive is empty',
      trigger,
    });
  }
  if (size > maxBytes) {
    return snapshotCaptureFailure(manifest, {
      id: snapshotId,
      code: 'snapshot_archive_too_large',
      error: `snapshot archive exceeds ${maxBytes} bytes`,
      trigger,
      byteCount: size,
      fileCount: candidates.files.length,
      skippedCount: candidates.skippedCount,
    });
  }

  const refs = await snapshotGitRefs(cwd, { deps });
  const readFile = deps.readFile || readFileSync;
  const body = readFile(archivePath);
  const uploadUrl = urlTemplate.replace('{snapshot_id}', encodeURIComponent(snapshotId));
  const uploaded = await uploadSnapshotPayload(uploadUrl, body, {
    token: runtimeToken,
    contentType: upload.content_type || 'application/zstd',
    fileCount: candidates.files.length,
    skippedCount: candidates.skippedCount,
    baseRef: refs.baseRef,
    headRef: refs.headRef,
    runtimeGeneration,
    authorizationDigest,
    deps,
  });
  if (!uploaded.ok) {
    return snapshotCaptureFailure(manifest, {
      id: snapshotId,
      code: uploaded.code || 'snapshot_upload_failed',
      error: uploaded.error || 'snapshot upload failed',
      trigger,
      byteCount: size,
      fileCount: candidates.files.length,
      skippedCount: candidates.skippedCount,
      baseRef: refs.baseRef,
      headRef: refs.headRef,
    });
  }

  return {
    ok: true,
    captured: true,
    archive_path: archivePath,
    file_count: candidates.files.length,
    byte_count: size,
    skipped_count: candidates.skippedCount,
    deleted_count: deleted.paths.length,
    snapshot: codingBinSnapshotMetadata(manifest, {
      id: snapshotId,
      status: 'ready',
      source: 'runtime_sleep',
      baseRef: refs.baseRef,
      headRef: refs.headRef,
      fileCount: candidates.files.length,
      byteCount: size,
      skippedCount: candidates.skippedCount,
    }),
  };
}

export function codingBinReadiness(manifest, {
  restore = null,
  capture = null,
  snapshotting = false,
} = {}) {
  const latest = manifest?.coding_bin?.latest_snapshot || null;
  const policy = manifest?.coding_bin?.snapshot || null;
  const restoreFailed = restore?.ok === false;
  const captureFailed = capture?.ok === false;
  return sanitizeRuntimeData({
    id: manifest?.coding_bin_id || manifest?.coding_bin?.id || null,
    root: manifest?.coding_bin?.root || runtimeWorkspaceDir(manifest),
    snapshot_policy_enabled: policy?.enabled === true,
    latest_snapshot_id: latest?.id || null,
    snapshotting: snapshotting === true,
    restored: restore?.restored === true,
    captured: capture?.captured === true,
    ready: !restoreFailed && !captureFailed && snapshotting !== true,
    repair_required: restoreFailed || captureFailed,
    repair_action: restoreFailed ? 'retry_wake' : captureFailed ? 'retry_sleep' : null,
    warning: restoreFailed ? 'snapshot_restore_failed' : captureFailed ? 'snapshot_capture_failed' : null,
    secret_boundary: 'status_only',
  });
}

async function downloadSnapshotPayload(url, {
  token,
  maxBytes,
  runtimeGeneration = null,
  authorizationDigest = null,
  deps = {},
} = {}) {
  try {
    const res = await runtimeFetch(url, {
      token,
      method: 'GET',
      deps,
      timeoutMs: deps.snapshotDownloadTimeoutMs || 120_000,
      headers: runtimeAuthorizationHeaders(runtimeGeneration, authorizationDigest),
    });
    if (!res.ok) return res;
    const length = Number(res.headers?.get?.('content-length'));
    if (Number.isFinite(length) && length > maxBytes) {
      return { ok: false, code: 'snapshot_payload_too_large', error: `snapshot payload exceeds ${maxBytes} bytes` };
    }
    const buffer = Buffer.from(await res.response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      return { ok: false, code: 'snapshot_payload_too_large', error: `snapshot payload exceeds ${maxBytes} bytes` };
    }
    return { ok: true, body: buffer, byteCount: buffer.byteLength };
  } catch (err) {
    return { ok: false, code: 'snapshot_download_failed', error: safeError(err) };
  }
}

async function uploadSnapshotPayload(url, body, {
  token,
  contentType,
  fileCount,
  skippedCount,
  baseRef,
  headRef,
  runtimeGeneration = null,
  authorizationDigest = null,
  deps = {},
} = {}) {
  try {
    const res = await runtimeFetch(url, {
      token,
      method: 'PUT',
      body,
      deps,
      timeoutMs: deps.snapshotUploadTimeoutMs || 120_000,
      headers: {
        'Content-Type': contentType || 'application/zstd',
        'Content-Length': String(body.byteLength ?? body.length ?? 0),
        'X-MC-Snapshot-File-Count': String(Math.max(0, fileCount || 0)),
        'X-MC-Snapshot-Skipped-Count': String(Math.max(0, skippedCount || 0)),
        'X-MC-Snapshot-Base-Ref': baseRef || 'unknown',
        'X-MC-Snapshot-Head-Ref': headRef || 'unknown',
        ...runtimeAuthorizationHeaders(runtimeGeneration, authorizationDigest),
      },
    });
    return res.ok ? { ok: true } : res;
  } catch (err) {
    return { ok: false, code: 'snapshot_upload_failed', error: safeError(err) };
  }
}

function runtimeAuthorizationHeaders(runtimeGeneration, authorizationDigest) {
  if (!runtimeGeneration || !authorizationDigest) return {};
  return {
    'X-MC-Runtime-Generation': runtimeGeneration,
    'X-MC-Authorization-Digest': authorizationDigest,
  };
}

async function runtimeFetch(url, {
  token,
  method = 'GET',
  body = null,
  headers = {},
  timeoutMs = 120_000,
  deps = {},
} = {}) {
  if (!token) return { ok: false, code: 'runtime_token_missing', error: 'runtime token missing' };
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return { ok: false, code: 'fetch_unavailable', error: 'fetch is unavailable' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...headers,
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      let text = '';
      try { text = await response.text(); } catch {}
      return { ok: false, status: response.status, code: `http_${response.status}`, error: text || `HTTP ${response.status}` };
    }
    return { ok: true, response, headers: response.headers };
  } finally {
    clearTimeout(timer);
  }
}

async function collectSnapshotFileList(cwd, manifest, { deps = {} } = {}) {
  const maxFiles = snapshotMaxFiles(manifest);
  const runProcess = deps.runProcess || runProcessDefault;
  let res = await runProcess('git', ['-C', cwd, 'ls-files', '-z', '--cached', '--modified', '--others', '--exclude-standard'], {
    cwd,
    env: deps.env || process.env,
  });
  if (!res || res.code !== 0) {
    res = await runProcess('find', ['.', '-type', 'f', '-print0'], {
      cwd,
      env: deps.env || process.env,
    });
  }
  if (!res || res.code !== 0) {
    return { ok: false, code: 'snapshot_file_list_failed', error: res?.stderr || res?.error || `file list exited ${res?.code ?? 'unknown'}` };
  }
  const raw = String(res.stdout || '');
  const paths = raw.split('\0')
    .map((item) => normalizeSnapshotPath(item))
    .filter(Boolean);
  const files = [];
  let skippedCount = 0;
  const seen = new Set();
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    if (!isSafeSnapshotPath(path) || isSnapshotPathExcluded(path, manifest)) {
      skippedCount += 1;
      continue;
    }
    if (files.length >= maxFiles) {
      skippedCount += 1;
      continue;
    }
    files.push(path);
  }
  return { ok: true, files, skippedCount };
}

async function collectDeletedSnapshotPaths(cwd, manifest, { deps = {} } = {}) {
  const runProcess = deps.runProcess || runProcessDefault;
  const res = await runProcess('git', ['-C', cwd, 'diff', '--name-only', '-z', '--diff-filter=D', 'HEAD', '--'], {
    cwd,
    env: deps.env || process.env,
  }).catch(() => null);
  if (!res || res.code !== 0) return { paths: [], skippedCount: 0 };
  const raw = String(res.stdout || '');
  const paths = [];
  let skippedCount = 0;
  const seen = new Set();
  for (const item of raw.split('\0')) {
    const path = normalizeSnapshotPath(item);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    if (!isSafeSnapshotPath(path) || isSnapshotPathExcluded(path, manifest)) {
      skippedCount += 1;
      continue;
    }
    paths.push(path);
  }
  return { paths, skippedCount };
}

async function applySnapshotManifest(cwd, { deps = {} } = {}) {
  const manifestPath = join(cwd, SNAPSHOT_MANIFEST_FILE);
  const exists = deps.existsSync || existsSync;
  const readFile = deps.readFile || readFileSync;
  const remove = deps.rm || rmSync;
  if (!exists(manifestPath)) return { ok: true, deletedCount: 0, manifest: false };
  let parsed;
  try {
    parsed = JSON.parse(readFile(manifestPath, 'utf8'));
  } catch (err) {
    return { ok: false, code: 'snapshot_manifest_invalid', error: `snapshot manifest invalid (${safeError(err)})` };
  }
  const deletedPaths = Array.isArray(parsed?.deleted_paths)
    ? parsed.deleted_paths.map((item) => normalizeSnapshotPath(item)).filter(Boolean)
    : [];
  let deletedCount = 0;
  for (const path of deletedPaths) {
    if (!isSafeSnapshotPath(path) || path === SNAPSHOT_MANIFEST_FILE) {
      return { ok: false, code: 'snapshot_manifest_unsafe_path', error: `snapshot manifest contains unsafe path: ${path || '<empty>'}` };
    }
    try {
      remove(join(cwd, path), { force: true });
      deletedCount += 1;
    } catch (err) {
      return { ok: false, code: 'snapshot_manifest_delete_failed', error: `snapshot delete failed for ${path} (${safeError(err)})` };
    }
  }
  try { remove(manifestPath, { force: true }); } catch {}
  return { ok: true, deletedCount, manifest: true };
}

function cleanupSnapshotTempFiles(paths, deps = {}) {
  const remove = deps.rm || rmSync;
  for (const path of paths || []) {
    try { remove(path, { force: true }); } catch {}
  }
}

async function createTarArchive(archivePath, cwd, fileListPath, { deps = {} } = {}) {
  return runTarVariants([
    ['--zstd', '-cf', archivePath, '-C', cwd, '-T', fileListPath],
    ['-I', 'zstd', '-cf', archivePath, '-C', cwd, '-T', fileListPath],
  ], { deps });
}

async function listTarArchive(archivePath, { deps = {}, cwd = process.cwd() } = {}) {
  const listed = await runTarVariants([
    ['--zstd', '-tf', archivePath],
    ['-I', 'zstd', '-tf', archivePath],
  ], { deps, cwd });
  if (!listed.ok) return listed;
  const entries = String(listed.stdout || '')
    .split(/\r?\n/)
    .map((line) => normalizeSnapshotPath(line))
    .filter(Boolean);
  return { ok: true, entries };
}

async function extractTarArchive(archivePath, cwd, { deps = {} } = {}) {
  return runTarVariants([
    ['--zstd', '-xf', archivePath, '-C', cwd],
    ['-I', 'zstd', '-xf', archivePath, '-C', cwd],
  ], { deps, cwd });
}

async function runTarVariants(variants, { deps = {}, cwd = process.cwd() } = {}) {
  const runProcess = deps.runProcess || runProcessDefault;
  let last = null;
  for (const args of variants) {
    const res = await runProcess('tar', args, {
      cwd,
      env: deps.env || process.env,
    });
    if (res?.code === 0) return { ok: true, stdout: res.stdout || '', stderr: res.stderr || '', args };
    last = res;
  }
  return { ok: false, code: last?.code, error: last?.stderr || last?.error || `tar exited ${last?.code ?? 'unknown'}` };
}

async function snapshotGitRefs(cwd, { deps = {} } = {}) {
  const runProcess = deps.runProcess || runProcessDefault;
  const branch = await runProcess('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd,
    env: deps.env || process.env,
  }).catch(() => null);
  const head = await runProcess('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
    cwd,
    env: deps.env || process.env,
  }).catch(() => null);
  return {
    baseRef: cleanHeaderText(branch?.code === 0 ? branch.stdout : null) || 'unknown',
    headRef: cleanHeaderText(head?.code === 0 ? head.stdout : null) || 'unknown',
  };
}

function snapshotCaptureFailure(manifest, {
  id = null,
  code,
  error,
  trigger,
  byteCount = 0,
  fileCount = 0,
  skippedCount = 0,
  baseRef = null,
  headRef = null,
} = {}) {
  const snapshotId = normalizeCodingBinSnapshotId(id) || newCodingBinSnapshotId({});
  const snapshot = codingBinSnapshotMetadata(manifest, {
    id: snapshotId,
    status: 'failed',
    source: trigger || 'runtime_shutdown',
    baseRef,
    headRef,
    fileCount,
    byteCount,
    skippedCount,
    errorCode: code || 'snapshot_failed',
    error: error || 'snapshot failed',
  });
  return { ok: false, captured: false, code: code || 'snapshot_failed', error: error || 'snapshot failed', snapshot };
}

function codingBinSnapshotMetadata(manifest, {
  id,
  status,
  source,
  baseRef = null,
  headRef = null,
  fileCount = 0,
  byteCount = 0,
  skippedCount = 0,
  errorCode = null,
  error = null,
} = {}) {
  return sanitizeRuntimeData({
    id,
    status,
    storageProvider: null,
    storageBucket: null,
    storageKey: null,
    source,
    baseRef,
    headRef,
    fileCount: Math.max(0, Number(fileCount) || 0),
    byteCount: Math.max(0, Number(byteCount) || 0),
    skippedCount: Math.max(0, Number(skippedCount) || 0),
    errorCode,
    error,
    codingBinId: manifest?.coding_bin_id || manifest?.coding_bin?.id || null,
  });
}

function runProcessDefault(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => resolve({ code: 1, error: err.message || String(err), stdout, stderr }));
    child.on('close', (code) => resolve({ code: Number.isInteger(code) ? code : 1, stdout, stderr }));
  });
}

function runtimePaths(manifest, env = {}, manifestPath = null) {
  const paths = manifest.runtime?.paths || {};
  const status = env.MC_CLOUD_RUNTIME_STATUS || paths.status || join(DEFAULT_RUNTIME_DIR, 'status.json');
  const events = env.MC_CLOUD_RUNTIME_EVENTS || paths.events || join(DEFAULT_RUNTIME_DIR, 'events.jsonl');
  const readiness = env.MC_CLOUD_RUNTIME_READINESS || paths.readiness || join(DEFAULT_RUNTIME_DIR, 'readiness.json');
  return {
    dir: paths.dir || dirname(status),
    manifest: env.MC_CLOUD_RUNTIME_MANIFEST || manifestPath || paths.manifest || join(DEFAULT_RUNTIME_DIR, 'manifest.json'),
    status,
    events,
    readiness,
  };
}

function runtimeWorkspaceDir(manifest) {
  return stringOrNull(manifest?.runtime?.cwd) || DEFAULT_REPO_CWD;
}

function normalizeCodingBinSnapshotId(value) {
  const id = stringOrNull(value);
  return id && CODING_BIN_SNAPSHOT_ID_RE.test(id) ? id : null;
}

function newCodingBinSnapshotId(deps = {}) {
  const random = deps.randomUUID || randomUUID;
  return `cbsnap_${String(random()).replace(/-/g, '').slice(0, 24)}`;
}

function snapshotMaxBytes(manifest) {
  const value = Number(manifest?.coding_bin?.snapshot?.max_bytes);
  return Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), DEFAULT_SNAPSHOT_MAX_BYTES)
    : DEFAULT_SNAPSHOT_MAX_BYTES;
}

function snapshotMaxFiles(manifest) {
  const value = Number(manifest?.coding_bin?.snapshot?.max_files);
  return Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), DEFAULT_SNAPSHOT_MAX_FILES)
    : DEFAULT_SNAPSHOT_MAX_FILES;
}

function normalizeSnapshotPath(value) {
  let path = String(value || '').replace(/\0/g, '').trim();
  if (!path) return null;
  path = path.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/');
  return path || null;
}

function isSafeSnapshotPath(value) {
  const path = normalizeSnapshotPath(value);
  if (!path) return false;
  if (path.startsWith('/') || path.includes('\n') || path.includes('\r')) return false;
  return !path.split('/').some((part) => part === '..' || part === '');
}

function isSnapshotPathExcluded(path, manifest) {
  const normalized = normalizeSnapshotPath(path);
  if (!normalized) return true;
  const segments = normalized.split('/');
  const pathRules = manifest?.coding_bin?.snapshot?.exclude?.paths || [];
  const globRules = manifest?.coding_bin?.snapshot?.exclude?.globs || [];
  for (const rule of pathRules) {
    const clean = normalizeSnapshotPath(rule);
    if (!clean) continue;
    if (normalized === clean || normalized.startsWith(`${clean}/`) || segments.includes(clean)) return true;
  }
  const lower = normalized.toLowerCase();
  for (const rule of globRules) {
    const clean = String(rule || '').toLowerCase();
    if (!clean) continue;
    if (clean === '**/.env' && segments.at(-1) === '.env') return true;
    if (clean === '**/.env.*' && segments.at(-1)?.startsWith('.env.')) return true;
    if (clean === '**/*token*' && lower.includes('token')) return true;
    if (clean === '**/*secret*' && lower.includes('secret')) return true;
    if (clean === '**/*credential*' && lower.includes('credential')) return true;
    if (clean === '**/*auth*.json' && /auth.*\.json$/i.test(normalized)) return true;
    if (clean === '**/id_rsa' && segments.at(-1) === 'id_rsa') return true;
    if (clean === '**/id_ed25519' && segments.at(-1) === 'id_ed25519') return true;
  }
  return false;
}

function cleanHeaderText(value) {
  return String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 256);
}

function sanitizeRuntimeData(value, depth = 0) {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeRuntimeData(item, depth + 1));
  if (typeof value === 'string') return redactCredentialText(value);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (!isSafeRuntimeMetadataKey(key) && /(token|secret|password|passphrase|private.?key|access.?key|refresh|auth.?json|api.?key|credential(?!_source)|capability)/i.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = sanitizeRuntimeData(child, depth + 1);
  }
  return out;
}

function isSafeRuntimeMetadataKey(key) {
  return [
    'credential_source',
    'secret_boundary',
    'exposes_secrets_to_llm',
  ].includes(key);
}

function safeError(err) {
  return redactCredentialText(err?.message || err || 'unknown', 500);
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
