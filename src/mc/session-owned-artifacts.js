import {
  existsSync,
  lstatSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import {
  isAbsolute,
  join,
  relative,
  sep,
} from 'node:path';

import { requestBroker as defaultRequestBroker } from './broker/client.js';
import {
  brokerSessionMatchesEntry,
} from './broker/session-cleanup.js';
import { mcHome } from './paths.js';

const SESSION_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/;

export function sessionOwnedMcArtifactPaths(entry, {
  mcDir = mcHome(),
} = {}) {
  const codingSessionId = nonEmpty(entry?.coding_session_id);
  const sessionName = nonEmpty(entry?.name);
  const durableSessionKey = nonEmpty(entry?.legacy_session_key)
    || nonEmpty(entry?.session_id)
    || sessionName;
  const issues = [];
  if (!isAbsolute(mcDir)) {
    issues.push({ code: 'invalid-mc-home' });
  }
  if (codingSessionId && !SESSION_KEY_RE.test(codingSessionId)) {
    issues.push({ code: 'invalid-coding-session-id' });
  }
  if (!sessionName || !SESSION_KEY_RE.test(sessionName)) {
    issues.push({ code: 'invalid-session-name' });
  }
  if (!durableSessionKey || !SESSION_KEY_RE.test(durableSessionKey)) {
    issues.push({ code: 'invalid-durable-session-key' });
  }
  const hostDir = codingSessionId ? join(mcDir, 'hosts', codingSessionId) : null;
  return {
    ok: issues.length === 0,
    issues,
    coding_session_id: codingSessionId,
    host_dir: hostDir,
    host_socket: hostDir ? join(hostDir, 'broker.sock') : null,
    host_pid: hostDir ? join(hostDir, 'broker.pid') : null,
    guard_dir: codingSessionId ? join(mcDir, 'guard-bin', codingSessionId) : null,
    vault_manifest: durableSessionKey
      ? join(mcDir, 'state', `${durableSessionKey}-materialised.json`)
      : null,
  };
}

export function inspectSessionOwnedMcArtifacts(entry, {
  mcDir = mcHome(),
  lstat = lstatSync,
} = {}) {
  const paths = sessionOwnedMcArtifactPaths(entry, { mcDir });
  if (!paths.ok) {
    return {
      ok: false,
      state: 'unverified',
      paths,
      leftovers: [],
      issues: paths.issues,
    };
  }
  const leftovers = [];
  for (const [kind, path] of [
    ['broker-host', paths.host_dir],
    ['guard-bin', paths.guard_dir],
    ['vault-manifest', paths.vault_manifest],
  ]) {
    if (!path) continue;
    const inspected = inspectOwnedPath(mcDir, path, {
      lstat,
      expected: kind === 'vault-manifest' ? 'file' : 'directory',
    });
    if (inspected.missing) continue;
    if (!inspected.ok) {
      return {
        ok: false,
        state: 'unverified',
        paths,
        leftovers,
        issues: [inspected.issue],
      };
    }
    leftovers.push({ kind, path });
  }
  return {
    ok: true,
    state: leftovers.length > 0 ? 'present' : 'absent',
    paths,
    leftovers,
    issues: [],
  };
}

export async function removeSessionOwnedRuntimeArtifacts(entry, {
  mcDir = mcHome(),
  lstat = lstatSync,
  readFile = readFileSync,
  remove = removeExactDirectoryDefault,
  beforeRemove = null,
  isAlive = defaultIsAlive,
  kill = defaultKill,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  requestBroker = defaultRequestBroker,
  stopTimeoutMs = 500,
  pollMs = 25,
} = {}) {
  const paths = sessionOwnedMcArtifactPaths(entry, { mcDir });
  if (!paths.ok) return { ok: false, removed: [], issues: paths.issues };
  const removed = [];

  if (paths.host_dir) {
    const safe = inspectOwnedPath(mcDir, paths.host_dir, {
      lstat,
      expected: 'directory',
    });
    if (!safe.ok && !safe.missing) return { ok: false, removed, issues: [safe.issue] };
    if (!safe.missing) {
      let socketPresent = false;
      for (const [path, expected] of [
        [paths.host_pid, 'file'],
        [paths.host_socket, null],
      ]) {
        const child = inspectOwnedPath(paths.host_dir, path, { lstat, expected });
        if (!child.ok && !child.missing) {
          return { ok: false, removed, issues: [child.issue] };
        }
        if (path === paths.host_socket) socketPresent = !child.missing;
      }
      let pid = readPid(paths.host_pid, readFile);
      let status = null;
      if (!pid && socketPresent) {
        status = await readHostStatus(paths.host_socket, requestBroker);
        pid = verifiedBrokerPid(status);
        if (!pid) {
          return {
            ok: false,
            removed,
            issues: [{
              code: 'broker-host-pid-unverified',
              path: paths.host_dir,
              pid: null,
            }],
          };
        }
      }
      if (pid && isAlive(pid)) {
        status ||= await readHostStatus(paths.host_socket, requestBroker);
        if (verifiedBrokerPid(status) !== pid) {
          return {
            ok: false,
            removed,
            issues: [{
              code: 'broker-host-pid-unverified',
              path: paths.host_dir,
              pid,
            }],
          };
        }
        if (!kill(pid)) {
          return {
            ok: false,
            removed,
            issues: [{ code: 'broker-host-stop-failed', path: paths.host_dir, pid }],
          };
        }
        const started = Date.now();
        while (isAlive(pid) && Date.now() - started < stopTimeoutMs) {
          await sleep(pollMs);
        }
        if (isAlive(pid)) {
          return {
            ok: false,
            removed,
            issues: [{ code: 'broker-host-still-running', path: paths.host_dir, pid }],
          };
        }
      }
      const fresh = inspectOwnedPath(mcDir, paths.host_dir, {
        lstat,
        expected: 'directory',
      });
      if (!fresh.missing) {
        if (!fresh.ok || !sameDirectoryIdentity(safe.fingerprint, fresh.fingerprint)) {
          return {
            ok: false,
            removed,
            issues: [fresh.issue || {
              code: 'mc-artifact-changed',
              path: paths.host_dir,
            }],
          };
        }
        if (beforeRemove) await beforeRemove({ kind: 'broker-host', path: paths.host_dir });
        try {
          remove(paths.host_dir, {
            root: mcDir,
            expectedFingerprint: fresh.fingerprint,
            lstat,
          });
        } catch (err) {
          return {
            ok: false,
            removed,
            issues: [removeIssue(paths.host_dir, err)],
          };
        }
      }
      removed.push({ kind: 'broker-host', path: paths.host_dir });
    }
  }

  if (paths.guard_dir) {
    const safe = inspectOwnedPath(mcDir, paths.guard_dir, {
      lstat,
      expected: 'directory',
    });
    if (!safe.ok && !safe.missing) return { ok: false, removed, issues: [safe.issue] };
    if (!safe.missing) {
      if (beforeRemove) await beforeRemove({ kind: 'guard-bin', path: paths.guard_dir });
      try {
        remove(paths.guard_dir, {
          root: mcDir,
          expectedFingerprint: safe.fingerprint,
          lstat,
        });
      } catch (err) {
        return {
          ok: false,
          removed,
          issues: [removeIssue(paths.guard_dir, err)],
        };
      }
      removed.push({ kind: 'guard-bin', path: paths.guard_dir });
    }
  }

  const verification = inspectSessionOwnedMcArtifacts(entry, {
    mcDir,
    lstat,
  });
  const runtimeLeftovers = (verification.leftovers || [])
    .filter((item) => item.kind !== 'vault-manifest');
  return {
    ok: verification.ok && runtimeLeftovers.length === 0,
    removed,
    leftovers: runtimeLeftovers,
    issues: verification.ok ? [] : verification.issues,
  };
}

export async function inspectBrokerSessionAbsence(entry, {
  requestBroker = defaultRequestBroker,
  exists = existsSync,
  mcDir = mcHome(),
} = {}) {
  const paths = sessionOwnedMcArtifactPaths(entry, { mcDir });
  if (!paths.ok) return { ok: false, state: 'unverified', issues: paths.issues };
  const sockets = [
    join(mcDir, 'broker.sock'),
    paths.host_socket,
  ].filter((path, index, list) => path && list.indexOf(path) === index && exists(path));
  for (const socketPath of sockets) {
    const result = await requestBroker({ type: 'sessions' }, { socketPath })
      .catch((err) => ({ ok: false, error: err?.message || String(err) }));
    if (!result?.ok || !Array.isArray(result.sessions)) {
      return {
        ok: false,
        state: 'unverified',
        issues: [{
          code: 'broker-inventory-unavailable',
          path: socketPath,
          error: result?.error || 'invalid broker inventory',
        }],
      };
    }
    const matching = result.sessions.filter((session) => brokerSessionMatchesEntry(session, entry));
    if (matching.length > 0) {
      return {
        ok: false,
        state: 'present',
        issues: matching.map((session) => ({
          code: 'broker-session-leftover',
          id: session.id || session.coding_session_id || null,
          path: socketPath,
        })),
      };
    }
  }
  return { ok: true, state: 'absent', issues: [] };
}

function inspectOwnedPath(root, path, { lstat, expected = null }) {
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, issue: { code: 'mc-artifact-outside-root', path } };
  }
  let current = root;
  let finalStat = null;
  const parts = rel.split(sep);
  for (let index = -1; index < parts.length; index += 1) {
    if (index >= 0) current = join(current, parts[index]);
    let stat;
    try {
      stat = lstat(current);
    } catch (err) {
      if (err?.code === 'ENOENT') return { ok: false, missing: true };
      return {
        ok: false,
        issue: { code: 'mc-artifact-stat-failed', path: current, fs_code: err?.code },
      };
    }
    if (stat.isSymbolicLink()) {
      return { ok: false, issue: { code: 'symlink-not-allowed', path: current } };
    }
    const final = index === parts.length - 1;
    if (!final && !stat.isDirectory()) {
      return {
        ok: false,
        issue: { code: 'mc-artifact-parent-not-directory', path: current },
      };
    }
    if (final && expected === 'directory' && !stat.isDirectory()) {
      return { ok: false, issue: { code: 'mc-artifact-not-directory', path: current } };
    }
    if (final && expected === 'file' && !stat.isFile()) {
      return { ok: false, issue: { code: 'mc-artifact-not-file', path: current } };
    }
    if (final) finalStat = stat;
  }
  return { ok: true, fingerprint: fingerprint(finalStat) };
}

function removeExactDirectoryDefault(path, {
  root,
  expectedFingerprint,
  lstat = lstatSync,
} = {}) {
  const fresh = inspectOwnedPath(root, path, {
    lstat,
    expected: 'directory',
  });
  if (!fresh.ok || !sameFingerprint(fresh.fingerprint, expectedFingerprint)) {
    const err = new Error('mc-owned artifact changed immediately before deletion');
    err.code = 'ARTIFACT_CHANGED';
    err.issue = fresh.issue || null;
    throw err;
  }
  rmSync(path, { recursive: true, force: false });
}

function fingerprint(stat) {
  if (!stat) return null;
  return {
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    mode: Number(stat.mode),
    size: Number(stat.size),
  };
}

function sameFingerprint(a, b) {
  return a?.dev === b?.dev
    && a?.ino === b?.ino
    && a?.mode === b?.mode
    && a?.size === b?.size;
}

function sameDirectoryIdentity(a, b) {
  return a?.dev === b?.dev
    && a?.ino === b?.ino
    && a?.mode === b?.mode;
}

function removeIssue(path, err) {
  return {
    code: err?.code === 'ARTIFACT_CHANGED'
      ? 'mc-artifact-changed'
      : 'mc-artifact-delete-failed',
    path: err?.issue?.path || path,
    ...(err?.code ? { fs_code: err.code } : {}),
  };
}

function readPid(path, readFile) {
  if (!path) return null;
  try {
    const pid = Number(String(readFile(path, 'utf8')).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function readHostStatus(socketPath, requestBroker) {
  return requestBroker({ type: 'status' }, { socketPath })
    .catch((err) => ({ ok: false, error: err?.message || String(err) }));
}

function verifiedBrokerPid(status) {
  const pid = Number(status?.ok ? status?.broker?.pid : null);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function defaultKill(pid) {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch (err) {
    return err?.code === 'ESRCH';
  }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
