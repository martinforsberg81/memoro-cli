/**
 * `mc run` — what happens to a plan that says `done`.
 *
 * A plan that reaches `done` is archived (Martin, 2026-08-29: "När en plan
 * är DONE ska den arkiveras. Punkt."). Nothing else is the trigger and
 * nothing has to be typed: the runner reads the plan on main, removes
 * `docs/project/<programme>/<project>/` and leaves one row in that
 * repository's `docs/project/project_log.md` behind it.
 *
 * Everything here is a function of text: the rows of a project log, the row
 * a plan deserves, and the two cells that have to be derived (the summary
 * from the plan's `next:`, the doc from the `docs/technical/` path the plan
 * names). The git and gh half is run.js, so these rules can be covered with
 * no repository behind them.
 *
 * The measured reason: on 2026-08-29 `docs/project/` held ten directories
 * whose plan said `done` — four of them with their `project_log.md` row
 * already written by their close-out step, which is why a row is preferred
 * and never rewritten. `docs/plans/`, the directory `docs/project/`
 * replaced, had reached 656 files the same way.
 */
import { planFields } from './brief-collect.js';
import { readPlanText } from './plan-schema.js';

/** Every archive branch the runner has ever pushed starts with this. */
export const ARCHIVE_BRANCH_PREFIX = 'mc-archive-';

/** The cells of `docs/project/project_log.md`, in the order the table has them. */
export const LOG_COLUMNS = ['date', 'programme', 'project', 'outcome', 'summary', 'doc', 'pointer'];

/** A row whose `doc` cell is this names no lasting documentation. */
export const NO_DOC = 'none';

/** Every plan of one repository that says `done`. The whole trigger. */
export function donePlans(plans = [], repoName = null) {
  return plans.filter((plan) => plan.status === 'done' && (!repoName || plan.repo === repoName));
}

/* ------------------------------------------------------------ the log file */

const DATE = /^\d{4}-\d{2}-\d{2}$/u;

/** The cells of one `| a | b | … |` line, or null when it is not one. */
function cellsOf(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  const cells = trimmed.replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim());
  return cells.length >= 3 ? cells : null;
}

/**
 * The data rows of a project log. The header and its `|---|` rule are not
 * rows: a row starts with a date, which is also what keeps a project called
 * "project" from matching the header's third cell.
 */
export function logRows(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const cells = cellsOf(line);
    if (!cells || !DATE.test(cells[0])) continue;
    out.push(Object.fromEntries(LOG_COLUMNS.map((key, i) => [key, cells[i] ?? ''])));
  }
  return out;
}

/** The row that already names this project, or null. The runner never writes a second. */
export function rowFor(text, project) {
  return logRows(text).find((row) => row.project === project) || null;
}

/** One cell as the table writes it: one line, pipes escaped, `-` for nothing. */
function cellText(value) {
  return String(value ?? '-').replace(/\s+/gu, ' ').replace(/\|/gu, '\\|').trim() || '-';
}

/** One markdown row, cells in `LOG_COLUMNS` order, pipes escaped so the table survives. */
export function formatRow(row) {
  return `| ${LOG_COLUMNS.map((key) => cellText(row[key])).join(' | ')} |`;
}

/**
 * The first row that occurs a second time, by its `date`, `programme` and
 * `project` cells, or null. memoro's `.gitattributes` merges this file
 * `merge=union`, which keeps both sides of a conflicting hunk: on 2026-10-10
 * main carried one row five times, each copy from a step branch that merged
 * main in. The gate reads this so a copy never lands.
 */
export function duplicateRow(text) {
  const seen = new Set();
  for (const row of logRows(text)) {
    const key = [row.date, row.programme, row.project].join('\u0000');
    if (seen.has(key)) return row;
    seen.add(key);
  }
  return null;
}

/**
 * A row appended after the last row of the table — not at the end of the
 * file, which would land it under whatever prose the log keeps below its
 * log. A file with no table at all gets the row at the end, which is the
 * only place left.
 *
 * A log that already has a row for this programme and project (a programme's
 * own row has project `-`) is returned as it is: both archives come here, and
 * only one of them asked `rowFor` first.
 */
export function appendRow(text, row) {
  const programme = cellText(row.programme);
  const project = cellText(row.project);
  if (logRows(text).some((have) => have.programme === programme && have.project === project)) return text;
  const lines = String(text || '').split('\n');
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (cellsOf(lines[i])) { at = i; break; }
  }
  const line = formatRow(row);
  if (at < 0) {
    const body = String(text || '').replace(/\n*$/u, '');
    return `${body ? `${body}\n\n` : ''}${line}\n`;
  }
  lines.splice(at + 1, 0, line);
  return lines.join('\n');
}

/* --------------------------------------------------------- the cells to derive */

/**
 * The summary cell: what the project was last doing, which for a plan that
 * reached `done` is what it finished.
 *
 * In a `PLAN.json` that is the last step's title — the steps are the record,
 * and the last one is where the project got to. A `PLAN.md` still on the old
 * shape answers with its `next:`, which was the one line written to be read on
 * its own; that arm goes when the last plan is migrated.
 */
export function planSummary(planText) {
  const { plan } = readPlanText(planText);
  const last = plan?.steps?.at(-1)?.title;
  if (last) return String(last).replace(/\s+/gu, ' ').trim();
  const next = planFields(planText).next;
  return next ? String(next).replace(/\s+/gu, ' ').trim() : '-';
}

/**
 * The doc cell: the first `docs/technical/…` path the plan names, as the
 * relative link the log's other rows use, or `none`. A thin or missing note
 * never stops an archive — it is reported (`undocumentedRow`) and Martin
 * decides whether to write it.
 */
export function planDoc(planText) {
  const match = /docs\/technical\/[A-Za-z0-9._-]+\.md/u.exec(String(planText || ''));
  if (!match) return NO_DOC;
  return `[${match[0]}](../technical/${match[0].slice('docs/technical/'.length)})`;
}

/** Does this row's doc cell name nothing? */
export function isUndocumented(row) {
  return !row?.doc || String(row.doc).trim().toLowerCase() === NO_DOC;
}

/** `owner/repo` from a git remote URL, or null — the pointer links need it. */
export function remoteSlug(url) {
  const match = /github\.com[:/]+([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/u.exec(String(url || '').trim());
  return match ? match[1] : null;
}

/** Every PR the runner merged for this project, oldest first, from runs.tsv. */
export function mergedPrs(tsv, project) {
  const out = [];
  for (const line of String(tsv || '').split('\n').slice(1)) {
    const cells = line.split('\t');
    if (cells[1] !== project || cells[5] === '-' || !cells[5]) continue;
    if (!String(cells[12] || '').includes('merged')) continue;
    if (!out.includes(cells[5])) out.push(cells[5]);
  }
  return out;
}

/**
 * The pointer cell: the PRs the runner merged for the project, linked when
 * the repository's slug is known. With no merged run to point at — a project
 * finished before the runner existed, or by hand — the fallback the caller
 * passes is used, and `none` is the last resort. The row is a one-line
 * index; this is how a reader gets from it to the record.
 */
export function pointerCell(prs, { slug = null, fallback = null } = {}) {
  if (prs.length) {
    return prs.map((pr) => (slug ? `[#${pr}](https://github.com/${slug}/pull/${pr})` : `#${pr}`)).join(', ');
  }
  return fallback || NO_DOC;
}

/* ------------------------------------------------- intake: the missing docs */

export const UNDOCUMENTED_HEADER = [
  '# Projects archived with no docs/technical/ note',
  '',
  'Written by `mc run` when it archives a project whose `project_log.md` row',
  'says `doc: none`. A missing note never stops an archive — it is recorded',
  'here for `mc brief` to raise, and Martin decides whether to write it.',
  '',
  '| date | repo | programme | project | pointer |',
  '|---|---|---|---|---|',
  '',
].join('\n');

export function undocumentedRow({ date, repo, programme, project, pointer }) {
  const cell = (value) => String(value ?? '-').replace(/\s+/gu, ' ').replace(/\|/gu, '\\|').trim() || '-';
  return `| ${[date, repo, programme, project, pointer].map(cell).join(' | ')} |`;
}

/* ----------------------------------------------- what code outside docs/ reads */

/** Where the code lives that an archive must not break: everything a test can read from. */
export const CODE_PATHS = ['src', 'tests', 'scripts', 'config', 'package.json'];

/** Where a path stops in a line of code: a quote, a bracket, a separator, whitespace. */
const PATH_END = /[\s'"`()[\],;]/u;

/** Where a template's fixed part stops: `${…}`, `{a,b}`, a glob, a `<placeholder>`. */
const TEMPLATE = /[$*{<]/u;

/**
 * The files under `dir` that code outside `docs/` names, each with the first
 * `<path>:<line>` that names it — from text alone. `files` is every file
 * under `dir`; `sources` is `[{ path, text }]`, the files `git grep` matched.
 *
 * A literal path names that file, or every file under it when it is a
 * directory. A template whose fixed prefix is inside `dir` names every file
 * under the directory that prefix points at — the code picks one at run
 * time, and which is not readable here.
 */
export function namedFiles(dir, files, sources) {
  const prefix = `${dir.replace(/\/+$/u, '')}/`;
  const by = new Map();
  const name = (file, where) => { if (!by.has(file)) by.set(file, where); };
  for (const { path, text } of sources) {
    String(text || '').split('\n').forEach((line, i) => {
      for (let at = line.indexOf(prefix); at >= 0; at = line.indexOf(prefix, at + prefix.length)) {
        const tail = line.slice(at + prefix.length);
        const end = tail.search(PATH_END);
        const token = prefix + (end < 0 ? tail : tail.slice(0, end));
        const where = `${path}:${i + 1}`;
        const cut = token.search(TEMPLATE);
        if (cut >= 0) {
          const under = token.slice(0, token.lastIndexOf('/', cut) + 1);
          for (const file of files) if (file.startsWith(under)) name(file, where);
          continue;
        }
        const literal = token.replace(/[.:]+$/u, '');
        if (files.includes(literal)) { name(literal, where); continue; }
        const under = literal.endsWith('/') ? literal : `${literal}/`;
        for (const file of files) if (file.startsWith(under)) name(file, where);
      }
    });
  }
  return [...by].map(([file, where]) => ({ file, by: where })).sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * What archiving `dir` may remove, asked of the worktree before `git rm`.
 * memoro #13310 (2026-10-10) archived four skill texts that
 * `tests/assistant/skills/delivery.test.js` reads verbatim; it landed as
 * docs-only, so no test ran, and main stayed red until #13323 put them back.
 *
 * Returns `{ kept, remove }`: `kept` is `[{ file, by }]`, the files some
 * code names; `remove` is every other file under `dir`, or null when nothing
 * is named — the whole directory goes, as it always did. `git(cwd, args)`
 * answers `{ ok, stdout }`; `read(path)` reads a path of the worktree.
 */
export function keptFiles(worktree, dir, { git, read }) {
  const prefix = `${dir.replace(/\/+$/u, '')}/`;
  // The trailing slash: `staff/day/` must not match `staff/day-two/`. No
  // match is exit 1, which is the same answer as an empty list.
  const grep = git(worktree, ['grep', '-l', '-F', '--', prefix, '--', ...CODE_PATHS]);
  const hits = grep.ok ? String(grep.stdout || '').split('\n').filter(Boolean) : [];
  if (!hits.length) return { kept: [], remove: null };
  const files = String(git(worktree, ['ls-files', '--', dir]).stdout || '').split('\n').filter(Boolean);
  const kept = namedFiles(dir, files, hits.map((path) => ({ path, text: read(path) })));
  if (!kept.length) return { kept: [], remove: null };
  const named = new Set(kept.map((k) => k.file));
  return { kept, remove: files.filter((file) => !named.has(file)) };
}

/** The PR body's paragraph for the files an archive left in place, or no lines. */
export function keptParagraph(kept) {
  if (!kept.length) return [];
  return [
    '',
    'Kept in place, because code outside `docs/` reads them — the directory is',
    'otherwise gone, and this list is the record of why these files are not:',
    '',
    ...kept.map(({ file, by }) => `- kept: ${file} — named by ${by}`),
  ];
}
