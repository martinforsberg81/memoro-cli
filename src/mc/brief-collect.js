/**
 * The shared readers of programmes, runs and the runner's tables — what the
 * page, the runner, `mc plan` and the helper each read, so that they read the
 * same thing.
 *
 * Programmes come from `docs/project/` on `origin/main` (`listProgrammes`);
 * the runs are the rows of `~/mc/runner/log/runs.tsv` (`parseRuns`,
 * `runsFor`); the proposals are the files in `~/mc/proposals/`
 * (`listProposals`). The pure readers take text and return data so a test
 * can feed them fixtures; the git calls are injected. The plan readers went
 * with projects on 2026-11-03 (goal mc/projects-to-goals).
 *
 * It was `mc brief --collect` once, a document gathered for the brief session.
 * `mc brief` gathers nothing now (2026-09-19): the session reads the page and
 * `mc goal list` where they live. The file kept its name because a dozen
 * modules import from it.
 */
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { run as runGitSync } from './git.js';

/** Where the programmes are, in each repository. */
const PROJECT_DIR = 'docs/project';

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

/* ---------------------------------------------------------------- programmes */

/**
 * The programmes on a ref: the directories directly under `docs/project/`.
 *
 * Asked of the tree, because a programme outlives its work: one whose work is
 * finished for now holds only its own document and its rulings, and it is
 * still a programme, and still the place the next piece of that work belongs
 * (`mc plan`).
 */
export function listProgrammes(repo, { ref = 'origin/main', git = runGit } = {}) {
  const tree = git(repo.path, ['ls-tree', '-d', '--name-only', ref, `${PROJECT_DIR}/`]);
  if (tree == null) return [];
  return tree.split('\n')
    .map((path) => path.split('/')[2])
    .filter(Boolean)
    .sort();
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

