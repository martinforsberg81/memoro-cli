/**
 * The page — the five sections `mc` prints, gathered from files the runner,
 * the helper and the sessions already write. No model, nothing started; the
 * only writes are the two read-through caches in page-cache.js.
 *
 * NOW      — the steps in flight, one per lane, a pending STOP, the live
 *            tmux areas, the foreground verbs, and the day behind it.
 * NEXT     — the order `mc run` would take (`assembleQueue`), one block per
 *            lane and three deep: what each lane starts now, how much of the
 *            walk is runnable, and what is skipped, counted by reason.
 * DECISIONS— how many wait on Martin, and the first few by name.
 * INTAKE   — the helper's newest digest, what is new in it, the `!` lines
 *            themselves, and how many proposals nobody has queued or dropped.
 * PROJECTS — one numbered row per project on `origin/main`, grouped by
 *            repository and sorted repo, programme, project: the plan's
 *            status, how many of its steps are done, `next`, the open PR, and
 *            whether it has a workarea at all. The number is the one the menu
 *            opens. The workareas that no project explains come last, under a
 *            heading of their own — nothing removes them, and what they are
 *            judged by is how much is uncommitted and when they were last
 *            committed to.
 *
 * The builders are pure: each takes read data and returns the section, so the
 * tests feed them fixtures and never touch git, gh or tmux. `collectPage` is
 * the only part that touches the machine, and `renderPage` (page-render.js)
 * is the only part that knows how it looks.
 *
 * The readers are shared: `nowBlock`, `kindFor`,
 * `areasWithCheckout` and `pidAlive` come from status-collect.js, the plan and
 * runs.tsv parsers from brief-collect.js, the digest's shape from
 * helper-collect.js.
 */
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  DAY_MS, defaultRepos, listProgrammes, runsSince, summariseRuns,
} from './brief-collect.js';
import { lastAttempt, lastDeploy } from './deploys.js';
import { heldEntries, heldPath } from './held.js';
import { HELPER_REPOS, digestDirs, findDigest, proposalsDir } from './helper-collect.js';
import { readLiveVersion } from './live-version.js';
import { ageWords, loadPlans, loadPrs, savePrs } from './page-cache.js';
import { PLAN_HOME, workRoot } from './paths.js';
import { planState } from './plan-schema.js';
import { PRICES_DATED, estimateCost } from './prices.js';
import { PR_LIST_ARGS, openPrsFor } from './project-prs.js';
import { assembleQueue, queueFileNames } from './run-plan.js';
import { staleBlockers } from './stale-blockers.js';
import {
  RUNNER_MODEL, areasWithCheckout, kindFor, machineState, nowBlock, pidAlive, readCurrents,
} from './status-collect.js';

/** How many of each list the page names rather than counts. */
export const LANE_DEEP = 3;
export const DECISIONS_NAMED = 3;
/** How many stale blockers the line names before it only counts them. */
export const STALE_NAMED = 3;

/* ------------------------------------------------------------------ RUNNER */

/**
 * The machine: the runner's steps, one per lane (`nowBlock`), a pending STOP,
 * the lane files whose process is gone, and one line of the day behind it.
 *
 * This was NOW, and NOW held two different kinds of thing at once — the
 * runner's steps and the sessions a person had open, drawn as one list of
 * dots. They answer different questions and are stopped by different things,
 * so they are two sections now: this one is what `mc run` is doing, and
 * `sessionsSection` is who is sitting where.
 *
 * `nowBlock`'s `runner` — the process, not the section — is carried as
 * `process`, because `runner.runner.alive` is a sentence nobody should have to
 * read. The rename is at this boundary only: `nowBlock` is shared with
 * `mc status` and keeps the shape it had.
 */
/**
 * Past this, a deploy that says `running` is a deploy that did not come back.
 *
 * Nothing sweeps `deploys.tsv` and nothing should: the row is what happened,
 * and a deploy whose terminal was closed half-way through wrangler is truly
 * `running` for ever. An hour is well past the longest deploy there is, so past
 * it the row is a question rather than a status.
 */
export const DEPLOY_LATE_S = 60 * 60;

const shortSha = (sha) => (sha ? String(sha).slice(0, 7) : null);

/**
 * What is in production, from the two readings that know: the last `deployed`
 * row of `deploys.tsv` and the `/api/version` the helper last cached.
 *
 * They are drawn together because the interesting case is when they differ.
 * The row says what mc shipped; the version says what is answering requests. A
 * deploy somebody made another way, a deploy that did not take, a wrangler that
 * rolled back — every one of them shows up here as two shas that are not the
 * same, and nothing else on the page would say so.
 *
 * Nothing is fetched: the page is offline and instant, so the version is
 * whatever `mc helper --collect` last wrote (`live-version.js`) and its age is
 * carried so a reader can weigh it. Null when neither source has anything —
 * a machine that has never deployed and never collected has nothing to say
 * about production, and a line saying "unknown" is worse than no line.
 */
export function productionSection({ deploy = null, attempt = null, live = null, now = new Date() } = {}) {
  if (!deploy?.sha && !live) return null;
  const at = now.getTime();
  const age = (iso) => {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : Math.max(0, Math.round((at - t) / 1000));
  };
  const when = deploy ? (deploy.ended || deploy.started || null) : null;

  // The last attempt matters only when it is not the deploy row itself: a
  // deploy in flight, or one that failed after the last good one.
  const same = deploy && attempt && attempt.started === deploy.started && attempt.sha === deploy.sha;
  const since = same ? null : attempt;
  const attemptState = (row) => ({
    sha: row.sha || null,
    short: shortSha(row.sha),
    holder: row.holder || null,
    at: row.ended || row.started || null,
    age_seconds: age(row.ended || row.started),
    stopped_at: row.stopped_at || null,
  });
  const running = since?.outcome === 'running' ? attemptState(since) : null;
  if (running) running.late = running.age_seconds != null && running.age_seconds >= DEPLOY_LATE_S;

  return {
    sha: deploy?.sha || null,
    short: shortSha(deploy?.sha),
    build: deploy?.build || null,
    holder: deploy?.holder || null,
    at: when,
    age_seconds: when ? age(when) : null,
    live,
    // Yellow on the page: what mc last shipped is not what production answers,
    // and no machine here can tell which of the two is the one to believe.
    differs: Boolean(live?.commit && deploy?.sha && live.commit !== deploy.sha),
    running,
    failed: since?.outcome === 'failed' ? attemptState(since) : null,
  };
}

export function runnerSection({
  runner = null, currents = [], stop = false, rows = [],
  deploy = null, attempt = null, live = null,
  now = new Date(), alive = pidAlive,
} = {}) {
  const { runner: process, ...base } = nowBlock({ runner, currents, stop, rows, now, alive });
  const tokens = rows.reduce((acc, r) => ({
    input: acc.input + (Number(r.input) || 0),
    output: acc.output + (Number(r.output) || 0),
    cacheRead: acc.cacheRead + (Number(r.cache_read) || 0),
    cacheWrite: acc.cacheWrite + (Number(r.cache_write) || 0),
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  return {
    ...base,
    process,
    // What is in production, under the day it took to get there.
    production: productionSection({ deploy, attempt, live, now }),
    day: {
      ...summariseRuns(rows),
      tokens,
      cost: estimateCost(tokens, RUNNER_MODEL),
      model: RUNNER_MODEL,
      prices_dated: PRICES_DATED,
    },
  };
}

/* ---------------------------------------------------------------- SESSIONS */

/** The two singleton desks, drawn whether or not anybody is at them. */
export const DESKS = Object.freeze(['helper', 'brief']);

/**
 * Who is sitting where — everything running that the runner did not start.
 *
 * The two desks are singletons and get a fixed row each, drawn open or not:
 * there is one helper and one brief, and *"is the helper running?"* is a
 * question an empty row answers as well as a full one. Everything else is a
 * list, because how many there are is not knowable in advance and their names
 * are the content.
 *
 * The register is `~/mc/runner/foreground/<pid>.json`, written by the verbs
 * that hold a terminal through `foreground.js`. An entry whose pid is not
 * alive is dropped rather than believed: a session killed with its terminal
 * never gets to remove its own file.
 *
 * **Every session carries its age**, which the page used to throw away. The
 * register has written `started` since it existed and nothing read it, so on
 * 2026-09-02 a `mc plan` opened three days earlier was drawn exactly like one
 * opened twenty minutes ago — seven of them, all alive, all looking current.
 * The age is the whole difference between somebody working here and somebody
 * having left this open.
 */
export function sessionsSection({
  foreground = [], live = [], now = new Date(), alive = pidAlive,
} = {}) {
  const at = now.getTime();
  const age = (iso) => {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : Math.max(0, Math.round((at - t) / 1000));
  };
  const open = foreground
    .filter((item) => alive(item.pid))
    .map((item) => ({ ...item, age_seconds: age(item.started) }));

  const desks = {};
  for (const verb of DESKS) desks[verb] = open.find((item) => item.verb === verb) || null;

  // A planning session belongs to its programme, and PROGRAMMES draws it on
  // that programme's own row rather than among the loose sessions — which is
  // the whole reason `mc plan` puts one at `plan/<programme>` (paths.js).
  // Keyed by programme here, so the section that owns programmes never has to
  // know how a session's area is spelled.
  //
  // A `mc plan` from before that change carries a bare project name, belongs
  // to no programme, and cannot be started again. It stays in the list below
  // with everything else nothing explains.
  const planning = {};
  for (const item of open) {
    if (item.verb !== 'plan') continue;
    const [home, programme] = String(item.area || '').split('/');
    if (home === PLAN_HOME && programme) planning[programme] = item;
  }
  const claimed = new Set(Object.values(planning));

  // A tmux window is a session too, and the only kind mc knows nothing else
  // about — no verb, no tool, no model, just a name and how long it has been
  // open. It goes in the same list, so the section is one answer rather than
  // two lists a reader has to add up.
  const windows = live.map((area) => ({
    verb: null,
    area: area.name,
    tmux: `mc-${area.name}`,
    tool: null,
    model: null,
    pid: null,
    age_seconds: area.opened_ms == null ? null : Math.max(0, Math.round((at - area.opened_ms) / 1000)),
  }));

  // Oldest first: the one that has been open longest is the one most likely to
  // have been forgotten, and that is the whole reason the age is on the row.
  const others = [...open.filter((item) => !DESKS.includes(item.verb) && !claimed.has(item)), ...windows]
    .sort((a, b) => (b.age_seconds ?? -1) - (a.age_seconds ?? -1)
      || String(a.area).localeCompare(String(b.area)));

  return {
    desks,
    planning,
    others,
    count: DESKS.filter((verb) => desks[verb]).length + Object.keys(planning).length + others.length,
  };
}

/* -------------------------------------------------------------------- NEXT */

/**
 * The order the runner would actually take: every name with the kind it would
 * be run as, or the reason it would be passed over.
 *
 * It read `~/mc/queue.md` and nothing else until 2026-09-06, so with that file
 * empty the section said *"empty — mc brief queues the next thing"* while the
 * runner was walking 41 projects and running one. `queue.md` is not the queue —
 * it is Martin's *these first*, and it empties itself. The order is
 * `assembleQueue`'s (run-plan.js), which is the runner's own: the file's names
 * that have a non-legacy plan on `main`, then every other such plan
 * alphabetically. The section reads the runner's function rather than repeating
 * its rule, so the page and the round cannot come to disagree about what is
 * next.
 *
 * Lanes are why it is blocks rather than a list: `mc run` drives one lane per
 * repository at the same time (`splitLanes`, run.js), so the head of *each*
 * lane starts now and a flat list would say one of them is second. Three deep
 * per lane is what is coming; past that it is a count, and the whole order is
 * in `items` for `mc --json`.
 *
 * A live area used to be a skip with a reason of its own, because the runner
 * would not start a step where somebody had a session open. It no longer
 * declines for that (`run.js`), so neither does this — a page that predicts a
 * skip the runner will not make is worse than one that says nothing, because
 * it is read as the runner's own answer. What stops a project is what the plan
 * says, and the plan is the only thing counted here.
 *
 * `stale` is the counterweight to `skipped`, and it is the reason this
 * section reads every plan rather than only the queued ones: a step blocked
 * on a project that has finished is not in the queue at all, and the whole
 * fault is that nothing was ever going to put it there
 * (stale-blockers.js). It is drawn from the same `origin/main` plans the
 * runner obeys, and it names rather than only counts, because a count of two
 * does not say which two a person has to go and read.
 *
 * `machine` is the other half of "would the runner start this" — a dirty
 * worktree, a held pull request, work already in flight (`machineState`,
 * status-collect.js). Without it this block counted only what the plans say,
 * and on 2026-09-05 it reported two names runnable while `held.json` held both
 * of them: a count that is a partial answer is read as the whole one. It is
 * injected rather than read here because this module takes read data and
 * `machineState` has to ask a worktree whether it is dirty; a caller with no
 * reader gets the plan-shaped answer alone, exactly as before.
 */
export function nextSection({
  queueText = '', plans = [], held = [], deep = LANE_DEEP, staleNamed = STALE_NAMED,
  machine = () => null,
} = {}) {
  const order = assembleQueue(queueText, plans);
  // What `queue.md` actually put at the front: its own lines, minus the ones
  // `assembleQueue` dropped for having no plan on main. The heading says how
  // many, so an empty file reads as *the order is alphabetical* rather than as
  // an empty queue.
  const queued = new Set(queueFileNames(queueText));
  const byProject = new Map(plans.map((plan) => [plan.project, plan]));

  const items = order.map((name) => {
    const plan = byProject.get(name) || null;
    // The step number and its title come off the plan record (`planSummary`),
    // where they are numbers and a string; the row draws `step 2/5` from them
    // rather than parsing the `next` sentence back apart.
    const base = {
      name,
      repo: plan?.repo || null,
      programme: plan?.programme || null,
      step: plan?.step ?? null,
      steps: plan?.steps ?? null,
      title: plan?.title ?? null,
      queued: queued.has(name),
    };
    const kind = kindFor(name, { plans });
    // The plan first, and no machine reading at all for a name it already
    // refuses: that is `machineState`'s own economy and the reason a round
    // walks 38 projects in a second rather than a minute.
    if (kind.startsWith('skip')) return { ...base, kind, runnable: false, machine: null };
    const state = machine(name) || null;
    if (state && !state.runnable) return { ...base, kind: `skip:${state.reason}`, runnable: false, machine: state };
    // `repair` rather than `step` where a held pull request is owed one: the
    // kind drawn beside the name is what the runner would actually start.
    return { ...base, kind: state?.kind || kind, runnable: true, machine: state };
  });
  const runnable = items.filter((item) => item.runnable);
  const skipped = items.filter((item) => !item.runnable);
  const reasons = {};
  for (const item of skipped) {
    const reason = item.kind.slice('skip:'.length);
    reasons[reason] = (reasons[reason] || 0) + 1;
  }
  const lanes = lanesOf(runnable, deep);
  return {
    // How far the runner's order reaches: every non-legacy plan on `main`,
    // `queue.md`'s names first. Not a depth anybody types — a depth it walks.
    depth: items.length,
    from_queue: order.filter((name) => queued.has(name)).length,
    runnable: runnable.length,
    items,
    lanes,
    more: lanes.reduce((n, lane) => n + lane.more, 0),
    skipped: { count: skipped.length, reasons },
    held: heldSection(held),
    stale: staleSection(plans, staleNamed),
  };
}

/**
 * The runnable names split one lane per repository, each lane in the order the
 * runner would take it and `deep` of them named — `splitLanes`' rule (run.js)
 * over the same list, with the lanes in the order their first name appears.
 */
function lanesOf(runnable, deep) {
  const lanes = [];
  const byRepo = new Map();
  for (const item of runnable) {
    const repo = item.repo || null;
    if (!byRepo.has(repo)) {
      const lane = { repo, count: 0, items: [], more: 0 };
      byRepo.set(repo, lane);
      lanes.push(lane);
    }
    const lane = byRepo.get(repo);
    lane.count += 1;
    if (lane.items.length < deep) lane.items.push(item);
  }
  for (const lane of lanes) lane.more = lane.count - lane.items.length;
  return lanes;
}

/**
 * The pull requests the runner would not land (`~/mc/runner/held.json`),
 * oldest first — the one that has been standing still longest is the one to
 * read.
 *
 * Every entry is carried, not the first few: `mc --json` is read by programs
 * and by the brief, and a held pull request that fell off a display cap is a
 * project standing still that nothing was told about. The page draws what fits
 * and counts the rest (page-render.js), which is where a cap belongs.
 */
function heldSection(held) {
  const items = heldEntries(held)
    .sort((a, b) => String(a.since ?? '').localeCompare(String(b.since ?? '')) || a.pr - b.pr);
  return { count: items.length, items };
}

/** The stale blockers as the line draws them: how many, and the first few. */
function staleSection(plans, named) {
  const items = staleBlockers(plans);
  return { count: items.length, items: items.slice(0, named), more: Math.max(0, items.length - named) };
}

/* ------------------------------------------------------------------ INTAKE */

const NEW_SINCE = /^##\s+New since the last digest\b/iu;

/** How many of the digest's `!` lines the page names rather than counts. */
export const INTAKE_LOUD_NAMED = 3;

/**
 * The bullets under "New since the last digest", as the digest wrote them:
 * `- ! \`<fingerprint>\` — 41× 500 — <message>` for a new fingerprint at or
 * above the threshold or a condition that has just started failing, `- ·` for
 * the rest. The marker is dropped here and kept as `loud`, so the page can
 * draw it in its own way.
 */
export function newErrorLines(text) {
  const lines = String(text || '').replace(/\r\n/gu, '\n').split('\n');
  const at = lines.findIndex((line) => NEW_SINCE.test(line));
  if (at < 0) return { lines: [], first: false };
  const out = [];
  let first = false;
  for (const line of lines.slice(at + 1)) {
    if (/^##\s/u.test(line)) break;
    if (/^_first digest/u.test(line.trim())) { first = true; continue; }
    const bullet = /^-\s+(!|·)?\s*(.*)$/u.exec(line);
    if (!bullet) continue;
    out.push({ loud: bullet[1] === '!', text: bullet[2].trim() });
  }
  return { lines: out, first };
}

/** The bullets under "New since the last digest": how many, and how many loud. */
export function countNewErrors(text) {
  const { lines, first } = newErrorLines(text);
  return { count: lines.length, loud: lines.filter((line) => line.loud).length, first };
}

/**
 * What waits in `~/mc/intake/`: the newest digest with what is new in it, and
 * the proposals nobody has queued or dropped.
 *
 * With no digest the section says so. It never prints a zero — a zero here
 * would read as "production is quiet" when it means "nobody has looked".
 */
export function intakeSection({ digests = [], proposals = [], now = new Date(), named = INTAKE_LOUD_NAMED } = {}) {
  const repos = digests.map((digest) => {
    const { lines, first } = newErrorLines(digest.text);
    const loud = lines.filter((line) => line.loud);
    const age = digest.mtime_ms == null ? null : Math.max(0, Math.round((now.getTime() - digest.mtime_ms) / 1000));
    return {
      repo: digest.repo,
      digest: digest.name,
      // The date is read off the end of the name: `errors-<repo>-<date>.md`
      // does not match a pattern anchored on `errors-` and a digit, which is
      // why the section showed no date at all once the prefix landed.
      date: dateOf(digest.name) || null,
      age_seconds: age,
      new_errors: lines.length,
      loud: loud.length,
      // The `!` lines themselves, not just how many. A count of loud errors is
      // a number somebody has to go and look up; the line is the thing that
      // makes them look. Everything below the first few is a number again.
      loud_lines: loud.slice(0, named).map((line) => line.text),
      more_loud: Math.max(0, loud.length - named),
      first,
    };
  });
  return { repos, digests: repos.length, proposals: proposals.length };
}

/* ---------------------------------------------------------------- PROJECTS */

/** How many workareas with no project the page draws before it counts them. */
export const UNPLANNED_SHOWN = 12;

/**
 * What holds a blocked project: the `blocked_by` of the step that stopped it.
 *
 * The step is the one `planState` picks — the first that is not done, which is
 * the only step the runner considers and therefore the only one the row's
 * `blocked` is about. A later step blocked on something else is not why this
 * project is standing still.
 *
 * Read off the plan rather than out of the `next` sentence: `blocked_by` is a
 * `{ kind, name }` every blocked step carries, and parsing the prose back apart
 * would be a second answer to a question the plan already answers.
 * `stale-blockers.js` walks the same field for its own purpose, and is the
 * precedent for reading it here.
 */
function blockerOf(record) {
  if (record.status !== 'blocked') return null;
  const { step } = planState(record.plan);
  if (step?.status !== 'blocked') return null;
  const by = step.blocked_by;
  return by?.name ? { kind: by.kind || null, name: by.name } : null;
}

/** How many of each plan status a set of projects holds. */
function statusesOf(projects) {
  const out = {};
  for (const project of projects) {
    const key = project.status || 'unknown';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

/**
 * The blockers a set of projects waits on, biggest first — the shape both the
 * programme's collapsed row and the page's one rollup line are drawn from.
 *
 * By name *and* kind, because the two namespaces are different: a `decision`
 * called `plan-review` and a project called `plan-review` would be two
 * different things waiting, and nothing here can merge them.
 */
function blockersOf(projects) {
  const tally = new Map();
  for (const project of projects) {
    const blocker = project.blocked_by;
    if (!blocker) continue;
    const key = `${blocker.kind} ${blocker.name}`;
    const held = tally.get(key) || { kind: blocker.kind, name: blocker.name, count: 0 };
    held.count += 1;
    tally.set(key, held);
  }
  return [...tally.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * What a programme's blocked projects collapse to: how many, the numbers that
 * still open them, and what holds them.
 *
 * `names` is what the renderer leaves out; `numbers` is what it draws instead.
 * Both, rather than one derived from the other, because the numbering runs
 * through every project of every programme and a row that is not drawn is still
 * openable by its number — that is the contract the collapsing is allowed under.
 *
 * A blocked project the runner has a step in flight on keeps its own row: the
 * plan on `origin/main` says blocked, but something is happening to it right
 * now, and that is the one thing a person watching this page wants to see.
 */
function collapsedOf(projects) {
  const blocked = projects.filter((project) => project.status === 'blocked' && !project.running);
  if (!blocked.length) return null;
  return {
    count: blocked.length,
    numbers: blocked.map((project) => project.number),
    names: blocked.map((project) => project.name),
    blockers: blockersOf(blocked),
  };
}

/**
 * One heading per **programme**, its projects under it, sorted programme then
 * project.
 *
 * The grouping was by repository, and a repository is not a unit of work — it
 * is where the code happens to live. A programme is: it is what `mc plan`
 * opens on, what a project belongs to, and the thing several projects add up
 * to. `msr-core` spanning both repositories read as two unrelated blocks under
 * two headings; `mc` and `docx-editing-surface` sat interleaved under one.
 * So the repository moves to a column on the project's own row, where it is a
 * fact about that project rather than the shape of the page.
 *
 * The programme heading carries its **planning session**, open or not — that
 * is the room `mc plan <programme>` fills, and a programme with none is a
 * programme nobody is thinking about right now (Martin, 2026-09-02). A
 * programme is drawn whether or not any of its projects have a plan the runner
 * can read, and a programme that exists *only* as an open planning session is
 * drawn too: it is on its way to having projects, and it would otherwise be
 * the one piece of work the page could not show.
 *
 * A project row's `●` means **the runner has a step in flight on it**, and
 * nothing else. It used to mean a live tmux area — a person sitting in the
 * folder — which made the row say two things at once: where the plan stands,
 * and who is standing nearby. `mc work` and `mc run` know nothing about each
 * other now, and neither do their marks. Sessions are WORK's.
 *
 * The workarea has not stopped mattering — it is where a session runs — so
 * every row says whether the project has one, and the folders that no project
 * explains keep a list of their own underneath. Nothing removes those
 * (close-workarea.js), which is exactly why they are counted where somebody
 * looks; only the first `UNPLANNED_SHOWN` are drawn, because fifty-seven rows
 * would be the page again.
 *
 * Numbering runs through the projects and then the drawn folders, so every row
 * is openable by the number beside it. A project with no workarea is numbered
 * like any other: opening it is what creates the folder.
 *
 * **Every programme carries its own counts, and its blocked projects collapse.**
 * Thirty-three of forty-four projects were `blocked` on 2026-09-06 and the page
 * said so thirty-three times without once saying what would move any of them,
 * though every blocked step carries `blocked_by: { kind, name }`. So a group
 * carries `statuses` — its own `x ready · y blocked` — and `blocked`: how many,
 * which numbers they are, and the blockers holding them, biggest first. The
 * section carries the same rollup over every programme at once, which is the
 * line worth more than all thirty-three red cells: `plan-review` holds twelve
 * of them and `home-on-msr` seven.
 *
 * The rows themselves are all still here. Collapsing is the renderer's, and it
 * is drawing rather than listing: `projects` is every project of the programme
 * whether or not a row is drawn for it, which is what keeps `mc --json` whole
 * and every number openable (`commands/home.js` § `menu`).
 */
export function programmesSection({
  plans = [], areas = [], rows = [], openPrs = [], live = [], detail = () => ({}),
  planning = {}, running = [], programmes = [], shown = UNPLANNED_SHOWN,
} = {}) {
  const lastRun = {};
  for (const row of rows) lastRun[row.name] = row; // rows are in time order; the last wins
  const held = new Set(areas.map((area) => (typeof area === 'string' ? area : area.name)));
  // A project's branches are `<name>` or `<name>-<suffix>`, so the row can say
  // what the project is waiting on rather than only what sits on a branch of
  // its own name: `action-window` had three branches with an open pull request
  // and an empty PR column on 2026-09-02. The siblings are what tell
  // `mc-cut-2` from `mc`'s, so the whole repository's names go in.
  const namesIn = (repo) => plans.filter((p) => p.repo === repo).map((p) => p.project);

  const projects = plans.map((plan) => {
    const name = plan.project;
    const last = lastRun[name] || null;
    const pr = openPrsFor({ prs: openPrs, name, names: namesIn(plan.repo), repo: plan.repo })[0] || null;
    // The steps are on the plan the cache already holds, so how far a project
    // has got costs nothing to say — and "3 of 7" is the one number that turns
    // a list of names into a picture of where the work stands.
    const steps = Array.isArray(plan.plan?.steps) ? plan.plan.steps : [];
    return {
      name,
      repo: plan.repo,
      programme: plan.programme,
      status: plan.status || null,
      next: plan.next || null,
      // What would move it, for a project that is stopped. Null for every other
      // project, and for a blocked plan too old to carry the field.
      blocked_by: blockerOf(plan),
      legacy: Boolean(plan.legacy),
      steps: steps.length ? { done: steps.filter((step) => step?.status === 'done').length, total: steps.length } : null,
      // The runner, and only the runner: a session somebody has open in the
      // folder is WORK's business and not this row's.
      running: running.includes(name),
      workarea: held.has(name),
      last: last ? { ts: last.ts, kind: last.kind, pr: last.pr, note: last.note } : null,
      pr: pr ? pr.number : null,
    };
  });

  projects.sort((a, b) => String(a.programme).localeCompare(String(b.programme))
    || a.name.localeCompare(b.name));

  // The folders no project explains, in the order the old WORK list used: live
  // first — that is where a conversation waits on a person — then by last
  // activity, the later of the folder's own mtime and its last runner step.
  const known = new Set(projects.map((project) => project.name));
  const orphans = areas
    .map((area) => (typeof area === 'string' ? { name: area } : area))
    .filter((area) => !known.has(area.name))
    .map((area) => {
      const last = lastRun[area.name] || null;
      const ran = last ? Date.parse(last.ts) : NaN;
      return {
        name: area.name,
        repo: (area.repos || [])[0] || null,
        live: live.includes(area.name),
        last: last ? { ts: last.ts, kind: last.kind, pr: last.pr, note: last.note } : null,
        activity_ms: Math.max(Number(area.mtime_ms) || 0, Number.isNaN(ran) ? 0 : ran),
      };
    })
    .sort((a, b) => (Number(b.live) - Number(a.live))
      || (b.activity_ms - a.activity_ms)
      || a.name.localeCompare(b.name));

  let number = 0;
  for (const project of projects) { number += 1; project.number = number; }
  const drawn = orphans.slice(0, Math.max(0, shown));
  // `detail` is asked here and nowhere else, of the rows that are actually
  // drawn. It is two `git` calls per folder, and it was being paid for all of
  // them: 81 folders on 2026-08-30, which was 15 s of the page's 8 s — most of
  // it for rows the page then did not print. The cap turned a slow section into
  // a wasteful one, so the reading follows the cap.
  for (const orphan of drawn) { number += 1; orphan.number = number; Object.assign(orphan, detail(orphan.name)); }

  // Every programme that has a project, plus every one that exists only as an
  // open planning session or as a directory on main with nothing runnable
  // under it yet. `programmes` is the tree's own answer (`listProgrammes`),
  // which is what keeps a programme whose projects have all been archived on
  // the page — that is exactly the heading the next piece of its work belongs
  // under.
  const names = [...new Set([
    ...projects.map((project) => project.programme),
    ...Object.keys(planning),
    ...programmes,
  ])].filter(Boolean).sort((a, b) => a.localeCompare(b));

  const groups = names.map((name) => {
    const own = projects.filter((project) => project.programme === name);
    return {
      programme: name,
      projects: own,
      repos: [...new Set(own.map((project) => project.repo))].sort(),
      planning: planning[name] || null,
      // The heading's own answer: how many of this programme's projects are
      // ready and how many are stopped. An empty object is a programme with no
      // project yet, which the heading says in words.
      statuses: statusesOf(own),
      blocked: collapsedOf(own),
    };
  });

  const stopped = projects.filter((project) => project.status === 'blocked');
  const kinds = {};
  for (const project of stopped) {
    const kind = project.blocked_by?.kind;
    if (kind) kinds[kind] = (kinds[kind] || 0) + 1;
  }

  return {
    count: projects.length,
    programmes: groups,
    statuses: statusesOf(projects),
    // Every stopped project at once: how many wait on an answer from Martin,
    // how many on another project, and which blockers hold the most. The page
    // draws it under NEXT, where somebody is looking for what to do.
    blocked: { count: stopped.length, kinds, blockers: blockersOf(stopped) },
    planning: groups.filter((group) => group.planning).length,
    running: projects.filter((project) => project.running).length,
    no_workarea: projects.filter((project) => !project.workarea).length,
    unplanned: { count: orphans.length, shown: drawn, more: Math.max(0, orphans.length - drawn.length) },
  };
}

/**
 * The two facts an unplanned workarea is judged by, asked of git — how much
 * is uncommitted, and when it was last committed to. Asked one folder at a
 * time, of the few the section actually draws: it is two `git` calls each, and
 * paying them for all 81 folders under `~/mc` was 15 s of an 8 s page — most
 * of it for rows nothing printed.
 *
 * Whether the branch's content is already on main is deliberately not here:
 * `git merge-tree` is another process per area, and the page is offline and
 * fast. `mc run` writes that into `~/mc/runner/unplanned-workareas.md` once a
 * round, which is where the question gets answered.
 */
export function readUnplanned(root, areas, git = runGit) {
  const out = {};
  for (const area of areas) {
    const repo = (area.repos || [])[0];
    if (!repo) continue;
    const dir = join(root, area.name, repo);
    const status = git(dir, ['status', '--porcelain']);
    out[area.name] = {
      uncommitted: status == null ? null : status.split('\n').filter(Boolean).length,
      last_commit: git(dir, ['log', '-1', '--format=%cs']) || null,
    };
  }
  return out;
}

/* ----------------------------------------------------------------- readers */

function runGit(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trimEnd() : null;
}

function execAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 8 << 20, ...opts }, (error, stdout) => resolve({ ok: !error, stdout: stdout || '' }));
  });
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/**
 * The tmux sessions that are a workarea, with when each was opened.
 * `#{session_created}` is epoch seconds, which is how long somebody has had
 * this open — the one thing about a live area the page can know for 5 ms.
 */
export function liveAreas(run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' })) {
  const r = run('tmux', ['ls', '-F', '#{session_name} #{session_created}']);
  if (!r || r.status !== 0) return [];
  return r.stdout.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('mc-'))
    .map((line) => {
      const [name, created] = line.split(/\s+/u);
      const at = Number(created) * 1000;
      return { name: name.slice(3), opened_ms: Number.isFinite(at) && at > 0 ? at : null };
    });
}

/** `~/mc/runner/foreground/<pid>.json` — the verbs that registered themselves. */
export function readForeground(dir, read = readJson, list = readdirSync) {
  let names = [];
  try { names = list(dir).filter((name) => name.endsWith('.json')).sort(); } catch { return []; }
  const out = [];
  for (const name of names) {
    const item = read(join(dir, name));
    if (item && item.pid) out.push(item);
  }
  return out;
}

/**
 * Every digest on the machine, one per repository, in `HELPER_REPOS` order.
 *
 * It read one directory and one name shape until 2026-09-05, which stopped
 * being a digest's name when the two-repository digest landed and stopped
 * being a digest's home when the inbox began to drain. Both are `findDigest`'s
 * now, so the page and the delta cannot drift apart again.
 *
 * It returns them all rather than the newest, because the newest silently hid
 * whichever repository was collected first — and memoro-cli's digest is about
 * this machine, which is the one nobody else is watching.
 */
export function readDigests(env) {
  const dirs = digestDirs(env);
  return HELPER_REPOS
    .map((repo) => { const found = findDigest(dirs, { repo }); return found && { repo, ...found }; })
    .filter(Boolean);
}

function dateOf(name) {
  return (/(\d{4}-\d{2}-\d{2})\.md$/u.exec(name) || [])[1] || '';
}

/**
 * The areas under the work root that hold a checkout, each with its mtime and
 * the repositories it holds. `repoNames` is what makes a directory a workarea
 * at all, and defaults to the two mc knows — mc's own folders under `~/mc`
 * hold neither.
 */
export function readAreas(root, repoNames) {
  return areasWithCheckout(root, repoNames).map(({ name, repos }) => {
    let mtime = 0;
    try { mtime = statSync(join(root, name)).mtimeMs; } catch { mtime = 0; }
    return { name, repos, mtime_ms: mtime };
  });
}

/* ----------------------------------------------------------------- collect */

/**
 * Everything the page shows, in one object: one key per section, plus what the
 * caches did and whatever could not be read.
 *
 * Offline is the default and the whole point — plans come from `plans.json`
 * keyed by the `origin/main` sha, open PRs from `prs.json` with their age said
 * out loud. `--fresh` is the opt-in that fetches, asks GitHub and refills both.
 */
export async function collectPage({
  env = process.env,
  now = new Date(),
  repos = defaultRepos(env),
  fresh = false,
  git = runGit,
  run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }),
  exec = execAsync,
  alive = pidAlive,
  cache = { loadPlans, loadPrs, savePrs },
} = {}) {
  const root = workRoot(env);
  const notes = [];
  const present = repos.filter((repo) => existsSync(join(repo.path, '.git')));

  let prs = { prs: [], fetched: null, age_seconds: null };
  // The repositories whose open pull requests are unknown rather than none:
  // what nobody asked and what failed read the same to a list, and the queue
  // reading below would otherwise call a project runnable on that silence.
  const prsFailed = [];
  if (fresh) {
    // Fetch and gh per repository, side by side: serial they were the whole
    // budget on their own.
    const asked = [];
    await Promise.all(present.flatMap((repo) => [
      exec('git', ['-C', repo.path, 'fetch', '-q', 'origin']).then((r) => { if (!r.ok) notes.push(`${repo.name}: git fetch failed — plans may be stale`); }),
      exec('gh', PR_LIST_ARGS, { cwd: repo.path }).then((r) => {
        try {
          if (r.ok) asked.push(...JSON.parse(r.stdout).map((pr) => ({ repo: repo.name, ...pr })));
          else { prsFailed.push(repo.name); notes.push(`${repo.name}: gh pr list failed`); }
        } catch { prsFailed.push(repo.name); notes.push(`${repo.name}: gh pr list unreadable`); }
      }),
    ]));
    prs = cache.savePrs({ root, prs: asked, now });
  } else {
    prs = cache.loadPrs({ root, now });
    if (!prs.fetched) prsFailed.push(...present.map((repo) => repo.name));
    notes.push(prs.fetched
      ? `PRs from cache, ${ageWords(prs.age_seconds)} old — --fresh asks GitHub`
      : 'no PR cache yet — --fresh asks GitHub and fills it');
  }

  const { plans, sources } = cache.loadPlans({ root, repos: present, now, git });
  let tsv = '';
  try { tsv = readFileSync(join(root, 'runner', 'log', 'runs.tsv'), 'utf8'); } catch { notes.push('no runner/log/runs.tsv'); }
  const rows = runsSince(tsv, new Date(now.getTime() - DAY_MS));
  // The file's text, not its names: `assembleQueue` reads it the way the round
  // does, and a second parser here is a second answer waiting to happen.
  let queueText = '';
  try { queueText = readFileSync(join(root, 'queue.md'), 'utf8'); } catch { notes.push('no queue.md'); }

  const live = liveAreas(run);
  const liveNames = live.map((item) => item.name);
  const areas = readAreas(root);

  // PROGRAMMES reads from both of these — which programme has a planning
  // session open, and which projects the runner has a step in flight on — so
  // they are built before it rather than beside it.
  // Read once, for NOW and for the queue reading both: they are the same two
  // facts, and asking twice is how two answers on one page come to differ.
  const stop = existsSync(join(root, 'runner', 'STOP'));
  const held = heldEntries(readJson(heldPath(root)));

  const runner = runnerSection({
    runner: readJson(join(root, 'runner', 'runner.json')),
    currents: readCurrents(join(root, 'runner')),
    stop,
    rows,
    // Three file reads, no network: the record `mc deploy` wrote and the
    // version the helper's last collect cached.
    deploy: lastDeploy(env),
    attempt: lastAttempt(env),
    live: readLiveVersion(env, now),
    now,
    alive,
  });
  const sessions = sessionsSection({
    foreground: readForeground(join(root, 'runner', 'foreground')),
    live,
    now,
    alive,
  });

  return {
    runner,
    sessions,
    next: nextSection({
      queueText,
      plans,
      held,
      machine: (name) => machineState(name, {
        plans,
        prs: prs.prs,
        prsFailed,
        held,
        stop,
        root,
        // `git` answers with a string or null here; the reading wants ok and text.
        git: (cwd, args) => { const out = git(cwd, args); return { ok: out != null, stdout: out ?? '' }; },
      }),
    }),
    intake: intakeSection({ digests: readDigests(env), proposals: proposalFiles(proposalsDir(env)), now }),
    programmes: programmesSection({
      plans, areas, rows, openPrs: prs.prs, live: liveNames,
      planning: sessions.planning,
      running: runner.steps.map((step) => step.name).filter(Boolean),
      programmes: present.flatMap((repo) => listProgrammes(repo)),
      detail: (name) => readUnplanned(root, areas.filter((area) => area.name === name), git)[name] || {},
    }),
    caches: { fresh, plans: sources, prs: { fetched: prs.fetched, age_seconds: prs.age_seconds, count: prs.prs.length } },
    notes,
  };
}

/** The proposal files, by name. A count is all mc does with a proposal. */
function proposalFiles(dir) {
  try { return readdirSync(dir).filter((name) => name.endsWith('.md')).sort(); } catch { return []; }
}
