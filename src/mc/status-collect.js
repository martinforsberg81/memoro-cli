/**
 * The readers behind the page — the parts built from files the runner and the
 * sessions already write, that more than one caller needs.
 * No model, nothing written, nothing started.
 *
 * `nowBlock` turns the files `mc run` keeps into the NOW section;
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
 * tests feed them fixtures and never touch git, gh or tmux.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { sessionKind } from './session-kind.js';
import { listStepAreas } from './work-area.js';

/** What the runner ran everything on; runs.tsv carries no model column yet. */
export const RUNNER_MODEL = 'opus';

/** The repositories a directory under `~/mc` must hold one of to be a workarea. */
export const REPO_NAMES = Object.freeze(['memoro', 'memoro-cli']);

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
 * `current-<repo>.json` per lane — the step each lane has in flight, as the
 * runner wrote it when it started the session.
 *
 * It lives here rather than in page-collect.js because two readers need it and
 * one of them cannot reach that module: the page draws NOW from it, and `mc status`
 * drops a project the runner is running from what it cannot start.
 *
 * A file whose pid is dead is not a running step — `pidAlive` is the test, and
 * both callers apply it — so a crashed runner's leftover file neither claims a
 * step on the page nor hides a workarea nobody is in.
 */
export function readCurrents(dir, read = readJson, list = readdirSync) {
  let names = [];
  try { names = list(dir).filter((name) => /^current-.+\.json$/u.test(name)).sort(); } catch { return []; }
  return names.map((name) => read(join(dir, name))).filter(Boolean);
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/**
 * NOW — what is happening this second, from the files `mc run` keeps and the
 * STOP file anyone can touch.
 *
 * There is one `current-<repo>[-<lane>].json` per lane and one runner.json for
 * the process that drives them all, so `steps` is a list: `mc run` runs as
 * many headless sessions at once as `mc run lanes` says, across every
 * repository and every kind, and NOW names every one of them.
 *
 * A file whose pid is dead is a crashed runner, not a running one: it is
 * reported as stale and counts as nothing running. `runs.tsv` cannot answer
 * any of this — its row is appended after the step is over.
 *
 * `disk` and `memory` are `disk.json` and `memory.json` as the caller read
 * them: present while the runner starts no step for want of either, carrying
 * the line it said. Returned as given, or null when there is no line.
 */
export function nowBlock({
  runner = null, currents = [], stop = false, rows = [], disk = null, memory = null, now = new Date(), alive = pidAlive,
}) {
  const stale = [];
  const runnerLive = runner ? alive(runner.pid) : false;
  if (runner && !runnerLive) stale.push(`runner.json (pid ${runner.pid} is gone)`);

  const since = (iso) => {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : Math.max(0, Math.round((now.getTime() - t) / 1000));
  };
  const steps = [];
  for (const current of currents.filter(Boolean)) {
    // The lane's index within its repository: `current-memoro.json` is lane 0
    // and `current-memoro-1.json` lane 1 (`paths.currentFor`, run.js), so a
    // second lane on the same repository is a second step and not a second
    // reading of the first.
    const lane = Number.isInteger(current.lane) && current.lane > 0 ? current.lane : 0;
    const file = current.repo ? `current-${current.repo}${lane ? `-${lane}` : ''}.json` : 'current.json';
    if (!alive(current.pid)) { stale.push(`${file} (pid ${current.pid} is gone)`); continue; }
    // Nothing is killed on elapsed time (ruling 18), so the clock has no
    // end to be over: it has the check-in interval and how many check-ins
    // the session has had. A codex session has neither.
    const interval = Number(current.check_in_minutes);
    const checkInSeconds = Number.isFinite(interval) && interval > 0 ? interval * 60 : null;
    const checkIns = Number(current.check_ins);
    const elapsed = since(current.started);
    // The session's kind in today's words — `plan`, `build`, `review` — and,
    // for a build or a review, what of: a project or a goal. A lane file from
    // before says `step` or `goal`, and is read as the build it was.
    const named = sessionKind(current.kind, current.variant);
    const goal = /^goal:(.+)$/u.exec(String(current.name || ''))?.[1] ?? null;
    steps.push({
      name: current.name || null,
      kind: named?.kind ?? (current.kind || null),
      // A plan session has no variant; a file with no kind it knows is a
      // goal's when its name says so.
      variant: named ? named.variant : (goal ? 'goal' : null),
      // `mc/<goal>` for a session on a goal, null for a project's.
      goal,
      // The programme the lane file names (run.js writes it); the page falls
      // back to the goal's name or the project's plan for a file from before.
      programme: current.programme || null,
      repo: current.repo || null,
      lane,
      tool: current.tool || null,
      model: current.model || null,
      effort: current.effort || null,
      advisor: current.advisor || null,
      billing: current.billing || null,
      worktree: current.worktree || null,
      pid: current.pid ?? null,
      started: current.started || null,
      elapsed_seconds: elapsed,
      check_in_seconds: checkInSeconds,
      check_ins: checkInSeconds == null ? null : (Number.isInteger(checkIns) && checkIns > 0 ? checkIns : 0),
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
    disk: disk?.line ? disk : null,
    memory: memory?.line ? memory : null,
  };
}

/* ------------------------------------------------------------------- areas */

/**
 * The runner's areas that hold a checkout of a repository mc knows — under
 * `~/mc/step/`, and the ones from before it directly under `~/mc`
 * (`listStepAreas`, work-area.js) — each with its project name, its path and
 * the repositories it holds.
 *
 * A folder without `memoro/` or `memoro-cli/` in it is not a workarea and is
 * never listed: `bin/`, `brief/`, `inbox/`, `intake/`,
 * `runner/`, `status/` and the two role homes are mc's own filing. They were
 * off the page already, but by accident — nothing under them happens to hold
 * a `.git` — and a repository mirror dropped into one would have put mc's own
 * bookkeeping on the board as work.
 */
export function areasWithCheckout(root, repoNames = REPO_NAMES) {
  return listStepAreas({ root, repoNames });
}
