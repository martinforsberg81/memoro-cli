/**
 * `~/mc/runner/merges.json` — the pull requests the merger has been handed,
 * oldest first.
 *
 * Ruling 30 (2026-10-09): `mc merge <repo> <pr>` puts the pull request here
 * and returns; one process, the merger (`merger.js`), lands them one at a
 * time. Until then every `mc merge` was its own waiter — an entry with its
 * pid, polling the gate lock every fifteen seconds and giving up after eight
 * minutes with "run this again" — and a machine with six lanes had six
 * processes standing in line for one lock (Martin: *"Just nu blir flera
 * processer hängande eller väntande på detta."*).
 *
 * An entry is a job, not a process: what to land (`repo`, `repo_path`,
 * `pr`), who asked (`holder`), the goal it is (`goal`, or null for a pull
 * request that is nobody's goal), and where it stands (`state`: `queued`,
 * `landing` while the merger has it, or `red` once it answered red). A red
 * entry is not work: it stays so the page draws it red while the queue goes
 * on (Martin, 2026-10-10: *"en misslyckad merge pr bör ligga kvar som en rad
 * i mc (röd) medan merge-kön fortsätter med nästa"*), and `mc merge` again
 * puts it back in line. A `landing` entry names the merger that
 * has it (`merger`, a pid); a `landing` entry whose merger died is
 * landed again by the next one — the round itself is what says whether the
 * pull request already merged.
 *
 * Everything here is pure over the entries; the file is read, changed and
 * written whole under the register's lock by its caller (`merger.js`).
 */
import { join } from 'node:path';

/**
 * One pull request, in one repository. Two repositories number their pull
 * requests independently, so a number alone is not an identity — memoro's
 * #500 and memoro-cli's are different work.
 */
export function samePr(a, b) {
  return Number(a.pr) === Number(b.pr) && (a.repo ?? null) === (b.repo ?? null);
}

/** Where the file lives, spelled once for the verb, the merger, the runner and the page. */
export function mergesPath(root) {
  return join(root, 'runner', 'merges.json');
}

// A `mending` entry from before the mend was removed (2026-11-02, goal
// `headless-plan`) is not a state any more: it reads as `queued`, and the
// merger measures the branch as it stands.
export const JOB_STATES = Object.freeze(['queued', 'landing', 'red']);

const plain = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** One entry, whatever a hand-edited file or an older mc left behind. */
function normalise(entry) {
  return {
    repo: entry.repo ?? null,
    repo_path: entry.repo_path ?? null,
    pr: Number(entry.pr),
    branch: entry.branch ?? null,
    holder: plain(entry.holder) ? { ...entry.holder } : (typeof entry.holder === 'string' ? { name: entry.holder } : null),
    // A goal's pull request (goals.js), queued by its green review: the goal
    // whose status the answer sets, and the head the review judged. Only that
    // head lands; one that has moved sends the goal back to review.
    goal: plain(entry.goal) && typeof entry.goal.programme === 'string' && typeof entry.goal.goal === 'string' && typeof entry.goal.dir === 'string'
      ? { programme: entry.goal.programme, goal: entry.goal.goal, dir: entry.goal.dir }
      : null,
    sha: typeof entry.sha === 'string' && entry.sha ? entry.sha : null,
    since: entry.since ?? null,
    state: JOB_STATES.includes(entry.state) ? entry.state : 'queued',
    started: entry.started ?? null,
    // The pid of the merger that has the job; another live merger leaves the
    // entry alone (`held`, see `heldBy`).
    merger: entry.state === 'landing' && Number.isInteger(entry.merger) ? entry.merger : null,
    // A red only under load is put back in line rather than answered
    // (`markRequeued`): how often, and not before when it is taken again.
    requeues: Number.isInteger(entry.requeues) && entry.requeues > 0 ? entry.requeues : 0,
    // Rounds the network stopped in a row for this job (`markOffline`): not a requeue, not an attempt.
    offline: Number.isInteger(entry.offline) && entry.offline > 0 ? entry.offline : 0,
    not_before: entry.state === 'queued' && typeof entry.not_before === 'string' ? entry.not_before : null,
    // A red answer's words and when it came (`markRed`).
    reason: entry.state === 'red' && typeof entry.reason === 'string' ? entry.reason : null,
    answered: entry.state === 'red' ? entry.answered ?? null : null,
  };
}

/** The entries of a parsed file — anything else is no entries at all. */
export function queueEntries(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && Number.isFinite(Number(entry.pr)))
    .map(normalise);
}

/** The file's text: unreadable means empty. */
export function parseQueue(text) {
  if (text == null) return [];
  try { return queueEntries(JSON.parse(text)); } catch { return []; }
}

/**
 * This pull request queued. Queued again — a session that fixed a red the
 * door found and asked once more — keeps `since`: how long it has been
 * waiting is a fact about the pull request, not about the last call.
 * An entry the merger is landing right now is left as it is: the round in
 * flight is measuring the branch as it was, and the answer is the round's.
 */
export function enqueue(entries, entry) {
  const next = normalise(entry);
  const at = entries.findIndex((item) => samePr(item, next));
  if (at < 0) return [...entries, next];
  const was = entries[at];
  if (was.state === 'landing') return entries;
  // A goal's job queued again by `mc merge` stays the goal's, so its landing
  // still sets the goal done; the head is the new call's, none for a person's.
  return entries.map((item, index) => (index === at ? { ...next, since: was.since || next.since, goal: next.goal || was.goal } : item));
}

/** The entries without it: landed, or nothing left to land. */
export function dequeue(entries, { repo = null, pr }) {
  return entries.filter((entry) => !samePr(entry, { repo, pr }));
}

/** This pull request's entry, or null — the identity is repository and number. */
export function queuedFor(entries, repo, pr) {
  return entries.find((entry) => samePr(entry, { repo: repo ?? null, pr })) || null;
}

/**
 * The entry kept with the round's red answer: `state: 'red'`, the reason and
 * when — no longer work for the merger, still a row on the page.
 */
export function markRed(entries, job, { reason = null, answered = null } = {}) {
  return entries.map((entry) => (samePr(entry, job)
    ? { ...entry, state: 'red', reason, answered, merger: null }
    : entry));
}

/** The jobs the merger may take: `queued`, or `landing` under a merger that died. */
const takeable = (entry) => entry.state === 'queued' || entry.state === 'landing';

/** A queued job put back with a `not_before` still ahead of `now` (epoch ms) waits; null `now` waits for nothing. */
const due = (now) => (entry) => now == null || !entry.not_before || !(Date.parse(entry.not_before) > now);

/** The entries the merger still has to land: everything not answered red. */
export function inLine(entries) {
  return entries.filter((entry) => entry.state !== 'red');
}

/** The red answers, newest first. */
export function redEntries(entries) {
  return entries.filter((entry) => entry.state === 'red')
    .sort((a, b) => String(b.answered ?? '').localeCompare(String(a.answered ?? '')) || b.pr - a.pr);
}

/**
 * Oldest first: the one that has been waiting longest is the one to land.
 * Queued in the same second — `mc merge <repo> <pr> <pr>` — they keep the
 * file's order, which is the order they were given in.
 */
export function queueOrder(entries) {
  return [...entries].sort((a, b) => String(a.since ?? '').localeCompare(String(b.since ?? '')));
}

/**
 * The job the merger takes next: one already `landing` (its merger died
 * under it), else the oldest `queued`. An entry `held` names (another live
 * merger's) is not taken. Null when there is nothing the merger may take.
 */
export function nextJob(entries, { now = null, held = () => false } = {}) {
  const line = queueOrder(inLine(entries).filter(takeable).filter(due(now)).filter((entry) => !held(entry)));
  return line.find((entry) => entry.state === 'landing')
    || line.find((entry) => entry.state === 'queued')
    || null;
}

/**
 * The most jobs one round lands: one (ruling 55, 2026-10-24). Measured over
 * `~/.memoro/mc/gate-rounds.jsonl` on memoro's merge rounds 2026-10-17 to
 * 2026-10-24: a single round (305) selected 349 files at the median, its suite
 * took 154 s and its wall 210 s, 80 % green. A batch (37) selected 874 files,
 * its suite took 406 s and its wall 822 s, 54 % green, and a red batch falls
 * back to one round per member: about 430 s per landed pull request against
 * 210 s alone. So no round is formed with more than one job. The constant stays
 * and `nextBatch` keeps its `max`, so a test can ask for a wider batch; a merger
 * resuming a batch it died under still takes its `landing` entries again.
 */
export const MERGE_BATCH_MAX = 1;

/**
 * The jobs the merger lands in one round: `nextJob`'s pick and the next ones
 * in line for the same repository that are `queued` and may go, up to `max`.
 * Entries already `landing` are a merger that died under a batch: every
 * `landing` entry of the first one's repository is taken again, and the
 * round says what has already merged. Empty when there is nothing to take.
 *
 * With a `lane`, only the jobs whose repository's gate lane (`laneOf`) is that
 * one: the merger runs one loop per lane (ruling 34), and each takes its own.
 * Entries `held` names (another live merger's) are not taken, a `landing`
 * one included.
 */
export function nextBatch(entries, {
  max = MERGE_BATCH_MAX, lane = null, laneOf = (entry) => entry.repo, now = null,
  held = () => false,
} = {}) {
  const mine = lane ? entries.filter((entry) => laneOf(entry) === lane) : entries;
  const line = queueOrder(inLine(mine).filter(takeable).filter(due(now)).filter((entry) => !held(entry)));
  const landing = line.filter((entry) => entry.state === 'landing');
  if (landing.length) return landing.filter((entry) => entry.repo === landing[0].repo);
  const first = nextJob(mine, { now, held });
  if (!first) return [];
  const batch = [first];
  for (const entry of line) {
    if (batch.length >= max) break;
    if (entry !== first && entry.repo === first.repo && entry.state === 'queued') batch.push(entry);
  }
  return batch;
}

/** The entry back in line, as `queued`, its place (`since`) kept. */
export function markQueued(entries, job) {
  return entries.map((entry) => (samePr(entry, job) ? { ...entry, state: 'queued', started: null, merger: null, offline: 0 } : entry));
}

/**
 * The entry back in line after a round that was red only under load: `queued`,
 * its place kept, one more `requeues`, and not taken before `notBefore` (an ISO
 * instant). No session is started for it and no attempt counted: there is
 * nothing in the change to fix (gate-round-under-load, 2026-10-19).
 */
export function markRequeued(entries, job, { notBefore = null } = {}) {
  return entries.map((entry) => (samePr(entry, job)
    ? { ...entry, state: 'queued', started: null, merger: null, requeues: (entry.requeues || 0) + 1, offline: 0, not_before: notBefore }
    : entry));
}

/**
 * The entry back in line after a round the network stopped: `queued`, its
 * place kept, one more `offline` in a row, and not taken before `notBefore`.
 * Not a requeue: nothing in the change was measured, so the requeue budget
 * stays for the change's own reds, and no session is started.
 */
export function markOffline(entries, job, { notBefore = null } = {}) {
  return entries.map((entry) => (samePr(entry, job)
    ? { ...entry, state: 'queued', started: null, merger: null, offline: (entry.offline || 0) + 1, not_before: notBefore }
    : entry));
}

/**
 * The entry with `state`, `started` and the merger that has it moved. `merger`
 * is the pid of the merger process landing it; another live merger leaves it alone (`heldBy`).
 */
export function markLanding(entries, job, started, merger = null) {
  return entries.map((entry) => (samePr(entry, job) ? { ...entry, state: 'landing', started, merger } : entry));
}

/**
 * Whether another live merger holds an entry: `merger` names a pid that is not
 * `pid` (this merger) and `alive(pid)` says it runs. A dead merger's entry is
 * not held — the next merger lands it again.
 */
export function heldBy({ pid = process.pid, alive }) {
  return (entry) => Number.isInteger(entry.merger) && entry.merger !== pid && alive(entry.merger);
}

/** How many stand before this pull request — 0 is next. */
export function placeOf(entries, repo, pr) {
  const at = queueOrder(inLine(entries)).findIndex((entry) => samePr(entry, { repo, pr }));
  return at < 0 ? null : at;
}
