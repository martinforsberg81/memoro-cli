/**
 * `~/mc/runner/merges.json` — every `mc merge` standing in line for the gate,
 * each with its pid.
 *
 * Measured 2026-09-06: `mc merge memoro-cli 671` was refused fourteen times in
 * twenty minutes by the runner's own landings, and every one of those refusals
 * cost a person another command. So a call that meets a busy gate or a held
 * lease writes itself in here with a `pid` and waits its turn rather than
 * refusing at once — see `nextWaiter` and the loop in `commands/repo.js`. The
 * file is mc's own state beside `runner.json`, never a status in a
 * `PLAN.json`. (Until 2026-09-12 a refused round also left an entry with no
 * pid, for a merge lane in the runner to land; ruling 21 removed the lane.)
 *
 * Everything here is pure over the entries: any caller may write the file, so
 * it is read, changed and written whole in one turn by its caller, and the
 * rules can be tested without one.
 */
import { join } from 'node:path';


/**
 * One pull request, in one repository. Two repositories number their pull
 * requests independently, so a number alone is not an identity — memoro's
 * #500 and memoro-cli's are different work. (Was `held.js`'s until ruling 21
 * took that file out.)
 */
export function samePr(a, b) {
  return Number(a.pr) === Number(b.pr) && (a.repo ?? null) === (b.repo ?? null);
}

/** Where the file lives, spelled once for the verb, the runner and the page. */
export function mergesPath(root) {
  return join(root, 'runner', 'merges.json');
}


/** Past this, a wait is not a wait any more — see the loop in `commands/repo.js`. */
export const MERGE_WAIT_MS = 8 * 60 * 1000;
/** How often a waiting `mc merge` looks again. */
export const MERGE_POLL_MS = 15 * 1000;

/** One entry, whatever a hand-edited file or an older mc left behind. */
function normalise(entry) {
  return {
    // Part of the identity, for the reason `held.js` (gone with ruling 21) gave: memoro #9 and
    // memoro-cli #9 are different work.
    repo: entry.repo ?? null,
    pr: Number(entry.pr),
    branch: entry.branch ?? null,
    reason: String(entry.reason ?? 'no reason given'),
    stopped_at: entry.stopped_at ?? null,
    since: entry.since ?? null,
    holder: entry.holder ?? null,
    // Only a waiter has one: the process asking `mc merge` and waiting its
    // turn. An entry with no pid (the refused rounds of before 2026-09-12,
    // queued for a lane that is gone) is left alone by `dropDeadEntries`. `null` is
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
