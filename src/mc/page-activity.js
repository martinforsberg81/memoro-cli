/** Session details shared by the programme tree and its unassigned fallback. */
import { clipCell, duration, kindTone } from './page-grid.js';
import { width } from './status-render.js';

export function sessionGoal(session) {
  const name = session.goal || session.name || '';
  return name.replace(/^goal:/u, '');
}

/** Keep identity and the clock before optional metadata on narrow terminals. */
export function activityLines(c, wide, session, { indent = 10, expand = false, named = false } = {}) {
  const tone = kindTone(session.kind || session.verb);
  // Reserve the two borders and one space on either side before wrapping.
  const contentWide = wide - 4;
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
  const lines = [];
  let current = ' '.repeat(indent);
  for (const part of parts) {
    const separator = width(current) > indent ? ' · ' : '';
    if (width(current) + separator.length + part.text.length > contentWide) {
      if (width(current) > indent) lines.push(current);
      current = ' '.repeat(indent + 2);
    } else current += separator;
    current += c(clipCell(part.text, contentWide - width(current)), ...part.styles);
  }
  if (width(current) > indent) lines.push(current);
  const room = Math.max(...lines.map((line) => width(line) - indent));
  const prefix = ' '.repeat(indent);
  const rule = '─'.repeat(room + 2);
  const framed = [
    `${prefix}${c(`╭${rule}╮`, ...tone)}`,
    ...lines.map((line) => `${prefix}${c('│', ...tone)} ${line.slice(indent)}${' '.repeat(room - (width(line) - indent))} ${c('│', ...tone)}`),
    `${prefix}${c(`╰${rule}╯`, ...tone)}`,
  ];
  // A check-in remains visible without expanding; elapsed time is not a failure.
  if (session.check_ins) framed.push(`${' '.repeat(indent + 2)}${c(`${session.check_ins} check-in${session.check_ins === 1 ? '' : 's'}`, 'yellow')}`);
  if (expand) {
    const details = [session.repo, session.advisor && `${session.advisor} advisor`, session.pid && `pid ${session.pid}`,
      session.check_ins === 0 && '0 check-ins'].filter(Boolean).join(' · ');
    if (details) framed.push(`${' '.repeat(indent + 2)}${c(clipCell(details, wide - indent - 2), 'grey')}`);
  }
  return framed;
}
