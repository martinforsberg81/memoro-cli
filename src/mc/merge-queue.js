/**
 * `~/mc/runner/merges.json` — the pull requests a hand `mc merge` could not
 * land, waiting for the runner's merge lane to land them.
 *
 * Measured 2026-09-06: `mc merge memoro-cli 671` was refused fourteen times in
 * twenty minutes by the runner's own landings, and every one of those refusals
 * cost a person another command. The runner's own landing already waits for a
 * busy gate and already gives a red pull request one repair (`landPr`,
 * `heldRepair` in run.js); a hand merge got neither, so the refusal was the
 * caller's problem and the caller was a person.
 *
 * So a refused round writes the pull request down, in mc's own state beside
 * `runner.json` and `held.json` — never a status in a `PLAN.json`. The file is
 * what the lane has *not tried yet*: an entry leaves it the moment the lane
 * has an answer, and a pull request the lane could not land is `held.json`'s,
 * with its one-repair rule, exactly as a step's pull request is.
 *
 * Since step-lands-itself, the file is also `mc merge`'s own wait queue: a
 * call that meets a busy gate or a held lease writes itself in here with a
 * `pid`, and waits its turn rather than refusing at once — see `nextWaiter`
 * and the loop in `commands/repo.js`. `busy` and `lease` no longer reach
 * `queueRefusal`: the verb itself waits them out, so a round can no longer
 * stop there and hand the wait to the runner's lane instead.
 *
 * Everything here is pure over the entries, the shape `held.js` has for the
 * same reason: any lane may write the file, so it is read, changed and written
 * whole in one turn by its caller, and the rules can be tested without one.
 */
import { join } from 'node:path';

import { samePr } from './held.js';

/** Where the file lives, spelled once for the verb, the runner and the page. */
export function mergesPath(root) {
  return join(root, 'runner', 'merges.json');
}

/**
 * The stops a refused round queues on — the ones the merge lane can do
 * something about, and no others:
 *
 *  - `red` — the gate measured red, and a red pull request is what the
 *    repair session exists for.
 *  - `pr-tests` — the pull request's own tests failed, which is the same
 *    answer arrived at one phase earlier.
 *  - `extra-gate` — a declared command gate failed or could not run, and a
 *    gate that could not run is not an approval a second caller can give.
 *  - `merge` — the squash itself was refused (a conflict, a forge that said
 *    no), and the lane's round starts from a main that has moved since.
 *
 * `busy` and `lease` are not here any more. Both used to be the lane's to
 * retry, exactly like the four above; now the verb itself waits out a busy
 * gate lock and a held lease (see the module docstring), so a round can no
 * longer stop at either — `queueable('busy')` returning true would double a
 * process that is already its own waiter into a second entry.
 *
 * A stop at `pr` is not here: GitHub could not be asked, or there is no such
 * pull request, and nothing on this machine can land what it cannot name.
 * Every other stop (`drift`, `merge-unknown`, `batch`, `plan-trespass`) stays
 * exactly as it is today — the caller is told and nothing is queued.
 */
export const QUEUEABLE_STOPS = Object.freeze(['red', 'pr-tests', 'extra-gate', 'merge']);

/** Past this, a wait is not a wait any more — see the loop in `commands/repo.js`. */
export const MERGE_WAIT_MS = 8 * 60 * 1000;
/** How often a waiting `mc merge` looks again. */
export const MERGE_POLL_MS = 15 * 1000;

/** Would a round that stopped here be the lane's to try again? */
export function queueable(stoppedAt) {
  return QUEUEABLE_STOPS.includes(String(stoppedAt || ''));
}

/** One entry, whatever a hand-edited file or an older mc left behind. */
function normalise(entry) {
  return {
    // Part of the identity, for the reason held.js gives: memoro #9 and
    // memoro-cli #9 are different work.
    repo: entry.repo ?? null,
    pr: Number(entry.pr),
    branch: entry.branch ?? null,
    reason: String(entry.reason ?? 'no reason given'),
    stopped_at: entry.stopped_at ?? null,
    since: entry.since ?? null,
    holder: entry.holder ?? null,
    // Only a waiter has one: the process asking `mc merge` and waiting its
    // turn. A refused-round entry (queued for the runner's lane, not waiting
    // itself) has none, and `dropDeadEntries` leaves those alone. `null` is
    // checked first: `Number(null)` is `0`, a finite number, so a no-pid entry
    // written to disk and read back would otherwise become `pid: 0` — a
    // "waiter" nothing is actually waiting as.
    pid: entry.pid == null ? null : (Number.isFinite(Number(entry.pid)) ? Number(entry.pid) : null),
  };
}

/** The entries of a parsed file — anything else is no entries at all. */
export function queueEntries(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && Number.isFinite(Number(entry.pr)))
    .map(normalise);
}

/** The file's text, read the way the runner reads it: unreadable means empty. */
export function parseQueue(text) {
  if (text == null) return [];
  try { return queueEntries(JSON.parse(text)); } catch { return []; }
}

/**
 * This pull request queued. Queued again — a second `mc merge` refused for a
 * new reason — keeps `since`: how long it has been waiting is a fact about the
 * pull request, not about the round that last asked.
 */
export function enqueue(entries, entry) {
  const next = normalise(entry);
  const at = entries.findIndex((item) => samePr(item, next));
  if (at < 0) return [...entries, next];
  const was = entries[at];
  return entries.map((item, index) => (index === at ? { ...next, since: was.since || next.since } : item));
}

/** The entries without it: the lane has an answer, whatever the answer was. */
export function dequeue(entries, { repo = null, pr }) {
  return entries.filter((entry) => !samePr(entry, { repo, pr }));
}

/** This pull request's entry, or null — the identity is repository and number. */
export function queuedFor(entries, repo, pr) {
  return entries.find((entry) => samePr(entry, { repo: repo ?? null, pr })) || null;
}

/** Oldest first: the one that has been waiting longest is the one to land. */
export function queueOrder(entries) {
  return [...entries].sort((a, b) => String(a.since ?? '').localeCompare(String(b.since ?? '')) || a.pr - b.pr);
}

/**
 * A waiter's entry left behind by a process that is gone — killed, crashed,
 * the terminal closed — is litter, not a place in the line. Dropped by
 * whoever polls next, the same reasoning `gate-lock.js` uses for the round
 * lock itself. An entry with no `pid` (a refusal queued for the runner's
 * lane) is not a waiter and is never dropped by this.
 */
export function dropDeadEntries(entries, { alive }) {
  return entries.filter((entry) => entry.pid == null || alive(entry.pid));
}

/**
 * The waiter allowed to take the gate lock next.
 *
 * Ordering rule: the oldest live entry is the one allowed to take the lock,
 * so a round that has just released the gate is followed by the waiter that
 * arrived first, not by whichever process polled first. Two waiters on
 * different repositories are both bounded by the one machine-wide gate lock
 * and each by its own per-repository lease, so the rule is: the oldest live
 * entry across every repository takes the lock; a waiter behind a lease it
 * cannot get keeps its place, rather than blocking a later arrival whose own
 * repository is free.
 */
export function nextWaiter(entries, { leaseHeld = () => false } = {}) {
  const waiting = queueOrder(entries.filter((entry) => entry.pid != null));
  return waiting.find((entry) => !leaseHeld(entry.repo)) || null;
}
