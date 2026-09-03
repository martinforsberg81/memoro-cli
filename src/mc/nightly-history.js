/**
 * Red, and since when.
 *
 * The number that would have prevented memoro's #10529 is not "31 tests are
 * red". It is "these 31 tests have been red since Tuesday". One run's red list
 * looks exactly like a flake; the same list twice, dated, does not — and the
 * difference between those two readings is the whole of this file.
 *
 * So the stored thing is a short history of runs — when, which commit of the
 * branch, and the set of failing test *names* — and the reported thing is
 * derived from it: for each test red in the latest run that measured anything,
 * the earliest run of the consecutive streak that saw it red.
 *
 * ## Names, and nothing else
 *
 * Not output, not stack traces, not the log. A name is enough to say a thing
 * is still red, and anything more turns a meter into an archive. The names are
 * deliberately *not* capped the way `repo-round-log.js` caps its own: a
 * dropped name would come back in the next run looking like a test that had
 * gone green and broken again, and dating that to today is the exact lie this
 * file exists to prevent. The bound is the number of runs kept.
 *
 * ## Only the scheduled run writes here
 *
 * `mc test <repo> --full` typed by a person is the same reading, but it can be
 * asked about a pull request — `--full` narrows nothing, it does not choose the
 * tree — and a run over a candidate merge tree carries red names that were
 * never about `main`. One of those between two nightly runs would make "since
 * when" a sentence about somebody's branch. The history is the meter's.
 *
 * ## Consecutive
 *
 * A test red on Monday, green on Tuesday and red on Wednesday has been red
 * since Wednesday. The other reading — earliest occurrence anywhere in the
 * history — is identical on every history where nothing ever went green, which
 * is every history there is on the day this ships, so it is asserted directly
 * rather than read for.
 *
 * A run that produced no suite result at all is transparent to that walk: it
 * neither continues a streak nor breaks one, because it is not evidence of
 * anything. It is *not* a run that found nothing — those two collapsed into one
 * is a day of stopped runs reported as a green streak, which is the same false
 * green this project's first step exists to remove, arriving by a third road.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { nightlyRoot } from './nightly.js';
import { mcHome } from './paths.js';
import { repoFileSlug } from './repo-snapshot.js';

export const NIGHTLY_HISTORY_SCHEMA = 'mc-nightly-history';
export const NIGHTLY_HISTORY_VERSION = 1;

/**
 * How many runs are kept, oldest dropped.
 *
 * Two weeks at the default cadence of a day — enough to answer "since when"
 * over a week with room for the nights that were skipped, and not a
 * time-series database. A history this size is a few hundred kilobytes at
 * memoro's worst.
 */
export const HISTORY_LIMIT = 14;

/** One file per repository, named the way every other mc file about one is. */
export function nightlyHistoryPath(repoPath, root = mcHome()) {
  return join(nightlyRoot(root), `${repoFileSlug(repoPath)}.json`);
}

/**
 * What a run was, in the four facts the reading needs.
 *
 * `red` is the load-bearing one and its *type* is what carries the meaning:
 * an array for a run whose suite reached its own summary, and `null` for one
 * that produced no suite result — the lock was held, the preparation failed,
 * the declaration stopped it, the process died. A `null` coerced to an empty
 * set anywhere downstream is a false green.
 */
export function storedRun(run) {
  const measured = Array.isArray(run?.red);
  return {
    at: run?.started_at || run?.at || new Date().toISOString(),
    duration_ms: run?.duration_ms ?? null,
    commit: run?.commit || null,
    outcome: measured ? (run.red.length ? 'failed' : 'passed') : 'incomplete',
    stopped_at: run?.stopped_at || null,
    reason: run?.reason ? String(run.reason).slice(0, 300) : null,
    tests: run?.tests ?? null,
    red: measured ? [...run.red] : null,
  };
}

/**
 * Append one run to a repository's history, oldest dropped.
 *
 * Written atomically, under mc's home, and never inside a repository — and a
 * history that cannot be written never fails the run it describes, for
 * `repo-round-log.js`'s reason: a meter's own bookkeeping must not be able to
 * take down the thing it is measuring.
 */
export function recordNightlyRun(run, { root = mcHome(), limit = HISTORY_LIMIT } = {}) {
  const path = nightlyHistoryPath(run.path, root);
  const history = readNightlyHistory(run.path, { root });
  const runs = [...history.runs, storedRun(run)].slice(-limit);
  try {
    writeJsonAtomic(path, {
      schema: NIGHTLY_HISTORY_SCHEMA,
      version: NIGHTLY_HISTORY_VERSION,
      repo: run.repo || null,
      path: run.path,
      runs,
    }, { mode: 0o600 });
    return { ok: true, path, runs: runs.length };
  } catch (error) {
    return { ok: false, path, reason: error?.message || String(error) };
  }
}

/**
 * Every stored run for one repository, oldest first.
 *
 * Unreadable, or from a version that meant something else by these fields,
 * reads as absent — a history is a saving of work and never a source of truth
 * that can fail closed. The order is taken from the timestamps rather than
 * from the file, because a history is a thing a person is invited to edit by
 * hand and an entry pasted at the end is usually the oldest one.
 */
export function readNightlyHistory(repoPath, { root = mcHome() } = {}) {
  let raw = null;
  try { raw = JSON.parse(readFileSync(nightlyHistoryPath(repoPath, root), 'utf8')); } catch { return { runs: [] }; }
  if (raw?.schema !== NIGHTLY_HISTORY_SCHEMA || raw?.version !== NIGHTLY_HISTORY_VERSION) return { runs: [] };
  const runs = (Array.isArray(raw.runs) ? raw.runs : [])
    .filter((run) => run && Number.isFinite(Date.parse(run.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { repo: raw.repo || null, path: raw.path || repoPath, runs };
}

/**
 * What the page says about one repository: the last attempt, the last
 * measurement, and every test red in it with the date it went red.
 *
 * The two are separate on purpose. A tick that skipped because a merge round
 * held the lock is the last *attempt* and measured nothing; the reading it
 * could not replace is still the last *measurement* and still true of the
 * commit it names. Showing only the first loses the answer; showing only the
 * second claims a freshness the meter does not have.
 */
export function nightlyReading(repoPath, { root = mcHome() } = {}) {
  const { runs } = readNightlyHistory(repoPath, { root });
  const measured = runs.filter((run) => Array.isArray(run.red));
  const latest = measured.at(-1) || null;
  return {
    runs: runs.length,
    last: runs.at(-1) ? summary(runs.at(-1)) : null,
    measured: latest ? summary(latest) : null,
    red: latest ? standing(measured) : [],
  };
}

function summary(run) {
  return {
    at: run.at,
    outcome: run.outcome,
    stopped_at: run.stopped_at || null,
    reason: run.reason || null,
    commit: run.commit || null,
    tests: run.tests ?? null,
    duration_ms: run.duration_ms ?? null,
    red: Array.isArray(run.red) ? run.red.length : null,
  };
}

/**
 * Every test red in the latest measurement, with the earliest run of the
 * streak that saw it — oldest standing first, because that is the one a reader
 * is deciding about.
 *
 * `bounded` says the streak reaches the oldest run kept and there is nothing
 * before it to disagree: the date is then a floor rather than the day it
 * broke, and the page says "at least". With one run in the whole history that
 * floor is the run itself, which is "first seen in this run" — the honest
 * answer, rather than dating everything to the day this shipped.
 */
function standing(measured) {
  const latest = measured.at(-1);
  return latest.red
    .map((name) => {
      let index = measured.length - 1;
      while (index > 0 && measured[index - 1].red.includes(name)) index -= 1;
      const since = measured[index];
      return {
        name,
        since: since.at,
        since_commit: since.commit,
        runs: measured.length - index,
        bounded: index === 0,
      };
    })
    .sort((a, b) => Date.parse(a.since) - Date.parse(b.since) || a.name.localeCompare(b.name));
}
