/**
 * `mc brief --collect` — the ground a brief session stands on, gathered by a
 * script and written to one file. No model is involved here; the model is
 * the session that reads the file afterwards.
 *
 * Ten sections, in the order the plan fixes them: merged since the last
 * brief · opened, not merged · the helper's proposals · plan status ·
 * archived without a note · workareas with no plan · plans that do not parse ·
 * runner · held before merge · queue. Every line comes from a file the runner
 * or a session already writes (`~/mc/runner/log/runs.tsv`,
 * `~/mc/runner/held.json`,
 * `docs/project/<programme>/<project>/PLAN.md` on origin/main, `~/mc/queue.md`,
 * `~/mc/intake/*.md`) or from GitHub through `gh`. The pure builders take text
 * and return data so the test can feed them fixtures; `collectBrief` is the
 * only part that touches the machine.
 *
 * "Since last brief" is the mtime of the newest file in `~/mc/brief/`; the
 * first run looks back 24 hours.
 */
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { heldPath, parseHeld } from './held.js';
import { intakeDir, proposalsDir } from './helper-collect.js';
import { planSummary, readPlanText } from './plan-schema.js';
import { workRoot } from './paths.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

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

/* ---------------------------------------------------------------- proposals */

/**
 * `~/mc/proposals/` — what the helper wrote and nobody has acted on yet: the
 * desk session's, from what Martin reported, and the intake turn's, from the
 * digest, in one directory.
 *
 * **mc does not read them.** It used to parse a fixed frontmatter and fixed
 * section names out of every file, in three places that disagreed: a proposal
 * whose first prose line was not marked `# ` was counted by the page, missing
 * from the brief, and recorded as "wrote nothing" by the very turn that had
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

/* -------------------------------------------------- intake: what mc run left */

/**
 * `mc run` writes three files and reads none: `undocumented-closures.md`,
 * appended when it archives a project whose `project_log.md` row says
 * `doc: none`; `unplanned-workareas.md`, rewritten every round with the
 * folders under `~/mc` that no project on main explains; and
 * `unreadable-plans.md`, rewritten every round with the plans on `origin/main`
 * the schema refuses. All three exist because the tidying refuses to decide
 * alone — a missing note never stops an archive, a workarea without a plan is
 * never removed by a machine, and what a malformed plan meant to say is not
 * mc's to guess — and all three are therefore questions for the one person who
 * can answer them. This is where they are asked.
 *
 * The runner is the only writer of either, so the shape is known: a header
 * paragraph saying who writes it, then one table.
 */
export const UNDOCUMENTED_KEYS = ['date', 'repo', 'programme', 'project', 'pointer'];
export const UNPLANNED_KEYS = ['name', 'repo', 'uncommitted', 'lastCommit', 'branch'];
export const UNREADABLE_KEYS = ['project', 'repo', 'problem', 'path'];

/** A row of a pipe table, with `\|` folded back into a cell rather than splitting it. */
function splitRow(line) {
  const inner = line.trim().replace(/^\|/u, '').replace(/\|$/u, '');
  return inner.split(/(?<!\\)\|/u).map((cell) => cell.replace(/\\\|/gu, '|').trim());
}

/**
 * The rows under the first `|---|` rule of a table, keyed by `keys`. A file
 * the runner has written but never filled is a header and a rule, which is
 * an empty list — not the same answer as a file that is not there, which the
 * caller gets as `null`.
 */
export function intakeRows(text, keys) {
  const lines = String(text || '').replace(/\r\n/gu, '\n').split('\n');
  const rule = lines.findIndex((line) => /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/u.test(line));
  if (rule < 0) return [];
  const out = [];
  for (const line of lines.slice(rule + 1)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = splitRow(line);
    out.push(Object.fromEntries(keys.map((key, i) => [key, cells[i] ?? ''])));
  }
  return out;
}

/** One intake table, or `null` when the runner has never written the file. */
function readIntake(read, path, keys) {
  let text = null;
  try { text = read(path); } catch { return null; }
  return intakeRows(text, keys);
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

/* --------------------------------------------------- held before merge */

/**
 * How many repair sessions a held pull request gets before it is a person's.
 * One: the runner runs it, and what that session could not fix is not tried
 * again by another one exactly like it.
 */
export const REPAIRS_BEFORE_BRIEF = 1;

/**
 * `~/mc/runner/held.json`, filtered to what the brief is for: the pull
 * requests whose repair session has already run and left them held anyway.
 * An entry at `repairs: 0` is the runner's next round, not Martin's hour, and
 * raising it here would ask him to decide something a session is about to try.
 *
 * Oldest first, because the pull request that has stood still longest is the
 * one to open first. The file is read, never reconstructed: the runner writes
 * it (`held.js`) and the page draws the same entries, so a runs.tsv note
 * parsed back into a reason would be a second answer that can disagree.
 */
export function heldForBrief(text) {
  return parseHeld(text)
    .filter((entry) => entry.repairs >= REPAIRS_BEFORE_BRIEF)
    .sort((a, b) => String(a.since ?? '').localeCompare(String(b.since ?? '')) || a.pr - b.pr);
}

export function queueNames(text) {
  return String(text || '').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
}

/* ------------------------------------------------------------------- render */

const fmt = (n) => Number(n).toLocaleString('en-US');
/** Named in the brief so the answer is a file Martin can open, not a fact he must trust. */
const UNDOCUMENTED_FILE = '`~/mc/intake/undocumented-closures.md`';
const UNPLANNED_FILE = '`~/mc/intake/unplanned-workareas.md`';
const UNREADABLE_FILE = '`~/mc/intake/unreadable-plans.md`';
const HELD_FILE = '`~/mc/runner/held.json`';
/** The undocumented file is append-only; the brief shows the newest rows and counts the rest. */
const INTAKE_CAP = 12;
/**
 * A `project_log.md` pointer cell as text: `[#455](https://…), [#456](…)`
 * is five PRs' worth of URL in one cell, and clipping that mid-URL leaves a
 * broken link rather than a short one. The brief is read in a terminal, so
 * the numbers are the whole value; the row in the intake file keeps the URLs.
 */
const unlink = (text) => String(text ?? '-').replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1');
const clip = (text, max = 90) => {
  const one = String(text || '').replace(/\s+/gu, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

export function renderBrief({
  now, since, firstBrief, merged, opened, proposals = [], plans,
  undocumented = null, unplanned = null, unreadable = null, runs, queue, held = [], notes = [],
}) {
  const out = [];
  const stamp = (d) => d.toISOString().replace(/\.\d{3}Z$/u, 'Z');
  out.push(`# Brief — ${stamp(now)}`, '');
  out.push(firstBrief
    ? `First brief: the window is the last 24 h (since ${stamp(since)}).`
    : `Since last brief: ${stamp(since)}.`);
  for (const note of notes) out.push(`> ${note}`);
  // A held pull request keeps its whole project out of the runner's round, so
  // it is not something to find in the ninth section of a long file.
  if (held.length) {
    out.push('', `**${held.length} pull request${held.length === 1 ? '' : 's'} held before merge** after `
      + `${held.length === 1 ? 'its' : 'their'} repair — *Held before merge*, below. `
      + `${held.length === 1 ? 'That project runs' : 'Those projects run'} nothing until you decide.`);
  }
  out.push('');

  out.push('## Merged since last brief', '');
  if (!merged.length) out.push('_nothing_');
  for (const pr of merged) out.push(`- ${pr.repo} #${pr.number} — ${pr.title} (${pr.mergedAt.slice(0, 16)}Z)`);
  out.push('');

  out.push('## Opened, not merged', '');
  if (!opened.length) out.push('_nothing_');
  for (const pr of opened) out.push(`- ${pr.repo} #${pr.number} — ${pr.title} (${pr.headRefName}, ${pr.createdAt.slice(0, 10)})`);
  out.push('');

  out.push('## Proposals', '');
  if (!proposals.length) out.push('_none in ~/mc/proposals/_');
  else {
    for (const p of proposals) out.push(`- \`${p.file}\``);
    out.push('', 'Open the ones worth opening. Each is a reading, not work yet: it becomes a '
      + 'project — a `PLAN.json` on main, then its name in `~/mc/queue.md` — or it is dropped. '
      + 'The file goes either way, at the moment that is decided.');
  }
  out.push('');

  out.push('## Plan status', '');
  if (!plans.length) out.push('_no PLAN.md on origin/main_');
  else {
    out.push('| repo | programme / project | status | next |', '|---|---|---|---|');
    for (const p of plans) out.push(`| ${p.repo} | ${p.programme} / ${p.project} | ${p.status || '?'} | ${clip(p.next || '—', 110)} |`);
  }
  const byStatus = {};
  for (const p of plans) byStatus[p.status || '?'] = (byStatus[p.status || '?'] || 0) + 1;
  out.push('', Object.entries(byStatus).map(([s, n]) => `${s}: ${n}`).join(' · ') || '', '');

  out.push('## Archived without a note', '');
  if (!undocumented) out.push(`_no ${UNDOCUMENTED_FILE} — nothing has been archived without one_`);
  else if (!undocumented.length) out.push('_none_');
  else {
    const shown = undocumented.slice(-INTAKE_CAP);
    out.push('| date | repo | programme / project | pointer |', '|---|---|---|---|');
    for (const r of shown) out.push(`| ${r.date} | ${r.repo} | ${r.programme} / ${r.project} | ${clip(unlink(r.pointer), 60)} |`);
    const older = undocumented.length - shown.length;
    if (older) out.push(`| … | | ${older} older row${older === 1 ? '' : 's'} above these | |`);
    out.push('', `${undocumented.length} project${undocumented.length === 1 ? '' : 's'} archived with \`doc: none\`. `
      + `The directory is gone and \`git log --all -- docs/project/…\` is what is left of it: write the note under `
      + `\`docs/technical/\`, or decide it needs none. ${UNDOCUMENTED_FILE} is append-only — nothing but you prunes it.`);
  }
  out.push('');

  out.push('## Workareas with no project on main', '');
  if (!unplanned) out.push(`_no ${UNPLANNED_FILE} — \`mc run\` writes it at the end of every round_`);
  else if (!unplanned.length) out.push('_none_');
  else {
    out.push('| name | repo | uncommitted | last commit | branch |', '|---|---|---|---|---|');
    for (const r of unplanned) out.push(`| ${r.name} | ${r.repo} | ${r.uncommitted} | ${r.lastCommit} | ${r.branch} |`);
    const landed = unplanned.filter((r) => r.branch === 'landed').length;
    out.push('', `${unplanned.length} folder${unplanned.length === 1 ? '' : 's'} under \`~/mc\` that no project on main `
      + `explains — no plan, and no row in \`project_log.md\` — ${landed} whose branch is already on main. `
      + `No machine removes one: give it a plan (\`mc plan <name>\`), or remove the folder by hand.`);
  }
  out.push('');

  out.push('## Plans that do not parse', '');
  if (!unreadable) out.push(`_no ${UNREADABLE_FILE} — \`mc run\` writes it at the end of every round_`);
  else if (!unreadable.length) out.push('_none_');
  else {
    out.push('| project | repo | problem |', '|---|---|---|');
    for (const r of unreadable) out.push(`| ${r.project} | ${r.repo} | ${clip(r.problem, 80)} |`);
    out.push('', `${unreadable.length} plan${unreadable.length === 1 ? '' : 's'} on \`origin/main\` the schema refuses. `
      + `The runner can hand out no step from one and does not guess at what its author meant, so it stops there `
      + `silently: fix the field the problem names, or the project waits. ${UNREADABLE_FILE} has the plan's path.`);
  }
  out.push('');

  const s = runs.summary;
  out.push('## Runner', '');
  out.push(`Last 24 h: ${s.steps} steps (${Object.entries(s.kinds).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}) — merged ${s.merged}, left open ${s.open}, failed ${s.failed}, timed out ${s.timeout}.`);
  out.push(`Tokens: cache_read ${fmt(s.cacheRead)}, output ${fmt(s.output)}; wall ${Math.round(s.seconds / 60)} min.`);
  if (runs.rows.length) {
    out.push('', '| when | project | kind | s | pr | note |', '|---|---|---|---|---|---|');
    for (const r of runs.rows) out.push(`| ${r.ts.slice(5, 16)} | ${r.name} | ${r.kind} | ${r.seconds} | ${r.pr} | ${r.note} |`);
  }
  out.push('');

  out.push('## Held before merge', '');
  if (!held.length) out.push('_none_');
  else {
    out.push('| project | repo | pr | branch | repairs | reason |', '|---|---|---|---|---|---|');
    for (const h of held) {
      out.push(`| ${h.project || '?'} | ${h.repo || '?'} | #${h.pr} | ${h.branch || '?'} | ${h.repairs} | ${clip(h.reason, 80)} |`);
    }
    out.push('', `${held.length} pull request${held.length === 1 ? '' : 's'} the runner would not land, `
      + `${held.length === 1 ? 'its' : 'each with its'} one repair session already behind it. `
      + `Each is a project standing still — the pull request is open, so the runner passes the project every round — and each is now yours: `
      + `\`mc merge <repo> <pr>\` by hand when the red is not the change's, \`gh pr close\` when the work is wrong, `
      + `or the step set \`blocked\` with a \`blocked_by\` decision. One proposal per pull request. `
      + `${HELD_FILE} has the rest of what the gate saw.`);
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

  const plans = present.flatMap((repo) => listPlans(repo, { git }));

  let tsv = '';
  try { tsv = read(join(root, 'runner', 'log', 'runs.tsv')); } catch { notes.push('no runner/log/runs.tsv'); }
  const rows = runsSince(tsv, new Date(now.getTime() - DAY_MS));
  const runs = { rows, summary: summariseRuns(rows) };

  let queue = [];
  try { queue = queueNames(read(join(root, 'queue.md'))); } catch { notes.push('no queue.md'); }

  // No note when the file is not there: the runner writes `held.json` the
  // first time it refuses to land something, and never having refused one is
  // the good answer, not a missing file.
  let held = [];
  try { held = heldForBrief(read(heldPath(root))); } catch { held = []; }

  const proposals = listProposals(proposalsDir(env));

  // The three files `mc run` writes and never reads. Absent is its own answer —
  // the runner has not written one yet — so it is kept apart from empty.
  const intake = intakeDir(env);
  const undocumented = readIntake(read, join(intake, 'undocumented-closures.md'), UNDOCUMENTED_KEYS);
  const unplanned = readIntake(read, join(intake, 'unplanned-workareas.md'), UNPLANNED_KEYS);
  const unreadable = readIntake(read, join(intake, 'unreadable-plans.md'), UNREADABLE_KEYS);

  const text = renderBrief({
    now, since, firstBrief: !last, merged, opened, proposals, plans,
    undocumented, unplanned, unreadable, runs, queue, held, notes,
  });
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${now.toISOString().replace(/[:.]/gu, '-').replace(/-\d{3}Z$/u, 'Z')}.md`);
  writeFileSync(path, text);
  return { path, text, data: { since, merged, opened, proposals, plans, undocumented, unplanned, unreadable, runs, queue, held, notes } };
}
