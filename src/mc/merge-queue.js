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

export const JOB_STATES = Object.freeze(['queued', 'landing', 'red']);

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
  if (was.state === 'landing') return entries;
  return entries.map((item, index) => (index === at ? { ...next, since: was.since || next.since } : item));
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
  return entries.map((entry) => (samePr(entry, job) ? { ...entry, state: 'red', reason, answered } : entry));
}

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
 * and lands. Null when there is nothing the merger may take.
 */
export function nextJob(entries, { landed = () => true } = {}) {
  const ordered = queueOrder(inLine(entries));
  const mayGo = (entry) => !entry.parent
    || (!queuedFor(entries, entry.repo, entry.parent.pr) && landed(entry.parent));
  return ordered.find((entry) => entry.state === 'landing')
    || ordered.find(mayGo)
    || null;
}

/** Jobs waiting on a parent that has not landed, for the page: `{ entry, parent }`. */
export function waitingOnParent(entries, { landed = () => true } = {}) {
  return inLine(entries).filter((entry) => entry.parent && entry.state !== 'landing'
    && (queuedFor(entries, entry.repo, entry.parent.pr) || !landed(entry.parent)));
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
