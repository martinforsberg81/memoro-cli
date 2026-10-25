/**
 * `mc run` — what happens to a workarea whose plan is finished.
 *
 * A workarea outlives its plan for exactly the reason a done plan used to
 * outlive its project: nothing removed it. Measured on 2026-08-29, `~/mc`
 * held 61 workareas — seven of them finished and merged weeks earlier, and
 * sixteen from before the plan world with no plan on main at all.
 *
 * So the rule is three facts and no judgement. A workarea is **closable** when
 * its project is finished — its plan on main says `done`, or the plan is gone
 * and `docs/project/project_log.md` says the runner archived it — its worktree
 * has no uncommitted change, and its last row in `runs.tsv` ends `merged`.
 * Commit counting against main is not one of them: the runner squash-merges,
 * so every finished branch reads as "ahead" forever (branch-landed.js is the
 * same lesson one layer up).
 *
 * A workarea **no project explains at all** — no plan on main, and no row in
 * the project log — is never removed by a machine. It is listed: on the page
 * under its own heading, and in `~/mc/runner/unplanned-workareas.md` for
 * `mc brief` to raise, with whether its branch's content is already on main,
 * which is the one thing that says whether anything would be lost.
 *
 * Everything here is a function of text and small objects; the git half is
 * run.js, and `closeArea` takes its git and disk as doors, so these rules and
 * the taking-down can be covered with no repository behind them.
 */
import { join } from 'node:path';

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
 * The order is the order a reader wants: no project at all first (it is a
 * different answer, not a failed one), then the plan's own word, then the two
 * facts that could make a finished project the wrong moment.
 *
 * **`archived` is what a plan that has already gone leaves behind.** A plan
 * reaching `done` is archived off main and *then* its workarea is closed, and
 * for a while both had to happen in the same round: the closing tested
 * `status: done`, so a plan an earlier round had already removed simply read
 * as "no plan on main" — a folder no machine would ever touch again. Measured
 * 2026-08-30, the closing had never once run, and the single round that got as
 * far as archiving three projects was cut short by STOP before reaching it; the
 * next round found three folders with no plan and filed them with the
 * fifty-seven nobody can explain. So the second question is asked of the record
 * the archive itself writes — `docs/project/project_log.md` names every project
 * the runner has ever taken off main — and a folder is closable whether its
 * plan left main this round or three weeks ago.
 *
 * The two facts after it are what keep that widening from taking anything it
 * should not: a folder goes only with a clean worktree *and* a last runner step
 * that ends `merged`. One somebody made by hand that happens to share a name
 * with an archived project has no runner step to point at, and stays.
 *
 * `live` is not one of those conditions and is not a fourth rule: it is the
 * same refusal `runStep` already makes. Removing the worktree somebody is
 * sitting in would be the one irreversible thing here. It is true when a tmux
 * session of the project is live, or any process stands in the area — its cwd
 * is the area or somewhere under it.
 */
export function closable({
  plan = null, archived = false, dirty = false, live = false, lastRun = null, legacy = true, stepsDone = false,
} = {}) {
  if (!plan && !archived) return { close: false, unplanned: true, why: 'no project on main' };
  if (plan && plan.status !== 'done') return { close: false, unplanned: false, why: `the plan is ${plan.status || 'unreadable'}` };
  if (live) return { close: false, unplanned: false, why: 'a process stands in it' };
  if (dirty) return { close: false, unplanned: false, why: 'an uncommitted change' };
  // Only the runner makes areas under `step/` (ruling 39), so a hand-made area
  // sharing a project's name cannot be one — and that was the whole reason for
  // the last-run rule. There the register says it: every step `done`. On
  // 2026-10-11 the last-run rule had kept done areas open for 106 rounds on
  // `the last run says success,blocked|success,failed`. An area left directly
  // under `~/mc` keeps the last-run rule.
  if (!legacy) {
    if (!stepsDone) return { close: false, unplanned: false, why: 'not every step is done in the register' };
  } else {
    if (!lastRun) return { close: false, unplanned: false, why: 'no runner step to point at' };
    if (!MERGED.test(String(lastRun.note || ''))) return { close: false, unplanned: false, why: `the last run says ${lastRun.note || '-'}` };
  }
  const last = legacy ? 'last run merged' : 'every step done';
  return {
    close: true,
    unplanned: false,
    why: plan
      ? `plan done, worktree clean, ${last}`
      : `project archived in an earlier round, worktree clean, ${last}`,
  };
}

/* ---------------------------------- intake: the workareas no project explains */

export const UNPLANNED_HEADER = [
  '# Workareas with no project on main',
  '',
  'Written by `mc run` at the end of every round: the folders with no plan on',
  'main *and* no row in `project_log.md` — the runner has never archived a',
  'project by this name, so nothing here explains them. Nothing here is removed by',
  'a machine either: such a folder is work somebody started, and only Martin can',
  'say whether it is finished. `branch` is asked of content, not of commit counts:',
  '`landed` means main already has everything this branch holds.',
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

/* ---------------------------------------------------- taking one area down */

/**
 * One closable workarea, taken down: the worktree removed through the
 * repository that owns it, the local branch deleted, and everything the
 * folder kept beside its checkout moved to `runner/log/closed/<name>/`
 * before the folder itself goes.
 *
 * What mc deletes is nothing: every file the folder holds outside the
 * checkout is moved, and the checkout is git's to hand back — its content
 * is on origin, and the remote branch and the PRs stay. `git worktree
 * remove` does take the ignored files with it, which on the workareas
 * measured 2026-08-29 was `node_modules/`, `__pycache__/`, `.wrangler/`,
 * `public/dist/` and one generated `.sql` — build output a fresh checkout
 * rebuilds, and nothing a person wrote.
 *
 * A step that fails stops the rest and says so: the folder keeps whatever
 * has not been moved yet, and the next round tries again.
 *
 * `area` is the folder, `repos` the runner's `[{ name, path }]`: the ones
 * with a checkout in `area` are the ones acted on. The doors are the
 * runner's own — `closedDir` is `runner/log/closed`, `stopServers` stops the
 * dev servers under a folder.
 */
export function closeArea({ name, area, repos, closedDir, git, list, move, rmdir, exists, stopServers, say }) {
  // Its dev servers first: a server outlives the worktree otherwise, and
  // nothing else will ever stop it. A failed stop does not stop the close —
  // `git worktree remove` decides, as it always has.
  const servers = stopServers(area, { reason: 'workarea-closed' });
  for (const { instance_id: id, error } of servers?.failed || []) say(`close: ${name} — could not stop ${id}: ${error}`);
  for (const repo of repos.filter((candidate) => exists(join(area, candidate.name, '.git')))) {
    const worktree = join(area, repo.name);
    if (!git(repo.path, ['worktree', 'remove', worktree]).ok) {
      say(`close: ${name} — git worktree remove failed for ${repo.name}, left alone`);
      return false;
    }
    git(repo.path, ['branch', '-D', name]);
  }
  const kept = list(area).filter(Boolean);
  for (const entry of kept) {
    if (!move(join(area, entry), join(closedDir, name, entry))) {
      say(`close: ${name} — could not move ${entry} to ${join(closedDir, name)}, folder left alone`);
      return false;
    }
  }
  rmdir(area);
  const moved = kept.length ? `, ${kept.length} file(s) moved to runner/log/closed/${name}/` : '';
  say(`close: ${name} removed — worktree, branch ${name}${moved}`);
  return true;
}
