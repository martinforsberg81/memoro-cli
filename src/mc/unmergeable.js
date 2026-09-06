/**
 * `~/mc/runner/unmergeable.json` — every workarea a round could not bring to
 * `origin/main`, and the files the merge stopped on.
 *
 * The round already knew this and told nobody. It merges `origin/main` into
 * the area branch before it hands anything out; where that stops and there is
 * no session to hand the conflict to, it aborts the merge and writes one line
 * into `runner.log` — and an aborted merge leaves the worktree *clean*, so
 * nothing on this machine carries the fact afterwards. `machineState` reads a
 * clean worktree, a ready plan on main and nothing open, and says the project
 * is runnable; the next round merges, conflicts, aborts and says the same
 * line again. `docx-editor` did that for 13 rounds on 2026-09-05 and every
 * surface called it ready throughout.
 *
 * So the fact is written where a program can read it, in the shape `held.json`
 * already has: **mc's own state**, beside `runner.json` and
 * `current-<repo>.json`, never a status in a `PLAN.json`. An entry is born
 * where the round aborts a merge (`run.js`: `abandonMerge`) and dies the next
 * time that project's round gets past the merge at all — so a workarea a
 * person has fixed, or one main has moved past, leaves the file by itself.
 *
 * `since` is the whole point of the shape: a condition that lasts eight rounds
 * is one state with an age, not eight events. Held again keeps the first
 * `since`, exactly as `holdPr` does.
 *
 * Everything here is pure over the entries: the file is read, changed and
 * written by `run.js` through two functions, because any lane may write it.
 */
import { join } from 'node:path';

/** Where the file lives, spelled once for the runner and its readers both. */
export function unmergeablePath(root) {
  return join(root, 'runner', 'unmergeable.json');
}

/** How many of the conflicting files an entry keeps. */
export const FILES_CAP = 20;

/** One entry, whatever a hand-edited file or an older runner left behind. */
function normalise(entry) {
  const files = Array.isArray(entry.files) ? entry.files.map(String).filter(Boolean) : [];
  return {
    project: entry.project ?? null,
    repo: entry.repo ?? null,
    worktree: entry.worktree ?? null,
    files: files.slice(0, FILES_CAP),
    why: String(entry.why ?? 'no session to hand the merge to'),
    since: entry.since ?? null,
  };
}

/** The entries of a parsed file — anything else is no entries at all. */
export function unmergeableEntries(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => entry && entry.project).map(normalise);
}

/** The file's text, read the way the runner reads it: unreadable means empty. */
export function parseUnmergeable(text) {
  if (text == null) return [];
  try { return unmergeableEntries(JSON.parse(text)); } catch { return []; }
}

/**
 * One workarea, in one repository. A project has one workarea per repository
 * and its name is not unique across them, so the pair is the identity — the
 * same reason `samePr` (held.js) is a pair.
 */
function same(a, b) {
  return a.project === b.project && (a.repo ?? null) === (b.repo ?? null);
}

/**
 * The entries with this workarea marked. Marked again — another round that
 * could not merge it either — keeps `since`: how long it has been standing
 * still is a fact about the workarea and not about this round. The files and
 * the reason are this round's, because main moves and what it conflicts on
 * moves with it.
 */
export function markUnmergeable(entries, entry) {
  const next = normalise(entry);
  const at = entries.findIndex((item) => same(item, next));
  if (at < 0) return [...entries, next];
  const was = entries[at];
  return entries.map((item, index) => (index === at ? { ...next, since: was.since || next.since } : item));
}

/** The entries without it: the workarea took main, so it is not stuck. */
export function clearUnmergeable(entries, { project, repo = null }) {
  return entries.filter((entry) => !same(entry, { project, repo }));
}

/** This workarea's entry, or null — the reading's whole question. */
export function unmergeableFor(entries, { project, repo = null }) {
  return (entries || []).find((entry) => same(entry, { project, repo })) || null;
}

/**
 * What the entry says as a sentence a person reads, in the shape every other
 * `machineState` detail has — `<what> <worktree>: <the files>`, which is what
 * the brief clips from the middle so both ends survive a narrow terminal.
 *
 * Three files and a count, for the same reason the dirty sentence names three:
 * the count alone is what nobody acted on.
 *
 * `why` is deliberately not in it. The brief draws this in a table cell and
 * clips it from the middle at 110 characters; with the reason on the end, the
 * files — the one thing a person opens — were what the clip ate: *origin/main
 * could not be merged into /t…LAN.json is one of the conflicts*. The reason is
 * in the entry and in `runner.log` for whoever wants it.
 */
export function describeUnmergeable(entry, shown = 3) {
  const files = entry?.files || [];
  const named = files.slice(0, shown).join(', ') + (files.length > shown ? ` +${files.length - shown}` : '');
  const where = entry?.worktree ? ` ${entry.worktree}` : '';
  return `origin/main could not be merged into${where}${named ? `: ${named}` : ''}`;
}
