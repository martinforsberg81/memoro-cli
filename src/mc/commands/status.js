/**
 * `mc status <name>` (§9a).
 *
 * Reads the registry entry, recomputes `open_question` from
 * `last_assistant_text` (heuristic-only), and returns the entry with
 * the safety verdict and derived fields.
 */
import { findEntry, upsertEntry } from '../registry.js';
import { detectOpenQuestion } from '../open-question.js';
import { DEFAULT_TOOL, readConfig } from '../../lib/config.js';
import { formatPolicySummary, readRepoPolicy, resolveEffectivePolicy } from '../policy.js';
import { readRepoLocalConfig, resolveEffectiveConfig } from '../config-model.js';
import { fetchActiveCodingSessions, findActiveForLocalEntry } from '../session-list.js';
import { requestBroker } from '../broker/client.js';
import { brokerSessionMatchesEntry } from '../broker/session-cleanup.js';
import { listLocalBrokerAndHostSessions } from '../broker/session-hosts.js';
import { observeEntryWorktree } from '../session-observation.js';

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

  const lookupEntry = deps.findEntry || findEntry;
  let entry = lookupEntry(opts.name);
  if (!entry) {
    stderr.write(`mc: no such session "${opts.name}"\n`);
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
  const live = await resolveReachability(entry, { argv, deps });
  const safety_verdict = live.stale && entry.safety_verdict === 'IS_ACTIVE_NOW'
    ? 'SAFE_TO_END'
    : entry.safety_verdict || 'SAFE_TO_END';

  const out = {
    name: entry.name,
    branch: entry.current_branch || entry.branch,
    session_branch: entry.branch || null,
    current_branch: entry.current_branch || null,
    original_branch: entry.original_branch || entry.branch || null,
    observed_head: entry.observed_head || null,
    observed_worktree_path: entry.observed_worktree_path || entry.worktree_path || null,
    last_observed_at: entry.last_observed_at || null,
    kind: entry.kind || 'work',
    safety_verdict,
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
  stdout.write(`  session       ${out.session_state}\n`);
  stdout.write(`  reachability  ${out.reachability}\n`);
  stdout.write(`  dirty files   ${out.dirty_files}\n`);
  stdout.write(`  ahead         ${out.ahead}\n`);
  if (out.open_question) stdout.write(`  PAUSED — awaiting answer\n`);
  if (out.last_assistant_text) {
    stdout.write(`  asst: ${out.last_assistant_text.slice(0, 200).replace(/\n+/g, ' ')}\n`);
  }
  return 0;
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
  };
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
