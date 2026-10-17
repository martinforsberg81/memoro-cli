/**
 * The closeout — what a finished project leaves in git (ruling 39).
 *
 * A project's register file, its session logs and its runs.tsv rows are local
 * to this machine, and `mc tidy` removes the first two once the project is
 * archived. What a person may still want to know about the project afterwards
 * — what it set out to do, which pull request landed each step and when, and
 * what the sessions cost in time, tokens and money — goes into one JSON file
 * beside its programme's plans, `docs/project/<programme>/closeout/<project>.json`,
 * written by the archive in the same commit that removes the plan.
 *
 * Nothing reads the file but people. `buildCloseout` is pure: the caller
 * (`archiveIn`, run.js) reads the plan, the register entry, runs.tsv and the
 * session results (`readSessionResults`, its IO injectable), and writes what
 * `closeoutText` returns.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { parseRuns } from './brief-collect.js';

export const CLOSEOUT_SCHEMA = 'mc-closeout';
export const CLOSEOUT_VERSION = 1;

/** Row kinds that are the merger's, not the project's sessions. */
const NOT_SESSIONS = new Set(['merge', 'mend']);

/** Where a project's closeout lives, relative to the repository. */
export function closeoutPath(programme, project) {
  return `docs/project/${programme}/closeout/${project}.json`;
}

/**
 * Where the archive puts a project's README (ruling 46): beside its closeout
 * record, so the links that pointed into the removed directory can follow it.
 */
export function closeoutReadmePath(programme, project) {
  return `docs/project/${programme}/closeout/${project}.md`;
}

/**
 * A session result file of one project under `runner/log/`:
 * `<project>-<yyyymmddThhmmssZ>.json`, gzipped or not. Exact, because a
 * prefix would let `ui-faults` read `ui-faults-2`'s files.
 */
export function sessionFileRe(project) {
  const escaped = String(project).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`^${escaped}-\\d{8}T\\d{6}Z\\.json(\\.gz)?$`, 'u');
}

const cell = (value) => (value == null || value === '' || value === '-' ? null : String(value));
const num = (value) => {
  const text = cell(value);
  if (text == null) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
};
// Sums of dollars are rounded to the micro-dollar: a float sum otherwise
// prints `0.30000000000000004`, and the file is read by people.
const dollars = (value) => Math.round(value * 1e6) / 1e6;
const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] ?? 0), 0);

/** Summed known costs, or null when none of the rows has one. */
function costOf(rows) {
  const known = rows.filter((row) => row.cost_usd != null);
  return known.length ? dollars(sum(known, 'cost_usd')) : null;
}

/** `total_cost_usd` by `session_id`, from the session results the caller read. */
function costsBySession(sessions) {
  const out = new Map();
  for (const result of sessions || []) {
    if (!result || typeof result !== 'object') continue;
    const id = result.session_id;
    const cost = Number(result.total_cost_usd);
    if (typeof id === 'string' && id && result.total_cost_usd != null && Number.isFinite(cost)) out.set(id, cost);
  }
  return out;
}

/** The project's session rows, in runs.tsv order, with the cost their result reports. */
function sessionRows(project, runs, sessions) {
  const rows = typeof runs === 'string' ? parseRuns(runs) : (runs || []);
  const costs = costsBySession(sessions);
  return rows
    .filter((row) => row.name === project && !NOT_SESSIONS.has(row.kind))
    .map((row) => {
      const session = cell(row.session);
      return {
        ts: cell(row.ts),
        kind: cell(row.kind),
        seconds: num(row.seconds),
        land_seconds: num(row.land_seconds),
        pr: num(row.pr),
        turns: num(row.turns),
        input: num(row.input),
        output: num(row.output),
        cache_read: num(row.cache_read),
        cache_write: num(row.cache_write),
        model: cell(row.model),
        note: cell(row.note),
        session,
        // runs.tsv has no cost column; the session's own result is the only
        // source, and a session without one is unknown — never estimated.
        cost_usd: session && costs.has(session) ? costs.get(session) : null,
      };
    });
}

const dateOf = (at) => {
  if (at instanceof Date) return at.toISOString().slice(0, 10);
  return typeof at === 'string' && /^\d{4}-\d{2}-\d{2}/u.test(at) ? at.slice(0, 10) : null;
};

/**
 * The closeout of one project. `plan` is the parsed plan, or null when its
 * text could not be had (the file then says `plan: null` and the plan's own
 * fields are null). `entry` is its register entry (`readEntry`), or null.
 * `runs` is runs.tsv, as text or parsed rows; `sessions` the parsed session
 * results. `project`, `programme`, `repo` and `planPath` default to the
 * entry's.
 */
export function buildCloseout({
  plan = null, entry = null, runs = [], sessions = [], archivedAt = null,
  project = entry?.project ?? null, programme = entry?.programme ?? null,
  repo = entry?.repo ?? null, planPath = entry?.plan ?? null,
} = {}) {
  if (!project) throw new Error('no project name');
  if (!programme) throw new Error('no programme');
  const usable = plan && typeof plan === 'object' && !Array.isArray(plan) ? plan : null;
  const rows = sessionRows(project, runs, sessions);
  const planSteps = Array.isArray(usable?.steps) ? usable.steps : [];
  const entrySteps = Array.isArray(entry?.steps) ? entry.steps : [];
  const count = Math.max(planSteps.length, entrySteps.length);

  const steps = [];
  for (let i = 0; i < count; i += 1) {
    const from = planSteps[i] || null;
    const state = entrySteps[i] || null;
    const pr = state?.pr ?? null;
    const own = pr == null ? [] : rows.filter((row) => row.pr === pr);
    const landed = state?.landed
      ? { sha: state.landed.sha ?? null, into: state.landed.into ?? null, at: state.landed.at ?? null }
      : null;
    steps.push({
      title: typeof from?.title === 'string' ? from.title : null,
      done_when: typeof from?.done_when === 'string' ? from.done_when : null,
      status: state?.status ?? null,
      pr,
      landed,
      attempts: state?.attempts ?? 0,
      reason: state?.reason ?? null,
      comments: state?.comments ?? [],
      sessions: own.length,
      seconds: sum(own, 'seconds'),
      cost_usd: costOf(own),
    });
  }

  const landedAt = steps.map((step) => step.landed?.at).filter((at) => typeof at === 'string').sort();
  const totals = {
    sessions: rows.length,
    seconds: sum(rows, 'seconds'),
    land_seconds: sum(rows, 'land_seconds'),
    cost_usd: dollars(sum(rows.filter((row) => row.cost_usd != null), 'cost_usd')),
    cost_unknown: rows.filter((row) => row.cost_usd == null).length,
    input: sum(rows, 'input'),
    output: sum(rows, 'output'),
    cache_read: sum(rows, 'cache_read'),
    cache_write: sum(rows, 'cache_write'),
    first: rows[0]?.ts ?? null,
    landed: landedAt.at(-1) ?? null,
  };

  return {
    schema: CLOSEOUT_SCHEMA,
    version: CLOSEOUT_VERSION,
    project,
    programme,
    repo,
    plan_path: planPath,
    ...(usable ? {} : { plan: null }),
    archived: dateOf(archivedAt),
    goal: usable?.goal ?? null,
    success_criteria: usable?.success_criteria ?? null,
    steps,
    sessions: rows,
    totals,
  };
}

/** The file's text. */
export function closeoutText(closeout) {
  return `${JSON.stringify(closeout, null, 2)}\n`;
}

/* -------------------------------------------------------------------- IO */

const realList = (dir) => { try { return readdirSync(dir); } catch { return []; } };
const realRead = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
const realBytes = (path) => { try { return readFileSync(path); } catch { return null; } };

/**
 * Every session result of one project in `dir` (`runner/log/`), parsed:
 * plain and gzipped — since 2026-10-10 most of them are gzipped — by the
 * exact name rule (`sessionFileRe`). A file that does not read, unzip or
 * parse is passed over.
 */
export function readSessionResults({ dir, project, list = realList, read = realRead, readBytes = realBytes } = {}) {
  const re = sessionFileRe(project);
  const out = [];
  for (const file of list(dir) || []) {
    if (!re.test(file)) continue;
    const path = join(dir, file);
    try {
      let text;
      if (file.endsWith('.gz')) {
        const bytes = readBytes(path);
        text = bytes ? gunzipSync(bytes).toString('utf8') : null;
      } else {
        text = read(path);
      }
      const value = JSON.parse(String(text ?? ''));
      if (value && typeof value === 'object' && !Array.isArray(value)) out.push(value);
    } catch { /* not a result: passed over */ }
  }
  return out;
}
