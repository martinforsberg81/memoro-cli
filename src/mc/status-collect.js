/**
 * `mc status` — the one page Martin looks at, built from files the runner
 * and the sessions already write. No model, nothing written, nothing
 * started.
 *
 * Five blocks: NOW (the runner's pid, the step in flight with its tool,
 * model and elapsed against budget, a pending STOP, quota answers today),
 * RUNNER (alive? queue and the next project with its kind;
 * the last 24 h by kind and outcome; an estimated list-price cost),
 * DECISIONS (files without a `**Beslut:**` line), PROJECTS per repository
 * (programme → project: status, next, last step, open PR, workarea),
 * WORKAREAS WITHOUT A PROJECT (the closure candidates).
 *
 * The readers are shared with `mc brief --collect` (brief-collect.js); the
 * builders here take the read data and are tested on fixtures, with no git
 * and no gh.
 */
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DAY_MS, defaultRepos, listPlans, queueNames, runsSince, scanDecisions, summariseRuns,
} from './brief-collect.js';
import { workRoot } from './paths.js';
import { chooseKind } from './run-plan.js';
import { PRICES_DATED, estimateCost } from './prices.js';

/** What the runner ran everything on; runs.tsv carries no model column yet. */
export const RUNNER_MODEL = 'opus';

/* ------------------------------------------------------------------ runner */

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

export function runnerBlock({ queue, plans, decisions, rows, alive, live = [] }) {
  const items = queue.map((name) => ({ name, kind: kindFor(name, { plans }), live: live.includes(name) }));
  const next = items.find((item) => !item.kind.startsWith('skip') && !item.live) || null;
  const summary = summariseRuns(rows);
  const tokens = rows.reduce((acc, r) => ({
    input: acc.input + (Number(r.input) || 0),
    output: acc.output + (Number(r.output) || 0),
    cacheRead: acc.cacheRead + (Number(r.cache_read) || 0),
    cacheWrite: acc.cacheWrite + (Number(r.cache_write) || 0),
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const cost = estimateCost(tokens, RUNNER_MODEL);
  return { alive, queue: items, next, summary, tokens, cost, model: RUNNER_MODEL, prices_dated: PRICES_DATED };
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
 * NOW — what is happening this second, from the two files `mc run` keeps
 * and the STOP file anyone can touch.
 *
 * A file whose pid is dead is a crashed runner, not a running one: it is
 * reported as stale and counts as nothing running. `runs.tsv` cannot answer
 * any of this — its row is appended after the step is over.
 */
export function nowBlock({ runner = null, current = null, stop = false, rows = [], now = new Date(), alive = pidAlive }) {
  const stale = [];
  const runnerLive = runner ? alive(runner.pid) : false;
  if (runner && !runnerLive) stale.push(`runner.json (pid ${runner.pid} is gone)`);
  const stepLive = current ? alive(current.pid) : false;
  if (current && !stepLive) stale.push(`current.json (pid ${current.pid} is gone)`);

  const since = (iso) => {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : Math.max(0, Math.round((now.getTime() - t) / 1000));
  };
  const budget = Number(current?.budget_minutes);
  const budgetSeconds = Number.isFinite(budget) && budget > 0 ? budget * 60 : null;
  const elapsed = current ? since(current.started) : null;
  const step = stepLive ? {
    name: current.name || null,
    kind: current.kind || null,
    tool: current.tool || null,
    model: current.model || null,
    worktree: current.worktree || null,
    pid: current.pid ?? null,
    started: current.started || null,
    elapsed_seconds: elapsed,
    budget_seconds: budgetSeconds,
    over_budget: elapsed != null && budgetSeconds != null && elapsed > budgetSeconds,
  } : null;

  const quotaRows = rows.filter((row) => String(row.note || '').includes('quota'));
  return {
    runner: runner ? { pid: runner.pid ?? null, started: runner.started || null, alive: runnerLive, up_seconds: since(runner.started) } : null,
    step,
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

/* ---------------------------------------------------------------- projects */

/**
 * One row per PLAN.md on origin/main, grouped by repository and programme,
 * with the last runner step, the open PR on the workarea branch and whether
 * a workarea exists.
 */
export function projectsBlock({ plans, rows, openPrs = [], workareas = [] }) {
  const lastRun = {};
  for (const r of rows) lastRun[r.name] = r; // rows are in time order; the last wins
  const byRepo = {};
  for (const p of plans) {
    const pr = openPrs.find((item) => item.repo === p.repo && item.headRefName === p.project) || null;
    const row = {
      programme: p.programme,
      project: p.project,
      status: p.status || '?',
      next: p.next || '',
      last: lastRun[p.project] ? { ts: lastRun[p.project].ts, kind: lastRun[p.project].kind, pr: lastRun[p.project].pr, note: lastRun[p.project].note } : null,
      pr: pr ? pr.number : null,
      workarea: workareas.includes(p.project),
    };
    (byRepo[p.repo] ||= []).push(row);
  }
  for (const list of Object.values(byRepo)) list.sort((a, b) => a.programme.localeCompare(b.programme) || a.project.localeCompare(b.project));
  return byRepo;
}

/** Areas with a checkout inside but no PLAN.md anywhere on main. */
export function orphanWorkareas({ workareas, plans }) {
  const known = new Set(plans.map((p) => p.project));
  return workareas.filter((name) => !known.has(name));
}

/* ------------------------------------------------------------------ render */

const fmt = (n) => Number(n).toLocaleString('en-US');
const clip = (text, max) => {
  const one = String(text || '').replace(/\s+/gu, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};
const when = (ts) => String(ts || '').replace(/^\d{4}-/u, '').replace(/:\d{2}Z$/u, 'Z').replace('T', ' ');

const duration = (seconds) => {
  if (seconds == null) return '?';
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes <= 180 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`;
};

export function renderStatus({ now = null, runner, decisions, projects, orphans, notes = [] }) {
  const out = [];
  const s = runner.summary;
  if (now) {
    out.push('NOW');
    out.push(`  runner: ${now.runner?.alive ? `pid ${now.runner.pid}, up ${duration(now.runner.up_seconds)}` : 'not running'}`);
    if (now.step) {
      const budget = now.step.budget_seconds == null ? '' : ` of ${duration(now.step.budget_seconds)}`;
      out.push(`  step: ${now.step.name} — ${now.step.kind} (${now.step.tool} ${now.step.model}) ${duration(now.step.elapsed_seconds)}${budget}${now.step.over_budget ? ' — over budget' : ''}`);
    } else out.push('  step: none in flight');
    if (now.stop) out.push('  STOP requested — the runner exits after the step it is in');
    if (now.quota.count) out.push(`  quota: ${now.quota.count} answer(s) in the last 24 h (last ${when(now.quota.last)})`);
    for (const line of now.stale) out.push(`  stale: ${line}`);
    out.push('');
  }
  out.push('RUNNER');
  out.push(`  ${runner.alive ? `running (${runner.alive})` : 'not running'}`);
  const next = runner.next ? `${runner.next.name} (${runner.next.kind})` : 'nothing runnable';
  out.push(`  queue: ${runner.queue.length} projects — next: ${next}`);
  const skipped = runner.queue.filter((q) => q.kind.startsWith('skip') || q.live);
  if (skipped.length) out.push(`  skipped: ${skipped.map((q) => `${q.name} (${q.live ? 'live' : q.kind.slice(5)})`).join(', ')}`);
  const kinds = Object.entries(s.kinds).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
  out.push(`  last 24 h: ${s.steps} steps (${kinds}) — merged ${s.merged}, left open ${s.open}, failed ${s.failed}, timed out ${s.timeout}`);
  const cost = runner.cost == null ? 'n/a' : `$${runner.cost.toFixed(2)}`;
  out.push(`  tokens: cache_read ${fmt(runner.tokens.cacheRead)}, input ${fmt(runner.tokens.input)}, output ${fmt(runner.tokens.output)}`);
  out.push(`  ≈ ${cost} list (${runner.model}, prices ${runner.prices_dated}); quota is the real limit — /status`);
  out.push('');

  out.push('DECISIONS');
  if (!decisions.length) out.push('  none waiting');
  for (const d of decisions) out.push(`  ${d.file}  ${clip(d.title, 60)}  → ${d.waits_on}`);
  out.push('');

  out.push('PROJECTS');
  for (const [repo, rows] of Object.entries(projects)) {
    out.push(`  ${repo}`);
    let programme = null;
    for (const r of rows) {
      if (r.programme !== programme) { programme = r.programme; out.push(`    ${programme}`); }
      const last = r.last ? `${when(r.last.ts)} ${r.last.kind}${r.last.pr && r.last.pr !== '-' ? ` #${r.last.pr}` : ''}` : '—';
      const pr = r.pr ? `PR #${r.pr}` : '';
      const area = r.workarea ? '' : 'no workarea';
      const tail = [last, pr, area].filter(Boolean).join(' · ');
      out.push(`      ${r.project.padEnd(34)} ${r.status.padEnd(17)} ${clip(r.next, 70)}`);
      out.push(`      ${''.padEnd(34)} ${tail}`);
    }
  }
  if (!Object.keys(projects).length) out.push('  no PLAN.md on origin/main');
  out.push('');

  out.push('WORKAREAS WITHOUT A PROJECT');
  if (!orphans.length) out.push('  none');
  else out.push(`  ${orphans.join(', ')}`);
  for (const note of notes) out.push('', `note: ${note}`);
  return `${out.join('\n')}\n`;
}

/* ----------------------------------------------------------------- collect */

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

function liveAreas(run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' })) {
  const r = run('tmux', ['ls', '-F', '#S']);
  if (r.status !== 0) return [];
  return r.stdout.split('\n').filter((s) => s.startsWith('mc-')).map((s) => s.slice(3));
}

/** Areas under the work root that hold at least one checkout. */
export function areasWithCheckout(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .filter((name) => {
        try { return readdirSync(join(root, name)).some((sub) => existsSync(join(root, name, sub, '.git'))); } catch { return false; }
      })
      .sort();
  } catch { return []; }
}

export async function collectStatus({
  env = process.env,
  now = new Date(),
  repos = defaultRepos(env),
  offline = false,
  git = runGit,
  run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }),
  exec = execAsync,
  alive = pidAlive,
} = {}) {
  const root = workRoot(env);
  const notes = [];
  const present = repos.filter((repo) => existsSync(join(repo.path, '.git')));
  const openPrs = [];
  if (!offline) {
    // Fetch and gh per repository, side by side: serial they were the
    // whole 5 s budget on their own.
    await Promise.all(present.flatMap((repo) => [
      exec('git', ['-C', repo.path, 'fetch', '-q', 'origin']).then((r) => { if (!r.ok) notes.push(`${repo.name}: git fetch failed — plans may be stale`); }),
      exec('gh', ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,headRefName'], { cwd: repo.path }).then((r) => {
        try {
          if (r.ok) openPrs.push(...JSON.parse(r.stdout).map((pr) => ({ repo: repo.name, ...pr })));
          else notes.push(`${repo.name}: gh pr list failed`);
        } catch { notes.push(`${repo.name}: gh pr list unreadable`); }
      }),
    ]));
  }
  const plans = present.flatMap((repo) => listPlans(repo, { git }));
  const decisions = scanDecisions(root);
  let tsv = '';
  try { tsv = readFileSync(join(root, 'runner', 'log', 'runs.tsv'), 'utf8'); } catch { notes.push('no runner/log/runs.tsv'); }
  const rows = runsSince(tsv, new Date(now.getTime() - DAY_MS));
  let queue = [];
  try { queue = queueNames(readFileSync(join(root, 'queue.md'), 'utf8')); } catch { notes.push('no queue.md'); }
  const workareas = areasWithCheckout(root);
  const nowState = nowBlock({
    runner: readJson(join(root, 'runner', 'runner.json')),
    current: readJson(join(root, 'runner', 'current.json')),
    stop: existsSync(join(root, 'runner', 'STOP')),
    rows,
    now,
    alive,
  });
  const runner = runnerBlock({
    queue, plans, decisions, rows,
    alive: nowState.runner?.alive ? `pid ${nowState.runner.pid}` : null,
    live: liveAreas(run),
  });
  return {
    now: nowState,
    runner,
    decisions: decisionsBlock(decisions),
    projects: projectsBlock({ plans, rows, openPrs, workareas }),
    orphans: orphanWorkareas({ workareas, plans }),
    notes,
  };
}
