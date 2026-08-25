/**
 * `mc status` — the one page Martin looks at, built from files the runner
 * and the sessions already write. No model, nothing written, nothing
 * started.
 *
 * Four blocks: RUNNER (alive? queue and the next project with its kind;
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
import { PRICES_DATED, estimateCost } from './prices.js';

/** What the runner ran everything on; runs.tsv carries no model column yet. */
export const RUNNER_MODEL = 'opus';

/* ------------------------------------------------------------------ runner */

/**
 * What the runner would do with a queued name, by the same rules as
 * `~/mc/bin/runner.sh`: no plan → triage; ready → step; waiting-decision →
 * step only once a decision file for the project or its programme carries
 * an answer; anything else is skipped.
 */
export function kindFor(name, { plans, decisions }) {
  const plan = plans.find((p) => p.project === name);
  if (!plan) return 'triage';
  if (plan.status === 'ready') return 'step';
  if (plan.status === 'waiting-decision') {
    const answered = decisions.some((d) => d.answered
      && (d.file.includes(`/decisions/${plan.programme}-`) || d.file.includes(`/decisions/${name}-`) || d.area === name));
    return answered ? 'step' : 'skip:waiting-decision';
  }
  return `skip:${plan.status || 'no-status'}`;
}

export function runnerBlock({ queue, plans, decisions, rows, alive, live = [] }) {
  const items = queue.map((name) => ({ name, kind: kindFor(name, { plans, decisions }), live: live.includes(name) }));
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

export function renderStatus({ runner, decisions, projects, orphans, notes = [] }) {
  const out = [];
  const s = runner.summary;
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

function runnerAlive(run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' })) {
  if (run('tmux', ['has-session', '-t', 'runner']).status === 0) return 'tmux runner';
  const p = run('pgrep', ['-f', 'runner.sh|mc run']);
  if (p.status === 0 && p.stdout.trim()) return `pid ${p.stdout.trim().split('\n')[0]}`;
  return null;
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
  const runner = runnerBlock({ queue, plans, decisions, rows, alive: runnerAlive(run), live: liveAreas(run) });
  return {
    runner,
    decisions: decisionsBlock(decisions),
    projects: projectsBlock({ plans, rows, openPrs, workareas }),
    orphans: orphanWorkareas({ workareas, plans }),
    notes,
  };
}
