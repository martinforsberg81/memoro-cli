/**
 * The page's DESK section: what waits for Martin, what was decided without him, what is not ready and what the
 * desk costs today. `readPageDesk` is the section's data (`desk` in `mc --json`), `deskLines` draws it from that
 * data alone (docs/technical/mc-ui.md, The sections).
 *
 * It reads and nothing else: the item store as the last sync left it, each waiting item's brief.md, runs.tsv and the
 * ceiling, last-open.json and the jev ledger. It runs no sync, takes no lock and writes no file, so drawing the page
 * never changes what the desk holds and never waits on the runner. The figures come from the functions the desk's
 * own opening is built from (desk-opening.js); the changes, the horizons and the archive, which cost half a second,
 * are not read.
 */
import { programsHome } from './paths.js';
import { listDeskItems } from './desk-items.js';
import { readDeskText } from './desk-budget.js';
import {
  costReading, ledgerAsks, openingActs, openingDecided, openingNotReady, openingSince, openingStuck, openingTexts, readLastOpen,
} from './desk-opening.js';
import { programsGoals } from './goals.js';
import { detail, panelEnd, panelHeading } from './page-operations.js';
import { clip, width } from './status-render.js';

/** Waiting rows the panel draws; the rest is a count. */
export const DESK_ROWS = 5;

const LAST_OPEN_INVALID = 'last-open.json is not valid — mc martin opens again once it is corrected or removed';

/** The first non-empty line of a brief with its leading `#` marks removed; null when there is no brief, '' when it is empty. */
export function briefLineOf(brief) {
  if (brief == null) return null;
  const line = String(brief).split(/\r?\n/u).map((text) => text.trim()).find(Boolean);
  return line === undefined ? '' : line.replace(/^#+\s*/u, '');
}

const waitedMinutes = (sourceAt, now) => {
  const at = Date.parse(sourceAt);
  return Number.isFinite(at) ? Math.max(0, Math.floor((now.getTime() - at) / 60000)) : null;
};

const row = (item, now) => ({
  id: item.id, kind: item.kind, reference: item.reference, sort: item.sort, source_at: item.source_at,
  waited_minutes: waitedMinutes(item.source_at, now), blocks: item.blocks, ...(item.blocks_stated ? { blocks_stated: true } : {}),
});

/**
 * The page's desk. Never throws: a file that cannot be read is an `error` in the part it belongs to, and a failure
 * of the whole read is the top-level `error` with the rest empty. `now` is a Date.
 */
export function readPageDesk({ env = process.env, home = programsHome(env), now = new Date(), read = readDeskText } = {}) {
  const empty = (error) => ({
    since: null, last_opened: null, waiting: 0, texts: [], acts: [],
    decided: { since: null, asks: null, against: null, closed_for_you: null, unreadable_lines: 0, error: null },
    not_ready: { count: 0, oldest_age_hours: null, failed: 0, stuck: 0 },
    cost: { day: now.toISOString().slice(0, 10), today: null, ceiling: null, error: null },
    error,
  });
  try {
    let last = null, lastError = null;
    try { last = readLastOpen({ env, read }); } catch (error) { lastError = error.code ? `last-open.json unreadable — ${error.message}` : LAST_OPEN_INVALID; }
    const since = lastError ? null : openingSince({ env, last });
    const items = listDeskItems({ env });
    // The programmes' goals are read when something waits, and once.
    let all = null;
    const goals = () => (all ??= programsGoals({ home }));
    const texts = openingTexts({ items, env, home, goals });
    const acts = openingActs({ items, env, home, goals });
    const stuck = openingStuck(items);
    const notReady = openingNotReady({ items, stuck, now });
    const cost = costReading({ env, now, read });

    const decided = { since, asks: null, against: null, closed_for_you: null, unreadable_lines: 0, error: lastError };
    if (!lastError) {
      decided.closed_for_you = openingDecided({ items, since, now }).programmes.reduce((n, group) => n + group.items.length, 0);
      try { Object.assign(decided, (({ asks, against, unreadable_lines }) => ({ asks, against, unreadable_lines }))(ledgerAsks({ env, since, now, read }))); }
      catch (error) { decided.error = `jev ledger unreadable — ${error.message}`; }
    }
    return {
      since, last_opened: last, waiting: texts.length + acts.length,
      texts: texts.map((item) => ({ ...row(item, now), text: item.text, goal: item.goal, brief_line: briefLineOf(item.brief) })),
      acts: acts.map((item) => ({ ...row(item, now), brief_line: briefLineOf(item.brief) })),
      decided,
      not_ready: { count: notReady.count, oldest_age_hours: notReady.oldest?.age_hours ?? null, failed: notReady.failed.length, stuck: stuck.length },
      cost: { day: cost.day, today: cost.today, ceiling: cost.ceiling, error: cost.error },
      error: null,
    };
  } catch (error) { return empty(error.message); }
}

/** The ids and counts that make a change in the desk worth printing the page again for; no age and no cost. */
export function deskKey(desk) {
  if (!desk) return '';
  const d = desk.decided || {}, n = desk.not_ready || {};
  return [
    'desk', [...(desk.texts || []), ...(desk.acts || [])].map((item) => item.id).join(','),
    n.count, n.failed, n.stuck, d.asks, d.against, d.closed_for_you, d.error || desk.error ? 'error' : '',
  ].join(':');
}

/** How long: minutes under an hour, hours under two days, then days. */
export function waitedWords(minutes) {
  if (minutes == null) return 'waiting since an unknown time';
  if (minutes < 60) return `waited ${minutes}m`;
  if (minutes < 48 * 60) return `waited ${Math.floor(minutes / 60)}h`;
  return `waited ${Math.floor(minutes / 1440)}d`;
}

const stamp = (iso) => String(iso).replace('T', ' ').slice(0, 16);
const money = (value) => `$${Number(value).toFixed(2)}`;

/** The DESK panel, drawn from `desk` alone. A page whose data has no `desk` draws none. */
export function deskLines(lines, c, wide, desk) {
  if (!desk) return;
  const indent = 4, room = wide - indent;
  const put = (text, ...tones) => lines.push(`${' '.repeat(indent)}${c(clip(text, room), ...tones)}`);
  const waiting = (desk.texts?.length || 0) + (desk.acts?.length || 0);
  panelHeading(lines, c, wide, 'DESK', desk.error ? '' : waiting ? `${waiting} waiting for you` : 'Nothing waits for you.', 'd  mc martin');
  if (desk.error) {
    put(`desk unreadable — ${desk.error}`, 'red');
    panelEnd(lines, c, wide);
    return;
  }
  const rows = [
    ...(desk.texts || []).map((item) => ({ lead: 'text', subject: item.text, extra: item.goal || 'no goal', item })),
    ...(desk.acts || []).map((item) => ({ lead: 'act', subject: item.reference, extra: null, item })),
  ];
  for (const { lead, subject, extra, item } of rows.slice(0, DESK_ROWS)) {
    const brief = item.brief_line === null ? 'brief.md is missing' : item.brief_line === '' ? 'brief.md is empty' : item.brief_line;
    const tail = [waitedWords(item.waited_minutes), item.blocks > 0 ? `blocks ${item.blocks}` : null].filter(Boolean);
    const parts = [`${lead.padEnd(4)}  ${subject}`, extra, brief, ...tail].filter((part) => part !== null);
    const at = parts.indexOf(brief);
    const total = () => parts.reduce((sum, part) => sum + width(part), 0) + 3 * (parts.length - 1);
    // The brief gives way first, then the name: the frame holds every row by the page's own measure.
    if (total() > room) parts[at] = clip(brief, Math.max(1, width(brief) - (total() - room)));
    if (total() > room) parts[0] = clip(parts[0], Math.max(1, width(parts[0]) - (total() - room)));
    const [first, ...rest] = parts;
    lines.push(`${' '.repeat(indent)}${c(first.slice(0, 4), 'bold')}${first.slice(4)}${rest.map((part) => `${c(' · ', 'grey')}${part}`).join('')}`);
  }
  if (waiting > DESK_ROWS) put(`+${waiting - DESK_ROWS} more — d opens the desk`, 'grey');

  // The three rows that always follow wrap at the room rather than lose a figure.
  const wrap = (text, ...tone) => detail(lines, c, wide, indent, text, tone);
  const d = desk.decided || {};
  if (d.error && d.asks === null && d.closed_for_you === null) wrap(d.error, 'red');
  else {
    const asks = d.error ? d.error : `${d.asks} asks settled, ${d.against} against the asking session's recommendation`;
    wrap(`Decided without you since ${stamp(d.since)}: ${asks} · ${d.closed_for_you} desk items closed for you${d.unreadable_lines ? ` · ${d.unreadable_lines} ledger lines unreadable` : ''}`, ...(d.error ? ['red'] : []));
  }
  const n = desk.not_ready || {};
  wrap(`Not ready: ${n.count} in preparation · ${n.failed} failed${n.count > 0 && n.oldest_age_hours != null ? ` · oldest ${n.oldest_age_hours} h` : ''}${n.stuck > 0 ? ` · ${n.stuck} stuck, not yours` : ''}`);
  const cost = desk.cost || {};
  if (cost.error) wrap(`desk cost — ${cost.error}`, 'red');
  else wrap(`Cost: desk ${money(cost.today)} today of ${cost.ceiling === null ? 'ceiling off' : `${money(cost.ceiling).replace(/\.00$/u, '')} ceiling`}`);
  panelEnd(lines, c, wide);
}
