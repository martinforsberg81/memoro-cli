/**
 * Reading what mc wrote down — and joining the three files that record it.
 *
 * Step 1 gave every invocation a `run` id and made a gate round announce
 * itself before it works. This is the half that pays for it: the question
 * "what happened in that merge?" answered by one command instead of by three
 * files and a throwaway script.
 *
 * The three:
 *
 *   - `logs/mc.log`      — every invocation, its narration, its end;
 *   - `gate-rounds.jsonl` — one start line and one end line per gate round;
 *   - `repo-leases/leases.log` — claim, release and reap, with pids.
 *
 * They are joined on `run` where a run id exists, and on `pid` where it does
 * not: the lease log predates the run id and is a plain text file that other
 * things read, so it is parsed rather than changed. A join that needs both
 * files to have been rewritten is a join that cannot see history.
 *
 * ## Why "died" is inferred here and not written anywhere
 *
 * A round killed with SIGKILL runs no handler and writes no line. Nothing can
 * record its own death. So the verdict is made by a *later* reader, from a
 * start with no end whose pid is gone — and it asks the operating system
 * rather than a clock, because a gate round is supposed to take half an hour
 * and no timeout separates a slow round from a dead one.
 *
 * This file only reads. It never repairs a lease, never rewrites a log, never
 * decides that a holder is gone: `unfinished` is evidence for a person, and
 * the release stays the deliberate act it has always been.
 */
import { readFileSync } from 'node:fs';

import { logPath } from './logger.js';
import { mcHome } from './paths.js';
import { leaseLogPath } from './repo-lease.js';
import { readRounds, unfinishedRounds } from './repo-round-log.js';

/** Events from `mc.log`, oldest first. Unparseable lines are counted, never guessed at. */
export function readEvents({ path = null, root = mcHome() } = {}) {
  let raw = '';
  try { raw = readFileSync(path || logPath(), 'utf8'); } catch { return { events: [], skipped: 0 }; }
  const events = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value.event === 'string') events.push(value); else skipped += 1;
    } catch { skipped += 1; }
  }
  return { events, skipped, root };
}

/**
 * The lease log, parsed.
 *
 * Its shape is `<iso>  <verb>  <repo>  key=value …  errand="…"`, written by
 * `repo-lease.js`. Parsed leniently and on purpose: this file is a courtesy
 * that other eyes read, and a reader that threw on a line it did not
 * recognise would make the courtesy a liability.
 */
export function readLeaseLog({ root = mcHome() } = {}) {
  let raw = '';
  try { raw = readFileSync(leaseLogPath(root), 'utf8'); } catch { return []; }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    // An ISO stamp and one of the verbs this log actually writes. The looser
    // `\S+ \w+ \S+` this started as made an entry out of any three words —
    // "this line is not a lease record" parsed as a claim on a repo called
    // "is". Lenient about shapes it does not know, never inventing records.
    const match = /^(\d{4}-\d\d-\d\dT\S+)\s+(claim|release|reap|force)\s+(\S+)(.*)$/u.exec(line);
    if (!match) continue;
    const [, at, verb, repo, rest] = match;
    entries.push({
      at,
      verb,
      repo,
      pid: number(/\bpid[= ](\d+)/u.exec(rest)?.[1]),
      holder: /\bholder=(\S+)/u.exec(rest)?.[1] || /\bby=(\S+)/u.exec(rest)?.[1] || null,
      errand: /errand="([^"]*)"/u.exec(rest)?.[1] || null,
      gone: /\bgone\b/u.test(rest),
      raw: line,
    });
  }
  return entries;
}

/**
 * One invocation, assembled: its start, what it said, and how it ended.
 *
 * `ended: false` is the shape that matters. A run with a start and no end did
 * not return — it was killed, or it is still going — and `alive` says which,
 * from the pid rather than from elapsed time.
 *
 * That verdict is only ever reached for a run that HAS a start. Lines written
 * before the run id existed carry none, and every long-lived process still
 * running the older code writes them today: the runner logs `work.open` and
 * `work.background-start` all day, they group by pid, and the first version of
 * this reported each of them as a dead command. Five rows of `died` with no
 * verb, on a machine where nothing had died. A tool that reports itself as the
 * anomaly teaches people to ignore the anomaly column, which is the one thing
 * this file cannot afford.
 */
export function runsFrom(events, { alive = isAlive } = {}) {
  const runs = new Map();
  for (const event of events) {
    const id = event.run || `pid_${event.pid}`;
    if (!runs.has(id)) {
      runs.set(id, {
        run: id, pid: event.pid ?? null, at: event.at, verb: null, sub: null, args: [], flags: [],
        holder: null, cwd: null, started: false, ended: false, exit_code: null, duration_ms: null,
        threw: false, error: null, killed: null, said: [], events: 0,
      });
    }
    const run = runs.get(id);
    run.events += 1;
    if (event.event === 'mc.start') {
      run.started = true;
      run.verb = event.verb ?? run.verb;
      run.sub = event.sub ?? run.sub;
      run.args = event.args || run.args;
      run.flags = event.flags || run.flags;
      run.holder = event.holder ?? run.holder;
      run.cwd = event.cwd ?? run.cwd;
      run.at = event.at;
    } else if (event.event === 'mc.end') {
      run.ended = true;
      run.exit_code = event.exit_code ?? null;
      run.duration_ms = event.duration_ms ?? null;
      run.threw = Boolean(event.threw);
      run.error = event.error || null;
      run.finished_at = event.at;
    } else if (event.event === 'gate.killed') {
      run.killed = event.signal || 'signal';
    } else if (event.event === 'gate.say' || event.event === 'merge.say') {
      run.said.push({ at: event.at, text: event.text });
    }
  }
  for (const run of runs.values()) {
    if (run.ended) {
      run.outcome = run.threw ? 'threw' : run.exit_code === 0 ? 'ok' : 'failed';
    } else if (!run.started) {
      // Events with no invocation behind them: pre-run-id lines, or a process
      // that logs without going through the CLI funnel. They record that
      // something happened, not that a command failed to return.
      run.outcome = 'events';
    } else {
      run.outcome = run.pid && alive(run.pid) ? 'running' : 'died';
    }
  }
  return [...runs.values()];
}

/**
 * Everything mc knows about one run id, from all three files.
 *
 * This is the command's whole reason to exist: the 2026-08-30 reconstruction,
 * done by the machine that has the files.
 */
export function storyOf(run, { root = mcHome(), alive = isAlive } = {}) {
  const { events } = readEvents({ root });
  const mine = events.filter((event) => event.run === run);
  const [assembled] = runsFrom(mine, { alive });
  const { rounds } = readRounds({ root });
  const myRounds = rounds.filter((round) => round.run === run);
  const pids = new Set([assembled?.pid, ...myRounds.map((r) => r.pid)].filter(Boolean));
  return {
    run,
    invocation: assembled || null,
    rounds: myRounds,
    // The lease log has no run id; it is joined on the pid the round wrote
    // down, which is exactly the bridge that was missing.
    leases: readLeaseLog({ root }).filter((entry) => pids.has(entry.pid)),
  };
}

/**
 * Rounds that started and never ended, with the lease each one left behind.
 *
 * The direct answer to "did a round die, and is its lease still held by a pid
 * that is gone?" — the pair of facts that had to be assembled by hand.
 */
export function abandoned({ root = mcHome(), alive = isAlive } = {}) {
  const { rounds } = readRounds({ root });
  const open = unfinishedRounds(rounds, { alive });
  const leases = readLeaseLog({ root });
  return open.map((round) => ({
    ...round,
    lease: leases.filter((entry) => entry.pid === round.pid),
    reaped: leases.some((entry) => entry.verb === 'reap' && entry.pid === round.pid),
  }));
}

/**
 * Assembled runs, narrowed the ways a person actually narrows them.
 *
 * Filtering RUNS and not events, which is not a detail: a run's verb is on
 * its start line and its exit code is on its end line, so an event-level
 * filter for "the ones that failed" keeps the end and throws away the name of
 * the thing that failed. The first version of this printed a column of
 * verbless failures.
 */
export function filterRuns(runs, { since = null, repo = null, verb = null, failures = false, exclude = null, all = false } = {}) {
  let out = runs;
  if (since) {
    const from = Date.parse(since);
    if (Number.isFinite(from)) out = out.filter((run) => Date.parse(run.at) >= from);
  }
  if (repo) out = out.filter((run) => (run.args || []).some((arg) => String(arg).includes(repo)));
  if (verb) out = out.filter((run) => run.verb === verb);
  if (failures) out = out.filter((run) => run.outcome === 'failed' || run.outcome === 'threw' || run.outcome === 'died');
  // Loose events are context, never the answer to "what did mc run?". They
  // are reachable with --all, and with `mc log <run>` for one of them.
  if (!all) out = out.filter((run) => run.outcome !== 'events');
  if (exclude) out = out.filter((run) => run.run !== exclude);
  return out;
}

/**
 * What counts as a failure worth showing.
 *
 * A nonzero exit, a throw, a round killed by a signal — and `gate.round`
 * lines that stopped somewhere, because a round that refused a lease is a
 * fact somebody is looking for even though nothing about it is an error.
 */
export function isFailure(event) {
  if (event.event === 'mc.end') return event.threw === true || (event.exit_code ?? 0) !== 0;
  if (event.event === 'gate.killed') return true;
  if (event.event === 'gate.round') return event.ok === false;
  return false;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
