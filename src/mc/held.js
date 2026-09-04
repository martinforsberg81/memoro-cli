/**
 * `~/mc/runner/held.json` — every pull request the runner would not land, and
 * why it did not land it.
 *
 * The runner already knew this and told nobody: `landPr` logged `#N left open
 * — <reason>` into runner.log, `inFlight` then refused the project every later
 * round because the pull request was open, and the only other trace was a
 * runs.tsv note — `success,open,gate-red`, `plan-trespass`, `open,not-a-stack`.
 * Counted on 2026-09-03..04: of 55 step rows, seven ended that way, and every
 * one of those projects stood still until a person read the log, found the
 * reason and merged by hand.
 *
 * So the fact is written where a program can read it. It is **mc's own state**,
 * beside `runner.json` and `current-<repo>.json` — never a status in a
 * `PLAN.json`, which the runner does not write. An entry is born where the
 * runner decides not to land (`run.js`: `landPr`, `landProject`, the trespass
 * check) and dies when its pull request is no longer open — reconciled once a
 * round against the list `queue()` already fetches, so a pull request somebody
 * merged or closed by hand leaves the file by itself.
 *
 * Everything here is pure over the entries: the file is read, changed and
 * written by `run.js` through one function, because any lane may write it.
 */
import { join } from 'node:path';

/** Where the file lives, spelled once for the runner and the page both. */
export function heldPath(root) {
  return join(root, 'runner', 'held.json');
}

/** One entry, whatever a hand-edited file or an older runner left behind. */
function normalise(entry) {
  const repairs = Number(entry.repairs);
  return {
    project: entry.project ?? null,
    repo: entry.repo ?? null,
    pr: Number(entry.pr),
    branch: entry.branch ?? null,
    reason: String(entry.reason ?? 'no reason given'),
    note: entry.note ?? null,
    since: entry.since ?? null,
    repairs: Number.isFinite(repairs) && repairs > 0 ? Math.round(repairs) : 0,
  };
}

/** The entries of a parsed file — anything else is no entries at all. */
export function heldEntries(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && Number.isFinite(Number(entry.pr)))
    .map(normalise);
}

/** The file's text, read the way the runner reads it: unreadable means empty. */
export function parseHeld(text) {
  if (text == null) return [];
  try { return heldEntries(JSON.parse(text)); } catch { return []; }
}

/**
 * One pull request, in one repository. Two repositories number their pull
 * requests independently, so a number alone is not an identity — memoro's
 * #500 and memoro-cli's are different work.
 */
export function samePr(a, b) {
  return Number(a.pr) === Number(b.pr) && (a.repo ?? null) === (b.repo ?? null);
}

/**
 * The entries with this pull request held. Held again — a second round that
 * refused the same pull request for a new reason — keeps `since` and
 * `repairs`: how long it has been standing still, and whether its one repair
 * session has run, are facts about the pull request and not about this round.
 */
export function holdPr(entries, entry) {
  const next = normalise({ repairs: 0, ...entry });
  const at = entries.findIndex((item) => samePr(item, next));
  if (at < 0) return [...entries, next];
  const was = entries[at];
  return entries.map((item, index) => (index === at
    ? { ...next, since: was.since || next.since, repairs: was.repairs }
    : item));
}

/** The entries without it: the pull request landed, or is not open any more. */
export function releasePr(entries, { repo = null, pr }) {
  return entries.filter((entry) => !samePr(entry, { repo, pr }));
}

/**
 * The file against what GitHub says is open. `repos` is the repositories whose
 * open list was actually read this round — a repository `gh` could not be
 * asked for is unknown, not empty, and nothing of its is dropped on a network
 * failure.
 *
 * Returns `{ kept, dropped }`, because the round says one line per entry that
 * left: a pull request that stopped being held is the end of a project
 * standing still, and that is worth a line.
 */
export function reconcileHeld(entries, { prs = [], repos = [] } = {}) {
  const known = new Set(repos.filter(Boolean));
  if (!known.size) return { kept: entries, dropped: [] };
  const keyed = new Set(prs.map((pr) => `${pr.repo ?? ''}#${Number(pr.number)}`));
  const numbers = new Set(prs.map((pr) => Number(pr.number)));
  const kept = [];
  const dropped = [];
  for (const entry of entries) {
    const unknown = entry.repo != null && !known.has(entry.repo);
    const open = entry.repo == null ? numbers.has(entry.pr) : keyed.has(`${entry.repo}#${entry.pr}`);
    (unknown || open ? kept : dropped).push(entry);
  }
  return { kept, dropped };
}

/**
 * The session notes that leave work in an open pull request nobody is going
 * to land. `success` is landed (or held by the gate, which writes its own
 * reason); `quota` is a session that never ran and opened nothing.
 */
export function holdsAfterSession(note) {
  return Boolean(note) && note !== 'success' && note !== 'quota';
}

/** What a session-shaped hold says, in the words the repair session will read. */
export function holdReason({ note, problems = [] } = {}) {
  if (note === 'plan-trespass') {
    const said = problems.filter(Boolean).join('; ');
    return `the session changed more of the plan than its step${said ? `: ${said}` : ''}`;
  }
  if (note === 'timeout') return 'the session timed out with the pull request open';
  if (note === 'no-json') return 'the session ended without a result with the pull request open';
  return `the session ended \`${note}\` with the pull request open`;
}
