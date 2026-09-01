/**
 * `mc run` — the decisions the runner makes without starting anything.
 *
 * Everything here is a function of text and small objects: the queue from
 * `~/mc/queue.md` and the plans on origin/main; which kind of step a
 * project gets; the prompt a step is given; the headless argument list per
 * tool; what a finished session's output means; and the runs.tsv row. The
 * process-touching half (git, gh, tmux, the session itself) is run.js, and
 * it calls in here so that the tests can cover the rules with no session.
 *
 * These rules began as `~/mc/bin/runner.sh`'s, line by line — the shell
 * runner nights 1–2 measured (`~/mc/runner/log/natt-1.md`). That file is
 * deleted (Martin, 2026-08-29: "Inget att hålla kvar"); `mc run` had taken
 * over the nights by then. What it did differently and this does not: it
 * logged a weekly quota answer as eleven successful eight-second steps, it
 * ran every tool as claude on opus, it wrote plans it had invented, and it
 * started projects off answered decision files.
 */
import { parseRuns } from './brief-collect.js';
import { deliverableStep } from './plan-schema.js';

export const RUNS_HEADER = ['ts', 'name', 'kind', 'exit', 'seconds', 'pr', 'turns', 'input', 'output', 'cache_read', 'cache_write', 'session', 'note'];

export const DEFAULT_MODEL = 'opus'; // claude's alias, and only claude's — see `sessionSettings`
export const DEFAULT_TOOL = 'claude';
export const DEFAULT_BUDGET_MINUTES = 90;
export const QUOTA_SLEEP_MS = 30 * 60 * 1000;
export const TIMEOUT_EXIT = 142; // what the shell runner's `perl alarm` left in runs.tsv

/* ------------------------------------------------------------------ queue */

/**
 * Martin's order first (`queue.md`, comments and blanks ignored), then every
 * project with a PLAN.md on origin/main that the queue did not name, sorted.
 *
 * A name with no plan on main is not in the queue at all. It used to be —
 * queue.md was taken literally and whatever it named was attempted — and the
 * runner logged a skip line for it every round. Nobody reads that line
 * (Martin, 2026-08-29: "Ingen skip-rad: vem ska läsa den!?"). A workarea with
 * no plan is shown where somebody actually looks: `mc status`'s WORKAREAS
 * WITHOUT A PROJECT block.
 */
export function assembleQueue(queueText, plans) {
  // A plan still written as PLAN.md is not one the runner reads. It is left out
  // here rather than skipped in the round, because a skip line per unmigrated
  // project per round is a line nobody reads — `mc status` is where they show.
  const planned = new Set(plans.filter((p) => !p.legacy).map((p) => p.project));
  const named = queueFileNames(queueText).filter((name) => planned.has(name));
  const seen = new Set(named);
  const rest = [...planned].filter((name) => !seen.has(name)).sort();
  return [...named, ...rest];
}

/** What a project may be called — the same shape `mc work` accepts. */
const QUEUE_NAME = /^[A-Za-z0-9._-]{1,64}$/u;

/** The lines of the queue file that look like a name at all, in order. */
export function queueFileNames(queueText) {
  return String(queueText || '').split('\n')
    .map((line) => line.trim())
    .filter((line) => QUEUE_NAME.test(line));
}

/**
 * `~/mc/queue.md` is a strict list (Martin, 2026-08-29: "ett träsk — där ska
 * INTE finnas någonting annat än en lista över vad som ska köras"). One
 * project name per line and nothing else: no comments, no headings, no
 * blank-line sections.
 *
 * The file is Martin's "these first", and it empties itself — a name leaves
 * it the moment its project's step has run, and a name that cannot have a
 * step (the plan is done, or there is no plan on main) leaves it now. What
 * is left is the order; the alphabetical list of ready plans on main is what
 * follows it, as before.
 *
 * Returns `{ names, dropped }` — `dropped` is `{ line, why }` per line that
 * goes, one runner.log line each. The 2026-08-29 file had seven comment
 * lines and twenty names that were already done or had no plan on main.
 */
export function strictQueue(queueText, plans) {
  const byProject = new Map(plans.map((plan) => [plan.project, plan]));
  const names = [];
  const dropped = [];
  const seen = new Set();
  for (const raw of String(queueText || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (!QUEUE_NAME.test(line)) { dropped.push({ line, why: 'not a project name' }); continue; }
    if (seen.has(line)) { dropped.push({ line, why: 'named twice' }); continue; }
    const plan = byProject.get(line);
    if (!plan) { dropped.push({ line, why: 'no plan on main' }); continue; }
    if (plan.legacy) { dropped.push({ line, why: 'still a PLAN.md — migrate it to PLAN.json' }); continue; }
    if (plan.status === 'done') { dropped.push({ line, why: 'the plan is done' }); continue; }
    seen.add(line);
    names.push(line);
  }
  return { names, dropped };
}

/** The queue file as it is written back: names, one per line, nothing else. */
export function queueFileText(names) {
  return names.length ? `${names.join('\n')}\n` : '';
}

/* ------------------------------------------------------------------- kind */

/**
 * What a project gets this round. `conflicts` non-empty means the merge of
 * origin/main stopped and is left in progress; `plan` is null when no
 * PLAN.md exists in the worktree.
 *
 * Two things the runner used to do here and does not any more, both on
 * Martin's word of 2026-08-29:
 *
 * - **No plan means nothing happens, silently.** The runner runs plans; it
 *   does not write them. Planning is `mc plan <name>`, a foreground session
 *   with Martin in it, ending in a `Plan: <name>` PR he has read. ("JAG TAR
 *   FRAM PLANER I EN mc plan SESSION … Runner ska köra de planer som tagits
 *   fram.") The old `triage` kind invented a plan headlessly and landed it on
 *   main by itself, so work could begin on a plan nobody had agreed to.
 *   `assembleQueue` already drops such names, so this branch is only reached
 *   when a plan disappears mid-round; it carries no `skip` text because
 *   nothing would read it.
 * - **A stopped step is simply not ready.** The runner starts `ready` steps
 *   and nothing else — it never read a decision file, counted one, or started
 *   because one was answered. ("Runner genomför planer som är ready. Om
 *   väntande beslut är ej ready.") A plan comes back by being set `ready`,
 *   which is the job of whoever applies the answer.
 */
export function chooseKind({ plan, conflicts = [] }) {
  if (conflicts.length) return { kind: 'reconcile' };
  if (!plan) return { kind: null, skip: null };
  if (plan.legacy) return { kind: null, reason: 'unmigrated', skip: 'still a PLAN.md — migrate it to PLAN.json' };
  if (!plan.plan) {
    const first = plan.problems?.[0] || 'the plan does not parse';
    return { kind: null, reason: 'unparseable', skip: `the plan does not parse: ${first}`, problems: plan.problems || [] };
  }
  const { step, index, reason, why, problems } = deliverableStep(plan.plan);
  if (!step) return { kind: null, reason, skip: why, problems };
  return { kind: 'step', step, index };
}

/* ----------------------------------------------------------- the helper */

/**
 * `mc helper --intake` is a step of the runner's day, not a project: it is logged
 * runs.tsv under its own `kind` with `helper` in the name column, and it runs
 * at most once per calendar day.
 *
 * The hour is UTC and the day is UTC, so the two agree — the digest's window
 * is the day behind it, and a run before dawn would be measuring against a
 * baseline written an hour earlier. `05:00Z` is early morning here and after
 * the nightly tasks memoro runs on its own cadence.
 */
export const HELPER_KIND = 'helper';
export const HELPER_NAME = 'helper';
export const HELPER_HOUR_UTC = 5;

/**
 * Is the day's helper run due? The runs.tsv row is the whole state — there is
 * no separate stamp file to fall out of step with it — and the row is written
 * whether the run succeeded or failed. That is what "a failed collect is
 * logged and never retried within the day" means: the gate does not ask how
 * it went, only that it happened.
 */
export function helperDue({ tsv = '', now = new Date(), hour = HELPER_HOUR_UTC } = {}) {
  if (now.getUTCHours() < hour) return { due: false, why: `not before ${String(hour).padStart(2, '0')}:00Z` };
  const day = now.toISOString().slice(0, 10);
  const ran = parseRuns(tsv).find((row) => row.kind === HELPER_KIND && String(row.ts).slice(0, 10) === day);
  if (ran) return { due: false, why: `already ran today (${ran.ts}, ${ran.note || '-'})` };
  return { due: true, why: null };
}

/**
 * The runs.tsv note for a day's helper run. `success,<n>-proposals` keeps the
 * `success,...` shape every other row uses — `summariseRuns` reads a note that
 * does not start with it as a failure, and a quiet day is not a failure.
 */
export function helperNote(turn) {
  if (!turn) return 'collect-failed';
  if (turn.ok) return `success,${turn.wrote?.length ?? 0}-proposals`;
  return turn.reason || turn.note || 'failed';
}

/* ---------------------------------------------------------------- prompts */

const today = (now) => now.toISOString().slice(0, 10);

export function stepPrompt({ name, repo, planPath, planText, step, index, now = new Date() }) {
  const ordinal = Number.isInteger(index) ? index + 1 : 1;
  return [
    `You are working in the \`${name}\` workarea of ${repo} (this worktree; origin/main`,
    `is merged in). Below is your plan, \`${planPath}\`.`,
    '',
    `Your step is \`steps[${index}]\` — ${ordinal}, "${step?.title || ''}".`,
    `Done when: ${step?.done_when || ''}`,
    'That sentence is your success criterion for this session — verify it before',
    'you stop, and say in the PR body how you verified it.',
    '',
    `In the plan file you may edit that step's \`status\` and \`pr\`, the`,
    '`success_criteria` you actually met, and `what_the_code_taught_us`. Nothing',
    'else: not another step, not the goal, the contract or the scope. The runner',
    'compares the file before and after and will leave your PR unmerged if you',
    'changed anything else.',
    '',
    'If the contract must change, or a later step is wrong, set this step to',
    '`blocked` with `blocked_by` saying what the answer has to be about, and',
    'stop. Say it in the pull request too — that is where it will be read.',
    '',
    'Do not merge. Do not ask questions. Stop when the PR exists.',
    '',
    '----- PLAN.json -----',
    planText,
  ].join('\n');
}

export function reconcilePrompt({ name, repo, conflicts }) {
  return [
    `You are working in the \`${name}\` workarea of ${repo} (this worktree). A`,
    '`git merge origin/main` is in progress on this branch and stopped on',
    `conflicts in: ${conflicts.join(' ')}`,
    '',
    'Resolve them as your role says, commit the merge, push, and stop.',
  ].join('\n');
}

/* --------------------------------------------------------------- headless */

/**
 * The argument list for a session nobody sits in front of, per tool. The
 * model rides through the adapter's own `modelArgs`; the instructions
 * (Coding Profile + role overlay) through the same channel `mc work` uses;
 * the prompt is the last positional for both. Claude answers with one JSON
 * object; codex's `exec --json` streams events — parsed in
 * `readSessionOutput`.
 *
 * Codex gets `--sandbox danger-full-access`, and not the `--full-auto` this
 * started as. `--full-auto` is codex's workspace-write sandbox: no network,
 * and no writes outside the working directory. A step has to `git commit`,
 * `git push` and `gh pr create` — the network half goes at once, and the
 * commit goes with it, because a workarea's `.git` is a file pointing into
 * the main checkout's `.git/worktrees/<name>`, which is outside the working
 * directory. So a codex step under `--full-auto` could never reach the one
 * thing its prompt ends with: "Stop when the PR exists." The claude lane is
 * already `--permission-mode auto` — the workarea is the boundary the runner
 * trusts, not a sandbox inside it, and both tools are given the same.
 */
export function headlessArgs({ toolId, adapter, model, instructions, prompt, profileArgs }) {
  const modelArgs = adapter?.modelArgs?.(model) ?? [];
  const instr = profileArgs(toolId, instructions);
  if (toolId === 'codex') return ['exec', '--json', '--sandbox', 'danger-full-access', ...modelArgs, ...instr, prompt];
  return ['-p', prompt, ...modelArgs, '--permission-mode', 'auto', ...instr, '--output-format', 'json'];
}

/**
 * The usage fields runs.tsv carries, read from what the session printed.
 * Fields the tool does not give are `-`, never a guess. A quota or rate
 * limit answer is its own note: the session did not do the step.
 */
export function readSessionOutput({ toolId, stdout, stderr = '', exitCode, timedOut = false }) {
  const dash = { turns: '-', session: '-', input: '-', output: '-', cacheRead: '-', cacheWrite: '-' };
  // A limit answer is what the tool says when it refuses: one or two turns
  // and the limit text as the whole result. Session prose that mentions a
  // quota (a PR body about quota rows, say) is not a limit — 2026-08-29 the
  // runner slept 30 min and left a finished PR unmerged on exactly that.
  if (timedOut) return { ...dash, note: 'timeout', quota: false };
  if (toolId === 'codex') {
    const quota = exitCode !== 0 && quotaSeen(`${stdout}\n${stderr}`);
    return { ...dash, ...readCodexEvents(stdout), note: quota ? 'quota' : (exitCode === 0 ? 'success' : 'failed'), quota };
  }
  let json = null;
  try { json = JSON.parse(stdout); } catch { json = null; }
  if (!json || typeof json !== 'object') {
    const quota = quotaSeen(`${stdout}\n${stderr}`);
    return { ...dash, note: quota ? 'quota' : 'no-json', quota };
  }
  const usage = json.usage || {};
  const pick = (v) => (v == null ? '-' : String(v));
  const fewTurns = !(Number(json.num_turns) > 2);
  const quota = fewTurns && quotaSeen(`${json.result ?? ''}\n${stderr}`);
  return {
    turns: pick(json.num_turns),
    session: pick(json.session_id),
    input: pick(usage.input_tokens),
    output: pick(usage.output_tokens),
    cacheRead: pick(usage.cache_read_input_tokens),
    cacheWrite: pick(usage.cache_creation_input_tokens),
    note: quota ? 'quota' : (json.is_error ? 'failed' : pick(json.subtype ?? '-')),
    quota,
  };
}

function readCodexEvents(stdout) {
  const out = {};
  for (const line of String(stdout).split('\n')) {
    let event = null;
    try { event = JSON.parse(line); } catch { continue; }
    const usage = event?.usage || event?.msg?.usage || null;
    if (usage) {
      if (usage.input_tokens != null) out.input = String(usage.input_tokens);
      if (usage.output_tokens != null) out.output = String(usage.output_tokens);
      if (usage.cached_input_tokens != null) out.cacheRead = String(usage.cached_input_tokens);
    }
    const id = event?.thread_id || event?.session_id || event?.msg?.session_id;
    if (id) out.session = String(id);
  }
  return out;
}

export function quotaSeen(text) {
  return /rate limit|usage limit|weekly limit|quota|hit your (?:weekly|daily|5-hour) limit/iu.test(String(text || ''));
}

/* --------------------------------------------------------------------- log */

export function tsvRow({ ts, name, kind, exit, seconds, pr, turns, input, output, cacheRead, cacheWrite, session, note }) {
  const cell = (v) => String(v ?? '-').replace(/[\t\n]/gu, ' ');
  return [ts, name, kind, exit, seconds, pr, turns, input, output, cacheRead, cacheWrite, session, note].map(cell).join('\t');
}

export function tsvHeader() {
  return RUNS_HEADER.join('\t');
}

/* -------------------------------------------------------------- frontmatter */

/**
 * `tool`, `model`, `budget_minutes` from a PLAN.md frontmatter, with the
 * runner's defaults.
 *
 * The model default belongs to claude and to nothing else. `opus` is a claude
 * alias; handed to `codex -m` it names a model that tool does not have, and
 * the step dies on its own argument list before it has read a word of the
 * plan. A plan on another tool that names no model gets none — `modelArgs`
 * of nothing is `[]`, and the tool's own default is a better answer than
 * mc's guess at what that tool calls its best model.
 */
export function sessionSettings(fields = {}) {
  const minutes = Number(fields.budget_minutes);
  const tool = fields.tool || DEFAULT_TOOL;
  return {
    tool,
    model: fields.model || (tool === DEFAULT_TOOL ? DEFAULT_MODEL : null),
    budgetMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_BUDGET_MINUTES,
  };
}
