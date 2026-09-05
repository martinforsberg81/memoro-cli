/**
 * `mc status <name>` — one project on one page: what its plan says right
 * now, the last
 * three runner steps, and the open PR on its branch.
 *
 * The plan is read from the workarea's working tree when there is one, and
 * from origin/main otherwise, because the workarea copy is the newer of the
 * two whenever a session has written a step and the PR is not merged yet;
 * when they differ the page says so rather than choosing silently.
 *
 * The status row says the pair: what the plan is in, and — when this machine
 * has something to say about it — whether the runner could start it at all
 * (`machineState`, status-collect.js). The plan half is read as above; the
 * machine half is asked of the plan on `origin/main`, because that is the copy
 * the round reads.
 *
 * Like the page (status-collect.js): no model, nothing written, nothing
 * started. The builders are pure so the test can feed them fixtures.
 */
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { defaultRepos, runsFor } from './brief-collect.js';
import { heldPath, parseHeld } from './held.js';
import { planSummary, readPlanText } from './plan-schema.js';
import { workRoot } from './paths.js';
import { PR_LIST_ARGS, openPrsFor } from './project-prs.js';
import { machineDetail, machineState } from './status-collect.js';

/* ---------------------------------------------------------------- builders */

/**
 * The frontmatter as label rows. `next` is not among them: it is a
 * paragraph, long enough on a live plan to push everything else off the
 * screen, so the page gives it a block of its own.
 */
/**
 * The rows above the fold: what state the project is in, and anything wrong
 * with the file. A plan used to answer this with its frontmatter, which could
 * say `ready` while saying nothing a session could act on; the status is read
 * off the steps now, and a plan that does not parse says so here rather than at
 * three in the morning when the runner refuses it.
 *
 * The status row carries both halves, because a person reads one row and acts:
 * `ready · #614 is held before merge after a repair` is the answer, and
 * `ready` on a row of its own with the machine's answer under it is a row that
 * invites them to stop at the first one. On 2026-09-05 that is exactly what
 * this printed — `ready`, for two projects the runner could not have started.
 */
export function fieldRows(plan, problems = [], machine = null, home = homedir()) {
  const rows = [];
  if (plan) {
    const status = planSummary(plan).status;
    const note = machineNote(machine, status, home);
    rows.push(['status', note ? `${status} · ${note}` : status]);
  }
  for (const problem of problems) rows.push(['problem', problem]);
  return rows;
}

/**
 * What the machine adds to the plan's own word, or null when it adds nothing.
 *
 * Three cases and no others. A refusal the plan already says — `blocked`,
 * `done` — is dropped, because the row would then read `blocked · blocked`;
 * a refusal the plan does not say is the whole point and is spelled out. And
 * `runnable` is silent except for one repair owed, which is the runner's next
 * move here being a repair rather than the step the plan names.
 *
 * The silent case is the one that must stay silent: most projects have nothing
 * in the way, and a row that grew a clause for every one of them would be
 * noise nobody reads the day it matters.
 */
export function machineNote(machine, status, home = homedir()) {
  if (!machine) return null;
  if (machine.runnable) return machine.kind === 'repair' ? sentence(machine, home) : null;
  if (machine.reason === status) return null;
  return sentence(machine, home);
}

/** The machine's own sentence (status-collect.js), with the date after it. */
function sentence(machine, home) {
  const short = machineDetail(machine, home);
  return machine.since ? `${short} (since ${when(machine.since)})` : short;
}

/** One line per step: where the project got to, and where it stopped. */
export function stepRows(plan) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const mark = { done: '✓', ready: '▸', blocked: '■' };
  return steps.map((step, index) => {
    const waiting = step.blocked_by ? ` on ${step.blocked_by.kind} ${step.blocked_by.name}` : '';
    const state = step.status === 'done'
      ? (step.pr ? `#${step.pr}` : 'done')
      : `${step.status}${waiting}`;
    return `  ${mark[step.status] || '·'} ${String(index + 1).padStart(2)}  ${clip(step.title, 52).padEnd(53)} ${state}`;
  });
}

/* ------------------------------------------------------------------ render */

const when = (ts) => String(ts || '').replace(/^\d{4}-/u, '').replace(/:\d{2}Z$/u, 'Z').replace('T', ' ');
const clip = (text, max) => {
  const one = String(text || '').replace(/\s+/gu, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** Fold a paragraph to `width`, every line but the first indented by `pad`. */
export function wrap(text, width, pad) {
  const words = String(text || '').replace(/\s+/gu, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line && `${line} ${word}`.length > width) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.map((one, i) => (i === 0 ? one : `${' '.repeat(pad)}${one}`)).join('\n');
}

export function renderProject({
  name, repo, programme, path, source, unmerged, plan, problems = [], workarea, runs, prs, machine = null, notes = [],
}) {
  const out = [];
  out.push(`${name} — ${[repo, programme].filter(Boolean).join(' · ') || 'no repository'}`);
  const label = 11;
  const indent = 2 + label + 1;
  const row = (key, value) => out.push(`  ${key.padEnd(label)} ${wrap(value, 92 - indent, indent)}`);
  if (path) row('plan', `${path} (${source}${unmerged ? ', differs from origin/main' : ''})`);
  row('workarea', tilde(workarea) || 'none');
  for (const [key, value] of fieldRows(plan, problems, machine)) row(key, value);
  if (!path) out.push('  no plan — this is a workarea without a project');
  out.push('');

  if (path) {
    out.push('NEXT');
    out.push(`  ${wrap(plan ? planSummary(plan).next : 'the plan does not parse — nothing can be handed out', 90, 2)}`);
    out.push('');

    const steps = stepRows(plan);
    if (steps.length) {
      out.push('STEPS');
      out.push(...steps);
      out.push('');
    }
  }


  out.push('LAST RUNS');
  if (!runs.length) out.push('  none in the runner log');
  for (const r of runs) {
    const pr = r.pr && r.pr !== '-' ? `#${r.pr}` : '—';
    out.push(`  ${when(r.ts)}  ${String(r.kind).padEnd(9)} ${String(`${r.seconds}s`).padStart(6)}  ${pr.padEnd(7)} ${r.note}`);
  }
  out.push('');

  out.push('OPEN PR');
  if (!prs.length) out.push('  none for this project');
  for (const pr of prs) out.push(`  #${pr.number}  ${clip(pr.title, 70)}${pr.headRefName ? `  (${pr.headRefName})` : ''}`);
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

/** The `docs/project/<programme>/<name>/PLAN.json` inside a workarea checkout. */
export function findWorkareaPlan(dir, name) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return null; }
  for (const entry of entries) {
    const root = join(dir, entry.name);
    if (!existsSync(join(root, '.git'))) continue;
    let programmes = [];
    try { programmes = readdirSync(join(root, 'docs', 'project')); } catch { continue; }
    for (const programme of programmes) {
      const path = `docs/project/${programme}/${name}/PLAN.json`;
      if (existsSync(join(root, path))) return { repo: entry.name, programme, path, file: join(root, path) };
    }
  }
  return null;
}

/** Every project with a plan in an `ls-tree` of `docs/project` on origin/main. */
function names(tree) {
  return (tree || '').split('\n')
    .map((p) => p.split('/'))
    .filter((parts) => parts.length === 5 && parts[4] === 'PLAN.json')
    .map((parts) => parts[3]);
}

/** The plan on origin/main, if the project has one there. */
export function findMainPlan(repos, name, { git = runGit } = {}) {
  for (const repo of repos) {
    if (!existsSync(join(repo.path, '.git'))) continue;
    const tree = git(repo.path, ['ls-tree', '-r', '--name-only', 'origin/main', '--', 'docs/project']);
    if (tree == null) continue;
    const path = tree.split('\n').find((p) => {
      const parts = p.split('/');
      return parts.length === 5 && parts[3] === name && parts[4] === 'PLAN.json';
    });
    if (path) {
      return {
        repo: repo.name,
        path: repo.path,
        programme: path.split('/')[2],
        plan: path,
        text: git(repo.path, ['show', `origin/main:${path}`]) || '',
        // Every project of this repository, because a pull request is matched
        // to a project by the longest name its branch begins with — without
        // the siblings, `mc-cut-2` would read as `mc`'s (project-prs.js).
        names: names(tree),
      };
    }
  }
  return null;
}

/**
 * Everything `mc status <name>` prints, or null when nothing under the work
 * root and neither repository knows the name.
 */
export async function collectProject(name, {
  env = process.env,
  repos = defaultRepos(env),
  offline = false,
  git = runGit,
  exec = execAsync,
  read = (path) => readFileSync(path, 'utf8'),
} = {}) {
  const root = workRoot(env);
  const notes = [];
  const present = repos.filter((repo) => existsSync(join(repo.path, '.git')));
  if (!offline) {
    await Promise.all(present.map((repo) => exec('git', ['-C', repo.path, 'fetch', '-q', 'origin'])
      .then((r) => { if (!r.ok) notes.push(`${repo.name}: git fetch failed — origin/main may be stale`); })));
  }

  const dir = join(root, name);
  const workarea = existsSync(dir) ? dir : null;
  const local = workarea ? findWorkareaPlan(dir, name) : null;
  const main = findMainPlan(present, name, { git });
  if (!local && !main && !workarea) return null;

  let localPlan = null;
  if (local) {
    try { localPlan = readPlanText(read(local.file)); } catch { notes.push(`${local.path}: unreadable in the workarea`); }
  }
  const mainPlan = main ? readPlanText(main.text) : null;
  const chosen = localPlan || mainPlan || { plan: null, problems: [] };
  const plan = chosen.plan;
  const problems = chosen.problems;
  const source = localPlan ? `workarea ${local.repo}` : 'origin/main';
  const unmerged = Boolean(localPlan?.plan && mainPlan?.plan
    && JSON.stringify(localPlan.plan) !== JSON.stringify(mainPlan.plan));
  const repo = main?.repo || local?.repo || null;
  const programme = main?.programme || local?.programme || null;

  let tsv = '';
  try { tsv = read(join(root, 'runner', 'log', 'runs.tsv')); } catch { notes.push('no runner/log/runs.tsv'); }

  // The project's open pull requests, not its branch's: a project's work sits
  // on `<name>` or on `<name>-<n>`, and asking `--head <name>` printed nothing
  // for a project whose three branches all had one open (2026-09-02).
  const prs = [];
  const repoPath = main?.path || (local ? join(dir, local.repo) : present[0]?.path);
  // What GitHub was not asked is not the same as nothing being open, and the
  // reading below refuses to guess: `--offline` and a failed `gh` both leave
  // the repository unknown, which is a refusal of its own.
  let asked = [];
  let prsFailed = repo ? [repo] : [];
  if (!offline && repoPath) {
    const r = await exec('gh', PR_LIST_ARGS, { cwd: repoPath });
    try {
      if (r.ok) {
        asked = JSON.parse(r.stdout || '[]');
        prsFailed = [];
        prs.push(...openPrsFor({ prs: asked, name, names: main?.names || [name] }));
      } else notes.push('gh pr list failed');
    } catch { notes.push('gh pr list unreadable'); }
  }

  // The other half of the pair: would the runner start this now. Asked of the
  // plan on origin/main, because that is the copy the round reads, and of the
  // files this machine keeps — held.json, the STOP file, the worktree.
  const machine = machineState(name, {
    plans: mainPlansFor(name, main, mainPlan),
    prs: asked,
    prsFailed,
    held: readHeld(root, read),
    stop: existsSync(join(root, 'runner', 'STOP')),
    root,
    // `git` here answers with a string or null; the reading wants ok and text.
    git: (cwd, args) => { const out = git(cwd, args); return { ok: out != null, stdout: out ?? '' }; },
  });

  return {
    name,
    repo,
    programme,
    path: local?.path || main?.plan || null,
    source,
    unmerged,
    plan,
    problems,
    workarea,
    runs: runsFor(tsv, name, 3),
    prs,
    machine,
    notes,
  };
}

/**
 * The plans the reading is given: this project's, off `origin/main`, and the
 * bare names of its siblings.
 *
 * The siblings carry no plan and are there for one reason — a pull request is
 * matched to a project by the longest name its branch begins with, so without
 * them `mc-cut-2` reads as `mc`'s (project-prs.js) and a project would be
 * called in flight on somebody else's work.
 */
function mainPlansFor(name, main, mainPlan) {
  if (!main) return [];
  return [
    {
      repo: main.repo,
      programme: main.programme,
      project: name,
      path: main.plan,
      legacy: false,
      plan: mainPlan?.plan ?? null,
      problems: mainPlan?.problems ?? [],
    },
    ...(main.names || []).filter((other) => other !== name).map((other) => ({ project: other, repo: main.repo })),
  ];
}

/** `~/mc/runner/held.json` as the runner reads it: unreadable means empty. */
function readHeld(root, read) {
  try { return parseHeld(read(heldPath(root))); } catch { return []; }
}

/** `~/mc/x` reads better than the absolute path on a page a person reads. */
export function tilde(path, home = homedir()) {
  return path && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}
