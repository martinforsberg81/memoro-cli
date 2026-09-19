/**
 * The shared readers of plans, runs and the runner's tables — what the page,
 * the runner, `mc status`, `mc plan`, `mc step` and the helper each read, so
 * that they read the same thing.
 *
 * Plans come from `docs/project/<programme>/<project>/PLAN.json` on
 * `origin/main` (`listPlans`, `listProgrammes`); the runs are the rows of
 * `~/mc/runner/log/runs.tsv` (`parseRuns`, `runsFor`); the proposals are the
 * files in `~/mc/proposals/` (`listProposals`). The pure readers take text and
 * return data so a test can feed them fixtures; the git calls are injected.
 *
 * It was `mc brief --collect` once, a document gathered for the brief session.
 * `mc brief` gathers nothing now (2026-09-19): the session reads the page,
 * `mc status` and `mc step` where they live. The file kept its name because
 * a dozen modules import from it.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { planSummary, readPlanText } from './plan-schema.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** The two repositories that carry projects, checked out on main at home. */
export function defaultRepos(env = process.env) {
  const home = env.MC_REPOS_HOME || homedir();
  return [
    { name: 'memoro', path: join(home, 'memoro') },
    { name: 'memoro-cli', path: join(home, 'memoro-cli') },
  ];
}

/* ---------------------------------------------------------------- proposals */

/**
 * `~/mc/proposals/` — what the helper wrote and nobody has acted on yet: the
 * desk session's, from what Martin reported, and the intake turn's, from the
 * digest, in one directory.
 *
 * **mc does not read them.** It used to parse a fixed frontmatter and fixed
 * section names out of every file, in three places that disagreed: a proposal
 * whose first prose line was not marked `# ` was counted by the page, missing
 * from the old brief, and recorded as "wrote nothing" by the very turn that had
 * just written it — with no error anywhere. The parse existed so a script
 * could say what kind of thing each file was. Nothing needs that. A count says
 * how many are waiting, and a session that has to know what is in one opens
 * it, the way it would open any other document.
 *
 * So this is the whole of it: the names, oldest first. A proposal is prose.
 */
export function listProposals(dir) {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map((file) => ({ file, path: join(dir, file) }));
  } catch {
    return [];
  }
}

/* --------------------------------------------------------------------- plans */

/**
 * Every frontmatter field of a PLAN.md, in the order it is written, each
 * value unquoted and folded onto one line. `mc status <name>` prints them
 * all; the page takes two of them through `parsePlanFrontmatter`.
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
 * The programmes on a ref: the directories directly under `docs/project/`.
 *
 * Asked of the tree rather than derived from the plans, because a programme
 * outlives its projects. `mc run` archives a project directory the round its
 * plan says done, so a programme whose work is finished for now holds only its
 * own document and its rulings — no PLAN.json anywhere under it — and
 * `listPlans` cannot see it at all. It is still a programme, and still the
 * place the next piece of that work belongs (`mc plan`).
 */
export function listProgrammes(repo, { ref = 'origin/main', git = runGit } = {}) {
  const tree = git(repo.path, ['ls-tree', '-d', '--name-only', ref, 'docs/project/']);
  if (tree == null) return [];
  return tree.split('\n')
    .map((path) => path.split('/')[2])
    .filter(Boolean)
    .sort();
}

/**
 * `docs/project/<programme>/<project>/PLAN.md` on a ref of one repository,
 * read without a checkout: one `ls-tree` for the names and one
 * `cat-file --batch` for every plan's text. `git` and `batch` are both
 * injectable so a caller with its own git — the runner — and the tests can
 * stay off the real one; `showBatch` turns such a git into a batch reader.
 */
export function listPlans(repo, { ref = 'origin/main', git = runGit, batch = catFileBatch } = {}) {
  const tree = git(repo.path, ['ls-tree', '-r', '--name-only', ref, '--', 'docs/project']);
  if (tree == null) return [];
  const paths = tree.split('\n').filter((path) => {
    const parts = path.split('/');
    return parts.length === 5 && (parts[4] === 'PLAN.json' || parts[4] === 'PLAN.md');
  });
  const texts = batch(repo.path, paths.map((path) => `${ref}:${path}`));

  // One project, one plan. Both files can exist while a project is being
  // migrated; the JSON is the plan and the markdown is what it was.
  const byProject = new Map();
  for (const path of paths) {
    const parts = path.split('/');
    const project = parts[3];
    const json = parts[4] === 'PLAN.json';
    const held = byProject.get(project);
    if (held && !json) continue;
    const text = texts.get(`${ref}:${path}`) || '';
    const base = { repo: repo.name, programme: parts[2], project, path };
    if (!json) {
      // A PLAN.md is not a plan the runner can read. It keeps its frontmatter
      // status so `mc status` can still show what the project was, and carries
      // `legacy` so the queue leaves it alone rather than skipping it, loudly,
      // once per project per round.
      byProject.set(project, { ...base, legacy: true, plan: null, problems: [], ...parsePlanFrontmatter(text) });
      continue;
    }
    const { plan, problems } = readPlanText(text);
    byProject.set(project, {
      ...base,
      legacy: false,
      plan,
      problems,
      ...(plan ? planSummary(plan) : { status: 'invalid', next: problems[0] || 'the plan does not parse' }),
    });
  }
  return [...byProject.values()];
}

/**
 * `git cat-file --batch` output, split back into one text per input line.
 *
 * The stream is `<oid> <type> <size>\n<size bytes>\n` per object, or
 * `<input> missing\n` for a path that is not on the ref — no content follows
 * a miss, so the walk simply does not advance. `size` counts bytes, not
 * characters, which is why this works on a Buffer: a plan full of em-dashes
 * would slice apart under a string index.
 */
export function parseCatFileBatch(stdout, refs) {
  const out = new Map();
  const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout || ''));
  let at = 0;
  for (const ref of refs) {
    const end = buf.indexOf(10, at);
    if (end < 0) break;
    const [, , size] = buf.toString('utf8', at, end).split(' ');
    at = end + 1;
    const bytes = Number(size);
    if (!Number.isFinite(bytes)) continue; // "<ref> missing" — nothing follows it
    out.set(ref, buf.toString('utf8', at, at + bytes));
    at += bytes + 1;
  }
  return out;
}

/**
 * A batch reader made from an injected `git`: one `show` per ref, which is
 * what the caller was doing before. The runner keeps it — its `git` is a
 * dependency its own tests replace — and it is the shape a fixture passes.
 */
export function showBatch(git) {
  return (cwd, refs) => new Map(refs.map((ref) => [ref, git(cwd, ['show', ref]) || '']));
}

/**
 * Every named object of one repository in one process. The loop this
 * replaced spent a `git show` per plan — 1.22 s for memoro's 38 on
 * 2026-08-29, against 54 ms for the whole listing this way.
 */
export function catFileBatch(cwd, refs) {
  if (!refs.length) return new Map();
  const r = spawnSync('git', ['-C', cwd, 'cat-file', '--batch'], { input: `${refs.join('\n')}\n`, maxBuffer: 64 << 20 });
  if (r.status !== 0) return new Map();
  return parseCatFileBatch(r.stdout, refs);
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
  let other = 0;
  for (const row of rows) {
    kinds[row.kind] = (kinds[row.kind] || 0) + 1;
    // One bucket a row, so the numbers add up to `steps` by construction: on
    // 2026-09-11 the line read as a partition, was not one, and sent Martin
    // looking for four missing steps. A stall is the runner's only kill since
    // ruling 18, and counts where the wall-clock timeout it replaced did.
    if (row.note.includes('merged')) merged += 1;
    else if (row.note.includes('timeout') || row.note.startsWith('stalled')) timeout += 1;
    else if (row.exit !== '0' || !row.note.startsWith('success')) failed += 1;
    else if (row.note.includes('open')) open += 1;
    // A clean helper or intake turn, a step with nothing to land yet.
    else other += 1;
    cacheRead += Number(row.cache_read) || 0;
    output += Number(row.output) || 0;
    seconds += Number(row.seconds) || 0;
  }
  return { steps: rows.length, kinds, merged, open, failed, timeout, other, cacheRead, output, seconds };
}

/** `git -C <cwd> …` as text, or `null` when it fails — the default `git` of the readers above. */
function runGit(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trimEnd() : null;
}

