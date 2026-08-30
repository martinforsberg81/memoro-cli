/**
 * `mc run` — what happens to a workarea whose project is finished.
 *
 * **A round closes what the plan world built, and lists everything else.**
 * Ruled by Martin, 2026-08-30, after a round removed 22 workareas in one
 * evening: a project that came through `PLAN.json` is the runner's to take
 * down when it is done; a folder that predates that system is a person's, and
 * no machine may touch it — *"då riskerar innehåll att tas bort. Det ska göras
 * manuellt."*
 *
 * The boundary is not a judgement, it is a fact in git: **did this project
 * ever have a `docs/project/<programme>/<name>/PLAN.json` in `origin/main`'s
 * history?** Measured against those 22 removals, every single one was a
 * `PLAN.md` project and not one had ever had a `PLAN.json` — the migration
 * landed the same day the archiving caught up with the backlog, so the round
 * spent its first real evening taking down exactly the folders it had no
 * business taking down. Nothing was lost (every last pull request was checked
 * against GitHub afterwards and every one had merged), but nothing lost is not
 * the same as nothing at risk.
 *
 * A workarea is **closable** when four facts hold, and no judgement is made
 * beyond them:
 *
 *  - it is a plan-world project — a `PLAN.json` is in main's history for it;
 *  - its project is finished — the plan on main says `done`, or the plan is
 *    gone and `docs/project/project_log.md` says the runner archived it;
 *  - its worktree has no uncommitted change **and its branch holds nothing
 *    main does not** (branch-landed.js, asked of content — the runner
 *    squash-merges, so commit counting reads "ahead" forever);
 *  - its last delivering run ends `merged`.
 *
 * The branch fact is the fourth because of what the third one cannot see:
 * `git status --porcelain` reports uncommitted changes and says nothing about
 * a commit that was never pushed, and the close ends in `git branch -D`. A row
 * in `runs.tsv` saying `merged` is evidence that *a* pull request landed, never
 * that this branch has nothing left on it.
 *
 * Everything the four facts pass over is **listed, never taken**: the finished
 * ones from before the plan world in `~/mc/intake/finished-workareas.md`, the
 * ones no project explains at all in `~/mc/intake/unplanned-workareas.md`. Both
 * are for `mc brief` to raise and `mc work discard <name> --apply` to act on,
 * by a person who has read the row.
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
 * The last row that *delivered* something — one that names a pull request.
 *
 * The last row full stop was the wrong question, and the first real round said
 * so out loud: 20 of the finished workareas on 2026-08-30 were passed over
 * saying `the last run says success`, because their final step was a
 * `reconcile`. A reconcile resolves a conflict and opens nothing — its `pr`
 * column is `-` and its note is a plain `success` — so it can never end
 * `merged`, and a project whose last act was one could never be reported
 * finished however many merged steps came before it. `msr-design` was archived
 * off main with two merged steps behind it and a reconcile on top.
 *
 * A row with no pull request is not evidence either way, so it is skipped
 * rather than believed.
 */
export function lastDeliveryFor(tsv, name) {
  const rows = parseRuns(tsv).filter((row) => row.name === name && row.pr && row.pr !== '-');
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
 * The facts after it are what keep that widening from taking anything it
 * should not: a folder goes only if the plan world built it, with a clean
 * worktree, a branch main already holds, *and* a last delivery that ends
 * `merged`. One somebody made by hand that happens to share a name with an
 * archived project has no runner step to point at, and stays.
 *
 * `live` is not one of those conditions and is not a rule of its own: it is
 * the same refusal `runStep` already makes. Removing the worktree somebody is
 * sitting in would be the one irreversible thing here.
 *
 * Three of the outcomes are not failures but different answers, and the caller
 * lists each somewhere of its own: `unplanned` is a folder no project explains,
 * `legacy` one finished before the plan world, and `close` the only one a
 * machine acts on.
 */
export function closable({
  plan = null, archived = false, planWorld = false,
  dirty = false, live = false, landed = null, lastRun = null,
} = {}) {
  if (!plan && !archived) return { close: false, unplanned: true, why: 'no project on main' };
  if (plan && plan.status !== 'done') return { close: false, unplanned: false, why: `the plan is ${plan.status || 'unreadable'}` };
  if (live) return { close: false, unplanned: false, why: 'a live tmux session' };
  if (dirty) return { close: false, unplanned: false, why: 'an uncommitted change' };
  if (!lastRun) return { close: false, unplanned: false, why: 'no runner step to point at' };
  if (!MERGED.test(String(lastRun.note || ''))) return { close: false, unplanned: false, why: `its last delivery says ${lastRun.note || '-'}` };
  // Everything above is about whether the work is over. This is about whose
  // folder it is: a project that never had a PLAN.json was made before the
  // system that closes them, and only Martin removes one of those.
  if (!planWorld) {
    return { close: false, unplanned: false, legacy: true, why: 'finished, but from before PLAN.json — yours to remove' };
  }
  // And this is the one the other four cannot see: `git status` says nothing
  // about a commit that was never pushed, and the close ends in `branch -D`.
  if (landed !== null && landed !== 'landed') {
    return { close: false, unplanned: false, legacy: true, why: `its branch is ${landed} — main does not hold everything it has` };
  }
  return {
    close: true,
    unplanned: false,
    why: plan
      ? 'plan done, worktree clean, branch landed, last delivery merged'
      : 'project archived, worktree clean, branch landed, last delivery merged',
  };
}

/* ------------------------------- intake: the workareas that are finished */

export const FINISHED_HEADER = [
  '# Workareas whose project is finished',
  '',
  'Written by `mc run` at the end of every round. **Nothing here is removed by a',
  'machine** — a round measures and reports, and `mc work discard <name> --apply`',
  'is what takes one, typed by somebody who has read the row (Martin, 2026-08-30).',
  '',
  '`branch` is asked of content, not of commit counts: `landed` means main already',
  'holds everything this branch does and nothing would be lost. Anything else means',
  'read the branch first — `ahead` includes the case this list exists for, a commit',
  'that was never pushed. `pr` is the last delivery the runner made from it.',
  '',
  '| name | repo | why | pr | branch |',
  '|---|---|---|---|---|',
  '',
].join('\n');

export function finishedRow({ name, repo, why, pr, branch }) {
  return `| ${[name, repo, why, pr, branch].map(cell).join(' | ')} |`;
}

/** The whole file, rewritten every round — a picture of what is there now. */
export function finishedFile(rows) {
  return rows.length ? `${FINISHED_HEADER}${rows.join('\n')}\n` : FINISHED_HEADER;
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
