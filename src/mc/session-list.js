import { getSecret } from '../lib/keychain.js';
import { ACCOUNTS } from '../commands/auth.js';
import { readConfig, getApiUrl } from '../lib/config.js';
import { memoroFetch } from '../lib/api.js';

const ACTIVE_PATH = '/api/coding-sessions/active';

export async function fetchActiveCodingSessions({
  argv = [],
  deps = {},
} = {}) {
  const loadConfig = deps.readConfig || readConfig;
  const pickApiUrl = deps.getApiUrl || getApiUrl;
  const loadSecret = deps.getSecret || getSecret;
  const fetchJson = deps.memoroFetch || memoroFetch;

  let config = {};
  try { config = await loadConfig(); } catch { config = {}; }
  const apiUrl = deps.apiUrl || pickApiUrl(argv) || config.apiUrl;
  if (!apiUrl) {
    return { ok: false, sessions: [], warning: 'active sessions unavailable: no Memoro API URL configured' };
  }

  const token = deps.token ?? await loadSecret(ACCOUNTS.TOKEN);
  if (!token) {
    return { ok: false, sessions: [], warning: 'active sessions unavailable: not logged in to Memoro' };
  }

  try {
    const res = await fetchJson(apiUrl, ACTIVE_PATH, { token });
    return {
      ok: true,
      sessions: Array.isArray(res?.sessions) ? res.sessions : [],
      warning: null,
    };
  } catch (err) {
    return {
      ok: false,
      sessions: [],
      warning: `active sessions unavailable: ${err?.message || 'request failed'}`,
    };
  }
}

export function buildSessionListView({
  activeSessions = [],
  localEntries = [],
} = {}) {
  const active = normalizeActiveSessions(activeSessions);
  const local = (Array.isArray(localEntries) ? localEntries : [])
    .filter((entry) => entry && !findActiveForLocalEntry(entry, active))
    .map((entry) => ({ ...entry, type: 'local' }))
    .sort(compareLocalEntries);

  let number = 1;
  return {
    active: active.map((entry) => ({ ...entry, number: number++ })),
    local: local.map((entry) => ({ ...entry, number: number++ })),
  };
}

export function listChoices(view) {
  return [
    ...(Array.isArray(view?.active) ? view.active : []),
    ...(Array.isArray(view?.local) ? view.local : []),
  ];
}

export function parseNumberedChoice(input, choices) {
  const raw = String(input ?? '').trim();
  if (!/^\d+$/.test(raw)) return { error: 'enter a number from the list' };
  const number = Number(raw);
  const choice = (choices || []).find((entry) => entry.number === number);
  if (!choice) return { error: `no session numbered ${number}` };
  return { choice };
}

export function findActiveForLocalEntry(entry, activeSessions = []) {
  if (!entry) return null;
  const active = activeSessions.every?.((s) => s?.type === 'active')
    ? activeSessions
    : normalizeActiveSessions(activeSessions);
  return active.find((session) => activeMatchesLocal(session, entry)) || null;
}

export function renderSessionListHuman({
  view,
  title = 'mc sessions:',
  emptyLocalHint = null,
} = {}) {
  const out = [];
  out.push(title);
  out.push('');
  out.push('Active sessions (reachable with `mc sessions send/read`):');
  if (!view?.active?.length) {
    out.push('  (none)');
  } else {
    for (const session of view.active) {
      out.push(renderActiveLine(session));
      if (session.excerpt) out.push(`     ${session.excerpt}`);
    }
  }
  out.push('');
  out.push('Local sessions (start with `mc resume <name>`):');
  if (!view?.local?.length) {
    out.push('  (none)');
    if (emptyLocalHint) out.push(`  ${emptyLocalHint}`);
  } else {
    for (const entry of view.local) out.push(renderLocalLine(entry));
  }
  out.push('');
  return out.join('\n');
}

export function renderActiveSelectionMessage(session) {
  const id = session?.coding_session_id || session?.id || '<id>';
  const label = session?.label || session?.branch || id;
  const where = [session?.machine_id, session?.repo, session?.branch].filter(Boolean).join(' ');
  const suffix = where ? ` on ${where}` : '';
  return [
    `"${label}" is already active${suffix}.`,
    'mc cannot attach a second local terminal to that running session yet.',
    `Send a message with: mc sessions send ${id} "<message>"`,
    `Read recent output with: mc sessions read ${id}`,
    '',
  ].join('\n');
}

export function normalizeActiveSessions(sessions = []) {
  return (Array.isArray(sessions) ? sessions : [])
    .map(normalizeActiveSession)
    .filter((session) => session.coding_session_id)
    .sort(compareActiveSessions);
}

export function normalizeActiveSession(session = {}) {
  const codingSessionId = session.coding_session_id || session.id || null;
  const label = nonEmpty(session.label);
  const branch = nonEmpty(session.branch);
  const receivedAt = nonEmpty(session.received_at || session.at);
  return {
    type: 'active',
    coding_session_id: codingSessionId,
    id: codingSessionId,
    label,
    name: label || branch || codingSessionId,
    repo: nonEmpty(session.repo),
    branch,
    machine_id: nonEmpty(session.machine_id),
    source: nonEmpty(session.source || session.tool),
    idle_seconds: typeof session.idle_seconds === 'number' ? session.idle_seconds : null,
    status: formatStatus(session.idle_seconds),
    received_at: receivedAt,
    age_label: formatAge(receivedAt),
    excerpt: cleanExcerpt(session.last_user_excerpt || session.last_assistant_excerpt || ''),
  };
}

function activeMatchesLocal(active, local) {
  const localId = nonEmpty(local.coding_session_id || local.id);
  if (localId && active.coding_session_id === localId) return true;
  if (activeLocalBranchMatches(active, local)) return true;
  const localName = nonEmpty(local.name);
  if (!localName) return false;
  const nameMatches = active.label === localName || active.coding_session_id === localName;
  if (!nameMatches) return false;
  return activeLocalContextMatches(active, local);
}

function activeLocalBranchMatches(active, local) {
  const activeRepo = normaliseRepo(active.repo);
  const localRepo = normaliseRepo(local.repo_slug || local.repo || local.repo_name);
  if (activeRepo && localRepo && activeRepo !== localRepo) return false;

  const activeBranch = nonEmpty(active.branch);
  const localBranch = nonEmpty(local.branch);
  return Boolean(activeBranch && localBranch && activeBranch === localBranch);
}

function activeLocalContextMatches(active, local) {
  const activeRepo = normaliseRepo(active.repo);
  const localRepo = normaliseRepo(local.repo_slug || local.repo || local.repo_name);
  if (activeRepo && localRepo && activeRepo !== localRepo) return false;

  const activeBranch = nonEmpty(active.branch);
  const localBranch = nonEmpty(local.branch);
  if (activeBranch && localBranch && activeBranch === localBranch) return true;

  if (activeRepo && localRepo && activeRepo === localRepo) return true;

  return false;
}

function renderActiveLine(session) {
  const name = (session.name || session.coding_session_id || '').padEnd(20);
  const source = (session.source || '').padEnd(10);
  const location = [session.repo, session.branch, session.machine_id].filter(Boolean).join(' ');
  const age = session.age_label ? ` ${session.age_label}` : '';
  const id = session.coding_session_id ? ` id=${session.coding_session_id}` : '';
  return `  ${session.number}. ${name} active  ${source} ${location} ${session.status}${age}${id}`.replace(/\s+$/g, '');
}

function renderLocalLine(entry) {
  const name = String(entry.name || '').padEnd(20);
  const tool = String(entry.tool || '').padEnd(10);
  const branch = String(entry.branch || '').padEnd(24);
  const state = entry.session_state || 'no-session-yet';
  return `  ${entry.number}. ${name} local   ${tool} ${branch} ${state}`.replace(/\s+$/g, '');
}

function compareActiveSessions(a, b) {
  return String(a.label || a.coding_session_id).localeCompare(String(b.label || b.coding_session_id))
    || String(a.repo).localeCompare(String(b.repo))
    || String(a.branch).localeCompare(String(b.branch))
    || String(a.coding_session_id).localeCompare(String(b.coding_session_id));
}

function compareLocalEntries(a, b) {
  return String(a.name || '').localeCompare(String(b.name || ''));
}

function formatStatus(idleSeconds) {
  if (typeof idleSeconds !== 'number' || idleSeconds < 0) return 'unknown';
  if (idleSeconds < 5) return 'ACTIVE';
  if (idleSeconds < 60) return `idle ${idleSeconds}s`;
  if (idleSeconds < 3600) return `idle ${Math.floor(idleSeconds / 60)}m`;
  return `idle ${Math.floor(idleSeconds / 3600)}h`;
}

function formatAge(isoString) {
  if (!isoString) return null;
  const t = Date.parse(isoString);
  if (!Number.isFinite(t)) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function cleanExcerpt(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 100);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normaliseRepo(value) {
  const s = nonEmpty(value);
  return s ? s.toLowerCase() : null;
}
