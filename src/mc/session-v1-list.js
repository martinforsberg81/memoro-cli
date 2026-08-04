import { basename } from 'node:path';

const MIN_WIDTH = 41;
const MAX_WIDTH = 160;

export function buildV1SessionListView({ localSessions = [], cloudSessions = [] } = {}) {
  let number = 1;
  const local = sortSessions(localSessions).map((session) => ({ ...session, number: number++ }));
  const cloud = sortSessions(cloudSessions).map((session) => ({ ...session, number: number++ }));
  return { local, cloud, entries: [...local, ...cloud] };
}

export function renderV1SessionList({
  view,
  terminalWidth = 120,
  useColor = false,
  cloudWarning = null,
  issues = [],
} = {}) {
  const local = Array.isArray(view?.local) ? view.local : [];
  const cloud = Array.isArray(view?.cloud) ? view.cloud : [];
  const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Number(terminalWidth) || 120));
  const out = [
    `mc sessions · ${local.length} local · ${cloud.length} cloud`,
    '',
  ];
  renderSection(out, {
    title: 'Local sessions',
    help: 'Open: mc open <name> · Message: mc sessions send <name> "…"',
    sessions: local,
    width,
    useColor,
  });
  out.push('');
  renderSection(out, {
    title: 'Cloud sessions',
    help: 'Owned by Memoro Cloud; local and cloud sessions are separate.',
    sessions: cloud,
    width,
    useColor,
  });
  if (cloudWarning) {
    out.push('');
    out.push(...wrapText(`Cloud: ${cloudWarning}`, width).map((line) => dim(line, useColor)));
  }
  if (issues.length > 0) {
    out.push('');
    out.push(...wrapText(`${issues.length} local session entr${issues.length === 1 ? 'y' : 'ies'} could not be read; run mc doctor.`, width)
      .map((line) => dim(line, useColor)));
  }
  out.push('');
  return out.join('\n');
}

export function projectV1SessionJson(session) {
  return {
    source_kind: session.source_kind,
    source_id: session.source_id,
    mc_session_id: session.mc_session_id,
    name: session.name,
    objective: session.objective ?? null,
    lifecycle: session.lifecycle,
    runtime_state: session.runtime_state,
    runtime_generation: session.runtime_generation ?? null,
    tool: session.tool ?? null,
    updated_at: session.updated_at ?? null,
    workspace_id: session.workspace_id ?? null,
    workspace_path: session.workspace_path ?? null,
    workspace_state: session.workspace_state ?? null,
    workspace_count: session.workspace_count ?? 0,
  };
}

function renderSection(out, {
  title,
  help,
  sessions,
  width,
  useColor,
}) {
  out.push(title, ...wrapText(help, width - 2).map((line) => `  ${line}`));
  if (sessions.length === 0) {
    out.push('  (none)');
    return;
  }
  out.push('');
  const columns = columnLayout(width);
  const line = dim('─'.repeat(width), useColor);
  out.push(line);
  out.push(renderCells(columns, {
    number: '#',
    name: 'Session',
    tool: 'Tool',
    workspace: 'Workspace',
    runtime: 'Runtime',
    source: 'Source',
    id: 'mc-id',
  }, { header: true, useColor }));
  out.push(line);
  sessions.forEach((session, index) => {
    if (index > 0) out.push('');
    out.push(renderCells(columns, {
      number: `${session.number}.`,
      name: session.name || '—',
      tool: displayTool(session.tool),
      workspace: displayWorkspace(session),
      runtime: displayRuntime(session),
      source: session.source_kind || '—',
      id: session.mc_session_id || '—',
    }, { useColor, sourceKind: session.source_kind }));
  });
  out.push(line);
}

function columnLayout(width) {
  if (width < 73) {
    return [
      ['number', 5],
      ['name', width - 31],
      ['tool', 9],
      ['runtime', 11],
    ];
  }
  if (width < 89) {
    return [
      ['number', 5],
      ['name', width - 61],
      ['tool', 9],
      ['runtime', 11],
      ['id', 28],
    ];
  }

  const includeSource = width >= 110;
  const fixed = includeSource ? 72 : 63;
  const flexible = width - fixed;
  const name = Math.max(14, Math.floor(flexible * 0.42));
  const columns = [
    ['number', 5],
    ['name', name],
    ['tool', 9],
    ['workspace', flexible - name],
    ['runtime', 11],
  ];
  if (includeSource) columns.push(['source', 7]);
  columns.push(['id', 28]);
  return columns;
}

function renderCells(columns, values, { header = false, useColor = false, sourceKind = null } = {}) {
  return columns.map(([key, width]) => {
    let value = truncate(String(values[key] ?? ''), width);
    value = value.padEnd(width, ' ');
    if (!useColor) return value;
    if (header) return `\x1b[1;33m${value}\x1b[0m`;
    if (key === 'name') return `\x1b[1;${sourceKind === 'cloud' ? '35' : '36'}m${value}\x1b[0m`;
    if (key === 'id') return `\x1b[36m${value}\x1b[0m`;
    return value;
  }).join('  ').trimEnd();
}

function displayWorkspace(session) {
  const path = session.workspace_path;
  if (!path) return '—';
  const name = basename(path) || path;
  const count = Number(session.workspace_count) || 0;
  const suffix = count > 1 ? ` +${count - 1}` : '';
  const missing = session.workspace_state === 'missing' ? ' (missing)' : '';
  return `${name}${suffix}${missing}`;
}

function displayRuntime(session) {
  if (session.lifecycle === 'archived') return 'archived';
  const state = session.runtime_state || 'none';
  if (state === 'running' || state === 'live') return 'active';
  if (state === 'none') return 'not-started';
  if (state === 'exited') return 'idle';
  return state;
}

function displayTool(tool) {
  if (tool === 'claude-code') return 'claude';
  return tool || '—';
}

function sortSessions(sessions) {
  return (Array.isArray(sessions) ? sessions : [])
    .filter(Boolean)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))
      || String(a.mc_session_id || '').localeCompare(String(b.mc_session_id || '')));
}

function truncate(value, width) {
  if (value.length <= width) return value;
  if (width < 4) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

function wrapText(value, width) {
  const lines = [];
  let current = '';
  for (const rawWord of String(value || '').trim().split(/\s+/u).filter(Boolean)) {
    let word = rawWord;
    if (current && current.length + word.length + 1 <= width) {
      current += ` ${word}`;
      continue;
    }
    if (current) {
      lines.push(current);
      current = '';
    }
    while (word.length > width) {
      lines.push(word.slice(0, width));
      word = word.slice(width);
    }
    current = word;
  }
  if (current) lines.push(current);
  return lines;
}

function dim(value, enabled) {
  return enabled ? `\x1b[2;37m${value}\x1b[0m` : value;
}
