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
 *  - `busy` — another gate round holds this machine's one gate lock, so the
 *    only thing missing is a turn, which is what the lane has.
 *  - `lease` — somebody else holds the repository; the same wait applies.
 *  - `red` — the gate measured red, and a red pull request is what the
 *    repair session exists for.
 *  - `pr-tests` — the pull request's own tests failed, which is the same
 *    answer arrived at one phase earlier.
 *  - `extra-gate` — a declared command gate failed or could not run, and a
 *    gate that could not run is not an approval a second caller can give.
 *  - `merge` — the squash itself was refused (a conflict, a forge that said
 *    no), and the lane's round starts from a main that has moved since.
 *
 * A stop at `pr` is not here: GitHub could not be asked, or there is no such
 * pull request, and nothing on this machine can land what it cannot name.
 * Every other stop (`drift`, `merge-unknown`, `batch`) stays exactly as it is
 * today — the caller is told and nothing is queued.
 */
export const QUEUEABLE_STOPS = Object.freeze(['busy', 'lease', 'red', 'pr-tests', 'extra-gate', 'merge']);

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
