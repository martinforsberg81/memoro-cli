/**
 * `mc brief --collect` — the ground a brief session stands on, gathered by a
 * script and written to one file. No model is involved here; the model is
 * the session that reads the file afterwards.
 *
 * Nine sections, in the order the plan fixes them: merged since the last
 * brief · opened, not merged · waiting on Martin · the helper's proposals ·
 * plan status · archived without a note · workareas with no plan · runner ·
 * queue. Every line comes from a file the runner or a session already
 * writes (`~/mc/runner/log/runs.tsv`, `~/mc/<area>/decisions/<n>.md`,
 * `docs/project/<programme>/<project>/PLAN.md` on origin/main, `~/mc/queue.md`,
 * `~/mc/intake/*.md`) or from GitHub through `gh`. The pure builders take text
 * and return data so the test can feed them fixtures; `collectBrief` is the
 * only part that touches the machine.
 *
 * "Since last brief" is the mtime of the newest file in `~/mc/brief/`; the
 * first run looks back 24 hours.
 */
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { intakeDir, proposalsDir } from './helper-collect.js';
import { workRoot } from './paths.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The answer line: Martin's word, written into the decision file.
 *
 * It used to be the runner's trigger — a `waiting-decision` project started
 * again the moment any file for its programme carried this line. It is not,
 * any more. The runner runs `ready` plans and nothing else (Martin,
 * 2026-08-29), so the line is read here and nowhere else: it is what marks a
 * question closed, and what lets `retireDecisions` delete the file once the
 * plan carries the answer. `canon/roles/brief.md` fixes the shape a brief
 * session writes, and `tests/mc/commands/brief.test.js` holds the overlay's
 * own template against this pattern. There is no second implementation to
 * keep in step any more: `~/mc/bin/runner.sh` and its own grep are deleted.
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
 * A `# ` heading is the whole test. Anything narrower hides an open question
 * from the only person who can answer it, and this file is now the only
 * reader there is — nothing else watches `decisions/` at all. This once also
 * demanded an options-or-recommendation section; measured
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
  const fm = planFields(text);
  return {
    title: heading.replace(/^#\s*/u, '').trim(),
    recommendation,
    answered,
    owner: {
      programme: fm.programme ?? null,
      project: fm.project ?? null,
      plan: fm.plan ?? null,
    },
  };
}

/**
 * Every `<work root>/<area>/decisions/*.md` that is a decision, parsed,
 * minus the bookkeeping names.
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
      const path = join(dir, file);
      const parsed = parseDecision(readFileSync(path, 'utf8'));
      if (!parsed) continue;
      out.push({ area, base: file.replace(/\.md$/u, ''), path, file: `${area}/decisions/${file}`, ...parsed });
    }
  }
  return out;
}

/**
 * Which decision files have done their job and can go.
 *
 * `decisions/` is meant to hold open questions and nothing else. It did not:
 * on 2026-08-29 it held 51 files, 42 of them answered, some for weeks — so
 * every reader had to sort 51 to find the 6 that were live. Martin's rule is
 * that the plan changes for the decision and the file goes, deleted rather
 * than archived ("ALLT GAMMALT AV BESLUT MÅSTE RENSAS BORT").
 *
 * The test is deliberately not "has a `**Beslut:**` line". A file is retired
 * only when its answer has demonstrably landed: every plan that owns it has
 * left `waiting-decision`. Measured against `~/mc` the difference was eleven
 * files — `avatar-image-animation` carries seven answered decisions while its
 * plan still says `waiting-decision` and its `next:` still names one of them.
 * Deleting on the answer alone takes the answer away before whoever must
 * apply it has read it.
 *
 * **A decision file says who owns it, and that is read before anything is
 * guessed.** Its frontmatter carries `plan:`, `project:` or `programme:`, and
 * every file under `~/mc` on 2026-08-29 declared one. Only when none is
 * present does the old heuristic apply: a plan owns a file in its own area,
 * or one named `<programme>-*` or `<project>-*`.
 *
 * The heuristic alone was wrong for any programme whose name prefixes its
 * projects. `mc-test-1` declares `project: mc-test`, and no `mc-test` plan
 * exists — but `'mc-test-1'.startsWith('mc-')` made all eleven `mc` projects
 * its owners, none of them waiting, so a ruling nobody had applied and no
 * document carried was one `--collect` from deletion. Read as declared it is
 * an orphan, which is what it is.
 *
 * A file no plan owns is an **orphan** — the project it belonged to is gone
 * from main, or never existed — and a machine never deletes one: it is
 * reported so a person can decide. Silently deleting a question nobody has
 * answered is the one failure worse than keeping it.
 *
 * This runs from `mc brief --collect`, never from the runner: `mc run` has
 * nothing to do with decisions (Martin, 2026-08-29). So the tidying happens
 * when you sit down to look at the list, which is the moment it matters.
 */
export function retireDecisions({ decisions = [], plans = [] } = {}) {
  const owners = (d) => {
    const own = d.owner || {};
    if (own.plan) return plans.filter((p) => p.path === own.plan);
    if (own.project) return plans.filter((p) => p.project === own.project);
    if (own.programme) return plans.filter((p) => p.programme === own.programme);
    return plans.filter((p) => d.area === p.project
      || d.base?.startsWith(`${p.programme}-`)
      || d.base?.startsWith(`${p.project}-`));
  };

  const remove = [];
  const orphans = [];
  const held = [];
  for (const d of decisions) {
    if (!d.answered) continue;                      // an open question stays
    const mine = owners(d);
    if (!mine.length) { orphans.push({ ...d, why: 'no plan on main owns it' }); continue; }
    const waiting = mine.filter((p) => p.status === 'waiting-decision');
    if (waiting.length) { held.push({ ...d, why: `${waiting.map((p) => p.project).join(', ')} still waiting-decision` }); continue; }
    remove.push({ ...d, appliedBy: mine.map((p) => p.project).sort() });
  }
  return { remove, orphans, held };
}

/* ---------------------------------------------------------------- proposals */

/**
 * `~/mc/intake/proposals/` — what the helper wrote and nobody has acted on
 * yet: the desk session's, from what Martin reported, and the intake turn's,
 * from the digest, in one directory and one shape. It is read here for the
 * same reason `decisions/` is: this is the file a person sits down with, and
 * a proposal exists to be queued or dropped by Martin at exactly that
 * moment. Neither half of `mc helper` touches `queue.md`, so the brief is
 * the only place a proposal becomes work.
 */

/**
 * A proposal file: the frontmatter mc needs (what kind of thing, and where
 * it belongs) and the three sections a reader needs. Parsed the same way a
 * PLAN.md frontmatter is, so a proposal written by hand behaves like one
 * written by the turn.
 *
 * A file without a `# ` title is not a proposal — the turn's scratch notes,
 * a README somebody left — and is skipped rather than listed as one.
 */
export function parseProposal(text) {
  const lines = String(text || '').replace(/\r\n/gu, '\n').split('\n');
  const heading = lines.find((line) => /^# /u.test(line));
  if (!heading) return null;
  const fields = planFields(text);
  return {
    name: fields.name || null,
    repo: fields.repo || null,
    kind: fields.kind || null,
    project: fields.project || null,
    title: heading.replace(/^#\s*/u, '').trim(),
    doneWhen: section(lines, /^##\s+Done when\b/iu),
    evidence: section(lines, /^##\s+Evidence\b/iu),
  };
}

/** The first paragraph under a heading, folded onto one line. */
function section(lines, heading) {
  const at = lines.findIndex((line) => heading.test(line));
  if (at < 0) return null;
  const para = [];
  for (const line of lines.slice(at + 1)) {
    if (/^#/u.test(line)) break;
    if (!line.trim()) { if (para.length) break; continue; }
    para.push(line.trim().replace(/^[-*]\s+/u, ''));
  }
  return para.join(' ') || null;
}

/** Every proposal waiting in `~/mc/intake/proposals/`, oldest name first. */
export function scanProposals(dir) {
  let names = [];
  try { names = readdirSync(dir).filter((name) => name.endsWith('.md')).sort(); } catch { return []; }
  const out = [];
  for (const file of names) {
    const path = join(dir, file);
    let parsed = null;
    try { parsed = parseProposal(readFileSync(path, 'utf8')); } catch { parsed = null; }
    if (parsed) out.push({ file, path, ...parsed });
  }
  return out;
}

/* -------------------------------------------------- intake: what mc run left */

/**
 * `mc run` writes two files and reads neither: `undocumented-closures.md`,
 * appended when it archives a project whose `project_log.md` row says
 * `doc: none`, and `unplanned-workareas.md`, rewritten every round with the
 * folders under `~/mc` that no plan on main explains. Both exist because the
 * tidying refuses to decide alone — a missing note never stops an archive,
 * and a workarea without a plan is never removed by a machine — and both are
 * therefore questions for the one person who can answer them. This is where
 * they are asked.
 *
 * The runner is the only writer of either, so the shape is known: a header
 * paragraph saying who writes it, then one table.
 */
export const UNDOCUMENTED_KEYS = ['date', 'repo', 'programme', 'project', 'pointer'];
export const UNPLANNED_KEYS = ['name', 'repo', 'uncommitted', 'lastCommit', 'branch'];

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
    return parts.length === 5 && parts[4] === 'PLAN.md';
  });
  const texts = batch(repo.path, paths.map((path) => `${ref}:${path}`));
  return paths.map((path) => {
    const parts = path.split('/');
    const text = texts.get(`${ref}:${path}`) || '';
    return { repo: repo.name, programme: parts[2], project: parts[3], path, ...parsePlanFrontmatter(text) };
  });
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

export function queueNames(text) {
  return String(text || '').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
}

/* ------------------------------------------------------------------- render */

const fmt = (n) => Number(n).toLocaleString('en-US');
/** Named in the brief so the answer is a file Martin can open, not a fact he must trust. */
const UNDOCUMENTED_FILE = '`~/mc/intake/undocumented-closures.md`';
const UNPLANNED_FILE = '`~/mc/intake/unplanned-workareas.md`';
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
  now, since, firstBrief, merged, opened, decisions, proposals = [], plans,
  undocumented = null, unplanned = null, runs, queue, notes = [],
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

  out.push('## Proposals', '');
  if (!proposals.length) out.push('_none in ~/mc/intake/proposals/_');
  else {
    out.push('| file | proposes | what | done when |', '|---|---|---|---|');
    for (const p of proposals) {
      const where = [p.kind || '?', p.repo, p.project].filter(Boolean).join(' · ');
      out.push(`| ${p.file} | ${where} | ${clip(p.title, 80)} | ${clip(p.doneWhen || '—', 90)} |`);
    }
    out.push('', 'Each is the helper\'s reading of a digest, not work yet: queue it in `~/mc/queue.md` '
      + 'and delete the file, or delete the file.');
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

  out.push('## Workareas with no plan on main', '');
  if (!unplanned) out.push(`_no ${UNPLANNED_FILE} — \`mc run\` writes it at the end of every round_`);
  else if (!unplanned.length) out.push('_none_');
  else {
    out.push('| name | repo | uncommitted | last commit | branch |', '|---|---|---|---|---|');
    for (const r of unplanned) out.push(`| ${r.name} | ${r.repo} | ${r.uncommitted} | ${r.lastCommit} | ${r.branch} |`);
    const landed = unplanned.filter((r) => r.branch === 'landed').length;
    out.push('', `${unplanned.length} folder${unplanned.length === 1 ? '' : 's'} under \`~/mc\` that no plan on main `
      + `explains, ${landed} whose branch is already on main. No machine removes one: give it a plan `
      + `(\`mc plan <name>\`), or remove the folder by hand.`);
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

  // Tidy before the agenda is built, so the list is only ever open questions.
  // The runner does not do this — it has nothing to do with decisions — and
  // a person sitting down to look at the list is exactly when it matters.
  const scanned = scanDecisions(root);
  const { remove, orphans } = retireDecisions({ decisions: scanned, plans });
  const retired = [];
  for (const d of remove) {
    try { rmSync(d.path); retired.push(d.file); } catch { notes.push(`could not remove ${d.file}`); }
  }
  if (retired.length) notes.push(`retired ${retired.length} answered decision file(s): ${retired.join(', ')}`);
  for (const d of orphans) notes.push(`orphan decision ${d.file} — ${d.why}; answer it or delete it by hand`);
  const gone = new Set(retired);
  const decisions = scanned.filter((d) => !gone.has(d.file));

  let tsv = '';
  try { tsv = read(join(root, 'runner', 'log', 'runs.tsv')); } catch { notes.push('no runner/log/runs.tsv'); }
  const rows = runsSince(tsv, new Date(now.getTime() - DAY_MS));
  const runs = { rows, summary: summariseRuns(rows) };

  let queue = [];
  try { queue = queueNames(read(join(root, 'queue.md'))); } catch { notes.push('no queue.md'); }

  const proposals = scanProposals(proposalsDir(env));

  // The two files `mc run` writes and never reads. Absent is its own answer —
  // the runner has not written one yet — so it is kept apart from empty.
  const intake = intakeDir(env);
  const undocumented = readIntake(read, join(intake, 'undocumented-closures.md'), UNDOCUMENTED_KEYS);
  const unplanned = readIntake(read, join(intake, 'unplanned-workareas.md'), UNPLANNED_KEYS);

  const text = renderBrief({
    now, since, firstBrief: !last, merged, opened, decisions, proposals, plans,
    undocumented, unplanned, runs, queue, notes,
  });
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${now.toISOString().replace(/[:.]/gu, '-').replace(/-\d{3}Z$/u, 'Z')}.md`);
  writeFileSync(path, text);
  return { path, text, data: { since, merged, opened, decisions, proposals, plans, undocumented, unplanned, runs, queue, notes } };
}
