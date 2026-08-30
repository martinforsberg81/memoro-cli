/**
 * The page — the five sections `mc` prints, gathered from files the runner,
 * the helper and the sessions already write. No model, nothing started; the
 * only writes are the two read-through caches in page-cache.js.
 *
 * NOW      — the steps in flight, one per lane, a pending STOP, the live
 *            tmux areas, the foreground verbs, and the day behind it.
 * QUEUE    — how deep, how much of it is runnable, what comes next, and what
 *            is skipped, counted by reason.
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
 * The readers are shared: `nowBlock`, `kindFor`, `decisionsBlock`,
 * `areasWithCheckout` and `pidAlive` come from status-collect.js, the plan and
 * runs.tsv parsers from brief-collect.js, the digest's shape from
 * helper-collect.js.
 */
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  DAY_MS, defaultRepos, queueNames, runsSince, scanDecisions, summariseRuns,
} from './brief-collect.js';
import { intakeDir, proposalsDir } from './helper-collect.js';
import { ageWords, loadPlans, loadPrs, savePrs } from './page-cache.js';
import { workRoot } from './paths.js';
import { PRICES_DATED, estimateCost } from './prices.js';
import {
  RUNNER_MODEL, areasWithCheckout, decisionsBlock, kindFor, nowBlock, pidAlive,
} from './status-collect.js';

/** How many of each list the page names rather than counts. */
export const QUEUE_NAMED = 6;
export const DECISIONS_NAMED = 3;

/* --------------------------------------------------------------------- NOW */

/**
 * What is happening this second: the runner's steps, one per lane (nowBlock),
 * the tmux areas
 * somebody is sitting in, the foreground verbs that registered themselves, and
 * one line of the day behind it.
 *
 * The foreground register is `~/mc/runner/foreground/<pid>.json`, written by
 * the verbs that hold a terminal — `mc brief`, `mc plan`, `mc worker`,
 * `mc work <name>` — through `foreground.js`. What it says is what somebody
 * is sitting in front of; what it does not say is that nothing else is. An
 * entry whose pid is not alive is dropped here rather than believed: a
 * session killed with its terminal never gets to remove its own file.
 */
export function nowSection({
  runner = null, currents = [], stop = false, rows = [], live = [], foreground = [],
  now = new Date(), alive = pidAlive,
} = {}) {
  const base = nowBlock({ runner, currents, stop, rows, now, alive });
  const tokens = rows.reduce((acc, r) => ({
    input: acc.input + (Number(r.input) || 0),
    output: acc.output + (Number(r.output) || 0),
    cacheRead: acc.cacheRead + (Number(r.cache_read) || 0),
    cacheWrite: acc.cacheWrite + (Number(r.cache_write) || 0),
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  return {
    ...base,
    live,
    foreground: foreground.filter((item) => alive(item.pid)),
    day: {
      ...summariseRuns(rows),
      tokens,
      cost: estimateCost(tokens, RUNNER_MODEL),
      model: RUNNER_MODEL,
      prices_dated: PRICES_DATED,
    },
  };
}

/* ------------------------------------------------------------------- QUEUE */

/**
 * The queue as the runner would read it: every name with the kind it would be
 * run as, or the reason it would be passed over.
 *
 * A live area is a skip with a reason of its own — the runner will not start a
 * step where somebody is already working — so it is counted beside the plan
 * statuses rather than hidden among them.
 */
export function queueSection({ queue = [], plans = [], live = [], named = QUEUE_NAMED } = {}) {
  const items = queue.map((name) => {
    const kind = kindFor(name, { plans });
    const isLive = live.includes(name);
    return { name, kind, live: isLive, runnable: !kind.startsWith('skip') && !isLive };
  });
  const runnable = items.filter((item) => item.runnable);
  const skipped = items.filter((item) => !item.runnable);
  const reasons = {};
  for (const item of skipped) {
    const reason = item.live ? 'live' : item.kind.slice('skip:'.length);
    reasons[reason] = (reasons[reason] || 0) + 1;
  }
  return {
    depth: items.length,
    runnable: runnable.length,
    items,
    next: runnable.slice(0, named),
    more: Math.max(0, runnable.length - named),
    skipped: { count: skipped.length, reasons },
  };
}

/* --------------------------------------------------------------- DECISIONS */

/** The open questions: how many, and the first few by file. */
export function decisionsSection(decisions = [], { named = DECISIONS_NAMED } = {}) {
  const waiting = decisionsBlock(decisions);
  return { count: waiting.length, first: waiting.slice(0, named), more: Math.max(0, waiting.length - named) };
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
export function intakeSection({ digest = null, proposals = [], now = new Date(), named = INTAKE_LOUD_NAMED } = {}) {
  if (!digest) {
    return {
      digest: null, date: null, age_seconds: null, new_errors: 0, loud: 0, loud_lines: [], more_loud: 0,
      first: false, proposals: proposals.length,
    };
  }
  const { lines, first } = newErrorLines(digest.text);
  const loud = lines.filter((line) => line.loud);
  const age = digest.mtime_ms == null ? null : Math.max(0, Math.round((now.getTime() - digest.mtime_ms) / 1000));
  return {
    digest: digest.name,
    date: (/errors-(\d{4}-\d{2}-\d{2})\.md/u.exec(digest.name) || [])[1] || null,
    age_seconds: age,
    new_errors: lines.length,
    loud: loud.length,
    // The `!` lines themselves, not just how many. A count of loud errors is a
    // number somebody has to go and look up; the line is the thing that makes
    // them look. Everything below the first few is a number again.
    loud_lines: loud.slice(0, named).map((line) => line.text),
    more_loud: Math.max(0, loud.length - named),
    first,
    proposals: proposals.length,
  };
}

/* ---------------------------------------------------------------- PROJECTS */

/** How many workareas with no project the page draws before it counts them. */
export const UNPLANNED_SHOWN = 12;

/**
 * One row per **project**, grouped by repository, sorted repo then programme
 * then project.
 *
 * This was one row per *workarea*, and a workarea is the wrong unit. Measured
 * 2026-08-30: 81 folders under `~/mc`, of which 24 had a plan on main and 57
 * did not — so the page's longest section was mostly a list of things nobody
 * is working on, the 27 real projects were scattered through it, and two were
 * missing altogether because no folder happened to exist for them. A project
 * is what the work *is*: it lives in `PLAN.json` on `origin/main`, it is what
 * the runner steps and what `mc status` opens, and it exists whether or not a
 * folder does.
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
 */
export function projectsSection({
  plans = [], areas = [], rows = [], openPrs = [], live = [], detail = {},
  repoOrder = [], shown = UNPLANNED_SHOWN,
} = {}) {
  const lastRun = {};
  for (const row of rows) lastRun[row.name] = row; // rows are in time order; the last wins
  const held = new Set(areas.map((area) => (typeof area === 'string' ? area : area.name)));

  const projects = plans.map((plan) => {
    const name = plan.project;
    const last = lastRun[name] || null;
    const pr = openPrs.find((item) => item.headRefName === name && item.repo === plan.repo) || null;
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
      legacy: Boolean(plan.legacy),
      steps: steps.length ? { done: steps.filter((step) => step?.status === 'done').length, total: steps.length } : null,
      live: live.includes(name),
      workarea: held.has(name),
      last: last ? { ts: last.ts, kind: last.kind, pr: last.pr, note: last.note } : null,
      pr: pr ? pr.number : null,
    };
  });

  // Martin's order of repositories, not the alphabet: the lane he watches is
  // the one he named first.
  const rank = (repo) => {
    const at = repoOrder.indexOf(repo);
    return at === -1 ? repoOrder.length : at;
  };
  projects.sort((a, b) => rank(a.repo) - rank(b.repo)
    || String(a.repo).localeCompare(String(b.repo))
    || String(a.programme).localeCompare(String(b.programme))
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
        ...(detail[area.name] || {}),
      };
    })
    .sort((a, b) => (Number(b.live) - Number(a.live))
      || (b.activity_ms - a.activity_ms)
      || a.name.localeCompare(b.name));

  let number = 0;
  for (const project of projects) { number += 1; project.number = number; }
  const drawn = orphans.slice(0, Math.max(0, shown));
  for (const orphan of drawn) { number += 1; orphan.number = number; }

  const repos = [];
  for (const project of projects) {
    let group = repos.find((item) => item.repo === project.repo);
    if (!group) { group = { repo: project.repo, projects: [] }; repos.push(group); }
    group.projects.push(project);
  }

  const statuses = {};
  for (const project of projects) {
    const key = project.status || 'unknown';
    statuses[key] = (statuses[key] || 0) + 1;
  }

  return {
    count: projects.length,
    repos,
    statuses,
    live: projects.filter((project) => project.live).length,
    no_workarea: projects.filter((project) => !project.workarea).length,
    unplanned: { count: orphans.length, shown: drawn, more: Math.max(0, orphans.length - drawn.length) },
  };
}

/**
 * The two facts an unplanned workarea is judged by, asked of git — how much
 * is uncommitted, and when it was last committed to. Asked only of the areas
 * with no plan: they are the minority, and the rest have a plan that says
 * everything a row needs.
 *
 * Whether the branch's content is already on main is deliberately not here:
 * `git merge-tree` is another process per area, and the page is offline and
 * fast. `mc run` writes that into `~/mc/intake/unplanned-workareas.md` once a
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
 * `~/mc/runner/current-<repo>.json` — one file per lane, and one lane per
 * repository. They are read by name rather than counted: a lane that is
 * between steps has no file at all, and a lane whose runner died leaves one
 * behind that `nowBlock` reports as stale.
 */
export function readCurrents(dir, read = readJson, list = readdirSync) {
  let names = [];
  try { names = list(dir).filter((name) => /^current-.+\.json$/u.test(name)).sort(); } catch { return []; }
  return names.map((name) => read(join(dir, name))).filter(Boolean);
}

/** The newest `errors-<date>.md` in the intake directory, with its mtime. */
export function readDigest(dir) {
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => /^errors-\d{4}-\d{2}-\d{2}\.md$/u.test(name)).sort();
  } catch { return null; }
  const name = names.at(-1);
  if (!name) return null;
  try {
    return { name, text: readFileSync(join(dir, name), 'utf8'), mtime_ms: statSync(join(dir, name)).mtimeMs };
  } catch { return null; }
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
  if (fresh) {
    // Fetch and gh per repository, side by side: serial they were the whole
    // budget on their own.
    const asked = [];
    await Promise.all(present.flatMap((repo) => [
      exec('git', ['-C', repo.path, 'fetch', '-q', 'origin']).then((r) => { if (!r.ok) notes.push(`${repo.name}: git fetch failed — plans may be stale`); }),
      exec('gh', ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,headRefName'], { cwd: repo.path }).then((r) => {
        try {
          if (r.ok) asked.push(...JSON.parse(r.stdout).map((pr) => ({ repo: repo.name, ...pr })));
          else notes.push(`${repo.name}: gh pr list failed`);
        } catch { notes.push(`${repo.name}: gh pr list unreadable`); }
      }),
    ]));
    prs = cache.savePrs({ root, prs: asked, now });
  } else {
    prs = cache.loadPrs({ root, now });
    notes.push(prs.fetched
      ? `PRs from cache, ${ageWords(prs.age_seconds)} old — --fresh asks GitHub`
      : 'no PR cache yet — --fresh asks GitHub and fills it');
  }

  const { plans, sources } = cache.loadPlans({ root, repos: present, now, git });
  let tsv = '';
  try { tsv = readFileSync(join(root, 'runner', 'log', 'runs.tsv'), 'utf8'); } catch { notes.push('no runner/log/runs.tsv'); }
  const rows = runsSince(tsv, new Date(now.getTime() - DAY_MS));
  let queue = [];
  try { queue = queueNames(readFileSync(join(root, 'queue.md'), 'utf8')); } catch { notes.push('no queue.md'); }

  const live = liveAreas(run);
  const liveNames = live.map((item) => item.name);
  const areas = readAreas(root);
  const planned = new Set(plans.map((plan) => plan.project));
  return {
    now: nowSection({
      runner: readJson(join(root, 'runner', 'runner.json')),
      currents: readCurrents(join(root, 'runner')),
      stop: existsSync(join(root, 'runner', 'STOP')),
      rows,
      live,
      foreground: readForeground(join(root, 'runner', 'foreground')),
      now,
      alive,
    }),
    queue: queueSection({ queue, plans, live: liveNames }),
    decisions: decisionsSection(scanDecisions(root)),
    intake: intakeSection({ digest: readDigest(intakeDir(env)), proposals: proposalFiles(proposalsDir(env)), now }),
    projects: projectsSection({
      plans, areas, rows, openPrs: prs.prs, live: liveNames,
      repoOrder: repos.map((repo) => repo.name),
      detail: readUnplanned(root, areas.filter((area) => !planned.has(area.name)), git),
    }),
    caches: { fresh, plans: sources, prs: { fetched: prs.fetched, age_seconds: prs.age_seconds, count: prs.prs.length } },
    notes,
  };
}

/** The proposal files, by name — the page counts them; `mc brief` reads them. */
function proposalFiles(dir) {
  try { return readdirSync(dir).filter((name) => name.endsWith('.md')).sort(); } catch { return []; }
}
