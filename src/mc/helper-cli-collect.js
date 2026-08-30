/**
 * `mc helper --collect` for memoro-cli — because its production is this machine.
 *
 * The memoro half of the helper reads five production sources: error
 * fingerprints, the analysis items, AI-provider errors, deploys, D1 health.
 * memoro-cli has none of those. It is a command-line tool; there is no server,
 * no D1, no deploy. For a week that was taken to mean it had nothing to
 * collect, which is why every memoro-cli failure was found by a person
 * noticing it.
 *
 * It has production. It runs fifty workareas and a runner all day on one
 * laptop, and it records what happens in four files:
 *
 *   - `logs/mc.log`          — every invocation, its narration, how it ended;
 *   - `gate-rounds.jsonl`    — every gate round, including the ones that
 *                              started and never finished;
 *   - `repo-leases/leases.log` — claims, releases and reaps, with pids;
 *   - `runner/log/runs.tsv`  — every step the runner ran, and its note.
 *
 * Until 2026-08-30 the first of those was written by seven files and none of
 * them were the merge path, so this source did not exist to be read. `mc log`
 * made it exist. This is what reads it on a schedule instead of when somebody
 * thinks to look.
 *
 * ## The same shape, deliberately
 *
 * The rows this produces are `{ fingerprint, count, status, message, lastSeen }`
 * — exactly what `errorRows()` produces from memoro's survey — so the delta,
 * the state block, the `!` threshold and the digest renderer are the ones
 * already written and already tested. Two collectors, one notion of "new since
 * yesterday". A second delta implementation would be a second answer waiting
 * to disagree with the first.
 *
 * ## What a fingerprint is here
 *
 * A failure signature with its variables removed: the verb and the shape of
 * what went wrong, not the pid, the pull request number or the path. Two
 * `mc merge` rounds that both stopped on `lease` are the same fingerprint seen
 * twice, which is the whole point — one is noise, forty is a defect.
 *
 * The hash is over that normalised signature, so a fingerprint is stable
 * across days and the delta against yesterday means something.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readEvents, readLeaseLog } from './log-read.js';
import { mcHome, workRoot } from './paths.js';
import { readRounds, unfinishedRounds } from './repo-round-log.js';

/** How long a runner may be silent before that is itself a failing condition. */
export const RUNNER_SILENT_HOURS = 6;

/** At most this many fingerprint rows in one digest, loudest first. */
export const CLI_ROW_CAP = 60;

/**
 * One failure, reduced to what repeats.
 *
 * Numbers become `N` and hex blobs become `<hash>`: a pull request number, a
 * pid and a commit are what make two occurrences of one defect look like two
 * defects. Paths are kept only as their last segment for the same reason —
 * `/Users/x/mc/icon-assets/memoro` and `…/week-focus/memoro` are one story.
 */
export function signature(kind, ...parts) {
  const body = parts
    .filter((part) => part !== null && part !== undefined && part !== '')
    .map((part) => String(part)
      .replace(/\b[0-9a-f]{7,}\b/gu, '<hash>')
      .replace(/\d+/gu, 'N')
      .replace(/\/[^\s]*\/([^/\s]+)/gu, '$1'))
    .join(' ');
  return `${kind}: ${body}`.slice(0, 300);
}

export function fingerprintOf(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 8);
}

/**
 * The rows, from everything mc wrote about itself in the window.
 *
 * Every source is read separately and a source that will not read is reported
 * rather than allowed to empty the digest — the same rule the memoro half
 * follows, and for the same reason: these do not share a failure domain.
 */
export function cliRows({ root = mcHome(), work = workRoot(), since, now = new Date(), read = readFileSync } = {}) {
  const from = since instanceof Date ? since : new Date(since);
  const counts = new Map();
  const notes = [];
  const bump = (kind, message, at, status) => {
    const sig = signature(kind, message);
    const key = fingerprintOf(sig);
    const row = counts.get(key) || { fingerprint: key, count: 0, status, message: sig, lastSeen: null };
    row.count += 1;
    if (!row.lastSeen || at > row.lastSeen) row.lastSeen = at;
    counts.set(key, row);
  };
  const inWindow = (at) => {
    const when = Date.parse(at);
    return Number.isFinite(when) && when >= from.getTime();
  };

  // 1. Invocations that did not end well.
  try {
    const { events } = readEvents({ root });
    for (const event of events) {
      if (!inWindow(event.at)) continue;
      if (event.event === 'mc.end' && event.threw) {
        bump('mc threw', `${event.verb} — ${event.error || 'no message'}`, event.at, 'mc');
      } else if (event.event === 'mc.end' && (event.exit_code ?? 0) !== 0) {
        bump('mc failed', `${event.verb} exited ${event.exit_code}`, event.at, 'mc');
      } else if (event.event === 'gate.killed') {
        bump('round killed', `${event.repo} by ${event.signal}`, event.at, 'gate');
      }
    }
  } catch (error) { notes.push(`mc.log: ${error.message}`); }

  // 2. Gate rounds that stopped, and rounds that never ended at all.
  let open = [];
  try {
    const { rounds } = readRounds({ root });
    for (const round of rounds) {
      if (!inWindow(round.at)) continue;
      if (round.phase === 'start') continue;
      if (round.stopped_at) bump('round stopped', `${round.repo} at ${round.stopped_at}`, round.at, 'gate');
    }
    open = unfinishedRounds(rounds).filter((round) => inWindow(round.at) && round.verdict === 'died');
    for (const round of open) bump('round died', `${round.repo} — started and never ended`, round.at, 'gate');
  } catch (error) { notes.push(`gate-rounds.jsonl: ${error.message}`); }

  // 3. Leases reaped: every one is a holder that went away without giving it
  //    back, which is the same event as (2) seen from the other side and is
  //    worth counting separately — a reap with no died round means something
  //    outside a gate round is dying.
  let reaps = [];
  try {
    reaps = readLeaseLog({ root }).filter((entry) => entry.verb === 'reap' && inWindow(entry.at));
    for (const entry of reaps) bump('lease reaped', `${entry.repo} — holder ${entry.holder} was gone`, entry.at, 'lease');
  } catch (error) { notes.push(`leases.log: ${error.message}`); }

  // 4. The runner's own steps.
  let lastRun = null;
  try {
    const tsv = read(join(work, 'runner', 'log', 'runs.tsv'), 'utf8');
    const lines = tsv.split('\n').filter(Boolean);
    const header = lines.shift()?.split('\t') || [];
    const at = header.indexOf('ts');
    const note = header.indexOf('note');
    const kind = header.indexOf('kind');
    const name = header.indexOf('name');
    const exit = header.indexOf('exit');
    for (const line of lines) {
      const cell = line.split('\t');
      if (at < 0 || !cell[at]) continue;
      if (!lastRun || cell[at] > lastRun) lastRun = cell[at];
      if (!inWindow(cell[at])) continue;
      const outcome = cell[note] || '';
      const code = String(cell[exit] ?? '0');
      if (/success/u.test(outcome) && code === '0') continue;
      // The exit code is always named, never only the note. A row saying
      // `success` that exited 1 is a real anomaly — the session reported it
      // had finished and the process disagreed — and it is invisible if the
      // note is the only thing rendered.
      bump('runner step', `${cell[kind] || 'step'} ${cell[name] || '?'} — ${outcome || 'no note'} (exit ${code})`, cell[at], 'runner');
    }
  } catch (error) { notes.push(`runs.tsv: ${error.message}`); }

  const rows = [...counts.values()].sort((a, b) => b.count - a.count);
  return {
    rows: rows.slice(0, CLI_ROW_CAP),
    capped: rows.length > CLI_ROW_CAP ? rows.length - CLI_ROW_CAP : 0,
    byStatus: byStatus(rows),
    notes,
    open,
    reaps,
    lastRun,
    now,
  };
}

/**
 * Conditions that are wrong *now* — not counts of things that went wrong.
 *
 * The memoro half has two (a stale deploy, an unhealthy D1). These are the
 * equivalents on this side, and each one is a sentence somebody could act on
 * this morning rather than a statistic.
 */
export function cliFailing({ open = [], lastRun = null, now = new Date(), silentHours = RUNNER_SILENT_HOURS } = {}) {
  const failing = [];
  // A round that died and whose lease was never taken back is the state that
  // blocks the next round, and the one worth waking up to.
  const held = open.filter((round) => !round.reaped);
  if (held.length) failing.push(`gate-round-lease-held (${held.length})`);
  if (open.length) failing.push(`gate-round-died (${open.length})`);
  if (lastRun) {
    const idle = (now.getTime() - Date.parse(lastRun)) / 3_600_000;
    if (Number.isFinite(idle) && idle >= silentHours) failing.push(`runner-silent-${Math.floor(idle)}h`);
  } else {
    failing.push('runner-log-unreadable');
  }
  return failing;
}

/** The memoro-cli sections of the digest, in the renderer's own vocabulary. */
export function renderCliSections({ cli, threshold }) {
  const out = [];
  out.push('## mc itself — this machine', '');
  if (cli.notes.length) for (const note of cli.notes) out.push(`_could not read: ${note}_`);
  if (!cli.rows.length) {
    out.push('_nothing failed in the window_');
    out.push('');
    return out;
  }
  const summary = Object.entries(cli.byStatus)
    .map(([status, group]) => `${status}: ${group.fingerprints} fingerprints / ${group.occurrences} occurrences`)
    .join(' · ');
  if (summary) out.push(summary, '');
  out.push('| fingerprint | hits | source | last seen | what |', '|---|---|---|---|---|');
  for (const row of cli.rows) {
    out.push(`| \`${row.fingerprint}\` | ${row.count} | ${row.status} | ${short(row.lastSeen)} | ${clip(row.message, 90)} |`);
  }
  if (cli.capped) out.push('', `_and ${cli.capped} more fingerprints, not listed_`);
  out.push('');
  if (cli.open.length) {
    out.push('### Rounds that started and never ended', '');
    for (const round of cli.open) {
      out.push(`- ${round.repo} ${(round.prs || []).map((n) => `#${n}`).join(' ')} — started ${short(round.at)}, pid ${round.pid}`
        + `${round.reaped ? ', lease since reaped' : ', **its lease was never reaped**'}`);
    }
    out.push('', `\`mc log <run>\` for any of these in full. \`!\` above marks ${threshold}+ hits in the window.`);
    out.push('');
  }
  return out;
}

function byStatus(rows) {
  const out = {};
  for (const row of rows) {
    const group = out[row.status] || { fingerprints: 0, occurrences: 0 };
    group.fingerprints += 1;
    group.occurrences += row.count;
    out[row.status] = group;
  }
  return out;
}

function short(at) {
  return String(at || '').slice(0, 16).replace('T', ' ');
}

function clip(text, to = 120) {
  const one = String(text ?? '').replace(/\s+/gu, ' ').trim();
  return one.length > to ? `${one.slice(0, to - 1)}…` : one;
}
