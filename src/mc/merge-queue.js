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
 * `pr`), who asked (`holder`), the step it is (`step`, or null for a pull
 * request that is nobody's step), and where it stands (`state`: `queued`,
 * `landing` while the merger has it, or `red` once it answered red). A red
 * entry is not work: it stays so the page draws it red while the queue goes
 * on (Martin, 2026-10-10: *"en misslyckad merge pr bör ligga kvar som en rad
 * i mc (röd) medan merge-kön fortsätter med nästa"*), and `mc merge` again
 * puts it back in line. A `landing` entry whose merger died is
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

// `mending`: answered red, and a mend session has the branch (ruling 37,
// mend.js). In line, so the page and `placeOf` count it, but not work the
// merger may take until the mend puts it back as `queued`.
export const JOB_STATES = Object.freeze(['queued', 'landing', 'red', 'mending']);

const plain = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** One entry, whatever a hand-edited file or an older mc left behind. */
function normalise(entry) {
  const step = plain(entry.step) && typeof entry.step.project === 'string' && Number.isInteger(entry.step.index)
    ? { project: entry.step.project, index: entry.step.index }
    : null;
  return {
    repo: entry.repo ?? null,
    repo_path: entry.repo_path ?? null,
    pr: Number(entry.pr),
    branch: entry.branch ?? null,
    holder: plain(entry.holder) ? { ...entry.holder } : (typeof entry.holder === 'string' ? { name: entry.holder } : null),
    step,
    // The job this one is built on (ruling 30, A): `{ project, index, pr,
    // sha }`. It is not taken until that one has landed; see `nextJob`.
    parent: plain(entry.parent) && Number.isFinite(Number(entry.parent.pr)) && typeof entry.parent.sha === 'string'
      ? { project: entry.parent.project ?? null, index: entry.parent.index ?? null, pr: Number(entry.parent.pr), sha: entry.parent.sha }
      : null,
    since: entry.since ?? null,
    state: JOB_STATES.includes(entry.state) ? entry.state : 'queued',
    started: entry.started ?? null,
    // A red answer's words and when it came (`markRed`).
    reason: entry.state === 'red' && typeof entry.reason === 'string' ? entry.reason : null,
    answered: entry.state === 'red' ? entry.answered ?? null : null,
    // The one mend a job gets (mend.js): `{ at, outcome }` once it has had
    // it, and `{ pid, started, reason, stopped_at }` while it runs. Read and
    // written only by the merger that mends; an older mc drops them.
    mended: plain(entry.mended) ? { at: entry.mended.at ?? null, outcome: entry.mended.outcome ?? null } : null,
    mend: entry.state === 'mending' && plain(entry.mend)
      ? {
        pid: Number.isInteger(entry.mend.pid) ? entry.mend.pid : null,
        started: entry.mend.started ?? null,
        reason: entry.mend.reason ?? null,
        stopped_at: entry.mend.stopped_at ?? null,
      }
      : null,
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
 * flight is measuring the branch as it was, and the answer is the step's.
 */
export function enqueue(entries, entry) {
  const next = normalise(entry);
  const at = entries.findIndex((item) => samePr(item, next));
  if (at < 0) return [...entries, next];
  const was = entries[at];
  // A mend session has the branch: what it pushes is measured next.
  if (was.state === 'landing' || was.state === 'mending') return entries;
  // Queued again, a job keeps its one mend spent: a job gets at most one.
  return entries.map((item, index) => (index === at ? { ...next, since: was.since || next.since, mended: was.mended } : item));
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
export function markRed(entries, job, { reason = null, answered = null, mended = undefined } = {}) {
  return entries.map((entry) => (samePr(entry, job)
    ? { ...entry, state: 'red', reason, answered, mend: null, ...(mended !== undefined ? { mended } : {}) }
    : entry));
}

/**
 * The entry set aside for its one mend (mend.js): `state: 'mending'` with
 * the round's stop and reason, until `markMended` or `markRed` answers it.
 */
export function markMending(entries, job, { reason = null, stopped_at = null, started = null, pid = null } = {}) {
  return entries.map((entry) => (samePr(entry, job)
    ? { ...entry, state: 'mending', mend: { pid, started, reason, stopped_at } }
    : entry));
}

/** The mend pushed: back in line as `queued`, at its old place (`since`), its mend spent. */
export function markMended(entries, job, { outcome = 'pushed', at = null } = {}) {
  return entries.map((entry) => (samePr(entry, job)
    ? { ...entry, state: 'queued', started: null, mend: null, mended: { at, outcome } }
    : entry));
}

/** The jobs the merger may take: `queued`, or `landing` under a merger that died. */
const takeable = (entry) => entry.state === 'queued' || entry.state === 'landing';

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
 * under it), else the oldest `queued` that may go. A job built on another
 * (`parent`) may go once that one has landed — it is not in the queue and
 * `landed(parent)` says so. One whose parent is still queued waits behind
 * it; one whose parent came back red waits until that one is queued again
 * and lands. A job for step n of a plan goes only once every earlier step is
 * `done` (`ordered`, merger.js `stepsBeforeDone`), parent or none — and that
 * holds for a `landing` one too. Null when there is nothing the merger may take.
 */
export function nextJob(entries, { landed = () => true, ordered = () => true } = {}) {
  const line = queueOrder(inLine(entries).filter(takeable));
  const mayGo = mayGoIn(entries, landed, ordered);
  return line.find((entry) => entry.state === 'landing' && ordered(entry))
    || line.find(mayGo)
    || null;
}

const parentFree = (entries, landed) => (entry) => !entry.parent
  || (!queuedFor(entries, entry.repo, entry.parent.pr) && landed(entry.parent));

const mayGoIn = (entries, landed, ordered) => {
  const free = parentFree(entries, landed);
  return (entry) => free(entry) && ordered(entry);
};

/**
 * Whether every earlier step of a job's plan is `done`, from `stepsOf(project)`
 * — the steps as the register has them, or null when it cannot be read, which
 * is taken as done (the rule `parentLanded` has). A job with no step, or for a
 * plan's first step, has nothing before it (Martin, 2026-10-10: *"step n+1 ska
 * inte kunna bli mergad om inte step n i ett projekt blivit mergad"*).
 */
export function stepsDone(stepsOf) {
  return (job) => {
    if (!job?.step || !(job.step.index > 0)) return true;
    const steps = stepsOf(job.step.project);
    if (!Array.isArray(steps)) return true;
    for (let index = 0; index < job.step.index; index += 1) {
      if (steps[index]?.status !== 'done') return false;
    }
    return true;
  };
}

/**
 * The most jobs one round lands (merge-throughput, ruling 34). About 11 % of
 * rounds on 2026-10-09/10 were red in the suite or a gate, so a batch of four
 * is red about a third of the time and then costs its fallback rounds — one
 * per pull request. Four still roughly halves the time per landing at a queue
 * of ten; a larger batch makes the fallback longer than the batch saves.
 */
export const MERGE_BATCH_MAX = 4;

/**
 * The jobs the merger lands in one round: `nextJob`'s pick and the next ones
 * in line for the same repository that are `queued` and may go, up to `max`.
 * Entries already `landing` are a merger that died under a batch: every
 * `landing` entry of the first one's repository is taken again, and the
 * round says what has already merged. Empty when there is nothing to take.
 *
 * With a `lane`, only the jobs whose repository's gate lane (`laneOf`) is that
 * one: the merger runs one loop per lane (ruling 34), and each takes its own.
 * A job's parent is in its own repository, so in its own lane.
 */
export function nextBatch(entries, {
  landed = () => true, ordered = () => true, max = MERGE_BATCH_MAX, lane = null, laneOf = () => 'heavy',
} = {}) {
  const mine = lane ? entries.filter((entry) => (laneOf(entry) || 'heavy') === lane) : entries;
  const line = queueOrder(inLine(mine).filter(takeable));
  // A resumed member whose earlier step is no longer `done` is not landed:
  // the merger puts it back in line (`heldLanding`).
  const landing = line.filter((entry) => entry.state === 'landing' && ordered(entry));
  if (landing.length) return landing.filter((entry) => entry.repo === landing[0].repo);
  const first = nextJob(mine, { landed, ordered });
  if (!first) return [];
  const mayGo = mayGoIn(mine, landed, ordered);
  const batch = [first];
  for (const entry of line) {
    if (batch.length >= max) break;
    if (entry !== first && entry.repo === first.repo && entry.state === 'queued' && mayGo(entry)) batch.push(entry);
  }
  return batch;
}

/**
 * Jobs in line that may not go yet, for the page and `mc merge watch`:
 * `{ entry, parent, step }`. `parent` is the number of the pull request it is
 * built on while that one has not landed; `step` is `{ project, number }` of
 * the step just before its own while the earlier steps are not all `done`.
 * Either may be null, never both.
 */
export function waitingOn(entries, { landed = () => true, ordered = () => true } = {}) {
  const free = parentFree(entries, landed);
  return inLine(entries).filter((entry) => entry.state === 'queued').flatMap((entry) => {
    const parent = free(entry) ? null : entry.parent.pr;
    const step = ordered(entry) ? null : { project: entry.step.project, number: entry.step.index };
    return parent == null && !step ? [] : [{ entry, parent, step }];
  });
}

/**
 * `landing` entries a restarted merger may not resume — an earlier step of
 * their plan is no longer `done` — to be put back in line with `markQueued`.
 */
export function heldLanding(entries, { ordered = () => true } = {}) {
  return inLine(entries).filter((entry) => entry.state === 'landing' && !ordered(entry));
}

/** The entry back in line, as `queued`, its place (`since`) kept. */
export function markQueued(entries, job) {
  return entries.map((entry) => (samePr(entry, job) ? { ...entry, state: 'queued', started: null } : entry));
}

/** The entry with `state` and `started` moved. */
export function markLanding(entries, job, started) {
  return entries.map((entry) => (samePr(entry, job) ? { ...entry, state: 'landing', started } : entry));
}

/** How many stand before this pull request — 0 is next. */
export function placeOf(entries, repo, pr) {
  const at = queueOrder(inLine(entries)).findIndex((entry) => samePr(entry, { repo, pr }));
  return at < 0 ? null : at;
}
