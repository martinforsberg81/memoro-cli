/**
 * `mc run` — what happens to a workarea whose plan is finished.
 *
 * A workarea outlives its plan for exactly the reason a done plan used to
 * outlive its project: nothing removed it. Measured on 2026-08-29, `~/mc`
 * held 61 workareas — seven of them finished and merged weeks earlier, and
 * sixteen from before the plan world with no plan on main at all.
 *
 * So the rule is three facts and no judgement. A workarea is **closable**
 * when its plan on main says `done`, its worktree has no uncommitted change,
 * and its last row in `runs.tsv` ends `merged`. Commit counting against main
 * is not one of them: the runner squash-merges, so every finished branch
 * reads as "ahead" forever (branch-landed.js is the same lesson one layer
 * up).
 *
 * A workarea **without a plan on main** is never removed by a machine. It is
 * listed — on the page under its own heading, and in
 * `~/mc/intake/unplanned-workareas.md` for `mc brief` to raise — with
 * whether its branch's content is already on main, which is the one thing
 * that says whether anything would be lost.
 *
 * Everything here is a function of text and small objects; the git half is
 * run.js, so these rules can be covered with no repository behind them.
 */
import { parseRuns } from './brief-collect.js';

/** A step's note column ends this way when the runner merged its PR. */
const MERGED = /merged$/u;

/** The last row `runs.tsv` has for one project, or null. Rows are in time order. */
export function lastRunFor(tsv, name) {
  const rows = parseRuns(tsv).filter((row) => row.name === name);
  return rows.length ? rows.at(-1) : null;
}

/**
 * Is this workarea finished? Returns `{ close, unplanned, why }` — `why` is
 * the line runner.log gets, whichever way it goes.
 *
 * The order is the order a reader wants: the missing plan first (it is a
 * different answer, not a failed one), then the plan's own word, then the
 * two facts that could make a `done` plan the wrong moment.
 *
 * `live` is not in the plan's three conditions and is not a fourth rule: it
 * is the same refusal `runStep` already makes. Removing the worktree
 * somebody is sitting in would be the one irreversible thing here.
 */
export function closable({ plan = null, dirty = false, live = false, lastRun = null } = {}) {
  if (!plan) return { close: false, unplanned: true, why: 'no plan on main' };
  if (plan.status !== 'done') return { close: false, unplanned: false, why: `the plan is ${plan.status || 'unreadable'}` };
  if (live) return { close: false, unplanned: false, why: 'a live tmux session' };
  if (dirty) return { close: false, unplanned: false, why: 'an uncommitted change' };
  if (!lastRun) return { close: false, unplanned: false, why: 'no runner step to point at' };
  if (!MERGED.test(String(lastRun.note || ''))) return { close: false, unplanned: false, why: `the last run says ${lastRun.note || '-'}` };
  return { close: true, unplanned: false, why: 'plan done, worktree clean, last run merged' };
}

/* ------------------------------------- intake: the workareas with no plan */

export const UNPLANNED_HEADER = [
  '# Workareas with no plan on main',
  '',
  'Written by `mc run` at the end of every round. Nothing here is removed by a',
  'machine — a workarea without a plan is work somebody started, and only Martin',
  'can say whether it is finished. `branch` is asked of content, not of commit',
  'counts: `landed` means main already has everything this branch holds.',
  '',
  '| name | repo | uncommitted | last commit | branch |',
  '|---|---|---|---|---|',
  '',
].join('\n');

const cell = (value) => String(value ?? '-').replace(/\s+/gu, ' ').replace(/\|/gu, '\\|').trim() || '-';

export function unplannedRow({ name, repo, uncommitted, lastCommit, branch }) {
  return `| ${[name, repo, uncommitted, lastCommit, branch].map(cell).join(' | ')} |`;
}

/**
 * The whole file, rewritten every round rather than appended to: it is a
 * picture of what is there now, and a workarea that got its plan should
 * leave the list by itself.
 */
export function unplannedFile(rows) {
  return rows.length ? `${UNPLANNED_HEADER}${rows.join('\n')}\n` : UNPLANNED_HEADER;
}
