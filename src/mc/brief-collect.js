/**
 * `mc brief --collect` — the ground a brief session stands on, gathered by a
 * script and written to one file. No model is involved here; the model is
 * the session that reads the file afterwards.
 *
 * Six sections, in the order the plan fixes them: merged since the last
 * brief · opened, not merged · waiting on Martin · plan status · runner ·
 * queue. Every line comes from a file the runner or a session already
 * writes (`~/mc/runner/log/runs.tsv`, `~/mc/<area>/decisions/<n>.md`,
 * `docs/project/<programme>/<project>/PLAN.md` on origin/main, `~/mc/queue.md`) or from
 * GitHub through `gh`. The pure builders take text and return data so the
 * test can feed them fixtures; `collectBrief` is the only part that touches
 * the machine.
 *
 * "Since last brief" is the mtime of the newest file in `~/mc/brief/`; the
 * first run looks back 24 hours.
 */
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { workRoot } from './paths.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The answer line, and the only mechanism there is: Martin's word turns a
 * `waiting-decision` project back into a running one. The same test exists
 * three times — here, as `grep -l '^\*\*Beslut'` in `~/mc/bin/runner.sh`,
 * and as `isAnswered()` in `mc run` — so `canon/roles/brief.md` fixes the
 * shape a brief session writes and `tests/mc/commands/brief.test.js` holds
 * the overlay's own template against this pattern.
 */
export const ANSWER_LINE = /^\*\*Beslut/u;

/** Bookkeeping that lives under a `decisions/` directory but asks nothing. */
export const NOT_A_DECISION = new Set(['README.md', 'log.md', 'merge-log.md']);

/** The two repositories that carry projects, checked out on main at home. */
export function defaultRepos(env = process.env) {
  const home = env.MC_REPOS_HOME || homedir();
  return [
    { name: 'memoro', path: join(home, 'memoro') },
    { name: 'memoro-cli', path: join(home, 'memoro-cli') },
  ];
}

export function briefDir(env = process.env) {
  return join(workRoot(env), 'brief');
}

/** mtime of the newest brief, or null when there has never been one. */
export function lastBriefTime(dir) {
  let newest = null;
  let names = [];
  try { names = readdirSync(dir).filter((name) => name.endsWith('.md')); } catch { return null; }
  for (const name of names) {
    const time = statSync(join(dir, name)).mtime;
    if (!newest || time > newest) newest = time;
  }
  return newest;
}

/* ----------------------------------------------------------------- decisions */

/**
 * One decision file: the question is the first `# ` heading, the session's
 * recommendation is the first paragraph under `## Rekommendation` — or a
 * bold lead, `**Recommendation: option 2.**`, both shapes exist — and it is
 * answered when a line starts with `**Beslut`.
 *
 * A `# ` heading is the whole test, because the runner's is looser still:
 * it watches every `<area>/decisions/*.md` for the answer line, so anything
 * narrower here hides an open question from the only person who can answer
 * it. This once also demanded an options-or-recommendation section; measured
 * against ~/mc on 2026-08-29 that dropped five files the runner watches —
 * `swedish-grammar/decisions/language-content-1.md` unanswered among them,
 * its options written as `## Half one …` and its alternatives as bullets —
 * and let in `pm/decisions/log.md`, a 358 kB append-only log, because one of
 * its thousands of lines matched. The bookkeeping names go by name instead,
 * in `scanDecisions`.
 */
const RECOMMENDATION = /^(##\s+|\*\*)(Rekommendation|Recommendation)\b/iu;

export function parseDecision(text) {
  const lines = String(text || '').replace(/\r\n/gu, '\n').split('\n');
  const heading = lines.find((line) => /^# /u.test(line));
  if (!heading) return null;
  const answered = lines.some((line) => ANSWER_LINE.test(line));
  let recommendation = null;
  const at = lines.findIndex((line) => RECOMMENDATION.test(line));
  if (at >= 0) {
    const bold = lines[at].startsWith('**');
    const para = bold ? [lines[at].replace(/^\*\*(Rekommendation|Recommendation)[:.]?\s*/iu, '**').trim()] : [];
    for (const line of lines.slice(at + 1)) {
      if (ANSWER_LINE.test(line) || /^#/u.test(line)) break;
      if (!line.trim()) { if (para.length) break; continue; }
      para.push(line.trim());
    }
    recommendation = para.join(' ') || null;
  }
  return { title: heading.replace(/^#\s*/u, '').trim(), recommendation, answered };
}

/**
 * Every `<work root>/<area>/decisions/*.md` that is a decision, parsed —
 * the same set the runner watches, minus the bookkeeping names.
 */
export function scanDecisions(root) {
  const out = [];
  let areas = [];
  try { areas = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return out; }
  for (const area of areas) {
    const dir = join(root, area, 'decisions');
    let files = [];
    try { files = readdirSync(dir).filter((name) => name.endsWith('.md')).sort(); } catch { continue; }
    for (const file of files) {
      if (NOT_A_DECISION.has(file)) continue;
      const parsed = parseDecision(readFileSync(join(dir, file), 'utf8'));
      if (!parsed) continue;
      out.push({ area, file: `${area}/decisions/${file}`, ...parsed });
    }
  }
  return out;
}

/* --------------------------------------------------------------------- plans */

/**
 * Every frontmatter field of a PLAN.md, in the order it is written, each
 * value unquoted and folded onto one line. `mc status <name>` prints them
 * all; the brief and the page take two of them through
 * `parsePlanFrontmatter`.
 */
export function planFields(text) {
  const normalised = String(text || '').replace(/\r\n/gu, '\n');
  const match = /^---\n([\s\S]*?)\n---/u.exec(normalised);
  if (!match) return {};
  const raws = {};
  let key = null;
  for (const raw of match[1].split('\n')) {
    const pair = /^([A-Za-z_-]+):\s*(.*)$/u.exec(raw);
    if (pair) {
      key = pair[1].toLowerCase();
      raws[key] = pair[2].trim();
    } else if (key && /^\s+\S/u.test(raw)) {
      raws[key] = `${raws[key]} ${raw.trim()}`.trim();
    }
  }
  const scalar = (value) => {
    let v = value.replace(/^[>|][-+]?\s*/u, '').trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v.replace(/\\"/gu, '"') || null;
  };
  return Object.fromEntries(Object.entries(raws).map(([k, v]) => [k, scalar(v)]));
}

/** `status` and `next` from a PLAN.md frontmatter; `next` may be a folded scalar. */
export function parsePlanFrontmatter(text) {
  const fields = planFields(text);
  return { status: fields.status ?? null, next: fields.next ?? null };
}

/**
 * `docs/project/<programme>/<project>/PLAN.md` on a ref of one repository,
 * read without a checkout. `git` is injectable so the test can stay off git.
 */
export function listPlans(repo, { ref = 'origin/main', git = runGit } = {}) {
  const tree = git(repo.path, ['ls-tree', '-r', '--name-only', ref, '--', 'docs/project']);
  if (tree == null) return [];
  const plans = [];
  for (const path of tree.split('\n')) {
    const parts = path.split('/');
    if (parts.length !== 5 || parts[4] !== 'PLAN.md') continue;
    const text = git(repo.path, ['show', `${ref}:${path}`]) || '';
    plans.push({ repo: repo.name, programme: parts[2], project: parts[3], path, ...parsePlanFrontmatter(text) });
  }
  return plans;
}

/* -------------------------------------------------------------------- runner */

/** Every runs.tsv row, in file order, as objects keyed by the header. */
export function parseRuns(tsv) {
  const lines = String(tsv || '').split('\n').filter((line) => line.trim());
  if (!lines.length) return [];
  const header = lines[0].split('\t');
  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    return Object.fromEntries(header.map((key, i) => [key, cells[i] ?? '']));
  });
}

/** runs.tsv rows with `ts >= since`, as objects keyed by the header. */
export function runsSince(tsv, since) {
  return parseRuns(tsv).filter((row) => {
    const ts = Date.parse(row.ts);
    return !Number.isNaN(ts) && ts >= since.getTime();
  });
}

/** The last `limit` rows for one project, oldest first. */
export function runsFor(tsv, name, limit = 3) {
  return parseRuns(tsv).filter((row) => row.name === name).slice(-limit);
}

export function summariseRuns(rows) {
  const kinds = {};
  let merged = 0; let open = 0; let failed = 0; let timeout = 0;
  let cacheRead = 0; let output = 0; let seconds = 0;
  for (const row of rows) {
    kinds[row.kind] = (kinds[row.kind] || 0) + 1;
    if (row.note.includes('merged')) merged += 1;
    else if (row.note.includes('open')) open += 1;
    if (row.note.includes('timeout')) timeout += 1;
    else if (row.exit !== '0' || !row.note.startsWith('success')) failed += 1;
    cacheRead += Number(row.cache_read) || 0;
    output += Number(row.output) || 0;
    seconds += Number(row.seconds) || 0;
  }
  return { steps: rows.length, kinds, merged, open, failed, timeout, cacheRead, output, seconds };
}

export function queueNames(text) {
  return String(text || '').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
}

/* ------------------------------------------------------------------- render */

const fmt = (n) => Number(n).toLocaleString('en-US');
const clip = (text, max = 90) => {
  const one = String(text || '').replace(/\s+/gu, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

export function renderBrief({
  now, since, firstBrief, merged, opened, decisions, plans, runs, queue, notes = [],
}) {
  const out = [];
  const stamp = (d) => d.toISOString().replace(/\.\d{3}Z$/u, 'Z');
  out.push(`# Brief — ${stamp(now)}`, '');
  out.push(firstBrief
    ? `First brief: the window is the last 24 h (since ${stamp(since)}).`
    : `Since last brief: ${stamp(since)}.`);
  for (const note of notes) out.push(`> ${note}`);
  out.push('');

  out.push('## Merged since last brief', '');
  if (!merged.length) out.push('_nothing_');
  for (const pr of merged) out.push(`- ${pr.repo} #${pr.number} — ${pr.title} (${pr.mergedAt.slice(0, 16)}Z)`);
  out.push('');

  out.push('## Opened, not merged', '');
  if (!opened.length) out.push('_nothing_');
  for (const pr of opened) out.push(`- ${pr.repo} #${pr.number} — ${pr.title} (${pr.headRefName}, ${pr.createdAt.slice(0, 10)})`);
  out.push('');

  const waiting = decisions.filter((d) => !d.answered);
  out.push('## Waiting on Martin', '');
  if (!waiting.length) out.push('_no decision file without a **Beslut:** line_');
  else {
    out.push('| file | question | recommendation |', '|---|---|---|');
    for (const d of waiting) out.push(`| ${d.file} | ${clip(d.title, 80)} | ${clip(d.recommendation || '—', 120)} |`);
  }
  const answered = decisions.length - waiting.length;
  out.push('', `${waiting.length} waiting, ${answered} answered.`, '');

  out.push('## Plan status', '');
  if (!plans.length) out.push('_no PLAN.md on origin/main_');
  else {
    out.push('| repo | programme / project | status | next |', '|---|---|---|---|');
    for (const p of plans) out.push(`| ${p.repo} | ${p.programme} / ${p.project} | ${p.status || '?'} | ${clip(p.next || '—', 110)} |`);
  }
  const byStatus = {};
  for (const p of plans) byStatus[p.status || '?'] = (byStatus[p.status || '?'] || 0) + 1;
  out.push('', Object.entries(byStatus).map(([s, n]) => `${s}: ${n}`).join(' · ') || '', '');

  const s = runs.summary;
  out.push('## Runner', '');
  out.push(`Last 24 h: ${s.steps} steps (${Object.entries(s.kinds).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}) — merged ${s.merged}, left open ${s.open}, failed ${s.failed}, timed out ${s.timeout}.`);
  out.push(`Tokens: cache_read ${fmt(s.cacheRead)}, output ${fmt(s.output)}; wall ${Math.round(s.seconds / 60)} min.`);
  if (runs.rows.length) {
    out.push('', '| when | project | kind | s | pr | note |', '|---|---|---|---|---|---|');
    for (const r of runs.rows) out.push(`| ${r.ts.slice(5, 16)} | ${r.name} | ${r.kind} | ${r.seconds} | ${r.pr} | ${r.note} |`);
  }
  out.push('');

  out.push('## Queue', '');
  if (!queue.length) out.push('_empty_');
  for (const name of queue) out.push(`- ${name}`);
  out.push('');
  return out.join('\n');
}

/* ------------------------------------------------------------------ collect */

function runGit(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trimEnd() : null;
}

/** `gh … --json` as a promise: the calls per repository run side by side. */
function runGh(cwd, args) {
  return new Promise((resolve) => {
    execFile('gh', args, { cwd, encoding: 'utf8', timeout: 20_000, maxBuffer: 8 << 20 }, (error, stdout) => {
      if (error) { resolve(null); return; }
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

function fetchOrigin(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'fetch', '-q', 'origin'], { timeout: 20_000 }, (error) => resolve(!error));
  });
}

/**
 * Gather everything and write `<work root>/brief/<ISO date>.md`. Returns the
 * path, the rendered text, and the data it was rendered from. The network
 * (one fetch and two `gh` listings per repository) runs concurrently; done
 * one after another it was 10 s, which is the plan's whole budget.
 */
export async function collectBrief({
  env = process.env,
  now = new Date(),
  repos = defaultRepos(env),
  offline = false,
  git = runGit,
  gh = runGh,
  fetch = fetchOrigin,
  read = (path) => readFileSync(path, 'utf8'),
} = {}) {
  const root = workRoot(env);
  const dir = briefDir(env);
  const last = lastBriefTime(dir);
  const since = last || new Date(now.getTime() - DAY_MS);
  const notes = [];

  const merged = [];
  const opened = [];
  const present = repos.filter((repo) => {
    if (existsSync(join(repo.path, '.git'))) return true;
    notes.push(`${repo.name}: no checkout at ${repo.path}`);
    return false;
  });
  if (!offline) {
    await Promise.all(present.flatMap((repo) => [
      fetch(repo.path).then((ok) => { if (!ok) notes.push(`${repo.name}: git fetch failed — plan status may be stale`); }),
      gh(repo.path, ['pr', 'list', '--state', 'merged', '--limit', '100',
        '--search', `merged:>=${since.toISOString()}`, '--json', 'number,title,mergedAt'])
        .then((m) => { if (m) merged.push(...m.map((pr) => ({ repo: repo.name, ...pr }))); else notes.push(`${repo.name}: gh pr list (merged) failed`); }),
      gh(repo.path, ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,createdAt,headRefName'])
        .then((o) => { if (o) opened.push(...o.map((pr) => ({ repo: repo.name, ...pr }))); else notes.push(`${repo.name}: gh pr list (open) failed`); }),
    ]));
  }
  merged.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
  opened.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const decisions = scanDecisions(root);
  const plans = present.flatMap((repo) => listPlans(repo, { git }));

  let tsv = '';
  try { tsv = read(join(root, 'runner', 'log', 'runs.tsv')); } catch { notes.push('no runner/log/runs.tsv'); }
  const rows = runsSince(tsv, new Date(now.getTime() - DAY_MS));
  const runs = { rows, summary: summariseRuns(rows) };

  let queue = [];
  try { queue = queueNames(read(join(root, 'queue.md'))); } catch { notes.push('no queue.md'); }

  const text = renderBrief({ now, since, firstBrief: !last, merged, opened, decisions, plans, runs, queue, notes });
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${now.toISOString().replace(/[:.]/gu, '-').replace(/-\d{3}Z$/u, 'Z')}.md`);
  writeFileSync(path, text);
  return { path, text, data: { since, merged, opened, decisions, plans, runs, queue, notes } };
}
