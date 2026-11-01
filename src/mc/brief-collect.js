/**
 * The shared readers of plans, runs and the runner's tables — what the page,
 * the runner, `mc status`, `mc plan`, `mc step` and the helper each read, so
 * that they read the same thing.
 *
 * Plans come from `~/mc/programs/` (`listPlans`); programmes and old
 * closeouts from `docs/project/` on `origin/main` (`listProgrammes`,
 * `listArchived`); the runs are the rows of `~/mc/runner/log/runs.tsv`
 * (`parseRuns`, `runsFor`); the proposals are the files in `~/mc/proposals/`
 * (`listProposals`). The pure readers take text and
 * return data so a test can feed them fixtures; the git calls are injected.
 *
 * It was `mc brief --collect` once, a document gathered for the brief session.
 * `mc brief` gathers nothing now (2026-09-19): the session reads the page,
 * `mc status` and `mc step` where they live. The file kept its name because
 * a dozen modules import from it.
 */
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { run as runGitSync } from './git.js';
import { planSummary, readPlanText } from './plan-schema.js';
import { PROJECT_DIR, programsArchived, programsPlans } from './plan-source.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** The two repositories that carry projects, in either layout: `repos.js`. Re-exported for the modules that import it from here. */
export { defaultRepos } from './repos.js';

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

/** The systems a proposal's filename may name: `<date>-<system>-<slug>.md`. One word per repository in `defaultRepos`; the list grows only when one joins. */
export const PROPOSAL_SYSTEMS = Object.freeze(['mc', 'memoro']);

/** The system a proposal's filename names, `'mc'` or `'memoro'`, or null when the name carries none. Read off the name, never out of the file. */
export function proposalSystem(file) {
  const match = /^\d{4}-\d{2}-\d{2}-(mc|memoro)-[^/]+\.md$/u.exec(basename(String(file || '')));
  return match ? match[1] : null;
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
  const tree = git(repo.path, ['ls-tree', '-d', '--name-only', ref, `${PROJECT_DIR}/`]);
  if (tree == null) return [];
  return tree.split('\n')
    .map((path) => path.split('/')[2])
    .filter(Boolean)
    .sort();
}

/**
 * The plans of one repository as the readers see them: the plans under
 * `~/mc/programs/` whose `repo` is this repository (ruling 48), built by
 * `planRecords`. An archived project is not among them (`programsPlans`).
 * `ref`, `git`, `batch` and `archived` are accepted and not used: no
 * repository holds a plan any more, so callers that still pass them need not
 * change.
 */
export function listPlans(repo, { programs = programsPlans } = {}) {
  const own = programs().filter((e) => e.repo === repo.name);
  const texts = new Map(own.map((e) => [e.path, e.text]));
  return planRecords(repo.name, own, (path) => texts.get(path) || '');
}

/**
 * The records `listPlans` returns, built from plan-source's entries and a
 * reader of their text: one record a project, `{ repo, programme, project,
 * path, legacy, plan, problems, …planSummary(plan) }`. One project, one plan.
 */
export function planRecords(repoName, entries, textOf) {
  const byProject = new Map();
  for (const entry of entries) {
    const { plan, problems } = readPlanText(textOf(entry.path));
    byProject.set(entry.project, {
      repo: repoName,
      programme: entry.programme,
      project: entry.project,
      path: entry.path,
      legacy: false,
      plan,
      problems,
      ...(plan ? planSummary(plan) : { status: 'invalid', next: problems[0] || 'the plan does not parse' }),
    });
  }
  return [...byProject.values()];
}

/**
 * The archived projects of one repository, closeout names first, each name once:
 * the names of its `docs/project/<programme>/closeout/<project>.json` files on a
 * ref, then the `project` of every archived project under `~/mc/programs/` whose
 * `repo` is this repository (`programsArchived`: a `CLOSEOUT.json` beside its
 * plan, under `~/mc/programs/` or moved to `~/mc/archive/projects/`). The ref's names are what `mc run` writes when it archives a plan
 * (`closeoutPath` in `closeout.js`), and the archive takes only a done plan, so
 * a project with one was delivered. When the ref cannot be read, the programs
 * names are still returned.
 * A `closeout/<project>.md` is not a name, and a file nested deeper under
 * `closeout/` is not one either.
 */
export function listArchived(repo, { ref = 'origin/main', git = runGit, archived = programsArchived } = {}) {
  const tree = git(repo.path, ['ls-tree', '-r', '--name-only', ref, '--', 'docs/project']);
  const closeouts = tree == null ? [] : tree.split('\n')
    .map((path) => path.split('/'))
    .filter((parts) => parts.length === 5 && parts[3] === 'closeout' && parts[4].endsWith('.json'))
    .map((parts) => parts[4].slice(0, -'.json'.length));
  const programs = archived().filter((e) => e.repo === repo.name).map((e) => e.project);
  return [...new Set([...closeouts, ...programs])];
}

/**
 * A batch reader made from an injected `git`: one `show` per ref. The runner
 * still hands one to `listPlans`, which no longer reads git and ignores it.
 */
export function showBatch(git) {
  return (cwd, refs) => new Map(refs.map((ref) => [ref, git(cwd, ['show', ref]) || '']));
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
  const r = runGitSync(undefined, ['-C', cwd, ...args]);
  return r.status === 0 ? r.stdout.trimEnd() : null;
}

