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
  lines.push('');

  if (areas.length === 0) {
    lines.push(c('  nothing under ~/mc yet', 'grey'));
    lines.push('');
    return lines;
  }

  for (const area of areas) {
    const tone = TONE[state(area)];
    const label = pad(clip(area.name, 26), 26);
    const name = state(area) === 'idle' ? c(label, 'grey') : c(label, 'bold');
    lines.push(`  ${c(MARK[state(area)], tone)} ${name} ${c(clip(where(area), wide - 32), 'grey')}`);

    for (const item of area.conversations) {
      const tool = item.tool === 'claude-code' ? 'claude' : item.tool;
      const meta = `${tool} · ${ago(item.updated_ms, now)} · ${size(item.bytes)}`;
      lines.push(`      ${c(pad(item.state, 9), TONE[item.state] || 'grey')}${c(meta, 'grey')}`);
      // What it last said is the line a person actually reads. It is left
      // uncoloured when the conversation is live so it is the brightest thing
      // on the row, and dimmed once idle so a finished one recedes.
      if (item.said) {
        const said = clip(item.said, wide - 8);
        lines.push(`      ${item.state === 'idle' ? c(said, 'grey') : said}`);
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
  if (!area.worktrees.length) return 'no repository';
  return area.worktrees.map((worktree) => [
    worktree.repo,
    worktree.branch || '(detached)',
    worktree.uncommitted ? `${worktree.uncommitted} uncommitted` : null,
    worktree.unmerged_commits ? `${worktree.unmerged_commits} unmerged` : null,
  ].filter(Boolean).join('  ')).join('   ·   ');
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
