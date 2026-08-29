/**
 * `mc status <name>` — one project on one page: what its PLAN.md says right
 * now, which decisions belong to it and whether they are answered, the last
 * three runner steps, and the open PR on its branch.
 *
 * The plan is read from the workarea's working tree when there is one, and
 * from origin/main otherwise, because the workarea copy is the newer of the
 * two whenever a session has written a step and the PR is not merged yet;
 * when they differ the page says so rather than choosing silently.
 *
 * Like the page (status-collect.js): no model, nothing written, nothing
 * started. The builders are pure so the test can feed them fixtures.
 */
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { defaultRepos, planFields, runsFor, scanDecisions } from './brief-collect.js';
import { workRoot } from './paths.js';

/* ---------------------------------------------------------------- builders */

/**
 * The decisions that belong to one project: those written in its own
 * workarea, those named for it, and the programme-wide ones — `mc-2.md`,
 * `docx-editing-surface-6.md` — which are the programme's name and a number.
 *
 * `kindFor` in status-collect.js asks a looser question, any file whose name
 * starts with the programme, because it only has to decide whether the
 * runner may take a step and a false yes there costs nothing. Here the
 * looser rule is wrong: under programme `mc` it would hand `mc-status` the
 * decisions of `mc-run` and `mc-brief`, which are their projects' and not
 * this one's.
 */
export function decisionsForProject(decisions, { project, programme }) {
  const programmeWide = programme ? new RegExp(`/decisions/${programme}-\\d+\\.md$`, 'u') : null;
  return decisions.filter((d) => d.area === project
    || d.file.includes(`/decisions/${project}-`)
    || (programmeWide && programmeWide.test(d.file)));
}

/**
 * The frontmatter as label rows. `next` is not among them: it is a
 * paragraph, long enough on a live plan to push everything else off the
 * screen, so the page gives it a block of its own.
 */
export function fieldRows(fields) {
  return Object.entries(fields || {}).filter(([key, value]) => key !== 'next' && value != null);
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
  name, repo, programme, path, source, unmerged, fields, workarea, decisions, runs, prs, notes = [],
}) {
  const out = [];
  out.push(`${name} — ${[repo, programme].filter(Boolean).join(' · ') || 'no repository'}`);
  const label = 11;
  const indent = 2 + label + 1;
  const row = (key, value) => out.push(`  ${key.padEnd(label)} ${wrap(value, 92 - indent, indent)}`);
  if (path) row('plan', `${path} (${source}${unmerged ? ', differs from origin/main' : ''})`);
  row('workarea', tilde(workarea) || 'none');
  for (const [key, value] of fieldRows(fields)) row(key, value);
  if (!path) out.push('  no PLAN.md — this is a workarea without a project');
  out.push('');

  if (path) {
    out.push('NEXT');
    out.push(`  ${wrap(fields?.next || 'nothing — the plan names no next step', 90, 2)}`);
    out.push('');
  }

  out.push('DECISIONS');
  if (!decisions.length) out.push('  none');
  for (const d of decisions) {
    out.push(`  ${d.answered ? 'answered' : 'waiting '}  ${d.file}  ${clip(d.title, 60)}`);
    if (!d.answered && d.recommendation) out.push(`            ${wrap(d.recommendation, 76, 12)}`);
  }
  out.push('');

  out.push('LAST RUNS');
  if (!runs.length) out.push('  none in the runner log');
  for (const r of runs) {
    const pr = r.pr && r.pr !== '-' ? `#${r.pr}` : '—';
    out.push(`  ${when(r.ts)}  ${String(r.kind).padEnd(9)} ${String(`${r.seconds}s`).padStart(6)}  ${pr.padEnd(7)} ${r.note}`);
  }
  out.push('');

  out.push('OPEN PR');
  if (!prs.length) out.push('  none on this branch');
  for (const pr of prs) out.push(`  #${pr.number}  ${clip(pr.title, 70)}`);
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

/** The `docs/project/<programme>/<name>/PLAN.md` inside a workarea checkout. */
export function findWorkareaPlan(dir, name) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return null; }
  for (const entry of entries) {
    const root = join(dir, entry.name);
    if (!existsSync(join(root, '.git'))) continue;
    let programmes = [];
    try { programmes = readdirSync(join(root, 'docs', 'project')); } catch { continue; }
    for (const programme of programmes) {
      const path = `docs/project/${programme}/${name}/PLAN.md`;
      if (existsSync(join(root, path))) return { repo: entry.name, programme, path, file: join(root, path) };
    }
  }
  return null;
}

/** The plan on origin/main, if the project has one there. */
export function findMainPlan(repos, name, { git = runGit } = {}) {
  for (const repo of repos) {
    if (!existsSync(join(repo.path, '.git'))) continue;
    const tree = git(repo.path, ['ls-tree', '-r', '--name-only', 'origin/main', '--', 'docs/project']);
    if (tree == null) continue;
    const path = tree.split('\n').find((p) => {
      const parts = p.split('/');
      return parts.length === 5 && parts[3] === name && parts[4] === 'PLAN.md';
    });
    if (path) return { repo: repo.name, path: repo.path, programme: path.split('/')[2], plan: path, text: git(repo.path, ['show', `origin/main:${path}`]) || '' };
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

  let localFields = null;
  if (local) {
    try { localFields = planFields(read(local.file)); } catch { notes.push(`${local.path}: unreadable in the workarea`); }
  }
  const mainFields = main ? planFields(main.text) : null;
  const fields = localFields || mainFields || {};
  const source = localFields ? `workarea ${local.repo}` : 'origin/main';
  const unmerged = Boolean(localFields && mainFields
    && JSON.stringify(localFields) !== JSON.stringify(mainFields));
  const repo = main?.repo || local?.repo || null;
  const programme = main?.programme || local?.programme || null;

  let tsv = '';
  try { tsv = read(join(root, 'runner', 'log', 'runs.tsv')); } catch { notes.push('no runner/log/runs.tsv'); }

  const prs = [];
  const repoPath = main?.path || (local ? join(dir, local.repo) : present[0]?.path);
  if (!offline && repoPath) {
    const r = await exec('gh', ['pr', 'list', '--state', 'open', '--limit', '100', '--head', name, '--json', 'number,title'], { cwd: repoPath });
    try {
      if (r.ok) prs.push(...JSON.parse(r.stdout));
      else notes.push('gh pr list failed');
    } catch { notes.push('gh pr list unreadable'); }
  }

  return {
    name,
    repo,
    programme,
    path: local?.path || main?.plan || null,
    source,
    unmerged,
    fields,
    workarea,
    decisions: decisionsForProject(scanDecisions(root), { project: name, programme }),
    runs: runsFor(tsv, name, 3),
    prs,
    notes,
  };
}

/** `~/mc/x` reads better than the absolute path on a page a person reads. */
export function tilde(path, home = homedir()) {
  return path && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}
