/**
 * How the status board looks.
 *
 * Kept apart from the command so the page can be composed as lines rather than
 * one string. Watching redraws only the lines that changed, and that is only
 * possible if something knows where each line is.
 *
 * Colour is applied through `paint`, which returns the text untouched when the
 * output is not a terminal. A page piped into a file or read by a session
 * should contain what it says and nothing else.
 */
import { dueIn } from './wakeup.js';

const SGR = {
  reset: '[0m',
  bold: '[1m',
  dim: '[2m',
  red: '[31m',
  green: '[32m',
  yellow: '[33m',
  blue: '[34m',
  magenta: '[35m',
  cyan: '[36m',
  grey: '[90m',
};

export function painter(colour) {
  if (!colour) return (text) => text;
  return (text, ...styles) => `${styles.map((name) => SGR[name] || '').join('')}${text}${SGR.reset}`;
}

/** Visible width: escape sequences take no columns. */
export function width(text) {
  return String(text).replace(/\[[0-9;]*m/gu, '').length;
}

function pad(text, to) {
  const short = to - width(text);
  return short > 0 ? text + ' '.repeat(short) : text;
}

function clip(text, to) {
  if (width(text) <= to) return text;
  return `${String(text).slice(0, Math.max(0, to - 1))}…`;
}

const MARK = { waiting: '◆', working: '●', idle: '·' };
const TONE = { waiting: 'yellow', working: 'green', idle: 'grey' };

function state(area) {
  if (area.waiting) return 'waiting';
  if (area.working) return 'working';
  return 'idle';
}

const RANK = { waiting: 0, working: 1, idle: 2 };

/**
 * The page, as lines.
 *
 * Waiting first: it is the only thing here costing time while it is read.
 * Within that, oldest first — a conversation that stopped twenty minutes ago
 * has been waiting longer than one that stopped just now, and is likelier to
 * have been forgotten.
 */
export function renderLines(report, {
  columns = 100, colour = false, version = '', now = Date.now(),
} = {}) {
  const c = painter(colour);
  const wide = Math.max(60, Math.min(columns, 160));
  const areas = [...report.areas].sort((a, b) => (
    RANK[state(a)] - RANK[state(b)]
    || oldest(a) - oldest(b)
    || a.name.localeCompare(b.name)
  ));

  const lines = [];
  const waiting = report.summary?.waiting ?? 0;
  const working = report.summary?.working ?? 0;
  const counts = [
    waiting ? c(`${waiting} waiting`, 'yellow', 'bold') : null,
    working ? c(`${working} working`, 'green') : null,
    c(`${areas.length} areas`, 'grey'),
  ].filter(Boolean).join(c('  ·  ', 'grey'));

  const brand = `${c('MEMORO', 'bold')}${c('·CLI', 'grey')}${version ? c(`  ${version}`, 'grey') : ''}`;
  const rule = wide - width(brand) - width(counts) - 4;
  lines.push('');
  lines.push(`  ${brand} ${c('─'.repeat(Math.max(2, rule)), 'grey')} ${counts}`);
  // The suite right and what is actually running a suite, on one row — the
  // gap between them is the finding (D-0141: five suites at once on 8 GB;
  // D-0155: eleven runs on a clock nobody saw). How long it has run is the
  // number that separates a solo run from one under contention.
  if (report.suite) {
    const lease = report.suite.lease;
    const running = report.suite.running || [];
    const held = lease?.held
      ? `${c(lease.holder, 'bold')}${lease.errand ? ` “${lease.errand}”` : ''} ${c(`held for ${ago(now - (lease.age_ms ?? 0), now)}`, 'grey')}`
      : c('free', 'grey');
    const runs = running.length
      ? running.map((run) => c(`running in ${run.area || run.directory} for ${elapsed(run.elapsed)} (pid ${run.pid})`, running.length > 1 ? 'red' : 'yellow')).join(c('  ·  ', 'grey'))
      : c('nothing running', 'grey');
    lines.push(`  ${c('suite', 'grey')}  ${clip(`${held}  ${c('·', 'grey')}  ${runs}`, wide - 9)}`);
  }
  // The watchers — the last silent link. PM is woken by a file, queued wakes
  // are retried by the guard, the repo page kept fresh by its watcher; if one
  // dies, everything below this row goes quiet and nothing says why.
  if (report.watchers) {
    const word = (state) => {
      if (!state) return c('unknown', 'grey');
      if (state.running && state.stale) return c(`alive but stale — no round in ${ago(now - (state.last_write_age_ms ?? 0), now)}`, 'red');
      if (state.running) return c(`alive${state.last_write_age_ms !== null ? `, last round ${ago(now - state.last_write_age_ms, now)}` : ''}`, 'green');
      if (state.abandoned) return c('NOT RUNNING — stopped without telling anyone', 'red');
      return c('never started', 'yellow');
    };
    const cells = [['watch pm', report.watchers.pm], ['watch sessions', report.watchers.sessions], ['repo watch', report.watchers.repo]]
      .map(([name, state]) => `${c(name, 'grey')}: ${word(state)}`);
    lines.push(`  ${c('watch', 'grey')}  ${clip(cells.join(c('  ·  ', 'grey')), wide - 9)}`);
  }
  lines.push('');

  if (areas.length === 0) {
    lines.push(c('  nothing under ~/mc yet', 'grey'));
    lines.push('');
    return lines;
  }

  for (const area of areas) {
    const tone = TONE[state(area)];
    // A role-marked area says so beside its name. The role joins the name
    // *before* clipping so the column keeps its width: an area name and a role
    // are two unbounded strings, and the pair is clipped as one label rather
    // than pushing the rest of the row out of line.
    const label = pad(clip(area.role ? `${area.name} · ${area.role}` : area.name, 26), 26);
    const name = state(area) === 'idle' ? c(label, 'grey') : c(label, 'bold');
    lines.push(`  ${c(MARK[state(area)], tone)} ${name} ${c(clip(where(area), wide - 32), 'grey')}`);
    // A session nobody can reach by wake: the guard refused on a draft, the
    // wake is queued, and until the prompt clears this is the only place the
    // state is visible. "Since" is the number — twenty minutes of it once
    // passed unnoticed with an answer sitting in the inbox.
    // A session in a menu is blocked on a person — usually the PM — and can
    // sit there all night; no wake reaches it. The question, when the drawing
    // carries one, so the answer can be given without going to look.
    if (area.menu) {
      const ask = area.menu.question ? `: “${area.menu.question}”` : '';
      const options = area.menu.options?.length ? ` — ${area.menu.options.map((option, index) => `${index + 1}. ${option}`).join('  ')}` : '';
      lines.push(`      ${c(clip(`⧗ waiting on a menu — needs an answer, not a knock${ask}${options}`, wide - 8), 'red')}`);
    }
    if (area.pending_wake) {
      const since = clock(area.pending_wake.since);
      lines.push(`      ${c(`✉ draft in prompt — unreachable by wake since ${since} (wake queued; it lands when the prompt clears)`, 'red')}`);
    }

    for (const item of area.conversations) {
      const tool = item.tool === 'claude-code' ? 'claude' : item.tool;
      const meta = `${tool}${item.model ? ` · ${item.model}` : ''} · ${ago(item.updated_ms, now)} · ${size(item.bytes)}`;
      // The model is the one unbounded thing on this row — mc passes the
      // value through unvalidated, so the row is clipped like its neighbours
      // rather than trusting the name to be short.
      lines.push(`      ${c(pad(item.state, 9), TONE[item.state] || 'grey')}${c(clip(meta, wide - 15), 'grey')}`);
      // What it last said is the line a person actually reads. It is left
      // uncoloured when the conversation is live so it is the brightest thing
      // on the row, and dimmed once idle so a finished one recedes.
      if (item.said) {
        const said = clip(item.said, wide - 8);
        lines.push(`      ${item.state === 'idle' ? c(said, 'grey') : said}`);
      }
      // The clock it set for itself, and what the clock will run (D-0155).
      // A timer nobody can see is how a suite ran eleven times unasked.
      if (item.wakeup) {
        const when = dueIn(item.wakeup, now);
        const row = `⏰ wakeup${when ? ` ${when}` : ''}: ${item.wakeup.prompt || '(no prompt)'}`;
        lines.push(`      ${c(clip(row, wide - 8), 'yellow')}`);
      }
    }
    lines.push('');
  }
  return lines;
}

/** How long the longest-waiting conversation here has been stopped. */
function oldest(area) {
  const stopped = area.conversations.filter((item) => item.state !== 'idle');
  if (stopped.length === 0) return Number.MAX_SAFE_INTEGER;
  return Math.min(...stopped.map((item) => item.updated_ms || 0));
}

function where(area) {
  const parts = [];
  // Age is what makes a task worth seeing here — the count is a script's
  // answer to "does anything need a look", and the age behind each one lives
  // in `mc task list`. This line only ever has to say how many.
  if (area.open_tasks) parts.push(`${area.open_tasks} open task${area.open_tasks === 1 ? '' : 's'}`);
  if (!area.worktrees.length) {
    parts.push('no repository');
    return parts.join('   ·   ');
  }
  parts.push(...area.worktrees.map((worktree) => [
    worktree.repo,
    worktree.branch || '(detached)',
    worktree.uncommitted ? `${worktree.uncommitted} uncommitted` : null,
    worktree.unmerged_commits ? `${worktree.unmerged_commits} unmerged` : null,
    // A suite run here prints a number that is not a measurement (D-0152).
    worktree.dependencies === 'missing' ? 'no node_modules' : null,
  ].filter(Boolean).join('  ')));
  return parts.join('   ·   ');
}

/** `21:14` — an ISO instant as the local wall clock, which is how a person says "since". */
export function clock(iso) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '?';
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** `ps etime` — `MM:SS`, `HH:MM:SS` or `D-HH:MM:SS` — as the board says time. */
export function elapsed(etime) {
  const value = String(etime || '').trim();
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/u.exec(value);
  if (!match) return value || '?';
  const [, days = '0', hours = '0', minutes] = match;
  const total = Number(days) * 1440 + Number(hours) * 60 + Number(minutes);
  if (total < 1) return 'under a minute';
  if (total < 60) return `${total}m`;
  return `${Math.floor(total / 60)}h ${total % 60}m`;
}

function ago(updatedMs, now) {
  if (!updatedMs) return 'never';
  const minutes = Math.max(0, Math.round((now - updatedMs) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

function size(bytes) {
  if (!bytes) return '0';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${bytes} B`;
}
