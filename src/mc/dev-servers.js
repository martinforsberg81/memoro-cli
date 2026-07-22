/**
 * Machine-local dev-service registry and safety checks.
 *
 * Projects remain authoritative for startup and shutdown. They publish a
 * worktree-local manifest; mc keeps an atomic copy for discovery and invokes
 * only the control argv declared by that manifest, never a shell string.
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn as defaultSpawn, spawnSync as defaultSpawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { devServersRoot } from './paths.js';

const SCHEMA_VERSION = 1;
const STARTING_GRACE_MS = 30_000;
const HEALTH_TIMEOUT_MS = 1_500;
const MAX_LOG_LINES = 1_000;
const MAX_LOG_READ_BYTES = 1024 * 1024;

export function registerDevServerManifest(sourcePath, deps = {}) {
  const now = deps.now || (() => new Date());
  const source = canonicalFile(sourcePath, 'manifest path');
  const raw = readJson(source, 'dev server manifest');
  const normalized = normalizeManifest(raw, { sourcePath: source });
  const target = registryManifestPath(normalized.instance_id);
  const previous = readJsonIfExists(target);
  const timestamp = isoNow(now);
  const registered = {
    ...normalized,
    registered_at: validIso(previous?.registered_at) || timestamp,
    updated_at: timestamp,
  };
  writeJsonAtomic(target, registered);
  return registered;
}

export function unregisterDevServerManifest(sourcePath) {
  const source = canonicalFile(sourcePath, 'manifest path');
  const raw = readJson(source, 'dev server manifest');
  const instanceId = requiredIdentifier(raw.instance_id, 'instance_id');
  const target = registryManifestPath(instanceId);
  const registered = readJsonIfExists(target);
  if (!registered) return false;
  if (registered.instance_id !== instanceId || registered.source_manifest_path !== source) {
    throw new Error('registered dev server does not match the source manifest identity');
  }
  rmSync(target, { force: true });
  return true;
}

export function readDevServerManifests() {
  const root = devServersRoot();
  if (!existsSync(root)) return [];
  const manifests = [];
  for (const name of readdirSync(root).filter((entry) => entry.endsWith('.json')).sort()) {
    const parsed = readJsonIfExists(join(root, name));
    if (parsed && parsed.schema_version === SCHEMA_VERSION && parsed.instance_id) {
      manifests.push(parsed);
    }
  }
  return manifests;
}

export async function listDevServers(deps = {}) {
  const read = deps.readManifests || readDevServerManifests;
  const manifests = read();
  const inspected = await Promise.all(manifests.map((manifest) => inspectDevServer(manifest, deps)));
  return inspected.sort(compareServers);
}

export async function inspectDevServer(manifest, deps = {}) {
  const now = deps.now || (() => new Date());
  const identity = verifyDevServerIdentity(manifest, deps);
  const ageSeconds = ageInSeconds(manifest.started_at, now);
  const base = {
    ...manifest,
    age_seconds: ageSeconds,
    identity,
  };
  if (!identity.ok) {
    return {
      ...base,
      state: 'orphan',
      health: { status: 'unknown', ok: false, error: 'identity not verified' },
    };
  }

  const probe = deps.probeHealth || probeHttpHealth;
  const result = await probe(manifest.health_url, { timeoutMs: HEALTH_TIMEOUT_MS });
  const health = result?.ok
    ? { status: 'healthy', ok: true, http_status: result.status ?? null }
    : {
        status: 'unhealthy',
        ok: false,
        http_status: result?.status ?? null,
        error: result?.error || 'health check failed',
      };
  return {
    ...base,
    state: health.ok ? 'ready' : (ageSeconds < STARTING_GRACE_MS / 1000 ? 'starting' : 'unhealthy'),
    health,
  };
}

export function verifyDevServerIdentity(manifest, deps = {}) {
  const isAlive = deps.isAlive || defaultIsAlive;
  const processInfo = deps.processInfo || defaultProcessInfo;
  const pid = Number(manifest?.pid);
  if (!Number.isInteger(pid) || pid < 1 || !isAlive(pid)) {
    return identityFailure('process-not-running');
  }

  let source = null;
  try {
    const rawSource = readJsonIfExists(manifest.source_manifest_path);
    if (rawSource) source = normalizeManifest(rawSource, { sourcePath: manifest.source_manifest_path });
  } catch {
    source = null;
  }
  if (!source || !sourceManifestMatches(source, manifest)) {
    return identityFailure('source-manifest-mismatch');
  }

  const info = processInfo(pid);
  if (!info?.cwd || !Number.isInteger(Number(info.process_group_id))) {
    return identityFailure('process-uninspectable');
  }
  if (canonicalPath(info.cwd) !== canonicalPath(manifest.worktree_path)) {
    return identityFailure('worktree-mismatch');
  }
  if (Number(info.process_group_id) !== Number(manifest.process_group_id)) {
    return identityFailure('process-group-mismatch');
  }
  return { ok: true, status: 'verified', reason: null };
}

export async function controlDevServer(manifest, action, deps = {}) {
  if (action !== 'stop' && action !== 'restart') {
    return { ok: false, reason: 'unsupported-action', error: `unsupported dev control action: ${action}` };
  }
  const identity = verifyDevServerIdentity(manifest, deps);
  if (!identity.ok) {
    return {
      ok: false,
      reason: identity.reason,
      error: `refusing ${action}: dev server identity is not verified (${identity.reason})`,
    };
  }
  const control = manifest?.control?.[action];
  if (!control?.argv?.length) {
    return { ok: false, reason: 'control-not-declared', error: `${action} is not declared by this project` };
  }

  const [command, ...args] = control.argv;
  const options = {
    cwd: manifest.worktree_path,
    env: {
      ...process.env,
      MC_DEV_CONTROLLED_BY: 'mc',
      MC_DEV_INSTANCE_ID: manifest.instance_id,
    },
    shell: false,
  };

  if (control.detached) {
    const spawn = deps.spawn || defaultSpawn;
    try {
      const child = spawn(command, args, { ...options, detached: true, stdio: 'ignore' });
      await new Promise((resolveSpawn, rejectSpawn) => {
        child.once('spawn', resolveSpawn);
        child.once('error', rejectSpawn);
      });
      child.unref?.();
      return { ok: true, action, detached: true, pid: child.pid ?? null };
    } catch (error) {
      return { ok: false, reason: 'control-failed', error: error?.message || String(error) };
    }
  }

  const spawnSync = deps.spawnSync || defaultSpawnSync;
  const result = spawnSync(command, args, {
    ...options,
    encoding: 'utf8',
    timeout: control.timeout_ms || 30_000,
  });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      reason: 'control-failed',
      status: result.status ?? null,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      error: result.error?.message || result.stderr?.trim() || `${action} exited ${result.status}`,
    };
  }
  return {
    ok: true,
    action,
    detached: false,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

export function resolveDevServer(servers, selector) {
  const exact = servers.filter((server) => server.instance_id === selector);
  if (exact.length === 1) return { server: exact[0], error: null };
  const matches = servers.filter((server) => (
    server.session_name === selector
    || server.service === selector
  ));
  if (matches.length === 1) return { server: matches[0], error: null };
  if (matches.length > 1) {
    return {
      server: null,
      error: `selector "${selector}" matches ${matches.length} dev servers; use an instance id`,
      matches,
    };
  }
  return { server: null, error: `no dev server matches "${selector}"`, matches: [] };
}

export function summarizeDevServers(servers) {
  const summary = { total: servers.length, ready: 0, starting: 0, unhealthy: 0, orphan: 0 };
  for (const server of servers) {
    if (Object.hasOwn(summary, server.state)) summary[server.state] += 1;
  }
  return summary;
}

export function readDevServerLog(manifest, { lines = 100 } = {}) {
  const lineCount = Number(lines);
  if (!Number.isInteger(lineCount) || lineCount < 1 || lineCount > MAX_LOG_LINES) {
    throw new Error(`--lines must be an integer from 1 to ${MAX_LOG_LINES}`);
  }
  const logPath = absolutePath(manifest.log_path, 'log_path');
  assertInside(manifest.worktree_path, logPath, 'log_path');
  if (!existsSync(logPath)) throw new Error(`dev log does not exist: ${logPath}`);

  const fd = openSync(logPath, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, MAX_LOG_READ_BYTES);
    const start = size - length;
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (start > 0) text = text.slice(Math.max(0, text.indexOf('\n') + 1));
    const hadNewline = text.endsWith('\n');
    const all = text.split(/\r?\n/);
    if (all.at(-1) === '') all.pop();
    const tail = all.slice(-lineCount).join('\n');
    return tail ? `${tail}${hadNewline ? '\n' : ''}` : '';
  } finally {
    closeSync(fd);
  }
}

function normalizeManifest(raw, { sourcePath }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dev server manifest must be a JSON object');
  }
  if (raw.schema_version !== SCHEMA_VERSION) {
    throw new Error(`schema_version must be ${SCHEMA_VERSION}`);
  }
  const instanceId = requiredIdentifier(raw.instance_id, 'instance_id');
  const service = requiredText(raw.service, 'service');
  const sessionName = requiredText(raw.session_name, 'session_name');
  const worktreePath = canonicalDirectory(raw.worktree_path, 'worktree_path');
  assertInside(worktreePath, sourcePath, 'manifest path');
  const logPath = absolutePath(raw.log_path, 'log_path');
  assertInside(worktreePath, logPath, 'log_path');
  const pid = positiveInteger(raw.pid, 'pid');
  const processGroupId = positiveInteger(raw.process_group_id, 'process_group_id');
  const url = localHttpUrl(raw.url, 'url');
  const healthUrl = localHttpUrl(raw.health_url, 'health_url');
  const port = positiveInteger(raw.port, 'port');
  if (port > 65_535) throw new Error('port must be between 1 and 65535');
  const startedAt = validIso(raw.started_at);
  if (!startedAt) throw new Error('started_at must be an ISO timestamp');

  return {
    schema_version: SCHEMA_VERSION,
    instance_id: instanceId,
    service,
    session_name: sessionName,
    coding_session_id: optionalText(raw.coding_session_id),
    worktree_path: worktreePath,
    pid,
    process_group_id: processGroupId,
    url,
    port,
    health_url: healthUrl,
    log_path: logPath,
    started_at: startedAt,
    source_manifest_path: sourcePath,
    control: normalizeControls(raw.control),
  };
}

function normalizeControls(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('control must declare stop and restart commands');
  }
  return {
    stop: normalizeControl(raw.stop, 'control.stop', { allowDetached: false }),
    restart: normalizeControl(raw.restart, 'control.restart', { allowDetached: true }),
  };
}

function normalizeControl(raw, label, { allowDetached }) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.argv) || raw.argv.length < 1 || raw.argv.length > 64) {
    throw new Error(`${label}.argv must contain 1 to 64 arguments`);
  }
  const argv = raw.argv.map((part) => {
    if (typeof part !== 'string' || !part || part.length > 4096 || part.includes('\0')) {
      throw new Error(`${label}.argv contains an invalid argument`);
    }
    return part;
  });
  const detached = raw.detached === true;
  if (detached && !allowDetached) throw new Error(`${label} cannot be detached`);
  const timeout = raw.timeout_ms == null ? undefined : positiveInteger(raw.timeout_ms, `${label}.timeout_ms`);
  if (timeout != null && (timeout < 1_000 || timeout > 120_000)) {
    throw new Error(`${label}.timeout_ms must be between 1000 and 120000`);
  }
  return { argv, ...(detached ? { detached: true } : {}), ...(timeout ? { timeout_ms: timeout } : {}) };
}

function sourceManifestMatches(source, registered) {
  return source?.schema_version === registered.schema_version
    && source?.instance_id === registered.instance_id
    && source?.service === registered.service
    && source?.session_name === registered.session_name
    && source?.coding_session_id === registered.coding_session_id
    && Number(source?.pid) === Number(registered.pid)
    && Number(source?.process_group_id) === Number(registered.process_group_id)
    && canonicalPath(source?.worktree_path) === canonicalPath(registered.worktree_path)
    && source?.url === registered.url
    && Number(source?.port) === Number(registered.port)
    && source?.health_url === registered.health_url
    && canonicalPath(source?.log_path) === canonicalPath(registered.log_path)
    && source?.started_at === registered.started_at
    && JSON.stringify(source?.control) === JSON.stringify(registered.control);
}

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function defaultProcessInfo(pid) {
  const pgidResult = defaultSpawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 2_000,
  });
  const processGroupId = Number(String(pgidResult.stdout || '').trim());
  if (!Number.isInteger(processGroupId) || processGroupId < 1) return null;

  let cwd = null;
  if (process.platform === 'linux') {
    try { cwd = readlinkSync(`/proc/${pid}/cwd`); } catch { /* soft-degrade */ }
  } else {
    const lsof = existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof';
    const cwdResult = defaultSpawnSync(lsof, ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      timeout: 2_000,
    });
    cwd = String(cwdResult.stdout || '').split(/\r?\n/).find((line) => line.startsWith('n'))?.slice(1) || null;
  }
  return cwd ? { cwd, process_group_id: processGroupId } : null;
}

async function probeHttpHealth(url, { timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    return response.ok
      ? { ok: true, status: response.status }
      : { ok: false, status: response.status, error: `HTTP ${response.status}` };
  } catch (error) {
    return {
      ok: false,
      error: error?.name === 'AbortError' ? 'timeout' : (error?.message || String(error)),
    };
  } finally {
    clearTimeout(timer);
  }
}

function registryManifestPath(instanceId) {
  return join(devServersRoot(), `${requiredIdentifier(instanceId, 'instance_id')}.json`);
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${label} at ${path}: ${error?.message || String(error)}`);
  }
}

function readJsonIfExists(path) {
  if (!path || !existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function canonicalFile(path, label) {
  const absolute = absolutePath(path, label);
  try { return realpathSync(absolute); } catch { throw new Error(`${label} does not exist: ${absolute}`); }
}

function canonicalDirectory(path, label) {
  const canonical = canonicalFile(path, label);
  if (!statSync(canonical).isDirectory()) throw new Error(`${label} must be a directory`);
  return canonical;
}

function canonicalPath(path) {
  if (typeof path !== 'string' || !path) return '';
  try { return realpathSync(path); } catch { return resolve(path); }
}

function absolutePath(value, label) {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return resolve(value);
}

function assertInside(parent, child, label) {
  const root = canonicalPath(parent);
  const target = canonicalPath(child);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`${label} must be inside worktree_path`);
  }
}

function localHttpUrl(value, label) {
  let parsed;
  try { parsed = new URL(requiredText(value, label)); } catch { throw new Error(`${label} must be a valid URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${label} must use http or https`);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error(`${label} must target the local machine`);
  }
  return parsed.toString().replace(/\/$/, '');
}

function requiredIdentifier(value, label) {
  const text = requiredText(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(text)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return text;
}

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.includes('\0')) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalText(value) {
  if (value == null || value === '') return null;
  return requiredText(value, 'coding_session_id');
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${label} must be a positive integer`);
  return number;
}

function validIso(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function isoNow(now) {
  const value = now();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function ageInSeconds(startedAt, now) {
  const current = now();
  const currentMs = current instanceof Date ? current.getTime() : new Date(current).getTime();
  return Math.max(0, Math.floor((currentMs - Date.parse(startedAt)) / 1000));
}

function identityFailure(reason) {
  return { ok: false, status: 'mismatch', reason };
}

function compareServers(a, b) {
  return String(a.session_name || '').localeCompare(String(b.session_name || ''))
    || String(a.service || '').localeCompare(String(b.service || ''))
    || String(a.instance_id || '').localeCompare(String(b.instance_id || ''));
}
