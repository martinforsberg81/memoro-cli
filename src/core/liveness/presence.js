/**
 * THE local liveness truth for a coding session.
 *
 * One engine composes every piece of local evidence — broker/host session
 * rows, the trusted lifecycle journal, and the host runtime probe (socket,
 * pid, boot-time, hosted-session listing) — into a single verdict:
 *
 *   live | exited | unreachable | unknown
 *
 * Consumers (open/resume, switch, reconciler, storage repair) must go
 * through this module; local re-derivations of liveness are exactly the
 * bug family behind the 2026-08-01 crash incident and are forbidden.
 */
import { requestBroker } from '../../runtime/broker/client.js';
import {
  listLocalBrokerAndHostSessions,
  probeSessionHostRuntime,
} from '../../runtime/broker/session-hosts.js';
import { sessionHostPaths } from '../../runtime/broker/paths.js';
import { readSessionLifecycle } from '../../runtime/broker/lifecycle-journal.js';

export async function findLiveBrokerSessionForEntry(entry, {
  request = requestBroker,
  deps = {},
} = {}) {
  const presence = await inspectLocalBrokerSessionForEntry(entry, { request, deps });
  return presence.verdict === 'live' ? presence.session : null;
}

export async function inspectLocalBrokerSessionForEntry(entry, {
  request = requestBroker,
  deps = {},
} = {}) {
  const listed = await request({ type: 'sessions' }).catch(() => null);
  const sessions = await (deps.listLocalBrokerAndHostSessions || listLocalBrokerAndHostSessions)({ request })
    .catch(() => listed?.sessions || []);
  const target = selectBrokerSessionForEntry(entry, sessions || listed?.sessions || []);
  if (isLiveBrokerSession(target)) {
    return {
      verdict: 'live',
      session: target,
      runtime_generation: nonEmpty(target.runtime_generation),
    };
  }
  if (isExitedBrokerSession(target)) {
    return {
      verdict: 'exited',
      session: target,
      runtime_generation: nonEmpty(target.runtime_generation),
    };
  }

  const codingSessionId = nonEmpty(entry?.coding_session_id);
  if (!codingSessionId) return { verdict: 'unknown', session: null };
  const paths = (deps.sessionHostPaths || sessionHostPaths)(codingSessionId);
  let lifecycle = null;
  try {
    lifecycle = await (deps.readSessionLifecycle || readSessionLifecycle)({
      path: paths.lifecyclePath,
      codingSessionId,
    });
  } catch {}
  const hostRuntime = await (
    deps.probeSessionHostRuntime || probeSessionHostRuntime
  )(paths, {
    request,
    expectedSessionId: codingSessionId,
  });
  if (lifecycle?.verdict === 'exited') {
    return {
      verdict: 'exited',
      session: null,
      runtime_generation: nonEmpty(lifecycle.record?.runtime_generation),
      lifecycle,
      ...(hostRuntime ? { host_runtime: hostRuntime } : {}),
      ...(hostRuntime?.verdict === 'exited'
        ? { reason: hostRuntime.reason || 'host-process-exited' }
        : {}),
    };
  }
  if (lifecycle?.verdict === 'live') {
    if (hostRuntime?.verdict === 'exited') {
      return {
        verdict: 'exited',
        session: null,
        runtime_generation: nonEmpty(lifecycle.record?.runtime_generation),
        lifecycle,
        host_runtime: hostRuntime,
        reason: hostRuntime.reason || 'host-process-exited',
      };
    }
    // A live journal with a REACHABLE host that provably does not host the
    // session (e.g. the host was restarted after a machine crash) is positive
    // exit evidence: the host owns this session's socket namespace, so an
    // authoritative empty listing means the recorded runtime is gone.
    if (hostRuntime?.verdict === 'live'
      && hostRuntime.hosts_expected_session === false) {
      return {
        verdict: 'exited',
        session: null,
        runtime_generation: nonEmpty(lifecycle.record?.runtime_generation),
        lifecycle,
        host_runtime: hostRuntime,
        reason: 'host-session-absent',
      };
    }
    return {
      verdict: 'unreachable',
      session: null,
      runtime_generation: nonEmpty(lifecycle.record?.runtime_generation),
      lifecycle,
      ...(hostRuntime ? { host_runtime: hostRuntime } : {}),
    };
  }
  if (hostRuntime?.verdict === 'exited') {
    return {
      verdict: 'exited',
      session: null,
      runtime_generation: null,
      lifecycle,
      host_runtime: hostRuntime,
      reason: hostRuntime.reason || 'host-process-exited',
    };
  }
  return {
    verdict: 'unknown',
    session: null,
    lifecycle,
    ...(hostRuntime ? { host_runtime: hostRuntime } : {}),
  };
}

export function selectBrokerSessionForEntry(entry, sessions = []) {
  if (!entry || !Array.isArray(sessions)) return null;

  const entryId = nonEmpty(entry.coding_session_id);
  if (entryId) {
    const direct = sessions.find((session) => brokerSessionId(session) === entryId);
    if (direct) return direct;
  }

  const worktreePath = nonEmpty(entry.worktree_path);
  if (worktreePath) {
    const normalizedWorktreePath = normalizePathForMatch(worktreePath);
    const byCwd = sessions.find(
      (session) => normalizePathForMatch(session.cwd) === normalizedWorktreePath,
    );
    if (byCwd) return byCwd;
  }

  const name = nonEmpty(entry.name);
  if (name) {
    return sessions.find((session) => (
      nonEmpty(session.name) === name
      || nonEmpty(session.worktree_name) === name
    )) || null;
  }

  return null;
}

export function isLiveBrokerSession(session) {
  return !!brokerSessionId(session)
    && session?.attachable !== false
    && session?.session_state !== 'dead'
    && !session?.exit;
}

function isExitedBrokerSession(session) {
  return !!brokerSessionId(session)
    && (session?.session_state === 'dead' || !!session?.exit);
}

export function brokerSessionId(session) {
  return nonEmpty(session?.id) || nonEmpty(session?.coding_session_id);
}


function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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
