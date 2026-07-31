/**
 * `mc security claude-c1 <label|session-id> [--json]`
 *
 * A deliberately narrow, user-started gateway for the external C1 live
 * check. It owns no credential access: it resolves a local broker session,
 * derives its controller capability in this trusted CLI process, then makes
 * one fixed broker request. The broker alone decides whether custody may be
 * opened and returns a status-only result.
 */

import { requestBroker } from '../broker/client.js';
import { listLocalBrokerAndHostSessions } from '../broker/session-hosts.js';
import { resolveSessionControllerCapability } from '../session-controller-capability.js';

const C1_STATUSES = new Set(['passed', 'failed', 'indeterminate']);
// The fixed lease host has a ten-minute fail-closed bound. Keep the public
// request bounded too, but long enough to receive its terminal status after
// artifact verification and process-group cleanup.
const C1_BROKER_TIMEOUT_MS = 12 * 60_000;

export async function run(argv, deps = {}) {
  const opts = parseArgs(argv);
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    return 2;
  }
  if (opts.help) {
    stdout.write(helpText());
    return 0;
  }

  const detail = await runClaudeC1Detail(opts.identifier, deps);
  const result = publicResult(detail);
  if (opts.json) {
    // This output is a deliberately closed contract. In particular, do not
    // add diagnostics, paths, broker errors, or authority material here.
    stdout.write(`${JSON.stringify(publicResult(result))}\n`);
  } else if (result.status === 'passed') {
    stdout.write('Claude C1 credential-boundary check passed.\n');
  } else if (detail.reason === 'provider-session-live') {
    stderr.write('mc: exit the ordinary LLM session first, then run this command again.\n');
  } else if (detail.reason === 'local-session-not-found') {
    stderr.write('mc: no matching local broker session was found.\n');
  } else if (detail.reason === 'local-session-ambiguous') {
    stderr.write('mc: more than one local broker session matches that label; use its session id.\n');
  } else {
    stderr.write(`mc: Claude C1 credential-boundary check ${result.status}.\n`);
  }
  return result.ok ? 0 : 1;
}

export function parseArgs(argv = []) {
  const values = Array.isArray(argv) ? [...argv] : [];
  const subcommand = values.shift();
  if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    return { help: true };
  }
  if (subcommand !== 'claude-c1') {
    return { error: 'usage: mc security claude-c1 <label|session-id> [--json]' };
  }

  let identifier = null;
  let json = false;
  for (const value of values) {
    if (value === '--json') {
      if (json) return { error: 'duplicate flag: --json' };
      json = true;
      continue;
    }
    if (value === '--help' || value === '-h') return { help: true };
    if (value.startsWith('-')) return { error: `unknown flag: ${value}` };
    if (identifier !== null) return { error: `unexpected argument: ${value}` };
    identifier = value;
  }
  if (!identifier) return { error: 'claude-c1 requires a local session label or id' };
  return { identifier, json };
}

/**
 * Token-free command core, exported solely for deterministic unit tests.
 * `deps` may replace local discovery/IPC/authority derivation but cannot add
 * a credential source or alter the fixed broker request shape.
 */
export async function runClaudeC1(identifier, deps = {}) {
  return publicResult(await runClaudeC1Detail(identifier, deps));
}

async function runClaudeC1Detail(identifier, deps = {}) {
  const request = deps.request || requestBroker;
  const listSessions = deps.listSessions || listLocalBrokerAndHostSessions;
  const resolveControllerCapability = deps.resolveSessionControllerCapability
    || resolveSessionControllerCapability;
  let sessions;
  try {
    // Explicit includeHosts keeps test doubles equivalent to production: a
    // session-specific broker host is authoritative over the global broker.
    sessions = await listSessions({
      request,
      includeHosts: true,
      ...(deps.hostsDir ? { hostsDir: deps.hostsDir } : {}),
    });
  } catch {
    return c1Result('indeterminate', 'local-broker-unavailable');
  }
  if (!Array.isArray(sessions)) return c1Result('indeterminate', 'local-broker-unavailable');

  const candidates = sessions.filter((session) => sessionMatches(session, identifier));
  if (candidates.length === 0) return c1Result('failed', 'local-session-not-found');
  if (candidates.length !== 1) return c1Result('failed', 'local-session-ambiguous');

  const session = candidates[0];
  const sessionId = brokerSessionId(session);
  if (!sessionId) return c1Result('failed', 'local-session-not-found');
  // This is intentionally before authority derivation or broker IPC. A live
  // provider process in any local mc session is an unsafe peer while the C1
  // broker holds custody. The cross-broker interlock is authoritative; this
  // inventory check gives the user the repair instruction before IPC.
  if (sessions.some((row) => !providerSessionHasExited(row))) {
    return c1Result('indeterminate', 'provider-session-live');
  }

  let authority;
  try {
    authority = await resolveControllerCapability({ codingSessionId: sessionId });
  } catch {
    return c1Result('failed', 'controller-authority-unavailable');
  }
  if (authority?.ok !== true || typeof authority.capability !== 'string') {
    return c1Result('failed', 'controller-authority-unavailable');
  }

  const message = {
    type: 'run_claude_c1',
    id: sessionId,
    session_controller_capability: authority.capability,
  };
  let response;
  try {
    response = await request(message, brokerRequestOptions(session));
  } catch {
    return c1Result('indeterminate', 'broker-request-unavailable');
  }
  return c1Result(response?.status, 'broker-response');
}

function c1Result(status, reason) {
  const normalized = C1_STATUSES.has(status) ? status : 'failed';
  return {
    ok: normalized === 'passed',
    status: normalized,
    // This is internal-only: `run` never renders it in JSON and renders a
    // fixed human message. It lets the unit tests lock ordering and UX.
    reason,
  };
}

function publicResult(result) {
  return { ok: result?.ok === true, status: C1_STATUSES.has(result?.status) ? result.status : 'failed' };
}

function brokerRequestOptions(session) {
  const socketPath = session?.broker_socket_path || session?.brokerSocketPath;
  return {
    ...(socketPath ? { socketPath } : {}),
    timeoutMs: C1_BROKER_TIMEOUT_MS,
  };
}

function brokerSessionId(session) {
  return stringOrNull(session?.id) || stringOrNull(session?.coding_session_id);
}

function sessionMatches(session, identifier) {
  if (!session || typeof identifier !== 'string') return false;
  return [
    session.id,
    session.coding_session_id,
    session.name,
    session.label,
    localWorktreeName(session.cwd),
  ].some((value) => value === identifier);
}

function localWorktreeName(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) || null;
}

function providerSessionHasExited(session) {
  return session?.session_state === 'dead' || Boolean(session?.exit);
}

function stringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function helpText() {
  return `mc security — credential-boundary checks\n\nUSAGE\n  mc security claude-c1 <label|session-id> [--json]\n\nClaude C1 may run only after the ordinary provider session has exited and one\nclean OS restart has occurred for this exact installed containment release.\nThe credential stays in mc vault and broker custody; this command accepts no\npaths, environment, tool, secret, or credential input.\n`;
}
