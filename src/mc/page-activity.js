/** Session activity and its detail rows. */
import { clipCell, duration, kindTone } from './page-grid.js';
import { detail } from './page-operations.js';
import { width } from './status-render.js';

export function sessionGoal(session) {
  const name = session.goal || session.name || '';
  return name.replace(/^goal:/u, '');
}

/** Keep identity and the clock before optional metadata on narrow terminals. */
export function activityLines(c, wide, session, { indent = 10, expand = false, named = false, inline = false } = {}) {
  const tone = kindTone(session.kind || session.verb);
  const contentWide = inline ? wide : wide - 4;
  const parts = [];
  const add = (text, styles = []) => { if (text) parts.push({ text: String(text), styles }); };
  add('●', ['green']);
  add(String(session.kind || session.verb || 'session').toUpperCase(), kindTone(session.kind || session.verb));
  if (session.reason) add(session.reason);
  if (named) add(sessionGoal(session) || 'unknown');
  add(session.progress || duration(session.elapsed_seconds ?? session.age_seconds),
    session.check_ins > 0 || (session.check_in_seconds && session.elapsed_seconds >= session.check_in_seconds) ? ['yellow'] : []);
  add([session.tool, session.model].filter(Boolean).join(' · '), ['grey']);
  if (session.billing === 'credits') add('credits', ['grey']);
  if (session.check_ins > 0) add(`${session.check_ins} check-in${session.check_ins === 1 ? '' : 's'}`, ['yellow']);
  if (session.session_pid) add(`pid ${session.session_pid}`, ['grey']);
  else if (session.pid) add(`${Object.hasOwn(session, 'session_pid') || session.goal ? 'runner ' : ''}pid ${session.pid}`, ['grey']);
  const lines = [];
  let current = ' '.repeat(indent);
  for (const [index, part] of parts.entries()) {
    const separator = current.trim() ? inline && index === 1 ? ' ' : ' · ' : '';
    if (width(current) + separator.length + part.text.length > contentWide) {
      if (current.trim()) lines.push(current);
      current = ' '.repeat(indent + 2);
    } else current += separator;
    if (inline && width(current) + part.text.length > contentWide) {
      detail(lines, c, contentWide, indent + 2, part.text, part.styles);
      current = ' '.repeat(indent + 2);
    } else {
      current += c(clipCell(part.text, contentWide - width(current)), ...part.styles);
    }
  }
  if (current.trim()) lines.push(current);
  const activity = inline ? lines : framedActivity(c, lines, indent, tone);
  if (expand) {
    const details = [session.repo, session.advisor && `${session.advisor} advisor`,
      session.check_ins === 0 && '0 check-ins'].filter(Boolean).join(' · ');
    detail(activity, c, wide, indent + 2, details);
  }
  return activity;
}

function framedActivity(c, lines, indent, tone) {
  const room = Math.max(...lines.map((line) => width(line) - indent));
  const prefix = ' '.repeat(indent);
  const rule = '─'.repeat(room + 2);
  return [
    `${prefix}${c(`╭${rule}╮`, ...tone)}`,
    ...lines.map((line) => `${prefix}${c('│', ...tone)} ${line.slice(indent)}${' '.repeat(room - (width(line) - indent))} ${c('│', ...tone)}`),
    `${prefix}${c(`╰${rule}╯`, ...tone)}`,
  ];
}
