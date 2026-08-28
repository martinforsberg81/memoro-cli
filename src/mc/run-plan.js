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
 * The rules are `~/mc/bin/runner.sh`'s, line by line — the shell runner is
 * what nights 1–2 measured (`~/mc/runner/log/natt-1.md`), and this module
 * changes none of them. Two things it adds: a quota answer is logged as
 * `quota`, not `success` (the shell runner logged the weekly limit of
 * 2026-08-26 as eleven successful eight-second steps), and the tool and
 * model come from the project's frontmatter.
 */

export const RUNS_HEADER = ['ts', 'name', 'kind', 'exit', 'seconds', 'pr', 'turns', 'input', 'output', 'cache_read', 'cache_write', 'session', 'note'];
export const DEFAULT_MODEL = 'opus';
export const DEFAULT_TOOL = 'claude';
export const DEFAULT_BUDGET_MINUTES = 90;
export const QUOTA_SLEEP_MS = 30 * 60 * 1000;
export const TIMEOUT_EXIT = 142; // what the shell runner's `perl alarm` left in runs.tsv

/* ------------------------------------------------------------------ queue */

/**
 * Martin's order first (`queue.md`, comments and blanks ignored), then every
 * project with a PLAN.md on origin/main that the queue did not name, sorted.
 * The shell runner lists every plan and lets the status decide at run time;
 * so does this — a `done` plan is one skip line, which is also information.
 */
export function assembleQueue(queueText, plans) {
  const named = String(queueText || '').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  const seen = new Set(named);
  const rest = [...new Set(plans.map((p) => p.project))].filter((name) => !seen.has(name)).sort();
  return [...named, ...rest];
}

/* ------------------------------------------------------------------- kind */

/**
 * What a project gets this round. `conflicts` non-empty means the merge of
 * origin/main stopped and is left in progress; `plan` is null when no
 * PLAN.md exists in the worktree; `answered` lists decision files with a
 * `**Beslut:**` line for the project or its programme.
 */
export function chooseKind({ plan, conflicts = [], answered = [] }) {
  if (conflicts.length) return { kind: 'reconcile' };
  if (!plan) return { kind: 'triage' };
  if (plan.status === 'ready') return { kind: 'step' };
  if (plan.status === 'waiting-decision') {
    return answered.length ? { kind: 'step', answered } : { kind: null, skip: 'waiting-decision (no Beslut line yet)' };
  }
  return { kind: null, skip: `status ${plan.status || 'missing'}` };
}

/** The `**Beslut:**` test the whole decision mechanism rests on. */
export function isAnswered(text) {
  return /^\*\*Beslut/mu.test(String(text || ''));
}

/* ---------------------------------------------------------------- prompts */

const today = (now) => now.toISOString().slice(0, 10);

export function stepPrompt({ name, repo, planPath, planText, answered = [], now = new Date() }) {
  const head = [
    `You are working in the \`${name}\` workarea of ${repo} (this worktree; origin/main`,
    `is merged in). Below is your plan, \`${planPath}\`. Do the step named in \`next:\`;`,
    'its "done when" is your success criterion for this session — verify it before',
    'you stop, and say in the PR body how you verified it.',
    '',
    `If the Contract must change, the decision file is \`../decisions/${name}-${today(now)}.md\`.`,
    'Do not merge. Do not ask questions. Stop when the PR exists.',
  ];
  const decisions = answered.length
    ? [
      '',
      '----- Decisions answered by Martin -----',
      'The plan says waiting-decision, but these decision files now carry a line',
      'starting with **Beslut:** — read them first, apply the answer, set status:',
      'ready (or blocked if the answer blocks), and then do the next step if it fits',
      'in this session:',
      ...answered,
    ]
    : [];
  return [...head, ...decisions, '', '----- PLAN.md -----', planText].join('\n');
}

export function triagePrompt({ name, repo, now = new Date() }) {
  return [
    `You are working in the \`${name}\` workarea of ${repo} (this worktree). There is no`,
    `\`docs/project/*/${name}/PLAN.md\` yet. Write it as your role says, under the`,
    `programme it belongs to; a question for Martin goes in \`../decisions/${name}-${today(now)}.md\`.`,
    `Open a PR titled "Plan: ${name}" and land it with \`mc merge ${repo} <pr> --docs\`.`,
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
 * `readSessionOutput`. Codex is not measured live: it is not installed here.
 */
export function headlessArgs({ toolId, adapter, model, instructions, prompt, profileArgs }) {
  const modelArgs = adapter?.modelArgs?.(model) ?? [];
  const instr = profileArgs(toolId, instructions);
  if (toolId === 'codex') return ['exec', '--json', '--full-auto', ...modelArgs, ...instr, prompt];
  return ['-p', prompt, ...modelArgs, '--permission-mode', 'auto', ...instr, '--output-format', 'json'];
}

/**
 * The usage fields runs.tsv carries, read from what the session printed.
 * Fields the tool does not give are `-`, never a guess. A quota or rate
 * limit answer is its own note: the session did not do the step.
 */
export function readSessionOutput({ toolId, stdout, stderr = '', exitCode, timedOut = false }) {
  const dash = { turns: '-', session: '-', input: '-', output: '-', cacheRead: '-', cacheWrite: '-' };
  const quota = quotaSeen(`${stdout}\n${stderr}`);
  if (timedOut) return { ...dash, note: 'timeout', quota };
  if (toolId === 'codex') return { ...dash, ...readCodexEvents(stdout), note: quota ? 'quota' : (exitCode === 0 ? 'success' : 'failed'), quota };
  let json = null;
  try { json = JSON.parse(stdout); } catch { json = null; }
  if (!json || typeof json !== 'object') return { ...dash, note: quota ? 'quota' : 'no-json', quota };
  const usage = json.usage || {};
  const pick = (v) => (v == null ? '-' : String(v));
  return {
    turns: pick(json.num_turns),
    session: pick(json.session_id),
    input: pick(usage.input_tokens),
    output: pick(usage.output_tokens),
    cacheRead: pick(usage.cache_read_input_tokens),
    cacheWrite: pick(usage.cache_creation_input_tokens),
    note: quota ? 'quota' : pick(json.subtype ?? '-'),
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

/** `tool`, `model`, `budget_minutes` from a PLAN.md frontmatter, with the runner's defaults. */
export function sessionSettings(fields = {}) {
  const minutes = Number(fields.budget_minutes);
  return {
    tool: fields.tool || DEFAULT_TOOL,
    model: fields.model || DEFAULT_MODEL,
    budgetMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_BUDGET_MINUTES,
  };
}
