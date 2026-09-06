/**
 * `mc brief --collect` — the ground a brief session stands on, gathered by a
 * script and written to one file. No model is involved here; the model is
 * the session that reads the file afterwards.
 *
 * Thirteen sections, in the order the plan fixes them: merged since the last
 * brief · opened, not merged · the helper's proposals · plan status ·
 * archived without a note · workareas with no plan · plans that do not parse ·
 * runner · production · held before merge · ready and not started · blocked ·
 * queue. Every line comes from a file the runner
 * or a session already writes (`~/mc/runner/log/runs.tsv`,
 * `~/mc/runner/held.json`,
 * `docs/project/<programme>/<project>/PLAN.md` on origin/main, `~/mc/queue.md`,
 * `~/mc/runner/*.md`) or from GitHub through `gh`. The pure builders take text
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

import { lastAttempt, lastDeploy } from './deploys.js';
import { heldPath, parseHeld } from './held.js';
import { proposalsDir } from './helper-collect.js';
import { readLiveVersion } from './live-version.js';
import { nightlyReading } from './nightly-history.js';
import { NAME_RE, planSummary, readPlanText } from './plan-schema.js';
import {
  UNDOCUMENTED_CLOSURES, UNPLANNED_WORKAREAS, UNREADABLE_PLANS, runnerTableLabel, runnerTablePath,
  workRoot,
} from './paths.js';
import { PR_FIELDS } from './project-prs.js';
import { RUN_REFUSALS } from './run-plan.js';
import { staleBlockers } from './stale-blockers.js';
import { machineDetail, machineState, pidAlive, readCurrents } from './status-collect.js';
import { parseUnmergeable, unmergeablePath } from './unmergeable.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The repository that has a production. memoro-cli is installed, not deployed
 * (`commands/deploy.js`), so *Production* is one repository's section and takes
 * no argument, exactly as the verb does.
 */
export const DEPLOY_REPO = 'memoro';

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

/* ------------------------------------------ the runner's own three tables */

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
 * They live in `~/mc/runner/` (paths.js), beside `held.json` and `log/`, and
 * not in `~/mc/intake/` where they were written until 2026-09-04: two of the
 * three are rewritten whole every round, so an inbox that drained one would
 * find it back the next round, forever. This is their only reader.
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

/** One runner table, or `null` when the runner has never written the file. */
function readTable(read, path, keys) {
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

/* --------------------------------------------- ready, and still not started */

/**
 * Every project whose plan on `origin/main` says `ready` and which the runner
 * would nevertheless pass over right now — the reason, since when, and the run
 * that left it that way.
 *
 * `held.json` only knows a pull request the gate refused, so *Held before
 * merge* above cannot see the larger case: a session killed before it committed
 * never got as far as a pull request, and what it left is a dirty workarea the
 * round skips every ten minutes for as long as it stands there.
 * `no-text-in-code` sat from 2026-09-04T12:37Z on exit 143 with 35 files of
 * finished work uncommitted; `connections-section` sat from 2026-08-29T21:37Z
 * on a session that exited 0 and opened no pull request. Neither is in
 * `held.json`; neither is in *Workareas with no project on main*, because both
 * have a project on main — which is exactly what makes them a loss; and the
 * only thing that said so was a `, skip` line in `runner.log`, of which there
 * were 9 827.
 *
 * The reading is `machineState` (status-collect.js), shared with `mc status`
 * and the page and injected here for the same reason it is injected there:
 * this module takes read data, and asking a workarea whether it is dirty is
 * not read data. A plan-shaped refusal is dropped — `blocked` and `done` are
 * *Plan status*'s rows and the project is not `ready` — by keeping only the
 * words in `RUN_REFUSALS`, so a reason added to the round arrives here without
 * a second list to maintain.
 *
 * Oldest first: the workarea that has stood longest is the one nobody has
 * looked at, and six days is the record so far. `running` is what the runner
 * has a live session on and is dropped — those rows are true and none of them
 * is anybody's to act on.
 */
export function waitingOnHands({
  plans = [], machine = () => null, tsv = '', running = [], home = homedir(),
} = {}) {
  const machineWords = new Set(RUN_REFUSALS.map((item) => item.reason));
  const live = new Set(running.filter(Boolean));
  const rows = [];
  for (const plan of plans) {
    // A PLAN.md is not a plan the runner reads at all (`assembleQueue`), so it
    // is not a project waiting on hands — it is one waiting on a migration.
    if (plan.legacy) continue;
    // Nor is a project the runner has a session in flight on. Its worktree is
    // dirty because somebody is working in it this minute, and every row here
    // is meant to be one a person acts on: 2026-09-05T16:35Z this section named
    // `sql-w3-email-closure`, whose session had been running for eight minutes.
    if (live.has(plan.project)) continue;
    const state = machine(plan.project);
    if (!state || state.runnable || !machineWords.has(state.reason)) continue;
    rows.push({
      project: plan.project,
      repo: plan.repo || null,
      reason: state.reason,
      detail: machineDetail(state, home),
      since: state.since || null,
      run: runsFor(tsv, plan.project, 1)[0] || null,
    });
  }
  // A refusal with no `since` — GitHub unasked, a pull request in flight — has
  // no age to sort on and is not the one that has been waiting; it goes last.
  return rows.sort((a, b) => (a.since ? 0 : 1) - (b.since ? 0 : 1)
    || String(a.since ?? '').localeCompare(String(b.since ?? ''))
    || a.project.localeCompare(b.project));
}

/* ----------------------------------------------------------------- blocked */

/**
 * The `decision` blocker that is not a question. Every plan converted to the
 * schema was parked on it, and none of them has ever been put to Martin: it
 * names the programme's own planning session, which is `mc plan <programme>`
 * and not an hour of his.
 */
export const PLAN_REVIEW = 'plan-review';

/**
 * Every `blocked` step on `origin/main`, told apart by what a reader would do
 * with it — which is not the same question as what `blocked_by.kind` says.
 *
 * Three groups. A **project** blocker is sequencing: the named project has to
 * land first, and that order is the blocking project's design, so the whole
 * list is worth a count and no more. **`plan-review`** is a `decision` blocker
 * by kind and a hand-off by meaning — the programme's planning session has not
 * read the plan yet — so it is separated from the decisions that are decisions.
 * What is left is the **named decisions**, and that short list is the one a
 * brief session actually works through.
 *
 * Two facts ride along because both are invisible today and neither costs a
 * read. `stale` is `staleBlockers`'s (stale-blockers.js), reused rather than
 * recomputed so the page and the brief cannot disagree about which blocking
 * project is gone. `unnamed` is a blocker name that is not a name (`NAME_RE`,
 * plan-schema.js): `sql-goal1-certification` step 4 waits on a 79-character
 * sentence, which is neither a live blocker nor a finished one but a plan
 * nothing can check. Reported, not refused — refusing one is a decision with a
 * proposal of its own.
 *
 * Plan order, which is `listPlans`'s order: the plans are read from a ref in
 * one batch and nothing here re-sorts them, so two runs against the same ref
 * render the same file.
 */
export function blockedSteps(plans = []) {
  const stale = new Map();
  for (const item of staleBlockers(plans)) stale.set(`${item.repo}/${item.project}/${item.step}`, item.why);
  const rows = [];
  for (const record of plans) {
    const steps = Array.isArray(record?.plan?.steps) ? record.plan.steps : [];
    steps.forEach((step, index) => {
      if (step?.status !== 'blocked') return;
      const blocker = step.blocked_by || {};
      const name = typeof blocker.name === 'string' ? blocker.name.trim() : '';
      rows.push({
        repo: record.repo,
        programme: record.programme,
        project: record.project,
        step: index + 1,
        title: step.title || '',
        kind: blocker.kind || null,
        blocker: name || null,
        group: blocker.kind === 'project' ? 'project' : (name === PLAN_REVIEW ? 'plan-review' : 'decision'),
        stale: stale.get(`${record.repo}/${record.project}/${index + 1}`) || null,
        unnamed: Boolean(name) && !NAME_RE.test(name),
      });
    });
  }
  return rows;
}

/* ------------------------------------------------------------- production */

const sha7 = (sha) => (sha ? String(sha).slice(0, 7) : null);
/** `2026-09-04 09:12` — an instant as the brief prints one, with no seconds. */
const at16 = (iso) => (iso ? String(iso).slice(0, 16).replace('T', ' ') : '—');

/**
 * What is in production, what is on `main` that is not, and whether anything
 * ever measured that tree.
 *
 * The three readings a deploy is decided on, gathered here so the brief can put
 * them in one paragraph: the last row of `deploys.tsv` (`deploys.js`), the gap
 * to `origin/main` in commits, and the nightly's verdict on the tree that would
 * ship. `mc deploy` prints the same three before it asks its question
 * (`commands/deploy.js`) — this is that reading, without the question, so the
 * brief can propose the deploy Martin then types.
 *
 * The gap is counted from the deployed sha, which is a commit this checkout may
 * not have — a deploy from another machine, a history rewritten — so it is null
 * rather than a number when git cannot answer.
 */
export function productionState({
  path = null, env = process.env, now = new Date(), git = runGit, nightly = nightlyReading,
} = {}) {
  if (!path) return null;
  const sha = git(path, ['rev-parse', 'origin/main']);
  const deploy = lastDeploy(env);
  const attempt = lastAttempt(env);
  const same = deploy && attempt && attempt.started === deploy.started && attempt.sha === deploy.sha;
  const ahead = () => {
    const out = deploy?.sha && sha ? git(path, ['rev-list', '--count', `${deploy.sha}..${sha}`]) : null;
    const value = Number(out);
    return out != null && Number.isFinite(value) ? value : null;
  };
  const measured = nightly(path)?.measured || null;
  return {
    repo: DEPLOY_REPO,
    sha,
    deploy,
    // The last thing that happened, when it is not the deploy above: a deploy
    // running now, one that failed, one somebody refused.
    attempt: same ? null : attempt,
    live: readLiveVersion(env, now),
    ahead: ahead(),
    nightly: measured
      ? { commit: measured.commit, at: measured.at, red: measured.red, outcome: measured.outcome, this_tree: Boolean(sha) && measured.commit === sha }
      : null,
  };
}

export function queueNames(text) {
  return String(text || '').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
}

/* ------------------------------------------------------------------- render */

const fmt = (n) => Number(n).toLocaleString('en-US');
/** Named in the brief so the answer is a file Martin can open, not a fact he must trust. */
const UNDOCUMENTED_FILE = runnerTableLabel(UNDOCUMENTED_CLOSURES);
const UNPLANNED_FILE = runnerTableLabel(UNPLANNED_WORKAREAS);
const UNREADABLE_FILE = runnerTableLabel(UNREADABLE_PLANS);
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
/** `09-04 12:37` — the runner table's own stamp, the year and the seconds dropped. */
const at11 = (iso) => String(iso || '').slice(5, 16).replace('T', ' ');
/**
 * How long something has been true, in the words the page uses for an age
 * (`ageWords`, page-cache.js — not imported, because page-cache imports this
 * module). Rounded, because the difference this has to carry is the one
 * between a minute and six days.
 */
function ageWords(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '?';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}
const clip = (text, max = 90) => {
  const one = String(text || '').replace(/\s+/gu, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};
/**
 * A sentence too wide for a cell, cut in the middle instead of at the end.
 *
 * `machineState`'s detail is `<what> <worktree>: <the files>` and both ends
 * carry the whole meaning: a merge that stopped is not the same thing as work
 * somebody left uncommitted, and the files are what a person opens. What sits
 * between them is the workarea path, which the project column has already
 * said. Clipped from the right on a long root, the row loses exactly the two
 * words worth having.
 */
const clipMid = (text, max = 110) => {
  const one = String(text || '').replace(/\s+/gu, ' ').trim();
  if (one.length <= max) return one;
  const head = Math.ceil((max - 1) * 0.35);
  return `${one.slice(0, head)}…${one.slice(one.length - (max - 1 - head))}`;
};

/**
 * *Production* — the last deploy, what is on `main` that it does not have, and
 * what the nightly said about that tree.
 *
 * It is a reading and not a recommendation: whether a gap is worth shipping is
 * the brief session's to judge and Martin's to type (`canon/roles/brief.md`).
 * What this owes him is the three numbers that judgement needs, and the honest
 * absence when one of them cannot be had.
 */
function productionLines(out, production) {
  if (!production) {
    out.push(`_no ${DEPLOY_REPO} checkout here — nothing to read_`);
    return;
  }
  const { deploy, live, nightly } = production;
  if (!deploy) {
    out.push('- No deploy through `mc deploy` yet — `~/mc/runner/log/deploys.tsv` holds no `deployed` row, '
      + 'so what is live is only what production says it is.');
  } else {
    const verified = deploy.live_commit ? `, verified live \`${sha7(deploy.live_commit)}\`` : '';
    out.push(`- Last deploy: \`${sha7(deploy.sha)}\`${deploy.build ? ` build ${deploy.build}` : ''} — `
      + `${at16(deploy.ended || deploy.started)}${deploy.holder ? ` by ${deploy.holder}` : ''}${verified}`);
  }
  if (production.attempt) {
    const a = production.attempt;
    out.push(`- Since then: a deploy of \`${sha7(a.sha)}\` is **${a.outcome}**`
      + `${a.stopped_at ? `, stopped at *${a.stopped_at}*` : ''}${a.note ? ` — ${clip(a.note, 80)}` : ''}`);
  }
  out.push(`- \`origin/main\` is ${production.sha ? `\`${sha7(production.sha)}\`` : 'not readable here'}`
    + `${production.ahead == null
      ? ' — the gap to production cannot be counted from this checkout'
      : (production.ahead === 0
        ? ' — nothing to ship'
        : `, **${production.ahead} commit${production.ahead === 1 ? '' : 's'} ahead of production**`)}`);
  if (nightly) {
    out.push(`- The nightly measured \`${sha7(nightly.commit)}\`${nightly.this_tree ? ' — this tree' : ' — not this tree'}`
      + `, ${nightly.red == null ? 'no result' : `${nightly.red} red`} (${at16(nightly.at)})`);
  } else {
    out.push('- The nightly has measured nothing here — no tree has been measured whole.');
  }
  if (live) {
    out.push(`- \`/api/version\` said build ${live.build ?? '?'} · \`${live.short}\``
      + `${live.age_seconds == null ? '' : ` (read ${Math.round(live.age_seconds / 3600)} h ago)`}`
      + `${deploy?.sha && live.commit !== deploy.sha ? ' — **not the sha of the last deploy**' : ''}`);
  }
  if (production.ahead) {
    out.push('', 'A deploy is Martin\'s word every time: `mc deploy` asks once, at a terminal, and nothing else '
      + 'in mc calls it. Propose it or do not, but do not schedule it.');
  }
}

/**
 * *Ready, and the runner cannot start it* — a section of its own rather than
 * rows inside *Held before merge*.
 *
 * They are the same waiting and they are not the same act. Every row of *Held
 * before merge* is a pull request, and the role allows exactly three answers to
 * one (`canon/roles/brief.md`): merge it by hand, close it, or block the step.
 * None of the three is available for a workarea somebody killed at 12:37 with
 * 35 files uncommitted — there is nothing to merge and nothing to close, and
 * the act is to open the worktree and decide what the work was. Rows that take
 * a different act than the prose above them promises are rows a reader applies
 * the wrong answer to, so they get their own heading and their own prose.
 *
 * The held projects still appear here, in the reason word and no further: this
 * section is the whole answer to "what says ready and does not run", and a
 * complete list that points at the section with the detail beats a second copy
 * of the detail that can disagree with it.
 *
 * `prs-unknown` is the one reason that is not about a project. It is a fact
 * about a repository — GitHub did not answer, or `--offline` did not ask it —
 * and it is true of every ready plan that repository has, so it is one line per
 * repository and not twenty identical rows that bury the workarea somebody
 * killed.
 */
function waitingLines(out, waiting, now) {
  if (!waiting.length) {
    out.push('_none — every plan that says `ready` is one the runner would start_');
    return;
  }
  const unknown = waiting.filter((w) => w.reason === 'prs-unknown');
  const rows = waiting.filter((w) => w.reason !== 'prs-unknown');
  for (const repo of [...new Set(unknown.map((w) => w.repo))]) {
    const n = unknown.filter((w) => w.repo === repo).length;
    out.push(`- **${repo}: GitHub was not asked what it has open**, so ${n} ready `
      + `project${n === 1 ? '' : 's'} could not be read past ${n === 1 ? 'its' : 'their'} plan — `
      + 'a pull request in flight and a hold are both invisible until it answers.');
  }
  if (unknown.length) out.push('');
  if (!rows.length) {
    out.push('_nothing else — every other ready plan is one the runner would start_');
    return;
  }
  out.push('| project | repo | in the way | since | last run |', '|---|---|---|---|---|');
  for (const w of rows) {
    const age = w.since ? `${at11(w.since)} · ${ageWords(now.getTime() - Date.parse(w.since))}` : '—';
    const run = w.run
      ? `${w.run.kind} exit ${w.run.exit}, ${clip(w.run.note || '—', 22)} (${at11(w.run.ts)})`
      : 'no run recorded';
    // The same width *Plan status* gives `next`, and cut in the middle: the
    // named files are the end of the sentence and the whole value of it —
    // `email-window-layout` was skipped 134 rounds on three modified files
    // nobody had read the names of.
    out.push(`| ${w.project} | ${w.repo || '?'} | ${clipMid(w.detail, 110)} | ${age} | ${run} |`);
  }
  const dirty = rows.filter((w) => w.reason === 'dirty').length;
  out.push('', `${rows.length} project${rows.length === 1 ? '' : 's'} whose plan on \`origin/main\` says `
    + `\`ready\` and whose round ends before a session starts — every round, for as long as the row stands. `
    + `${dirty ? `${dirty} of them ${dirty === 1 ? 'is' : 'are'} a workarea with uncommitted work in it: `
      + 'open it, and the work is either finished — commit it on the branch it is on — or abandoned, and then '
      + 'it is Martin\'s `git restore`. No machine removes one, and the runner does not commit it either. ' : ''}`
    + `\`held-after-repair\` is *Held before merge* above, with what the gate saw and the three answers to it; `
    + `\`in-flight\` is a pull request already open on the branch, to land or to close.`);
}

/**
 * *Blocked* — every step on `origin/main` that is stopped, grouped by what the
 * reader does with it.
 *
 * It sits beside *Held before merge* and *Ready, and the runner cannot start
 * it* because it is the third and largest member of that family: a project
 * standing still, and yours. Until now the only trace of one was inside *Plan
 * status*, where a plan gets one row and its blocker arrives clipped to 110
 * characters inside the `next` cell — which is how a step waiting on a project
 * that landed months ago stays invisible.
 *
 * The named decisions get a table and the full blocker name uncut, because
 * that is the list a session works through and the name is the thing it looks
 * up. `plan-review` gets one line per programme, because the act is
 * `mc plan <programme>` and the programme is the whole address. Project
 * blockers get a count, because the order they close in is the blocking
 * project's design and not this brief's business — except where the project
 * they name has left main, which is the one project-blocker fact somebody has
 * to answer.
 */
function blockedLines(out, blocked) {
  if (!blocked.length) {
    out.push('_none — no step on `origin/main` is blocked_');
    return;
  }
  const named = blocked.filter((b) => b.group === 'decision');
  const review = blocked.filter((b) => b.group === 'plan-review');
  const project = blocked.filter((b) => b.group === 'project');
  const stale = blocked.filter((b) => b.stale);
  const unnamed = blocked.filter((b) => b.unnamed);
  const where = (b) => `${b.repo} · ${b.programme} / ${b.project} step ${b.step}`;

  out.push(`${blocked.length} step${blocked.length === 1 ? '' : 's'} on \`origin/main\` `
    + `${blocked.length === 1 ? 'is' : 'are'} \`blocked\`: `
    + `**${named.length} named decision${named.length === 1 ? '' : 's'}** to work, `
    + `${review.length} waiting on a programme's planning session, `
    + `${project.length} sequencing.`, '');

  out.push(`### Named decisions — ${named.length}`, '');
  if (!named.length) out.push('_none — every decision blocker on main is a `plan-review` park_');
  else {
    out.push('| repo | programme / project | step | waits on | the step |', '|---|---|---|---|---|');
    // The name uncut: it is what a session looks the answer up by, and the one
    // that does not fit a cell is exactly the one worth seeing whole.
    for (const b of named) {
      out.push(`| ${b.repo} | ${b.programme} / ${b.project} | ${b.step} | ${b.blocker} | ${clip(b.title, 60)} |`);
    }
    out.push('', 'Each is this brief\'s to sort. Read the plan and the code behind it: where the estate '
      + 'already holds the answer — the decision answered under another name, the blocking project '
      + 'landed — settle it and write what you read into the step\'s `comments`. What a reading cannot '
      + 'settle goes to Martin as one proposal with one recommendation, the way a held pull request does.');
  }
  out.push('');

  out.push(`### Waiting on a programme's planning session — ${review.length}`, '');
  if (!review.length) out.push('_none_');
  else {
    for (const programme of [...new Set(review.map((b) => b.programme))]) {
      const rows = review.filter((b) => b.programme === programme);
      out.push(`- **${programme}** — ${rows.length} step${rows.length === 1 ? '' : 's'}: `
        + `${rows.map((b) => `${b.project} step ${b.step}`).join(', ')} · \`mc plan ${programme}\``);
    }
    out.push('', `\`${PLAN_REVIEW}\` is not a question for Martin and never was: it is the park every plan `
      + 'converted to the schema carries until its programme\'s planning session reads it. Name the '
      + 'programme and hand it over — a brief that passes these over silently is why they are still here.');
  }
  out.push('');

  out.push(`### Sequencing — ${project.length} project blocker${project.length === 1 ? '' : 's'}`, '');
  out.push(project.length
    ? `${project.length} step${project.length === 1 ? '' : 's'} waiting on another project to land. `
      + 'That order is the blocking project\'s own design — this section reads it and never moves it — '
      + `so ${project.length === 1 ? 'it is' : 'they are'} a count and nothing more, except for the two `
      + 'cases below.'
    : '_none_');
  out.push('');

  out.push(`### Waiting on a project that is not on \`origin/main\` — ${stale.length}`, '');
  if (!stale.length) out.push('_none — every project blocker names a project main still has_');
  else {
    for (const b of stale) out.push(`- ${where(b)} waits on \`${b.blocker}\`, which ${b.stale}`);
    out.push('', 'A project leaves main when it is delivered and when it is abandoned, and only a person '
      + 'can say which happened. Delivered: unblock the step and say so in its `comments`. Abandoned: '
      + 'the step\'s premise is dead and the plan needs its programme.');
  }
  out.push('');

  out.push(`### A blocker name that is not a name — ${unnamed.length}`, '');
  if (!unnamed.length) out.push('_none — every blocker names a project or a decision_');
  else {
    for (const b of unnamed) {
      out.push(`- ${where(b)} waits on ${b.kind} “${b.blocker}” — ${b.blocker.length} characters, not a name`);
    }
    out.push('', 'Nothing can look one of these up: it is neither a live blocker nor a finished one, but a '
      + 'plan no reader can check. The schema does not refuse it — every plan carrying one would be '
      + 'unrunnable the moment it landed — so it is answered here, by name, or rewritten as one.');
  }
}

export function renderBrief({
  now, since, firstBrief, merged, opened, proposals = [], plans,
  undocumented = null, unplanned = null, unreadable = null, runs, queue, held = [],
  waiting = [], blocked = [], production = null, notes = [],
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

  out.push('## Production', '');
  productionLines(out, production);
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

  out.push('## Ready, and the runner cannot start it', '');
  waitingLines(out, waiting, now);
  out.push('');

  out.push('## Blocked', '');
  blockedLines(out, blocked);
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
  // Beside `git` because the plans are the ground every other section stands
  // on: a test that wants a plan on `origin/main` has to be able to hand one
  // over without a repository, the way the round does (`showBatch`, run.js).
  batch = catFileBatch,
  gh = runGh,
  fetch = fetchOrigin,
  nightly = nightlyReading,
  read = (path) => readFileSync(path, 'utf8'),
} = {}) {
  const root = workRoot(env);
  const dir = briefDir(env);
  const last = lastBriefTime(dir);
  const since = last || new Date(now.getTime() - DAY_MS);
  const notes = [];

  const merged = [];
  const opened = [];
  // The repositories whose open pull requests are unknown rather than none.
  // What nobody asked and what failed read the same to a list, and the reading
  // below would otherwise call a project runnable on that silence — which is
  // the round's own rule (`prsFailed`, run.js): a repository GitHub could not
  // be asked starts nothing.
  const prsFailed = [];
  const present = repos.filter((repo) => {
    if (existsSync(join(repo.path, '.git'))) return true;
    notes.push(`${repo.name}: no checkout at ${repo.path}`);
    return false;
  });
  if (offline) prsFailed.push(...present.map((repo) => repo.name));
  else {
    await Promise.all(present.flatMap((repo) => [
      fetch(repo.path).then((ok) => { if (!ok) notes.push(`${repo.name}: git fetch failed — plan status may be stale`); }),
      gh(repo.path, ['pr', 'list', '--state', 'merged', '--limit', '100',
        '--search', `merged:>=${since.toISOString()}`, '--json', 'number,title,mergedAt'])
        .then((m) => { if (m) merged.push(...m.map((pr) => ({ repo: repo.name, ...pr }))); else notes.push(`${repo.name}: gh pr list (merged) failed`); }),
      // The round's own field set plus the date this section prints, so the
      // reading beside it draws a draft as a draft (`describePr`) rather than
      // as a pull request nobody marked.
      gh(repo.path, ['pr', 'list', '--state', 'open', '--limit', '100', '--json', `${PR_FIELDS},createdAt`])
        .then((o) => {
          if (o) opened.push(...o.map((pr) => ({ repo: repo.name, ...pr })));
          else { prsFailed.push(repo.name); notes.push(`${repo.name}: gh pr list (open) failed`); }
        }),
    ]));
  }
  merged.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
  opened.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const plans = present.flatMap((repo) => listPlans(repo, { git, batch }));

  let tsv = '';
  try { tsv = read(join(root, 'runner', 'log', 'runs.tsv')); } catch { notes.push('no runner/log/runs.tsv'); }
  const rows = runsSince(tsv, new Date(now.getTime() - DAY_MS));
  const runs = { rows, summary: summariseRuns(rows) };

  let queue = [];
  try { queue = queueNames(read(join(root, 'queue.md'))); } catch { notes.push('no queue.md'); }

  // No note when the file is not there: the runner writes `held.json` the
  // first time it refuses to land something, and never having refused one is
  // the good answer, not a missing file.
  let heldText = '';
  try { heldText = read(heldPath(root)); } catch { heldText = ''; }
  const held = heldForBrief(heldText);
  let unmergeableNow = [];
  try { unmergeableNow = parseUnmergeable(read(unmergeablePath(root))); } catch { unmergeableNow = []; }

  // Every `ready` plan the runner would pass over now. The whole file is read
  // here rather than `heldForBrief`'s filtered half: an entry still at
  // `repairs: 0` is a repair the runner would start, which is the difference
  // between a project that is waiting on hands and one that is not.
  const stop = existsSync(join(root, 'runner', 'STOP'));
  const waiting = waitingOnHands({
    plans,
    tsv,
    // A lane's file whose pid is gone is a crashed runner, not a running step:
    // that workarea is exactly the one this section is for, so it is not
    // dropped (`nowBlock` calls the same file stale on the page).
    running: readCurrents(join(root, 'runner'))
      .filter((current) => pidAlive(current.pid))
      .map((current) => current.name),
    machine: (name) => machineState(name, {
      plans,
      prs: opened,
      prsFailed,
      held: parseHeld(heldText),
      // The workareas the last round could not bring to origin/main. Read the
      // same way and for the same reason as `held.json`: an aborted merge
      // leaves nothing on disk to see, so the round's own record is the only
      // thing that says the project is standing still.
      unmergeable: unmergeableNow,
      stop,
      root,
      // `git` answers with a string or null here; the reading wants ok and text.
      git: (cwd, args) => { const out = git(cwd, args); return { ok: out != null, stdout: out ?? '' }; },
    }),
  });

  // Every blocked step on the same ref, from the same parsed plans: no git
  // call of its own, and the same records the runner obeys.
  const blocked = blockedSteps(plans);

  const proposals = listProposals(proposalsDir(env));

  // The three files `mc run` writes and never reads. Absent is its own answer —
  // the runner has not written one yet — so it is kept apart from empty.
  const undocumented = readTable(read, runnerTablePath(UNDOCUMENTED_CLOSURES, env), UNDOCUMENTED_KEYS);
  const unplanned = readTable(read, runnerTablePath(UNPLANNED_WORKAREAS, env), UNPLANNED_KEYS);
  const unreadable = readTable(read, runnerTablePath(UNREADABLE_PLANS, env), UNREADABLE_KEYS);

  // What is in production, read from the files `mc deploy` and the helper
  // leave: no network, and no reading at all where memoro is not checked out.
  const production = productionState({
    path: present.find((repo) => repo.name === DEPLOY_REPO)?.path || null,
    env,
    now,
    git,
    nightly,
  });

  const text = renderBrief({
    now, since, firstBrief: !last, merged, opened, proposals, plans,
    undocumented, unplanned, unreadable, runs, queue, held, waiting, blocked, production, notes,
  });
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${now.toISOString().replace(/[:.]/gu, '-').replace(/-\d{3}Z$/u, 'Z')}.md`);
  writeFileSync(path, text);
  return {
    path,
    text,
    data: {
      since, merged, opened, proposals, plans, undocumented, unplanned, unreadable,
      runs, queue, held, waiting, blocked, production, notes,
    },
  };
}
