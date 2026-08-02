import { getSecret } from '../lib/keychain.js';
import { ACCOUNTS } from '../commands/auth.js';
import { readConfig, getApiUrl } from '../lib/config.js';
import { memoroFetch } from '../lib/api.js';
import { requestBroker } from '../runtime/broker/client.js';
import { listLocalBrokerAndHostSessions } from '../runtime/broker/session-hosts.js';

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
    if (res?.ok !== true || !Array.isArray(res.sessions)) {
      return {
        ok: false,
        sessions: [],
        warning: 'active sessions unavailable: invalid Memoro response',
      };
    }
    return {
      ok: true,
      sessions: res.sessions,
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

export async function fetchActiveCodingSessionsWithLocalBroker({
  argv = [],
  deps = {},
  localRes: precomputedLocalRes = null,
} = {}) {
  const localRes = precomputedLocalRes || await fetchLocalBrokerCodingSessions({ deps });
  const cloudRes = await fetchActiveCodingSessions({ argv, deps });
  const sessions = mergeActiveCodingSessions({
    localSessions: localRes.sessions,
    cloudSessions: cloudRes.sessions,
  });

  if (cloudRes.ok) {
    return { ok: true, sessions, warning: null };
  }
  if (sessions.length > 0) {
    return { ok: true, sessions, warning: null };
  }
  return {
    ok: false,
    sessions: [],
    warning: cloudRes.warning || localRes.warning || 'active sessions unavailable',
  };
}

export async function fetchLocalBrokerCodingSessions({ deps = {} } = {}) {
  const request = deps.requestBroker || requestBroker;
  let sessions = null;
  let hostWarning = null;
  try {
    sessions = await (deps.listLocalBrokerAndHostSessions || listLocalBrokerAndHostSessions)({ request });
  } catch (err) {
    hostWarning = err?.message || 'local broker unavailable';
  }
  if (!Array.isArray(sessions)) {
    const res = await request({ type: 'sessions' }).catch((err) => ({
      ok: false,
      error: err.message || String(err),
    }));
    if (!res?.ok || !Array.isArray(res.sessions)) {
      return { ok: false, sessions: [], warning: res?.error || hostWarning || 'local broker unavailable' };
    }
    sessions = res.sessions;
  }
  return {
    ok: true,
    sessions: sessions
      .filter(isLiveLocalBrokerSession)
      .map(normalizeLocalBrokerSessionForList),
    warning: null,
  };
}

function isLiveLocalBrokerSession(session) {
  return !!(session?.coding_session_id || session?.id)
    && session?.attachable !== false
    && session?.session_state !== 'dead'
    && session?.state !== 'dead'
    && !session?.exit;
}

export function normalizeLocalBrokerSessionForList(session = {}) {
  const id = session.coding_session_id || session.id || null;
  const label = nonEmpty(session.label)
    || nonEmpty(session.name)
    || nonEmpty(session.worktree_name)
    || localWorktreeName(session.cwd);
  const receivedAt = nonEmpty(session.last_output_at || session.lastOutputAt)
    || nonEmpty(session.started_at || session.startedAt);
  return {
    ...session,
    coding_session_id: id,
    label,
    repo: nonEmpty(session.repo),
    branch: nonEmpty(session.branch),
    machine_id: nonEmpty(session.machine_id) || 'local',
    source: nonEmpty(session.tool) || nonEmpty(session.source),
    idle_seconds: ageSeconds(receivedAt),
    received_at: receivedAt,
    _mc_list_origin: 'local-broker',
  };
}

export function mergeActiveCodingSessions({ localSessions = [], cloudSessions = [] } = {}) {
  const byId = new Map();
  for (const session of Array.isArray(cloudSessions) ? cloudSessions : []) {
    const id = session?.coding_session_id || session?.id;
    if (id) byId.set(id, session);
  }
  for (const session of Array.isArray(localSessions) ? localSessions : []) {
    const id = session?.coding_session_id || session?.id;
    if (id) byId.set(id, mergeActiveSessionMetadata(byId.get(id), session));
  }
  return [...byId.values()].sort(compareSessionsForList);
}

function mergeActiveSessionMetadata(cloud, local) {
  if (!cloud) return local;
  const merged = { ...cloud, ...local };
  for (const key of [
    'label',
    'name',
    'worktree_name',
    'repo',
    'branch',
    'tool',
    'source',
    'machine_id',
    'received_at',
  ]) {
    merged[key] = nonEmpty(local?.[key]) || nonEmpty(cloud?.[key]);
  }
  if (typeof local?.idle_seconds !== 'number') {
    merged.idle_seconds = typeof cloud?.idle_seconds === 'number' ? cloud.idle_seconds : null;
  }
  return merged;
}

function compareSessionsForList(a, b) {
  const aLocal = a?._mc_list_origin === 'local-broker' ? 0 : 1;
  const bLocal = b?._mc_list_origin === 'local-broker' ? 0 : 1;
  return aLocal - bLocal
    || String(a?.label || a?.coding_session_id || '').localeCompare(String(b?.label || b?.coding_session_id || ''))
    || String(a?.coding_session_id || '').localeCompare(String(b?.coding_session_id || ''));
}

export function buildSessionListView({
  activeSessions = [],
  localEntries = [],
} = {}) {
  const registryEntries = (Array.isArray(localEntries) ? localEntries : [])
    .filter(Boolean);
  const active = normalizeActiveSessions(activeSessions)
    .map((session) => enrichActiveSession(session, registryEntries))
    .sort(compareActiveSessions);
  const local = registryEntries
    .filter((entry) => entry && !findActiveForLocalEntry(entry, active))
    .map((entry) => ({ ...entry, type: 'local' }))
    .sort(compareLocalEntries);

  let number = 1;
  return {
    active: active.map((entry) => ({ ...entry, number: number++ })),
    local: local.map((entry) => ({ ...entry, number: number++ })),
  };
}

function enrichActiveSession(session, registryEntries) {
  const entry = findRegistryEntryForActive(session, registryEntries);
  if (!entry) return session;

  const activeLabel = meaningfulActiveLabel(session);
  const registryName = nonEmpty(entry.name) || nonEmpty(entry.label);
  const label = activeLabel || registryName;
  const source = meaningfulTool(session.source)
    || nonEmpty(entry.tool)
    || nonEmpty(session.source);
  return {
    ...session,
    label,
    name: label || session.name,
    source,
    repo: session.repo || localEntryRepo(entry),
    branch: session.branch || nonEmpty(entry.branch),
    status: session.status === 'unknown' ? 'active' : session.status,
  };
}

function findRegistryEntryForActive(active, entries) {
  const id = nonEmpty(active?.coding_session_id || active?.id);
  if (id) {
    const matches = entries.filter((entry) => (
      nonEmpty(entry?.coding_session_id || entry?.id) === id
    ));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return null;
  }

  const matches = entries.filter((entry) => activeMatchesLocal(active, entry));
  return matches.length === 1 ? matches[0] : null;
}

function meaningfulActiveLabel(session) {
  const label = nonEmpty(session?.label);
  const id = nonEmpty(session?.coding_session_id || session?.id);
  return label && label !== id ? label : null;
}

function meaningfulTool(value) {
  const tool = nonEmpty(value);
  return tool && tool !== 'local-broker' ? tool : null;
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
  includeExcerpts = false,
  isTTY = false,
  terminalWidth = 80,
  useColor = false,
} = {}) {
  if (isTTY) {
    return renderSessionListTable({
      view,
      title,
      emptyLocalHint,
      includeExcerpts,
      terminalWidth,
      useColor,
    });
  }

  const out = [];
  out.push(title);
  out.push('');
  out.push('Active sessions (reachable with `mc sessions send/read`):');
  if (!view?.active?.length) {
    out.push('  (none)');
  } else {
    for (const session of view.active) {
      out.push(renderActiveLine(session));
      if (includeExcerpts && session.excerpt) out.push(`     ${session.excerpt}`);
    }
  }
  out.push('');
  out.push('Local sessions (start with `mc open <name>`):');
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
    'No matching live session was found in the local broker attach path.',
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
  const idleSeconds = typeof session.idle_seconds === 'number' ? session.idle_seconds : null;
  const sessionState = nonEmpty(session.session_state || session.state || session.presence_state);
  return {
    type: 'active',
    coding_session_id: codingSessionId,
    id: codingSessionId,
    label,
    name: label || branch || codingSessionId,
    repo: nonEmpty(session.repo),
    branch,
    machine_id: nonEmpty(session.machine_id),
    source_id: nonEmpty(session.source_id),
    source_kind: nonEmpty(session.source_kind),
    runtime_generation: nonEmpty(session.runtime_generation),
    presence_state: nonEmpty(session.presence_state),
    session_state: sessionState,
    host_busy: session.host_busy === true,
    source: nonEmpty(session.tool) || nonEmpty(session.source),
    idle_seconds: idleSeconds,
    status: formatActiveStatus({ idleSeconds, sessionState, attachable: session.attachable }),
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
  const name = fixed(session.name || session.coding_session_id || '', 28);
  const source = fixed(session.source || '', 10);
  const repo = fixed(session.repo || '', 12);
  const branch = fixed(session.branch || '', 28);
  const status = fixed(session.status || 'unknown', 10);
  const id = session.coding_session_id ? ` id=${session.coding_session_id}` : '';
  return `  ${session.number}. ${name} active  ${source} ${repo} ${branch} ${status}${id}`.replace(/\s+$/g, '');
}

function renderLocalLine(entry) {
  const name = fixed(entry.name || '', 28);
  const tool = fixed(entry.tool || '', 10);
  const branch = fixed(entry.branch || '', 28);
  const state = entry.session_state || 'no-session-yet';
  return `  ${entry.number}. ${name} local   ${tool} ${branch} ${state}`.replace(/\s+$/g, '');
}

function renderSessionListTable({
  view,
  title,
  emptyLocalHint,
  includeExcerpts,
  terminalWidth,
  useColor,
}) {
  const width = normalizeTerminalWidth(terminalWidth);
  const activeCount = view?.active?.length || 0;
  const localCount = view?.local?.length || 0;
  const out = [renderListTitle(title, activeCount, localCount), '', 'Active sessions'];
  if (width >= 72) {
    out.push(styleText('  Message: mc sessions send <mc-id> "…" · Output: mc sessions read <mc-id>', ANSI.dim, useColor));
  }

  if (!activeCount) {
    out.push('  (none)');
  } else {
    const rows = view.active.map((session) => ({
      number: `${session.number}.`,
      session: session.name || session.coding_session_id || '',
      tool: session.source || '',
      repository: session.repo || '',
      branch: session.branch || '',
      status: session.status || 'unknown',
      id: session.coding_session_id || '',
    }));
    out.push(...renderBorderlessTable(rows, activeTableColumns(), { width, useColor }));
    if (includeExcerpts) {
      for (const session of view.active) {
        if (session.excerpt) out.push(styleText(`  ${session.number}. ${session.excerpt}`, ANSI.dim, useColor));
      }
    }
  }

  out.push('');
  out.push('Local sessions');
  if (width >= 54) {
    out.push(styleText('  Saved locally · Reopen with mc open <session>', ANSI.dim, useColor));
  }
  if (!localCount) {
    out.push('  (none)');
    if (emptyLocalHint) out.push(`  ${emptyLocalHint}`);
  } else {
    const rows = view.local.map((entry) => ({
      number: `${entry.number}.`,
      session: entry.name || '',
      tool: entry.tool || '',
      repository: localEntryRepo(entry),
      branch: entry.branch || '',
      status: formatLocalStatus(entry),
      id: entry.coding_session_id || '',
    }));
    out.push(...renderBorderlessTable(rows, localTableColumns(), { width, useColor }));
  }

  out.push('');
  return out.join('\n');
}

function renderListTitle(title, activeCount, localCount) {
  const base = String(title || 'mc sessions').replace(/:\s*$/u, '');
  return `${base} · ${activeCount} active · ${localCount} local`;
}

function activeTableColumns() {
  return [
    tableColumn('number', '#', 3, 3),
    tableColumn('session', 'Session', 16, 30, { grow: 2 }),
    tableColumn('status', 'Status', 8, 12),
    tableColumn('tool', 'Tool', 6, 10, { optional: true, dropOrder: 2 }),
    tableColumn('repository', 'Repository', 10, 14, { optional: true, dropOrder: 1 }),
    tableColumn('branch', 'Branch', 12, 28, { optional: true, dropOrder: 3, grow: 1 }),
    tableColumn('id', 'mc-id', 12, 24, { grow: 3, accent: true }),
  ];
}

function localTableColumns() {
  return [
    tableColumn('number', '#', 3, 3),
    tableColumn('session', 'Session', 16, 30, { grow: 2 }),
    tableColumn('status', 'Status', 8, 16),
    tableColumn('tool', 'Tool', 6, 10, { optional: true, dropOrder: 2 }),
    tableColumn('repository', 'Repository', 10, 14, { optional: true, dropOrder: 1 }),
    tableColumn('branch', 'Branch', 12, 28, { optional: true, dropOrder: 3, grow: 1 }),
    tableColumn('id', 'mc-id', 12, 24, { grow: 3, accent: true }),
  ];
}

/**
 * Sessions are repository-scoped, so the list must say WHICH repository
 * each row belongs to — without it, cross-repo duplicates are
 * indistinguishable and the "run inside the repository" errors point
 * nowhere.
 */
function localEntryRepo(entry) {
  const canonical = entry?.repository_identity?.canonical;
  if (typeof canonical === 'string' && canonical.includes('/')) {
    return canonical.split('/').pop();
  }
  return nonEmpty(entry?.repo_slug || entry?.repo || entry?.repo_name);
}

function tableColumn(key, label, minWidth, maxWidth, options = {}) {
  return {
    key,
    label,
    minWidth,
    maxWidth,
    optional: false,
    dropOrder: Number.POSITIVE_INFINITY,
    grow: 0,
    accent: false,
    ...options,
  };
}

function renderBorderlessTable(rows, definitions, { width, useColor }) {
  const columns = fitTableColumns(definitions, width);
  const divider = '─'.repeat(tableWidth(columns));
  const header = columns
    .map((column) => fixedCell(column.label, column.width))
    .join('  ');
  const lines = [
    styleText(divider, ANSI.divider, useColor),
    styleText(header, ANSI.header, useColor),
    styleText(divider, ANSI.divider, useColor),
  ];

  rows.forEach((row, index) => {
    const cells = columns.map((column) => {
      const raw = String(row[column.key] || '—');
      const cell = fixedCell(raw, column.width);
      return column.accent && raw !== '—'
        ? styleText(cell, ANSI.id, useColor)
        : cell;
    });
    lines.push(cells.join('  '));
    if (index < rows.length - 1) lines.push('');
  });
  lines.push(styleText(divider, ANSI.divider, useColor));
  return lines;
}

function fitTableColumns(definitions, availableWidth) {
  const columns = definitions.map((column) => ({
    ...column,
    width: column.minWidth,
  }));
  const optional = columns
    .filter((column) => column.optional)
    .sort((a, b) => a.dropOrder - b.dropOrder);

  while (tableWidth(columns) > availableWidth && optional.length > 0) {
    const dropped = optional.shift();
    columns.splice(columns.indexOf(dropped), 1);
  }

  let remaining = Math.max(0, availableWidth - tableWidth(columns));
  const growable = columns
    .filter((column) => column.maxWidth > column.width)
    .sort((a, b) => b.grow - a.grow);
  while (remaining > 0 && growable.some((column) => column.width < column.maxWidth)) {
    for (const column of growable) {
      if (remaining === 0) break;
      if (column.width >= column.maxWidth) continue;
      column.width += 1;
      remaining -= 1;
    }
  }

  if (tableWidth(columns) > availableWidth) {
    shrinkColumn(columns, 'session', 8, availableWidth);
    shrinkColumn(columns, 'id', 8, availableWidth);
    shrinkColumn(columns, 'status', 6, availableWidth);
  }
  return columns;
}

function shrinkColumn(columns, key, minimum, availableWidth) {
  const column = columns.find((candidate) => candidate.key === key);
  while (column && column.width > minimum && tableWidth(columns) > availableWidth) {
    column.width -= 1;
  }
}

function tableWidth(columns) {
  return columns.reduce((sum, column) => sum + column.width, 0)
    + Math.max(0, columns.length - 1) * 2;
}

function fixedCell(value, width) {
  return clipCell(String(value || ''), width).padEnd(width);
}

function clipCell(value, width) {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

function normalizeTerminalWidth(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 80;
  return Math.max(32, Math.floor(parsed));
}

function styleText(value, style, enabled) {
  return enabled ? `${style}${value}${ANSI.reset}` : value;
}

const ANSI = Object.freeze({
  reset: '\x1b[0m',
  header: '\x1b[1;33m',
  divider: '\x1b[2;37m',
  id: '\x1b[36m',
  dim: '\x1b[2m',
});

function compareActiveSessions(a, b) {
  return String(a.label || a.coding_session_id).localeCompare(String(b.label || b.coding_session_id))
    || String(a.repo).localeCompare(String(b.repo))
    || String(a.branch).localeCompare(String(b.branch))
    || String(a.coding_session_id).localeCompare(String(b.coding_session_id));
}

function compareLocalEntries(a, b) {
  return String(a.name || '').localeCompare(String(b.name || ''));
}

function formatActiveStatus({ idleSeconds, sessionState, attachable }) {
  if (typeof idleSeconds !== 'number' || idleSeconds < 0) {
    if (attachable === true || ['live', 'active', 'connected'].includes(sessionState)) return 'active';
    return humanizeState(sessionState) || 'unknown';
  }
  if (idleSeconds < 5) return 'active';
  if (idleSeconds < 60) return `idle ${idleSeconds}s`;
  if (idleSeconds < 3600) return `idle ${Math.floor(idleSeconds / 60)}m`;
  return `idle ${Math.floor(idleSeconds / 3600)}h`;
}

function formatLocalStatus(entry) {
  const state = nonEmpty(entry?.session_state) || 'no-session-yet';
  const label = humanizeState(state) || state;
  if (!['idle', 'stopped'].includes(label)) return label;
  const age = formatAge(entry?.last_activity)?.replace(/ ago$/u, '');
  return age ? `${label} ${age}` : label;
}

function humanizeState(state) {
  if (!state) return null;
  return {
    live: 'active',
    active: 'active',
    idle: 'idle',
    dead: 'stopped',
    stale: 'stale',
    'no-session-yet': 'not started',
  }[state] || state;
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

function ageSeconds(isoString) {
  if (!isoString) return null;
  const t = Date.parse(isoString);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

function cleanExcerpt(value) {
  return String(value || '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[=>cDEHM7-9NO]/g, '')
    .replace(/\[[0-9;?]+[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normaliseRepo(value) {
  const s = nonEmpty(value);
  return s ? s.toLowerCase() : null;
}

function localWorktreeName(cwd) {
  if (!cwd) return null;
  const parts = String(cwd).split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) || null;
}

function fixed(value, width) {
  return clip(String(value || ''), width).padEnd(width);
}

function clip(value, width) {
  if (value.length <= width) return value;
  if (width <= 3) return value.slice(0, width);
  return `${value.slice(0, width - 3)}...`;
}
