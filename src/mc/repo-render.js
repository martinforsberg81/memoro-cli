/**
 * How the repository view looks.
 *
 * Same shape as the board's renderer and for the same reason: lines rather
 * than one string, colour applied through a painter that returns the text
 * untouched when nobody is watching a terminal.
 *
 * One section per fact, in the order a person asks for them: what main is,
 * what is in the air against it, who is standing on it, and what is actually
 * installed here. A section that could not be read says so on its own line —
 * an empty section and an unreachable one must never look alike.
 */
import { painter, width } from './status-render.js';

const LABEL = 11;

export function renderRepoLines(report, {
  columns = 100, colour = false, now = Date.now(),
} = {}) {
  const c = painter(colour);
  const wide = Math.max(60, Math.min(columns, 160));
  const lines = [''];

  for (const name of report.unknown || []) {
    lines.push(`  ${c(`no repository called "${name}"`, 'yellow')}`);
  }
  if ((report.unknown || []).length) lines.push('');

  // "no repository here" under a name that matched nothing reads as an answer
  // to the wrong question; the line above already said what happened.
  if (report.repos.length === 0 && !(report.unknown || []).length) {
    lines.push(c('  no repository — mc work add <name> <repo> puts one here', 'grey'));
    lines.push('');
    return lines;
  }

  for (const repo of report.repos) {
    lines.push(`  ${c(repo.name, 'bold')}  ${c(repo.path, 'grey')}`);
    lines.push(...section(c, wide, 'main', mainRows(c, repo, now)));
    lines.push(...section(c, wide, 'pull', prRows(c, repo)));
    lines.push(...section(c, wide, 'worktrees', worktreeRows(c, repo)));
    if (repo.deploy) lines.push(...section(c, wide, 'deploy', deployRows(c, repo)));
    lines.push('');
  }
  return lines;
}

/** The label is written once; the rows below it line up under the first. */
function section(c, wide, label, rows) {
  if (rows.length === 0) return [];
  return rows.map((row, index) => (
    `    ${c(pad(index === 0 ? label : '', LABEL), 'grey')}${clip(row, wide - LABEL - 6)}`
  ));
}

function mainRows(c, repo, now) {
  const { main } = repo;
  if (!main.id) return [c(main.degraded || 'unknown', 'yellow')];
  const parts = [
    c(main.id.slice(0, 7), 'cyan'),
    main.subject || '',
    c(ago(main.at, now), 'grey'),
  ];
  const rows = [parts.filter(Boolean).join('  ')];
  if (main.degraded) rows.push(c(main.degraded, 'yellow'));
  return rows;
}

function prRows(c, repo) {
  const { degraded, items } = repo.pull_requests;
  const rows = items.map((item) => [
    c(`#${item.number}`, 'bold'),
    item.branch || '',
    behind(c, item.behind_main),
    item.draft ? c('draft', 'grey') : '',
    item.title || '',
  ].filter(Boolean).join('  '));
  if (degraded) rows.push(c(degraded, 'yellow'));
  if (rows.length === 0) rows.push(c('none open', 'grey'));
  return rows;
}

/**
 * How far behind main a branch is — the number the view exists for.
 *
 * Zero is said out loud rather than left blank: "up to date with main" is the
 * fact a reader is looking for when they are deciding whether yesterday's
 * green run still means anything.
 */
function behind(c, count) {
  if (count === null || count === undefined) return c('behind main: unknown', 'yellow');
  if (count === 0) return c('on main', 'green');
  return c(`${count} behind main`, count >= 10 ? 'yellow' : 'grey');
}

function worktreeRows(c, repo) {
  if (repo.worktrees.length === 0) return [c('none', 'grey')];
  return repo.worktrees.map((item) => [
    item.area,
    item.branch || '(detached)',
    item.uncommitted ? c(`${item.uncommitted} uncommitted`, 'yellow') : '',
    item.unmerged_commits ? c(`${item.unmerged_commits} unmerged`, 'grey') : '',
  ].filter(Boolean).join('  '));
}

function deployRows(c, repo) {
  const { deploy } = repo;
  const where = c(`${deploy.command} → ${deploy.source}`, 'grey');
  if (deploy.in_step) return [`${c('in step with main', 'green')}  ${where}`];
  const drift = [
    deploy.behind_main ? `${deploy.behind_main} behind main` : '',
    deploy.ahead_main ? `${deploy.ahead_main} ahead of main` : '',
  ].filter(Boolean).join(', ') || 'unknown';
  return [`${c(drift, 'yellow')}  ${where}`];
}

function ago(iso, now) {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.round((now - at) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function pad(text, to) {
  const short = to - width(text);
  return short > 0 ? text + ' '.repeat(short) : text;
}

/**
 * Cut a row to the terminal without cutting an escape sequence in half.
 *
 * A row here is assembled from coloured fragments, so slicing by index lands
 * inside a sequence and spills `[3` onto the page. Walking it instead
 * counts only what is visible, keeps every sequence whole, and closes the row
 * so the colour does not leak into the next one.
 */
function clip(text, to) {
  const source = String(text);
  if (width(source) <= to) return source;
  const pattern = /\[[0-9;]*m/gu;
  let out = '';
  let visible = 0;
  let index = 0;
  let coloured = false;
  while (index < source.length && visible < to - 1) {
    pattern.lastIndex = index;
    const match = pattern.exec(source);
    if (match && match.index === index) {
      out += match[0];
      coloured = true;
      index = pattern.lastIndex;
      continue;
    }
    out += source[index];
    visible += 1;
    index += 1;
  }
  return `${out}…${coloured ? '[0m' : ''}`;
}
