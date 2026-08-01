/**
 * `mc status <name>` (§9a).
 *
 * Reads the registry entry, recomputes `open_question` from
 * `last_assistant_text` (heuristic-only), and returns the entry with
 * the safety verdict and derived fields.
 */
import {
  formatEntryResolutionError,
  resolveEntry,
  upsertEntry,
} from '../mc/registry.js';
import { detectOpenQuestion } from '../mc/open-question.js';
import { escalateSafetyVerdict } from '../mc/safety-verdict.js';
import { DEFAULT_TOOL, readConfig } from '../lib/config.js';
import { formatPolicySummary, readRepoPolicy, resolveEffectivePolicy } from '../mc/policy.js';
import { readRepoLocalConfig, resolveEffectiveConfig } from '../mc/config-model.js';
import { fetchActiveCodingSessions, findActiveForLocalEntry } from '../mc/session-list.js';
import { requestBroker } from '../runtime/broker/client.js';
import { brokerSessionMatchesEntry } from '../runtime/broker/session-cleanup.js';
import { listLocalBrokerAndHostSessions } from '../runtime/broker/session-hosts.js';
import { observeEntryWorktree } from '../mc/session-observation.js';
import {
  projectRuntimeSession,
  projectTranscriptSession,
} from '../mc/session-projector.js';
import { listDevServers, summarizeDevServers } from '../mc/dev-servers.js';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    return 2;
  }
  if (!opts.name) {
    stderr.write('mc: usage — `mc status <name> [--json]`\n');
    return 2;
  }

  const resolvedEntry = deps.findEntry
    ? injectedLookup(opts.name, deps.findEntry)
    : resolveEntry(opts.name, { cwd: deps.cwd || process.cwd() });
  let entry = resolvedEntry.entry;
  if (!resolvedEntry.ok) {
    stderr.write(`mc: ${formatEntryResolutionError(opts.name, resolvedEntry)}\n`);
    return 1;
  }
  entry = maybeObserveEntry(entry, deps);

  const open_question = entry.open_question ?? detectOpenQuestion(entry.last_assistant_text || '');
  let config = {};
  const loadConfig = deps.readConfig || readConfig;
  try { config = await loadConfig(); } catch { /* status remains best-effort */ }
  const repoPolicy = readRepoPolicy({ worktreePath: entry.worktree_path });
  const repoLocal = readRepoLocalConfig({ worktreePath: entry.worktree_path });
  const effective_policy = resolveEffectivePolicy({ entry, repoPolicy, config });
  const effective_config = resolveEffectiveConfig({
    globalConfig: config,
    repoPolicy,
    localConfig: repoLocal.config,
    entry,
    warnings: repoLocal.warnings,
  });
  // Reachability (broker sweep + active lookup) and dev-server health
  // probes are independent — overlap them instead of paying both waits.
  const [live, dev_servers] = await Promise.all([
    resolveReachability(entry, { argv, deps }),
    resolveDevServers(entry, deps),
  ]);
  // A stale session cannot be active now; otherwise trust the stored
  // verdict only as far as fresh git facts allow (escalate-only).
  const storedVerdict = live.stale && entry.safety_verdict === 'IS_ACTIVE_NOW'
    ? null
    : entry.safety_verdict || null;
  const safety_verdict = escalateSafetyVerdict({
    stored: storedVerdict,
    dirtyFiles: entry.dirty_files ?? null,
    ahead: entry.ahead ?? null,
  });
  const work_status = projectStatusWorkStatus(entry, live, { safety_verdict });

  const out = {
    name: entry.name,
    session_id: entry.session_id || null,
    repository_id: entry.repository_id || null,
    branch: entry.current_branch || entry.branch,
    session_branch: entry.branch || null,
    current_branch: entry.current_branch || null,
    original_branch: entry.original_branch || entry.branch || null,
    observed_head: entry.observed_head || null,
    observed_worktree_path: entry.observed_worktree_path || entry.worktree_path || null,
    last_observed_at: entry.last_observed_at || null,
    kind: entry.kind || 'work',
    safety_verdict,
    work_status,
    session_state: live.session_state,
    reachability: live.reachability,
    active_session: live.active_session,
    dirty_files: entry.dirty_files || 0,
    ahead: entry.ahead || 0,
    behind: entry.behind || 0,
    last_activity: entry.last_activity || null,
    last_user_msg: entry.last_user_msg ?? null,
    last_assistant_text: entry.last_assistant_text ?? null,
    open_question,
    tool: entry.tool ?? null,
    model_chain: entry.model_chain ?? [],
    worktree_path: entry.worktree_path ?? null,
    relaunch_command: `mc open ${entry.name}`,
    effective_policy,
    effective_config,
    dev_servers,
  };

  if (opts.json) {
    stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 0;
  }

  // Human-readable
  stdout.write(`${out.name}  ${out.branch}\n`);
  if (out.current_branch && out.session_branch && out.current_branch !== out.session_branch) {
    stdout.write(`  session branch ${out.session_branch}\n`);
  }
  stdout.write(`  tool          ${out.tool || DEFAULT_TOOL}\n`);
  stdout.write(`  relaunch      ${out.relaunch_command}\n`);
  stdout.write(`  policy        ${formatPolicySummary(out.effective_policy)}\n`);
  stdout.write(`  verdict       ${out.safety_verdict}\n`);
  stdout.write(`  work status   ${out.work_status.status} (${out.work_status.reason_code})\n`);
  stdout.write(`  session       ${out.session_state}\n`);
  stdout.write(`  reachability  ${out.reachability}\n`);
  stdout.write(`  dirty files   ${out.dirty_files}\n`);
  stdout.write(`  ahead         ${out.ahead}\n`);
  stdout.write(`  dev servers   ${out.dev_servers.summary.total}`);
  if (out.dev_servers.summary.unhealthy || out.dev_servers.summary.orphan) {
    stdout.write(` (${out.dev_servers.summary.unhealthy} unhealthy, ${out.dev_servers.summary.orphan} orphan)`);
  }
  stdout.write(`\n`);
  if (out.open_question) stdout.write(`  PAUSED — awaiting answer\n`);
  if (out.last_assistant_text) {
    stdout.write(`  asst: ${out.last_assistant_text.slice(0, 200).replace(/\n+/g, ' ')}\n`);
  }
  return 0;
}

async function resolveDevServers(entry, deps = {}) {
  const list = deps.listDevServers || listDevServers;
  try {
    const all = await list();
    const servers = all.filter((server) => {
      if (entry.worktree_path) return server.worktree_path === entry.worktree_path;
      if (entry.coding_session_id) return server.coding_session_id === entry.coding_session_id;
      if (entry.session_id || entry.repository_id) return false;
      return server.session_name === entry.name;
    });
    return { summary: summarizeDevServers(servers), servers };
  } catch {
    return { summary: summarizeDevServers([]), servers: [] };
  }
}

function maybeObserveEntry(entry, deps = {}) {
  const observer = deps.observeEntryWorktree || (!deps.findEntry ? observeEntryWorktree : null);
  if (!observer) return entry;
  try {
    return observer(entry, {
      upsert: deps.upsertEntry || upsertEntry,
    })?.entry || entry;
  } catch {
    return entry;
  }
}

async function resolveReachability(entry, { argv = [], deps = {} } = {}) {
  const storedState = entry.session_state || 'no-session-yet';
  const broker = await resolveBrokerReachability(entry, { deps });
  if (broker?.reachability === 'reachable') return broker;

  const fetchActive = deps.fetchActiveSessions
    || ((args) => fetchActiveCodingSessions({ argv: args }));

  if (!deps.fetchActiveSessions && process.env.MC_TEST_MODE === '1') {
    return {
      session_state: storedState,
      reachability: broker?.authoritative ? staleOrMissingReachability(storedState) : 'unknown',
      active_session: null,
      stale: broker?.authoritative && storedState === 'live',
    };
  }

  const activeRes = await fetchActive(argv).catch((err) => ({
    ok: false,
    warning: err?.message || 'active-session lookup failed',
  }));
  if (!activeRes?.ok) {
    return {
      session_state: storedState,
      reachability: broker?.authoritative ? staleOrMissingReachability(storedState) : 'unknown',
      active_session: null,
      stale: broker?.authoritative && storedState === 'live',
    };
  }

  const active = findActiveForLocalEntry(entry, activeRes.sessions || []);
  if (active) {
    return {
      session_state: 'live',
      reachability: 'reachable',
      active_session: {
        coding_session_id: active.coding_session_id,
        label: active.label || null,
        repo: active.repo || null,
        branch: active.branch || null,
        machine_id: active.machine_id || null,
        idle_seconds: active.idle_seconds,
        status: active.status || null,
        session_projection: active.session_projection || null,
      },
      stale: false,
    };
  }

  return {
    session_state: storedState === 'live' ? 'idle' : storedState,
    reachability: staleOrMissingReachability(storedState),
    active_session: null,
    stale: storedState === 'live',
  };
}

async function resolveBrokerReachability(entry, { deps = {} } = {}) {
  const storedState = entry.session_state || 'no-session-yet';
  const fetchBrokerStatus = deps.fetchBrokerStatus
    || (() => requestBroker({ type: 'status' }));

  if (!deps.fetchBrokerStatus && process.env.MC_TEST_MODE === '1') {
    return { authoritative: false };
  }

  let sessions = null;
  if (!deps.fetchBrokerStatus) {
    sessions = await (deps.listLocalBrokerAndHostSessions || listLocalBrokerAndHostSessions)({ request: requestBroker })
      .catch(() => null);
  }
  const res = sessions ? { ok: true, sessions } : await fetchBrokerStatus().catch(() => null);
  if (!res?.ok || !Array.isArray(res.sessions)) return { authoritative: false };
  const live = findBrokerSessionForEntry(entry, res.sessions, { liveOnly: true });
  if (live) {
    return {
      session_state: 'live',
      reachability: 'reachable',
      active_session: brokerSessionSummary(live),
      stale: false,
      authoritative: true,
    };
  }
  return {
    session_state: storedState === 'live' ? 'idle' : storedState,
    reachability: staleOrMissingReachability(storedState),
    active_session: null,
    stale: storedState === 'live',
    authoritative: true,
  };
}

function findBrokerSessionForEntry(entry, sessions, { liveOnly = false } = {}) {
  const matches = sessions.filter((session) => brokerSessionMatchesEntry(session, entry));
  const eligible = liveOnly
    ? matches.filter((session) => isLiveBrokerSession(session))
    : matches;
  return eligible.sort(compareBrokerSessionsByActivity)[0] || null;
}

function isLiveBrokerSession(session) {
  if (!session) return false;
  if (session.exit) return false;
  if (session.session_state && session.session_state !== 'live') return false;
  return session.attachable !== false;
}

function compareBrokerSessionsByActivity(a, b) {
  return timestampMs(b?.last_output_at || b?.lastOutputAt || b?.started_at)
    - timestampMs(a?.last_output_at || a?.lastOutputAt || a?.started_at);
}

function brokerSessionSummary(session) {
  return {
    coding_session_id: session?.id || session?.coding_session_id || null,
    label: session?.name || session?.label || null,
    repo: session?.repo || null,
    branch: session?.branch || null,
    machine_id: session?.machine_id || null,
    idle_seconds: typeof session?.idle_seconds === 'number' ? session.idle_seconds : null,
    status: session?.session_state || null,
    session_projection: session?.session_projection || null,
  };
}

function projectStatusWorkStatus(entry, live, { safety_verdict } = {}) {
  const active = live?.active_session;
  if (active?.session_projection) {
    return projectRuntimeSession({
      session: {
        ...active,
        session_state: live.session_state,
        attachable: live.reachability === 'reachable',
      },
    });
  }

  const git = {
    current_branch: entry.current_branch || entry.branch || null,
    dirty_files: entry.dirty_files ?? entry.observed_dirty_files ?? null,
    ahead: entry.ahead ?? entry.observed_ahead ?? null,
    behind: entry.behind ?? entry.observed_behind ?? null,
    safety_verdict: safety_verdict || entry.safety_verdict || null,
    observed_at: entry.last_observed_at || entry.last_activity || null,
  };
  if (entry.last_assistant_text && live?.session_state !== 'live') {
    const messages = [];
    if (entry.last_user_msg) {
      messages.push({ role: 'user', content: entry.last_user_msg, at: entry.last_activity || null });
    }
    messages.push({
      role: 'assistant',
      content: entry.last_assistant_text,
      at: entry.last_activity || null,
    });
    return projectTranscriptSession({
      parsed: { messages, endedAt: entry.last_activity || null },
      git,
      runtimeLifecycle: live?.session_state === 'live' ? 'live' : 'stopped',
    });
  }
  return projectRuntimeSession({
    session: {
      ...entry,
      ...active,
      session_state: live?.session_state || entry.session_state,
      attachable: live?.reachability === 'reachable',
      last_output_at: active?.last_output_at || entry.last_activity || null,
    },
    output: entry.last_assistant_text || '',
    git,
  });
}

function staleOrMissingReachability(storedState) {
  return storedState === 'live' ? 'stale' : 'not-reachable';
}

function timestampMs(value) {
  const t = Date.parse(String(value || ''));
  return Number.isFinite(t) ? t : 0;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function injectedLookup(identifier, lookup) {
  const entry = lookup(identifier);
  return entry
    ? { ok: true, entry, source: 'injected' }
    : { ok: false, entry: null, reason: 'missing' };
}

function parseArgs(argv) {
  const opts = { name: null, json: false };
  for (const a of argv) {
    if (a === '--json') { opts.json = true; continue; }
    if (a.startsWith('--')) return { error: `unknown flag: ${a}` };
    if (opts.name) return { error: `unexpected arg: ${a}` };
    opts.name = a;
  }
  return opts;
}
