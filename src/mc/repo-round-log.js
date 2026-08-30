/**
 * One line per gate round — every round, not only the ones that merged (A7).
 *
 * An independent review measured "92 machine-run rounds, 0 with a red delta"
 * and then tore its own number down: the merge log is written *after* a
 * successful merge, so a round that stopped on red writes nothing, and
 * "0 of 92" can never contain the cases that would disprove it. A meter
 * that only sees the case that passes is the same shape as a falsely green
 * proof. So every round appends one JSON line here — merged, stopped,
 * refused the lease, cut short — with where it stopped and what it had cost
 * by then, and the question "has the gate ever caught anything?" is
 * answered by counting rather than by reading prose.
 *
 * Append-only JSONL under mc's own home: never inside a repository, never
 * in the merge log (which is a human document with a different owner), and
 * a line that cannot be written never fails the round it describes.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { log, runId } from './logger.js';
import { mcHome } from './paths.js';

export const ROUND_LOG_SCHEMA = 'mc-gate-round';
export const ROUND_LOG_VERSION = 1;

export function roundLogPath(root = mcHome()) {
  return join(root, 'gate-rounds.jsonl');
}

/**
 * A round, at its beginning.
 *
 * The line above says every round writes one line, "merged, stopped, refused
 * the lease, cut short" — and that was true of every round that *reached its
 * own end*. On 2026-08-30 two merge rounds were killed from outside, the
 * first after #11082 had already landed. Neither wrote anything. The file
 * built to answer "has the gate ever caught anything?" was silent about the
 * two rounds of that day that went wrong, and the meter that only sees the
 * case that finishes is the same shape as the meter that only sees the case
 * that passes.
 *
 * So a round announces itself before it does any work, and the pair is the
 * record: a start with no end is a round that died, and `pid` is how a later
 * reader proves it rather than guessing from a clock. SIGKILL runs nothing —
 * there is no line the dying process could have written — so this is the only
 * shape that can catch it.
 */
export function recordRoundStart({ repo, mode = 'merge', prs = [], holder = null }, { root = mcHome(), now = new Date() } = {}) {
  return append({
    schema: ROUND_LOG_SCHEMA,
    version: ROUND_LOG_VERSION,
    phase: 'start',
    at: now.toISOString(),
    repo: basename(String(repo || '')),
    mode,
    prs: (prs || []).map(Number).filter(Number.isFinite),
    holder,
    pid: process.pid,
    run: runId(),
  }, root);
}

/**
 * Record what one round was and where it ended. `report` is a merge round's
 * or a bare gate's report; `mode` says which was asked for, because a
 * `--check` that stopped at red and a merge that did are different facts.
 */
export function recordRound(report, { mode = 'merge', root = mcHome(), now = new Date() } = {}) {
  if (!report) return null;
  const gate = report.gate || report;
  const line = {
    schema: ROUND_LOG_SCHEMA,
    version: ROUND_LOG_VERSION,
    // Named on both halves so a reader never has to infer which it is holding.
    // Lines written before 2026-08-30 carry no `phase` and are ends: that is
    // what they were, and back-filling a field into a file nobody can rewrite
    // is how a log starts lying about its own history.
    phase: 'end',
    at: report.started_at || now.toISOString(),
    repo: basename(String(report.repo || '')),
    mode,
    pid: process.pid,
    run: runId(),
    prs: report.batch?.prs || [Number(report.pr?.number)].filter(Number.isFinite),
    holder: report.holder || null,
    ok: Boolean(report.ok),
    merged: report.batch
      ? (report.batch.merges || []).filter((item) => item.merged).map((item) => item.number)
      : report.merged ? [Number(report.pr?.number)] : [],
    // Where it stopped, or null for a round that reached its end. The words
    // are the round's own (`lease`, `busy`, `merge`, `red`,
    // `pr-tests`, `ratchet`, `extra-gate`, `drift`, …) so counting them is
    // counting the mechanism's own vocabulary, not a translation of it. Lines
    // from before 2026-08-30 say `suite-lease` where `busy` is written now;
    // they are what those rounds were, and nothing rewrites them.
    stopped_at: report.stopped_at || null,
    // Whether the landed tree was byte-identical to the measured candidate
    // (null when nothing landed): the difference between a green that
    // transfers by identity and one that describes a tree main never became.
    tree_identical: report.tree_identical ?? null,
    reason: report.reason ? String(report.reason).slice(0, 300) : null,
    duration_ms: report.duration_ms ?? null,
    timings: gate?.timings && Object.keys(gate.timings).length ? gate.timings : null,
    standing_red: gate?.standing_red ?? null,
    broke: gate?.broke?.length ?? null,
    // The red sets' delta by NAME, not only by count. The two names that
    // flapped 55 → 57 → 55 could not be pointed at afterwards: the gate's
    // report carried both red sets and threw them away, and the log line
    // carried only numbers. With the delta in the line, the next 57 names
    // itself. Capped and said when capped — a cap that says nothing reads
    // as "that was all of them".
    broke_names: capped(gate?.broke),
    fixed_names: capped(gate?.fixed),
    baseline_unstable: capped(gate?.ratchet?.baseline_risen),
  };
  log('gate.round', {
    repo: line.repo, mode, ok: line.ok, stopped_at: line.stopped_at,
    prs: line.prs, merged: line.merged, duration_ms: line.duration_ms,
  });
  return append(line, root);
}

/** One line, or null. A line that describes a round must never fail it. */
function append(line, root) {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    appendFileSync(roundLogPath(root), `${JSON.stringify(line)}\n`, { mode: 0o600 });
    return line;
  } catch {
    return null;
  }
}

/**
 * Rounds that started and never ended, oldest first.
 *
 * The join the incident needed: a `start` line whose `run` no `end` line
 * carries. `pid` is what turns "no end yet" into "died" — a round still
 * running has a live pid, and one that was killed does not. Asking the
 * operating system is deliberate: a clock cannot tell a dead round from a
 * slow one, and a gate round is *supposed* to take half an hour.
 */
export function unfinishedRounds(rounds, { alive = (pid) => isAlive(pid) } = {}) {
  const ended = new Set(rounds.filter((r) => r.phase === 'end' || !r.phase).map((r) => r.run).filter(Boolean));
  return rounds
    .filter((r) => r.phase === 'start' && !ended.has(r.run))
    .map((r) => ({ ...r, verdict: r.pid && alive(r.pid) ? 'running' : 'died' }));
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/** At most this many names in one field; past it, the count of the rest. */
const NAME_CAP = 40;

function capped(names) {
  if (!Array.isArray(names) || names.length === 0) return null;
  if (names.length <= NAME_CAP) return names;
  return [...names.slice(0, NAME_CAP), `… and ${names.length - NAME_CAP} more, not named here`];
}

/** Every recorded round, oldest first; lines that will not parse are skipped, counted. */
export function readRounds({ root = mcHome() } = {}) {
  let raw = '';
  try { raw = readFileSync(roundLogPath(root), 'utf8'); } catch { return { rounds: [], skipped: 0 }; }
  const rounds = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value?.schema === ROUND_LOG_SCHEMA) rounds.push(value);
      else skipped += 1;
    } catch { skipped += 1; }
  }
  return { rounds, skipped };
}

/**
 * The count the review could not make: rounds by outcome, per repo and in
 * all. `stopped_at: null` is "reached its end"; everything else is the
 * gate's own word for where it stopped.
 */
export function countRounds(rounds) {
  const total = { rounds: rounds.length, merged_prs: 0, by_stop: {} };
  for (const round of rounds) {
    total.merged_prs += (round.merged || []).length;
    const key = round.stopped_at || (round.ok ? 'completed' : 'unknown');
    total.by_stop[key] = (total.by_stop[key] || 0) + 1;
  }
  return total;
}
