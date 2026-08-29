/**
 * The readers behind the page — the parts built from files the runner and the
 * sessions already write, that more than one caller needs.
 * No model, nothing written, nothing started.
 *
 * `nowBlock` turns the files `mc run` keeps into the NOW section;
 * `kindFor` answers what the runner would do with a queued name; `pidAlive`
 * is the one liveness test the page and the foreground register both use;
 * `decisionsBlock` and `areasWithCheckout` name what waits on Martin and
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
 * tests feed them fixtures and never touch git, gh or tmux.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { chooseKind } from './run-plan.js';

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
 * to one string. It cannot see `reconcile`: that is a merge left in progress
 * inside a workarea, and the page does not open worktrees.
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
  const status = choice.skip.slice('status '.length);
  return `skip:${status === 'missing' ? 'no-status' : status}`;
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

/* --------------------------------------------------------------- decisions */

export function decisionsBlock(decisions) {
  return decisions.filter((d) => !d.answered).map((d) => {
    const file = d.file.split('/').at(-1).replace(/\.md$/u, '');
    const waits = file.replace(/-\d{4}-\d{2}-\d{2}$/u, '').replace(/-\d+$/u, '');
    return { file: d.file, title: d.title, waits_on: waits, area: d.area };
  });
}

/* ------------------------------------------------------------------- areas */

/**
 * Areas under the work root that hold a checkout of a repository mc knows,
 * each with the repositories it holds.
 *
 * A folder without `memoro/` or `memoro-cli/` in it is not a workarea and is
 * never listed: `bin/`, `brief/`, `decisions/`, `inbox/`, `intake/`,
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
