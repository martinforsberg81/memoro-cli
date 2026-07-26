import { existsSync } from 'node:fs';

import { requestBroker as defaultRequestBroker } from './client.js';
import {
  listLocalBrokerAndHostSessions,
  requestForSession,
} from './session-hosts.js';

export async function removeBrokerSessionForEntry(entry, {
  requestBroker = defaultRequestBroker,
} = {}) {
  if (!entry) return { ok: false, skipped: true, reason: 'entry-required' };
  const inventory = await listLocalBrokerAndHostSessions({ request: requestBroker })
    .then((sessions) => ({ ok: true, sessions }))
    .catch(async (err) => requestBroker({ type: 'sessions' }).catch(() => ({
      ok: false,
      error: err.message || String(err),
    })));
  if (!inventory?.ok || !Array.isArray(inventory.sessions)) {
    return {
      ok: false,
      skipped: true,
      reason: 'broker-unavailable',
      error: inventory?.error || 'broker unavailable',
    };
  }

  const session = inventory.sessions.find((item) => brokerSessionMatchesEntry(item, entry));
  const id = brokerSessionId(session);
  if (!id) return { ok: false, skipped: true, reason: 'not-found' };
  const request = requestForSession(session, { request: requestBroker });

  const removed = await request({ type: 'remove_session', id }).catch((err) => ({
    ok: false,
    error: err.message || String(err),
  }));
  if (!removed?.ok) {
    return {
      ok: false,
      id,
      skipped: false,
      reason: 'remove-failed',
      error: removed?.error || 'remove_session failed',
    };
  }

  // A session on its own dedicated host leaves an empty daemon behind once
  // its PTY is removed; that lingering process blocks sidecar cleanup
  // (broker-host-still-running). Retire the host — but only when it
  // confirms it has no sessions left.
  let hostStopped = false;
  const hostSocketPath = nonEmpty(session?.broker_socket_path || session?.brokerSocketPath);
  if (hostSocketPath) {
    const remaining = await request({ type: 'sessions' }).catch(() => null);
    if (remaining?.ok && Array.isArray(remaining.sessions) && remaining.sessions.length === 0) {
      const stop = await request({ type: 'stop' }).catch(() => null);
      if (stop?.ok) {
        // The sidecar cleanup that follows verifies the host by pid file
        // AND socket file. The daemon stops answering before it unlinks
        // its socket, so waiting only for a dead status leaves a window
        // where a dead socket without a pid reads as "unverified" and
        // fails the teardown. Wait for the socket file to be gone too.
        const deadline = Date.now() + 2_000;
        hostStopped = true;
        while (Date.now() < deadline) {
          const res = await request({ type: 'status' }).catch(() => null);
          if (!res?.ok && !socketFileExists(hostSocketPath)) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    }
  }
  return { ok: true, id, removed: removed.removed !== false, host_stopped: hostStopped };
}

export function brokerSessionMatchesEntry(session, entry) {
  if (!session || !entry) return false;

  const sessionId = nonEmpty(session.coding_session_id || session.id);
  const entryId = nonEmpty(entry.coding_session_id || entry.id);
  if (sessionId && entryId) return sessionId === entryId;

  const sessionCwd = normalizePathForMatch(session.cwd || session.worktree_path);
  const entryWorktree = normalizePathForMatch(entry.worktree_path);
  if (sessionCwd && entryWorktree) return sessionCwd === entryWorktree;

  const sessionName = nonEmpty(session.name || session.label || session.worktree_name);
  const entryName = nonEmpty(entry.name || entry.label);
  return Boolean(sessionName && entryName && sessionName === entryName);
}

function socketFileExists(path) {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function brokerSessionId(session) {
  return nonEmpty(session?.id) || nonEmpty(session?.coding_session_id);
}

function normalizePathForMatch(value) {
  const text = nonEmpty(value);
  if (!text) return null;
  let out = text.replace(/[/\\]+$/, '');
  if (process.platform === 'darwin' && out.startsWith('/private/')) {
    out = out.slice('/private'.length);
  }
  return out;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
