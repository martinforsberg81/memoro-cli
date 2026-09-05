/**
 * The readers behind the page — the parts built from files the runner and the
 * sessions already write, that more than one caller needs.
 * No model, nothing written, nothing started.
 *
 * `nowBlock` turns the files `mc run` keeps into the NOW section;
 * `kindFor` answers what the runner would do with a queued name;
 * `machineState` answers whether it could start it at all right now;
 * `pidAlive`
 * is the one liveness test the page and the foreground register both use;
 * `areasWithCheckout` names
 * what exists on disk.
 *
 * `page-collect.js` assembles the five sections out of these and
 * `page-render.js` draws them. Nothing here renders: the block-and-render
 * half `mc status` printed before the page existed — `collectStatus`,
 * `renderStatus`, `runnerBlock`, `projectsBlock`, `orphanWorkareas` — went
 * with its last caller, `commands/status-page.js`, in the same project that
 * replaced it.
 *
 * The builders are pure: each takes read data and returns a block, so the
 * tests feed them fixtures and never touch git, gh or tmux. `machineState` is
 * the one that has to ask a worktree something — is it dirty, does it have
 * that branch — and it asks through an injected `git` that is only ever given
 * read-only arguments, so its tests feed it a fixture like the rest.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { openPrsFor } from './project-prs.js';
import { REFUSAL, chooseKind, heldRepair, inFlight } from './run-plan.js';

/** What the runner ran everything on; runs.tsv carries no model column yet. */
export const RUNNER_MODEL = 'opus';

/** The repositories a directory under `~/mc` must hold one of to be a workarea. */
export const REPO_NAMES = Object.freeze(['memoro', 'memoro-cli']);

/* -------------------------------------------------------------------- kind */

/**
 * What the runner would do with a queued name — asked of the runner itself.
 *
 * The rule lives in one place, `chooseKind` in run-plan.js, and run.js calls
 * the same function before it starts a step; this only flattens the answer
 * to one string. A merge left in progress inside a workarea does not change
 * it either way — the plan decides what a project gets, and the conflict is
 * something the step session is told about rather than a kind of its own.
 *
 * Decisions are not a parameter any more. The runner runs `ready` plans and
 * nothing else — a project waiting on a decision is simply not ready, and no
 * `**Beslut:**` line anywhere starts it (Martin, 2026-08-29).
 */
export function kindFor(name, { plans }) {
  const plan = plans.find((p) => p.project === name) || null;
  const choice = chooseKind({ plan });
  if (choice.kind) return choice.kind;
  if (!plan) return 'skip:no-plan';
  // The reason is a word the page can count. The sentence beside it is for a
  // person; grouping on it produced rows like "n does not parse: ..." when the
  // sentence changed shape.
  return `skip:${choice.reason || 'no-status'}`;
}

/* ----------------------------------------------------------- machine state */

/**
 * Would the runner start this project now, and if not, what is in the way —
 * from the files on this machine, at this moment.
 *
 * `kindFor` above is the other half of the same question and it is a fact
 * about a file on `main`: *is this plan ready to be worked on*. It cannot see
 * a dirty worktree, a pull request in flight or a hold, and on 2026-09-05 both
 * of memoro-cli's unfinished plans read `ready` in every surface while #612 and
 * #614 were held and the whole queue was stopped. This answers the other
 * question — *would the round get as far as starting a session* — and neither
 * can answer the other's.
 *
 * The reasons are asked in `runStepClaimed`'s own order (run.js), because the
 * answer has to be the first thing the round would hit and not merely some
 * true thing: a project that is both held and dirty is reported dirty, which
 * is what a person has to deal with first. The words are `RUN_REFUSALS`,
 * shared with the round so the two cannot drift.
 *
 * The plan is asked first and its answer returned before any git at all. That
 * is `planRefusal`'s economy (run.js): a project whose plan on main already
 * refuses it must cost no `git status` — a round spent 51 seconds walking 38
 * projects to start one before it was asked in that order.
 *
 * Nothing here starts, writes or fetches, which is the rule this module opens
 * with: `git` is only ever asked read-only questions of a worktree, and a
 * caller that gives no `git` reads a worktree as clean — exactly as the round
 * does when `git status` fails it.
 *
 * Returns `{ runnable, reason, detail, since, kind }`: `reason` a word the
 * page can count, `detail` the sentence for a person, `since` when it started
 * being true (a hold's own `since`, the oldest dirty file's mtime), and `kind`
 * what the runner would start — `step`, or `repair` for a held pull request
 * that is still owed its one repair session.
 */
export function machineState(name, {
  plans = [], prs = [], prsFailed = [], held = [], stop = false,
  root = null, repoNames = REPO_NAMES,
  exists = existsSync, git = () => ({ ok: false, stdout: '' }), mtime = fileMtime,
} = {}) {
  const no = (reason, detail, since = null) => ({ runnable: false, reason, detail: detail || null, since: since || null, kind: null });

  // The plan, before a worktree is touched.
  const kind = kindFor(name, { plans });
  if (kind.startsWith('skip:')) {
    const plan = plans.find((p) => p.project === name) || null;
    return no(kind.slice('skip:'.length), chooseKind({ plan }).skip || 'no plan on origin/main');
  }
  if (stop) return no(REFUSAL.stop, 'the STOP file is present — the runner starts nothing');

  // `kindFor` has already answered for a name with no plan on main at all, in
  // the same word the round uses one question later (`no-plan`), so what is
  // left here is a plan whose repository is not one of mc's.
  const repo = repoFor(name, { plans, root, repoNames, exists });
  if (!repo) return no('no-plan', 'no workarea and no plan on main');
  const worktree = root ? join(root, name, repo) : null;
  const gitOut = (args) => { const r = git(worktree, args); return r?.ok ? String(r.stdout ?? '').trimEnd() : null; };

  // A worktree that is not there yet is not in the way: the round makes one
  // from origin/main. One that is there and dirty parks the project every
  // round until a person acts, which is the line this reading exists for.
  if (worktree && exists(worktree)) {
    const dirt = dirtyWorktree(worktree, { gitOut, mtime });
    if (dirt) return no(REFUSAL.dirty, dirt.detail, dirt.since);
  }
  if (prsFailed.includes(repo)) return no(REFUSAL['prs-unknown'], 'GitHub could not be asked what this repository has open');

  const openPrs = openPrsFor({ prs, name, names: plans.map((p) => p.project), repo });
  // A hold at `repairs: 0` is not a refusal — it is one repair session owed,
  // which is a thing the runner would start. Only a hold whose repair has been
  // spent stops the project, and then it is waiting on a person.
  const repair = heldRepair({ entries: held, openPrs, project: name, repo });
  if (repair?.skip) return no(REFUSAL['held-after-repair'], repair.skip, repair.entry?.since);
  if (!repair) {
    const flight = inFlight(openPrs);
    if (flight) return no(REFUSAL['in-flight'], flight.skip);
  }
  // A repair session has to stand on the branch its pull request is on. The
  // round checks that out; this asks the readable half of the same question —
  // whether the workarea has that branch at all.
  if (repair && worktree && exists(worktree)) {
    const wanted = repair.entry.branch;
    const on = gitOut(['branch', '--show-current']);
    if (wanted && on !== wanted && !gitOut(['rev-parse', '-q', '--verify', `refs/heads/${wanted}`])) {
      return no(REFUSAL.branch, `#${repair.entry.pr} is on ${wanted}, which this workarea has no branch for`, repair.entry.since);
    }
  }
  return {
    runnable: true,
    reason: null,
    detail: repair ? `#${repair.entry.pr} is held before merge — one repair session is owed` : null,
    since: repair ? repair.entry.since || null : null,
    kind: repair ? 'repair' : kind,
  };
}

/** memoro | memoro-cli | null — an existing workarea first, then the plan's own. `repoOf`'s rule (run.js), over read data. */
function repoFor(name, { plans = [], root = null, repoNames = REPO_NAMES, exists = existsSync } = {}) {
  if (root) for (const repo of repoNames) if (exists(join(root, name, repo, '.git'))) return repo;
  return plans.find((p) => p.project === name)?.repo || null;
}

/** The porcelain codes git writes for a path a merge stopped on. */
const UNMERGED = /^(?:DD|AU|UD|UA|DU|AA|UU)$/u;

/**
 * What `git status --porcelain` says about a workarea, as a sentence and a
 * date, or null when it is clean.
 *
 * The three dirty files are named because the count alone is what nobody
 * acted on: `email-window-layout` stood third in queue.md and was skipped 134
 * rounds on three modified files before anyone read the reason. A merge left
 * in progress is the same refusal — an unmerged path is a dirty worktree, and
 * the round skips on it — but a person needs to know which of the two it is,
 * so the sentence says.
 */
function dirtyWorktree(worktree, { gitOut, mtime = fileMtime }) {
  const porcelain = gitOut(['status', '--porcelain']) || '';
  if (!porcelain.trim()) return null;
  const rows = porcelain.split('\n').filter((line) => line.trim()).map((line) => {
    const at = /^(..)\s(.*)$/u.exec(line);
    return at ? { xy: at[1].trim(), path: at[2].trim() } : { xy: '', path: line.trim() };
  });
  const shown = rows.slice(0, 3).map((row) => row.path).join(', ') + (rows.length > 3 ? ` +${rows.length - 3}` : '');
  const merging = rows.some((row) => UNMERGED.test(row.xy));
  const since = rows
    .map((row) => mtime(join(worktree, row.path)))
    .filter(Boolean)
    .sort()[0] || null;
  const what = merging ? 'a merge stopped in' : 'uncommitted work in';
  return { detail: `${what} ${worktree}: ${shown}`, since };
}

/** When a path was last written, as an ISO stamp — null for one that is gone. */
export function fileMtime(path) {
  try { return statSync(path).mtime.toISOString().replace(/\.\d{3}Z$/u, 'Z'); } catch { return null; }
}

/* --------------------------------------------------------------------- now */

/**
 * Is this pid a live process? `kill(pid, 0)` sends nothing and only asks;
 * EPERM means it exists and belongs to somebody else, which is still alive.
 * This is the whole liveness test — no tmux session name, no pgrep pattern.
 * Both of those lied on 2026-08-29: a dead pane still answered
 * `tmux has-session -t runner`, and `pgrep -f 'mc run'` matched a
 * step session whose prompt happened to contain the words "mc run".
 */
export function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/**
 * NOW — what is happening this second, from the files `mc run` keeps and the
 * STOP file anyone can touch.
 *
 * There is one `current-<repo>.json` per lane and one runner.json for the
 * process that drives them all, so `steps` is a list: `mc run` runs one lane
 * per repository at the same time, and NOW names every one of them.
 *
 * A file whose pid is dead is a crashed runner, not a running one: it is
 * reported as stale and counts as nothing running. `runs.tsv` cannot answer
 * any of this — its row is appended after the step is over.
 */
export function nowBlock({ runner = null, currents = [], stop = false, rows = [], now = new Date(), alive = pidAlive }) {
  const stale = [];
  const runnerLive = runner ? alive(runner.pid) : false;
  if (runner && !runnerLive) stale.push(`runner.json (pid ${runner.pid} is gone)`);

  const since = (iso) => {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : Math.max(0, Math.round((now.getTime() - t) / 1000));
  };
  const steps = [];
  for (const current of currents.filter(Boolean)) {
    const file = current.repo ? `current-${current.repo}.json` : 'current.json';
    if (!alive(current.pid)) { stale.push(`${file} (pid ${current.pid} is gone)`); continue; }
    const budget = Number(current.budget_minutes);
    const budgetSeconds = Number.isFinite(budget) && budget > 0 ? budget * 60 : null;
    const elapsed = since(current.started);
    steps.push({
      name: current.name || null,
      kind: current.kind || null,
      repo: current.repo || null,
      tool: current.tool || null,
      model: current.model || null,
      worktree: current.worktree || null,
      pid: current.pid ?? null,
      started: current.started || null,
      elapsed_seconds: elapsed,
      budget_seconds: budgetSeconds,
      over_budget: elapsed != null && budgetSeconds != null && elapsed > budgetSeconds,
    });
  }
  steps.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const quotaRows = rows.filter((row) => String(row.note || '').includes('quota'));
  return {
    runner: runner ? { pid: runner.pid ?? null, started: runner.started || null, alive: runnerLive, up_seconds: since(runner.started) } : null,
    steps,
    stop,
    stale,
    quota: { count: quotaRows.length, last: quotaRows.at(-1)?.ts || null },
  };
}

/* ------------------------------------------------------------------- areas */

/**
 * Areas under the work root that hold a checkout of a repository mc knows,
 * each with the repositories it holds.
 *
 * A folder without `memoro/` or `memoro-cli/` in it is not a workarea and is
 * never listed: `bin/`, `brief/`, `inbox/`, `intake/`,
 * `runner/`, `status/` and the two role homes are mc's own filing. They were
 * off the page already, but by accident — nothing under them happens to hold
 * a `.git` — and a repository mirror dropped into one would have put mc's own
 * bookkeeping on the board as work.
 */
export function areasWithCheckout(root, repoNames = REPO_NAMES) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => ({
        name: d.name,
        repos: repoNames.filter((repo) => existsSync(join(root, d.name, repo, '.git'))),
      }))
      .filter((area) => area.repos.length)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch { return []; }
}
