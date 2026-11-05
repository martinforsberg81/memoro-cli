/** Session details shared by the programme tree and its unassigned fallback. */
import { clipCell, duration, kindTone } from './page-grid.js';
import { width } from './status-render.js';

export function sessionGoal(session) {
  const name = session.goal || session.name || '';
  return name.replace(/^goal:/u, '');
}

/** Keep identity and the clock before optional metadata on narrow terminals. */
export function activityLines(c, wide, session, { indent = 10, expand = false, named = false } = {}) {
  const parts = [];
  const add = (text, styles = []) => { if (text) parts.push({ text: String(text), styles }); };
  add('●', ['green']);
  add(String(session.kind || session.verb || 'session').toUpperCase(), kindTone(session.kind || session.verb));
  if (named) add(sessionGoal(session) || 'unknown');
  add(session.progress || duration(session.elapsed_seconds ?? session.age_seconds),
    session.check_ins > 0 || (session.check_in_seconds && session.elapsed_seconds >= session.check_in_seconds) ? ['yellow'] : []);
  add([session.tool, session.model].filter(Boolean).join(' · '), ['grey']);
  if (session.billing === 'credits') add('credits', ['grey']);
  const lines = [];
  let current = ' '.repeat(indent);
  for (const part of parts) {
    const separator = width(current) > indent ? ' · ' : '';
    if (width(current) + separator.length + part.text.length > wide) {
      if (width(current) > indent) lines.push(current);
      current = ' '.repeat(indent + 2);
    } else current += separator;
    current += c(clipCell(part.text, wide - width(current)), ...part.styles);
  }
  if (width(current) > indent) lines.push(current);
  // A check-in remains visible without expanding; elapsed time is not a failure.
  if (session.check_ins) lines.push(`${' '.repeat(indent + 2)}${c(`${session.check_ins} check-in${session.check_ins === 1 ? '' : 's'}`, 'yellow')}`);
  if (expand) {
    const details = [session.repo, session.advisor && `${session.advisor} advisor`, session.pid && `pid ${session.pid}`,
      session.check_ins === 0 && '0 check-ins'].filter(Boolean).join(' · ');
    if (details) lines.push(`${' '.repeat(indent + 2)}${c(clipCell(details, wide - indent - 2), 'grey')}`);
  }
  return lines;
}
