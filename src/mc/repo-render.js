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
import { orphanLine } from './lease-owner.js';
import { painter, width } from './status-render.js';

const LABEL = 11;

export function renderRepoLines(report, {
  columns = 100, colour = false, now = Date.now(),
} = {}) {
  const c = painter(colour);
  const wide = Math.max(60, Math.min(columns, 160));
  const lines = [''];

  const source = sourceLine(c, report, now);
  if (source) { lines.push(`  ${source}`); lines.push(''); }

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
    lines.push(...section(c, wide, 'lease', [
      leaseRow(c, repo.lease, now),
      livenessRow(c, repo.lease, repo.lease?.liveness, now),
    ].filter(Boolean)));
    lines.push('');
  }
  return lines;
}

/**
 * Where this page came from, and how old it is.
 *
 * The whole point of the snapshot is that reading it is nearly free — and the
 * whole risk of it is a reader taking a picture from an hour ago for the
 * present. So every page says which of the two it is, and an old one says so
 * loudly enough that nobody acts on it by accident.
 */
function sourceLine(c, report, now) {
  if (report.mode === 'snapshot') {
    const age = c(`updated ${ago(report.updated_at, now) || 'just now'}`, report.stale ? 'yellow' : 'grey');
    if (report.stale) {
      return `${c('STALE', 'yellow', 'bold')}  ${age}  ${c('— mc repo watch start', 'yellow')}`;
    }
    const who = report.watcher?.running ? `watcher pid ${report.watcher.pid}` : 'watcher not running';
    return `${age}  ${c(`· ${who}`, 'grey')}`;
  }
  if (report.mode === 'computed') {
    return c(report.watcher?.running
      ? 'counted now — the watcher has not written a snapshot yet'
      : 'counted now — mc repo watch start keeps this fresh for everyone', 'grey');
  }
  return null;
}

/**
 * The watcher itself: alive or not, how often, and when it last wrote.
 *
 * Three facts, because those are the three ways it fails — never started,
 * started and died, or running but stuck on a round that never finishes.
 */
export function renderWatchLines(state, { colour = false, now = Date.now() } = {}) {
  const c = painter(colour);
  const lines = [''];
  if (state.running) {
    lines.push(`  ${c('watching', 'green')}  pid ${state.pid}  every ${Math.round(state.interval_ms / 1000)}s`);
  } else if (state.abandoned) {
    lines.push(`  ${c('not running', 'yellow')}  ${c('— a pid file was left behind; mc repo watch stop clears it', 'grey')}`);
  } else {
    lines.push(`  ${c('not running', 'grey')}  ${c('— mc repo watch start', 'grey')}`);
  }
  const when = state.last_write_at
    ? `${ago(state.last_write_at, now)}${state.stale ? c('  STALE', 'yellow') : ''}`
    : c('never', 'grey');
  lines.push(`  ${c('last wrote', 'grey')}  ${when}`);
  lines.push(`  ${c('log', 'grey')}  ${c(state.log, 'grey')}`);
  lines.push('');
  return lines;
}

/**
 * The nightly, in four lines: whether it is running, how often, and where it
 * writes.
 *
 * What it *found* is not here. That is a reading of a history of runs and it
 * belongs on the page that says what a repository's state is, beside main and
 * the open pull requests — not behind a verb somebody has to know to type.
 */
export function renderNightlyLines(state, { colour = false } = {}) {
  const c = painter(colour);
  const lines = [''];
  if (state.running) {
    lines.push(`  ${c('running', 'green')}  pid ${state.pid}  a full run of every repository every ${hours(state.interval_ms)}`);
    if (state.started_at) lines.push(`  ${c('since', 'grey')}  ${state.started_at}`);
  } else if (state.abandoned) {
    lines.push(`  ${c('not running', 'yellow')}  ${c('— a pid file was left behind; mc repo nightly stop clears it', 'grey')}`);
  } else {
    lines.push(`  ${c('not running', 'grey')}  ${c('— mc repo nightly start', 'grey')}`);
  }
  lines.push(`  ${c('log', 'grey')}  ${c(state.log, 'grey')}`);
  lines.push('');
  return lines;
}

function hours(ms) {
  const value = Number(ms) || 0;
  if (value < 3_600_000) return `${Math.round(value / 1000)}s`;
  return `${Math.round((value / 3_600_000) * 10) / 10}h`;
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
    item.unmerged_commits && item.landed !== 'landed' ? c(`${item.unmerged_commits} unmerged`, 'grey') : '',
  ].filter(Boolean).join('  '));
}

/**
 * Who is holding a round on this repository, for what, and since when.
 *
 * The age is here because a lease has no expiry and never will. But age is
 * also, on its own, the wrong question — see `livenessRow` below, which is the
 * line that actually tells the two cases apart.
 */
export function leaseRow(c, lease, now = Date.now()) {
  if (!lease?.held) return c('free', 'grey');
  const age = Number.isFinite(lease.age_ms) ? lease.age_ms : Math.max(0, now - Date.parse(lease.since));
  const old = age > 2 * 60 * 60 * 1000;
  return [
    c(lease.holder, old ? 'yellow' : 'bold'),
    lease.errand ? `“${lease.errand}”` : '',
    c(`held for ${duration(age)}`, old ? 'yellow' : 'grey'),
    // Its process gone: said as that, because age alone reads as "walked away".
    lease.orphaned ? c(orphanLine(lease), 'yellow') : '',
  ].filter(Boolean).join('  ');
}

/**
 * Whether the holder is still working — the line the age could not give.
 *
 * A gate round should take half an hour and a forgotten lease can be two
 * minutes old, so the number above separates nothing. This one does, and it is
 * read off the board rather than off a clock: no heartbeat, no expiry, and
 * nothing for the holder to remember to do.
 *
 * `unknown` is printed as plainly as the rest, with the reason. A holder mc
 * cannot see is not a holder who is gone, and the whole risk here is somebody
 * reading a blank as permission to `--force`.
 */
export function livenessRow(c, lease, liveness, now = Date.now()) {
  if (!lease?.held || !liveness) return null;
  if (!liveness.known) {
    return `${c('liveness unknown', 'yellow')}  ${c(liveness.reason || 'mc cannot see this holder', 'grey')}`;
  }
  const since = liveness.last_seen_ms === null ? null : Math.max(0, now - liveness.last_seen_ms);
  const seen = since === null ? 'nothing has run there'
    : since < 60_000 ? 'last seen just now'
      : `last seen ${duration(since)} ago`;
  const colour = liveness.state === 'working' ? 'green' : liveness.state === 'waiting' ? 'cyan' : 'grey';
  return `${c(`holder ${liveness.state}`, colour)}  ${c(seen, 'grey')}`;
}

function duration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
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
