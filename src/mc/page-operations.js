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
  const repos = [...new Set(servers.map((server) => server.repo || 'unknown'))];
  for (const repo of repos) {
    detail(lines, c, wide, 4, repo, ['bold']);
    for (const server of servers.filter((item) => (item.repo || 'unknown') === repo)) {
      const kind = String(server.kind || 'slot').toUpperCase().padEnd(5);
      const address = server.port ? `:${server.port}` : server.url || 'address unknown';
      const state = server.state || 'unknown';
      const prefix = `      ${kind} ${address.padEnd(8)} `;
      lines.push(`${c(prefix, 'grey')}${c(clipCell(state, wide - prefix.length), ...stateTone(state))}`);
      if (server.name) detail(lines, c, wide, 12, server.name, server.holder_gone ? ['grey'] : []);
      if (server.holder_gone) detail(lines, c, wide, 12, 'holder gone', ['yellow']);
      if (expand) {
        detail(lines, c, wide, 12, [server.url, server.service, server.progress && `last used ${server.progress} ago`].filter(Boolean).join(' · '));
        detail(lines, c, wide, 12, [server.branch, shortPath(server.worktree)].filter(Boolean).join(' · '));
      }
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

export function mergesLines(lines, c, wide, merges, expand) {
  panelHeading(lines, c, wide, 'MERGE', '', 'mc merge <repo> <pr>');
  for (const repo of merges?.repos || []) {
    const active = repo.landings || [];
    const reds = repo.reds || [];
    const waiting = repo.waiting || [];
    const counts = [active.length && `${active.length} landing`, waiting.length && `${waiting.length} queued`, reds.length && `${reds.length} red`].filter(Boolean).join(' · ') || 'idle';
    detail(lines, c, wide, 4, `${repo.repo} · ${counts}`, ['bold']);
    if (repo.pause) detail(lines, c, wide, 6, `paused · ${repo.pause.reason || repo.pause.kind}`, ['red']);
    if (repo.merger_stopped) detail(lines, c, wide, 6, 'merger stopped', ['red']);
    const shown = [...active, ...reds, ...(expand ? waiting : waiting.slice(0, QUEUED_DRAWN))];
    for (const item of shown) {
      const refs = (item.prs || []).map((pr) => `#${pr.number}`).join(', ') || 'PR unknown';
      // References get their own line when unusually long, never a cut number.
      detail(lines, c, wide, 6, `${refs} · ${item.state || 'unknown'}${item.progress ? ` · ${item.progress}` : ''}`, stateTone(item.state));
      detail(lines, c, wide, 8, item.name || item.title || '', []);
      if (item.kind === 'red' || item.state === 'red') detail(lines, c, wide, 8, item.said || item.reason || 'failure reason unavailable', ['red']);
      if (item.batch_of) detail(lines, c, wide, 8, `with #${item.batch_of}`);
      if (expand) {
        if (item.title && item.title !== item.name) detail(lines, c, wide, 8, item.title);
        if (item.queue_age_seconds != null) detail(lines, c, wide, 8, `queued ${duration(item.queue_age_seconds)}`);
      }
    }
    if (!expand && waiting.length > QUEUED_DRAWN) detail(lines, c, wide, 6, `▸ ${waiting.length - QUEUED_DRAWN} more queued`);
    if (expand) detail(lines, c, wide, 6, `${repo.day_count || 0} merges in 24 h${repo.last ? ` · last ${age(repo.last.age_seconds)}${repo.last.pr ? ` · #${repo.last.pr}` : ''}` : ' · no landing yet'}`);
  }
}

export function deployLines(lines, c, wide, production, expand) {
  panelHeading(lines, c, wide, 'PRODUCTION', '', 'mc deploy');
  const p = production || {};
  detail(lines, c, wide, 4, p.live
    ? `LIVE      ${p.live.short || p.live.commit || 'unknown'} · observed ${age(p.live.age_seconds)}`
    : 'LIVE      unknown · no version reading', p.differs ? ['yellow'] : []);
  detail(lines, c, wide, 4, p.sha
    ? `RECORDED  ${p.short} · deployed ${age(p.age_seconds)}`
    : 'RECORDED  none');
  const attempt = p.running || p.failed || p.attempt;
  if (attempt) {
    const state = p.running ? (p.running.late ? 'no end recorded' : 'running') : p.failed ? 'failed' : attempt.outcome || 'unknown';
    detail(lines, c, wide, 4, `ATTEMPT   ${attempt.short || 'unknown'} · ${state} · ${age(attempt.age_seconds)}`,
      p.running?.late || state === 'refused' ? ['yellow'] : stateTone(state));
    if (attempt.stopped_at) detail(lines, c, wide, 14, attempt.stopped_at, ['red']);
  }
  if (p.differs) detail(lines, c, wide, 4, 'version mismatch · live and recorded commits differ', ['yellow']);
  if (expand) {
    if (p.build) detail(lines, c, wide, 4, `recorded build ${p.build}${p.at ? ` · ${p.at}` : ''}`);
    if (p.live?.build) detail(lines, c, wide, 4, `live build ${p.live.build}`);
  }
}
