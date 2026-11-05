/** Repository-specific operational views; a port is an address, never a PR cell. */
import { ageWords } from './page-cache.js';
import { clipCell, duration, stateTone } from './page-grid.js';

export const QUEUED_DRAWN = 6;
const one = (value) => String(value ?? '').replace(/[\r\n\t]+/gu, ' ').trim();
const age = (value) => value == null ? 'age unknown' : `${ageWords(value)} ago`;

/** Wrap detail text so a narrow terminal still exposes the whole stop reason. */
export function detail(lines, c, wide, indent, value, tone = ['grey']) {
  const room = wide - indent;
  let rest = one(value);
  while (rest) {
    let end = rest.length <= room ? rest.length : rest.lastIndexOf(' ', room);
    if (end <= 0) end = Math.min(room, rest.length);
    lines.push(`${' '.repeat(indent)}${c(rest.slice(0, end), ...tone)}`);
    rest = rest.slice(end).trimStart();
  }
}

/** Work panels share the programme frame shape, with orange structural rules. */
export function panelHeading(lines, c, wide, name, summary = '', verb = '') {
  const hint = verb && wide - name.length - verb.length >= 10 ? ` ${verb}` : '';
  const rule = '─'.repeat(Math.max(0, wide - name.length - hint.length - 6));
  lines.push(`  ${c('┌─ ', 'orange')}${c(name, 'bold')}${c(` ${rule}`, 'orange')}${hint ? c(hint, 'grey') : ''}`);
  if (summary) detail(lines, c, wide, 4, summary);
}

export function panelEnd(lines, c, wide) {
  lines.push(`  ${c('└' + '─'.repeat(wide - 3), 'orange')}`);
}

const shortPath = (path) => String(path || '').replace(/^\/(?:Users|home)\/[^/]+/u, '~').replace(/^~\/mc\/programs\//u, '');

export function devLines(lines, c, wide, dev, expand) {
  const servers = dev?.servers || [];
  const queue = dev?.queue || [];
  panelHeading(lines, c, wide, 'DEV', !dev ? 'not read' : servers.length || dev?.queued
    ? [`${dev.running} running`, `${dev.leased} leased`, dev.starting && `${dev.starting} starting`, dev.queued && `${dev.queued} queued`].filter(Boolean).join(' · ')
    : 'none running', 'mc dev list');
  for (const server of servers) {
    const kind = String(server.kind || 'slot').toUpperCase().padEnd(5);
    const address = server.port ? `:${server.port}` : server.url || 'address unknown';
    const state = server.state || 'unknown';
    const stage = one(server.holder?.kind);
    const label = ['build', 'review'].includes(stage) ? stage.toUpperCase() : stage;
    const prefix = `    ${kind} ${clipCell(address, 8).padEnd(8)} `;
    const stateCell = clipCell(state, 8).padEnd(8);
    const stageCell = clipCell(label, 7).padEnd(7);
    const warning = server.holder_gone ? ' · holder gone' : '';
    const room = wide - prefix.length - stateCell.length - stageCell.length - 2 - warning.length;
    const name = clipCell(server.holder?.name || '', room);
    lines.push(`${c(prefix, 'grey')}${c(stateCell, ...stateTone(state))} ${c(stageCell, ...(server.holder_gone ? ['grey'] : []))} ${c(name, ...(server.holder_gone ? ['grey'] : []))}${warning ? ' · ' + c('holder gone', 'yellow') : ''}`.trimEnd());
    if (expand) {
      detail(lines, c, wide, 12, [server.url, server.service, server.progress && `last used ${server.progress} ago`].filter(Boolean).join(' · '));
      detail(lines, c, wide, 12, [server.branch, shortPath(server.worktree)].filter(Boolean).join(' · '));
    }
  }
  if (queue.length) {
    detail(lines, c, wide, 4, `QUEUE · ${queue.length} waiting`, ['yellow']);
    const shown = expand ? queue : queue.slice(0, 3);
    for (const item of shown) {
      detail(lines, c, wide, 6, `${item.name || 'unknown holder'} · waited ${duration(item.waited_seconds)}`, ['yellow']);
      if (expand) detail(lines, c, wide, 8, [item.service, item.gate && 'gate', shortPath(item.worktree)].filter(Boolean).join(' · '));
    }
    if (shown.length < queue.length) detail(lines, c, wide, 6, `▸ ${queue.length - shown.length} more`);
  } else if (dev?.queued) detail(lines, c, wide, 4, `${dev.queued} queued · details unavailable`, ['yellow']);
}

/** Align operation labels and status; continuation lines stay in the status column. */
function operation(lines, c, wide, label, status = '', tone = ['grey'], { indent = 6, labelWide = 20 } = {}) {
  if (label.length > labelWide) {
    detail(lines, c, wide, indent, label, tone);
    if (status) detail(lines, c, wide, indent + labelWide + 3, status, tone);
    return;
  }
  const prefix = `${' '.repeat(indent)}${label.padEnd(labelWide)}   `;
  const wrapped = [];
  detail(wrapped, c, wide, prefix.length, status, tone);
  if (wrapped.length) {
    lines.push(c(prefix, ...tone) + wrapped[0].slice(prefix.length));
    lines.push(...wrapped.slice(1));
  } else detail(lines, c, wide, indent, label, tone);
}

/** A phase marker, never a percentage: prepare, gate, then land. */
function mergeBar(state) {
  return { rebase: '[●··]', gate: '[━●·]', landing: '[━━●]' }[state] || '[···]';
}

export function mergesLines(lines, c, wide, merges, expand) {
  panelHeading(lines, c, wide, 'MERGE & DEPLOY', '', 'mc merge · mc deploy');
  for (const [index, repo] of (merges?.repos || []).entries()) {
    if (index) lines.push('');
    const active = repo.landings || [];
    const reds = repo.reds || [];
    const waiting = repo.waiting || [];
    const shown = expand ? waiting : waiting.slice(0, QUEUED_DRAWN);
    const refs = shown.flatMap((item) => (item.prs || []).map((pr) => `#${pr.number}`));
    const unknown = shown.filter((item) => !item.prs?.length).length;
    const queue = waiting.length ? `${waiting.length} in queue: ${refs.join(' ')}${unknown ? ` · ${unknown} PR unknown` : ''}` : 'queue empty';
    operation(lines, c, wide, repo.repo, queue, ['bold'], { indent: 4, labelWide: 10 });
    if (shown.length < waiting.length) detail(lines, c, wide, 19, `+${waiting.length - shown.length} more queued · a shows all`);
    if (repo.pause) operation(lines, c, wide, 'paused', repo.pause.reason || repo.pause.kind, ['red']);
    if (repo.merger_stopped) operation(lines, c, wide, 'merger stopped', 'queue waiting', ['red']);
    if (!active.length && !repo.pause && !repo.merger_stopped) {
      operation(lines, c, wide, waiting.length ? 'waiting' : 'idle', waiting.length ? 'ready for merger' : 'no merge running');
    }
    for (const item of [...active, ...reds]) {
      const refs = (item.prs || []).map((pr) => `#${pr.number}`).join(', ') || 'PR unknown';
      const red = item.kind === 'red' || item.state === 'red';
      const label = `${red ? 'failed' : 'merging'} ${refs}`;
      const status = [!red && mergeBar(item.phase ? item.state : null), item.state || 'unknown', item.progress, item.phase].filter(Boolean).join(' · ');
      operation(lines, c, wide, label, status, stateTone(item.state));
      if (red) detail(lines, c, wide, 8, item.said || item.reason || 'failure reason unavailable', ['red']);
      if (item.batch_of) detail(lines, c, wide, 8, `with #${item.batch_of}`);
      if (expand) {
        detail(lines, c, wide, 8, item.name || item.title || '');
        if (item.title && item.title !== item.name) detail(lines, c, wide, 8, item.title);
        if (item.queue_age_seconds != null) detail(lines, c, wide, 8, `queued ${duration(item.queue_age_seconds)}`);
      }
    }
    if (expand) {
      for (const item of waiting) {
        const refs = (item.prs || []).map((pr) => `#${pr.number}`).join(', ') || 'PR unknown';
        operation(lines, c, wide, refs, `${item.state || 'unknown'}${item.progress ? ` · ${item.progress}` : ''}`, stateTone(item.state));
        detail(lines, c, wide, 8, item.name || item.title || '');
      }
      detail(lines, c, wide, 6, `${repo.day_count || 0} merges in 24 h${repo.last ? ` · last ${age(repo.last.age_seconds)}${repo.last.pr ? ` · #${repo.last.pr}` : ''}` : ' · no landing yet'}`);
    }
  }
  if (expand) detail(lines, c, wide, 4, 'Merge stages: [●··] prepare · [━●·] gate · [━━●] land; not a percentage');
}

export function deployLines(lines, c, wide, production, expand) {
  operation(lines, c, wide, 'DEPLOY', 'memoro · mc deploy', ['bold'], { indent: 4, labelWide: 10 });
  const p = production || {};
  operation(lines, c, wide, 'LIVE', p.live
    ? `${p.live.short || p.live.commit || 'unknown'} · observed ${age(p.live.age_seconds)}`
    : 'unknown · no version reading', p.differs ? ['yellow'] : []);
  operation(lines, c, wide, 'RECORDED', p.sha
    ? `${p.short} · deployed ${age(p.age_seconds)}`
    : 'none');
  const attempt = p.running || p.failed || p.attempt;
  if (attempt) {
    const state = p.running ? (p.running.late ? 'no end recorded' : 'running') : p.failed ? 'failed' : attempt.outcome || 'unknown';
    operation(lines, c, wide, 'ATTEMPT', `${attempt.short || 'unknown'} · ${state} · ${age(attempt.age_seconds)}${p.running && !p.running.late ? ' · progress unknown' : ''}`,
      p.running?.late || state === 'refused' ? ['yellow'] : stateTone(state));
    if (attempt.stopped_at) detail(lines, c, wide, 14, attempt.stopped_at, ['red']);
  }
  if (!p.running && !p.failed && !p.attempt) operation(lines, c, wide, 'idle', 'no deploy running');
  if (p.differs) detail(lines, c, wide, 4, 'version mismatch · live and recorded commits differ', ['yellow']);
  if (expand) {
    if (p.build) detail(lines, c, wide, 4, `recorded build ${p.build}${p.at ? ` · ${p.at}` : ''}`);
    if (p.live?.build) detail(lines, c, wide, 4, `live build ${p.live.build}`);
  }
}
