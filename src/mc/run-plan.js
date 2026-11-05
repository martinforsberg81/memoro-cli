/**
 * `mc run` — the decisions the runner makes without starting anything.
 *
 * Everything here is a function of text and small objects: the prompts a
 * goal's build, review and plan session is given; the headless argument list
 * per tool; what a finished session's output means; when the helper, intake
 * and nightly chores are due; and the runs.tsv row. The process-touching half
 * (git, gh, the session itself) is run.js, and it calls in here so that the
 * tests can cover the rules with no session. The runner starts goals only.
 *
 * These rules began as `~/mc/bin/runner.sh`'s, line by line — the shell
 * runner nights 1–2 measured (`~/mc/runner/log/natt-1.md`). That file is
 * deleted (Martin, 2026-08-29: "Inget att hålla kvar"); `mc run` had taken
 * over the nights by then. What it did differently and this does not: it
 * logged a weekly quota answer as eleven successful eight-second steps, it
 * ran every tool as claude on opus, it wrote plans it had invented, and it
 * started projects off answered decision files.
 */
import { CLAUDE_TOOLS } from '../adapters/claude-code.js';
import { parseRuns } from './brief-collect.js';
import { EFFORT_LEVELS } from './plan-schema.js';
import { estimateCost } from './prices.js';

/**
 * The runs.tsv columns. `land_seconds` is last and not beside `seconds` on
 * purpose: the header is written once, when the file is created, and the file
 * on this machine still carries the thirteen it was made with. A column
 * appended is a cell a header-keyed reader ignores; a column inserted would
 * shift `note` one to the left for every reader of the old header, and
 * an old reader may still key on it.
 * `model` (step-cost, 2026-09-11) is appended after it for the same reason:
 * the alias the session was launched on, `-` on every row that is not a
 * session and on every row written before it. `class`, `tool`, `effort` and
 * `billing` (ruling 59) follow it for the same reason: what the session was
 * routed to, the work class it was asked for (`-` for a concrete plan), and
 * the billing it ran on. Rows written before them have no such cells.
 */
export const RUNS_HEADER = ['ts', 'name', 'kind', 'exit', 'seconds', 'pr', 'turns', 'input', 'output', 'cache_read', 'cache_write', 'session', 'note', 'land_seconds', 'model', 'class', 'tool', 'effort', 'billing'];

/**
 * What a session runs on when neither its step nor its plan says otherwise,
 * per kind. A step is `opus` at `medium` effort with no advisor (2026-09-25,
 * ruling 18's second addendum; from 2026-09-11 it was `sonnet` with an `opus`
 * advisor). (Until 2026-09-12 a repair session kept `opus` with no effort
 * flag and no advisor; ruling 21 removed it.) These are claude's aliases and
 * nobody else's — see `sessionSettings`.
 */
export const SESSION_DEFAULTS = Object.freeze({
  step: Object.freeze({ model: 'opus', effort: 'medium', advisor: null }),
  review: Object.freeze({ model: 'opus', effort: 'high', advisor: null }),
});
/**
 * The role a goal's build session runs with (`canon/roles/build-session.md`,
 * its `goal` part).
 */
export const BUILD_ROLES = Object.freeze({ goal: 'build-session:goal' });
// The context window at which a claude step session compacts
// (`--autocompact`, 100k–1M on claude 2.1.268). Over 2026-09-05..12 the mean
// context per turn was 112k tokens, 36 of 295 sessions averaged over 200k and
// one over 300k — every turn paid for all of it. At 150k claude compacts well
// before the model's own limit. A constant and not a plan field: nothing has
// shown a plan needing another; the measurement after twenty sessions would.
export const AUTOCOMPACT_TOKENS = 150_000;
export const DEFAULT_TOOL = 'claude';
// How often a running claude session is asked whether its step can be
// finished (ruling 18: no session is killed on elapsed time). Median session
// wall was 17 minutes, p90 47.6, over 2026-09-05..12, so the first check-in
// reaches the sessions that are already unusual.
export const DEFAULT_CHECK_IN_MINUTES = 60;
// How long a claude session may write nothing to stdout before it is killed
// as stalled. The Bash ceiling a session's command gets is ten minutes
// (`BASH_DEFAULT_TIMEOUT_MS` in run.js), so a session is never legitimately
// silent for twenty.
export const DEFAULT_STALL_MINUTES = 20;
// How long a claude process may take to exit once its `result` line has been
// seen. The session has answered by then: a process that hangs past this is
// killed with the result standing, not stalled (2026-09-13,
// `sql-w2-search-closure` sat twenty minutes after a successful result).
export const RESULT_GRACE_MS = 2 * 60 * 1000;
export const QUOTA_SLEEP_MS = 30 * 60 * 1000;
export const TIMEOUT_EXIT = 142; // what the shell runner's `perl alarm` left in runs.tsv

/**
 * What a landing round leaves in the runs.tsv note, after `success,`.
 *
 * The two fields that are read are `merged_into` and `off_default`, and they
 * exist because a round on #363 said "merged as 7dcbf96" and was right — into
 * the stacked base it was aimed at — while everyone read "on main". A merge
 * that did not land on the default branch is not a merge this reports as one:
 * `off-main` is its own outcome, not `merged` and not `open`. Read by the
 * docs landings the runner still makes (the archive pull request).
 */
export function landingNote(report, { defaultBranch = 'main' } = {}) {
  if (!report) return 'open';
  const into = report.merged_into || null;
  const branch = report.default_branch || defaultBranch;
  if (report.merged) {
    if (report.off_default || (into && into !== branch)) return `off-${branch}`;
    return 'merged';
  }
  const stopped = report.stopped_at || 'unknown';
  return `open,gate-${stopped}`;
}

/* ----------------------------------------------------------- the helper */

/**
 * `mc helper --collect` is a step of the runner's day, not a project: it is
 * logged in runs.tsv under its own `kind` with `helper` in the name column, and
 * it runs at most once per calendar day.
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
 * The drain is the other half of the same verb and asks a different question,
 * so it has a gate and a kind of its own.
 *
 * `helperDue` is right for the collect: one digest per repository per calendar
 * day, whatever else happens. It is wrong for the turn, whose question is *is
 * there a file in the inbox?* — a question a day boundary has nothing to say
 * about. Sharing the gate meant a round could only ever read one file a day and
 * only if it had also collected, which is how thirteen digests came to be
 * waiting in a directory that is supposed to drain.
 *
 * `intake` is its own `kind` rather than a second meaning for `helper`: the two
 * are counted apart (the run summary in the page), `helperDue` is not closed for the
 * day by a drain that happened to run, and a reader of runs.tsv can tell the
 * script that read production from the model that read one file. The cost is
 * that the twelve `helper` rows written before 2026-09-05 mean both things; the
 * kind column tells them apart from here on and nothing re-reads the old ones.
 */
export const INTAKE_KIND = 'intake';

/**
 * How many files one round drains. Three, and the number is what a round costs:
 * a turn is capped at ten minutes (`DEFAULT_TURN_MINUTES`) and measured at two
 * to three, so a round's drain is bounded at half an hour and typically under
 * ten minutes — beside a lane's step, seventeen minutes at the median, that is noise. One file a
 * round would be smaller still and would take thirteen rounds to work through
 * the backlog that exists today; the whole inbox in one round is the version
 * with no bound at all, and an inbox Martin drops forty screenshots into would
 * stop the runner for a morning.
 */
export const INTAKE_PER_ROUND = 3;

/**
 * The inbox in the order it drains: oldest first, by the date in the name.
 *
 * By the date and not by the name itself, because the collector's two
 * generations of filename do not sort against each other as strings —
 * `errors-memoro-2026-09-04.md` sorts before `errors-memoro-cli-2026-08-31.md`
 * on the `2` against the `c`, which would put every memoro digest ahead of every
 * memoro-cli one whatever day either was written.
 *
 * A name with no date in it sorts last, under its own name. That is arrival
 * order too: the dated files are the collector's, written on the day they name,
 * and a file Martin dropped in by hand arrived now.
 *
 * Pure over a listing of filenames — dotfiles dropped, directories never in it
 * (`~/mc/intake/decisions-archive/` is an archive already, and the caller lists
 * files).
 */
export function intakeQueue(names = []) {
  return names
    .filter((name) => typeof name === 'string' && name && !name.startsWith('.'))
    .map((name) => ({ name, date: /(\d{4}-\d{2}-\d{2})/u.exec(name)?.[1] || '9999-99-99' }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name))
    .map((item) => item.name);
}

/**
 * Is the day's collect due? The runs.tsv row is the whole state — there is
 * no separate stamp file to fall out of step with it — and a row is written
 * whether the collect succeeded or failed. That is what "a failed collect is
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
 * The nightly's chore: a full run of every repository mc knows, once a day.
 *
 * Its `runs.tsv` rows carry `nightly` in both the name and the kind column, as
 * the helper's carry `helper`, and for the same reason: the row is the whole
 * state. There is no stamp file and no pid file beside it to fall out of step.
 */
export const NIGHTLY_KIND = 'nightly';
export const NIGHTLY_NAME = 'nightly';

/**
 * The daily `mc deps` reading of every repository mc knows, on the nightly's
 * cadence and gated the same way, by its own row. It is a chore of its own
 * rather than a part of the tick: a tick skipped behind a gate round, or
 * stopped, would otherwise leave the deps unread for another day.
 */
export const DEPS_KIND = 'deps';
export const DEPS_NAME = 'deps';

/** The daily `mc tidy --apply` (tidy.js), gated by its own row like the deps reading. */
export const TIDY_KIND = 'tidy';

/**
 * Once a day.
 *
 * The cadence is Martin's day rather than a cron expression: one full reading
 * of every repository mc knows, which is about 400 s of this machine on the
 * two it knows today. The number sits here beside the chore that uses it, as
 * `HELPER_HOUR_UTC` does, and there is no flag to change it.
 */
export const NIGHTLY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Is the nightly tick due? Twenty-four hours since the last one, measured from
 * that tick's own row and never from an hour of the clock.
 *
 * This is `helperDue`'s shape and deliberately not its rule. A wall-clock hour
 * is the wrong cadence for a laptop twice over: asleep at the hour it never
 * sees it, and a scheduler that notices the miss on waking fires a burst of
 * catch-up runs at breakfast (`nightly-loop.js`). Measured from the last tick,
 * sleep simply stretches the gap and the first tick after waking is one tick.
 *
 * A row is written whether the tick measured, skipped or threw, so the gate
 * asks only that a tick happened — a tick that failed is not retried ten
 * minutes later in a loop. A row whose `ts` does not parse says nothing about
 * when a tick happened and is passed over; with no readable row at all the
 * tick is due, and the row it writes then is the one that closes the gate.
 */
export function nightlyDue({ tsv = '', now = new Date(), intervalMs = NIGHTLY_INTERVAL_MS, kind = NIGHTLY_KIND } = {}) {
  const times = parseRuns(tsv)
    .filter((row) => row.kind === kind)
    .map((row) => Date.parse(row.ts))
    .filter((ms) => !Number.isNaN(ms));
  if (!times.length) return { due: true, why: null };
  const last = Math.max(...times);
  const gone = now.getTime() - last;
  const ago = `the last tick was ${spanOf(gone)} ago (${new Date(last).toISOString()})`;
  if (gone >= intervalMs) return { due: true, why: ago };
  return { due: false, why: `${ago}; the next is due in ${spanOf(intervalMs - gone)}` };
}

/** A span of time as a person says it: minutes below two hours, hours above. */
function spanOf(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours} h`;
}

/**
 * The runs.tsv note for one repository's collect. The outcome comes first and
 * the detail after, because the run summary reads a note that does not start
 * with `success` as a failure — and every helper row until 2026-09-05 was
 * `memoro,success,0-proposals`, which it counted as one.
 */
export function collectNote({ repo, digest = null }) {
  if (!digest) return `collect-failed,${repo}`;
  const delta = digest.data?.delta || {};
  return `success,${repo},${delta.first ? 'first-digest' : `${delta.fingerprints?.length ?? 0}-new`}`;
}

/**
 * The runs.tsv note for one drained file. `success,<n>-proposals` keeps the
 * `success,...` shape every other row uses; which file it was is the row's
 * `name` column, which is the column for naming the thing a row is about.
 */
export function intakeNote(turn) {
  if (!turn) return 'turn-missing';
  if (turn.ok) return `success,${turn.wrote?.length ?? 0}-proposals`;
  return turn.reason || turn.note || 'failed';
}

/* ---------------------------------------------------------------- prompts */


/**
 * The goal as text (`renderGoalText`, what `mc goal show` prints), after a
 * prompt: the brief a goal's build, review and plan session is given.
 */
function withBrief(prompt, brief) {
  return brief ? `${prompt}\n\nThe goal, as \`mc goal show\` renders it:\n\n${brief.trimEnd()}` : prompt;
}

/**
 * What a goal session is told: where the goal is and where it works, and the
 * goal itself (`brief`). The rest is the build role's
 * (`canon/roles/build-session.md`, its `goal` part).
 */
export function goalPrompt({ name, dir, worktree, branch, brief = null }) {
  return withBrief(`You are a session on the goal ${name}. Its directory is \`${dir}\`, with GOAL.json and LOG.md; your worktree is \`${worktree}\`, on branch \`${branch}\`. Your role says the rest.`, brief);
}

/**
 * What a goal's review session is told: the goal, its worktree, and the pull
 * request with the head it is to judge. The rest is `canon/roles/review-session.md`'s
 * (its `goal` part).
 */
export function goalReviewPrompt({ name, dir, worktree, branch, pr, head, brief = null }) {
  return withBrief(`You review the goal ${name}. Its directory is \`${dir}\`, with GOAL.json and LOG.md; its worktree is \`${worktree}\`, on branch \`${branch}\`. Its pull request is #${pr}, at head ${head}: that head is what you judge. Your role says the rest.`, brief);
}

/**
 * What a headless plan session on a goal is told: the goal, the stage it
 * takes it in — `finish` (a review found it not OK, or the build could not
 * end it) or `merge` (the merger answered red, or its head moved) — the
 * runner's last word on it, and where its worktree is, which it works in
 * itself. The rest is `canon/roles/plan-session.md`'s.
 */
export function goalPlanPrompt({ name, dir, worktree, branch, stage = 'finish', why = null, brief = null }) {
  const reason = [why?.done, why?.comment].filter(Boolean).join(' — ');
  const task = stage === 'merge'
    ? 'it is in merge and the merger did not land it: take the red in its worktree, publish, and queue it again'
    : 'it is in finish: read its REVIEW.md, when there is one, and LOG.md, fix it in its worktree, publish, and move it to merge';
  return withBrief([
    `The goal ${name} is yours to finish, headless — ${task}.${reason ? ` The last word on it: ${reason}.` : ''}`,
    `Its directory is \`${dir}\`, with GOAL.json and LOG.md; its worktree is \`${worktree}\`, on branch \`${branch}\`. Your role says the rest.`,
  ].join('\n'), brief);
}

/** `checkInPrompt` for a headless plan session on a goal. */
export function goalPlanCheckInPrompt({ minutes, count }) {
  return [
    `Check-in from the runner: you have been running for ${minutes} minutes (this is check-in number ${count}).`,
    'If you can still make useful progress, say so in one line and go on. This check-in is not a deadline.',
    '',
    'You retain planning and implementation authority: resolve technical choices, missing planning detail and bounded test scope yourself within the promised outcome and Martin\'s explicit constraints. Preserve acceptance and gate requirements.',
    'Block only for a decision or act reserved for Martin: `mc goal blocked --reason "<what only Martin can decide or do, what you tried, and your recommendation>"`. If the goal is wrong, use your role\'s drop/replacement path.',
  ].join('\n');
}

/**
 * What the runner writes to a running goal session every `check_in_minutes`
 * (ruling 18). Nothing is killed on elapsed time; instead the session is
 * asked to judge whether it is still moving the goal.
 */
export function goalCheckInPrompt({ minutes, count }) {
  return [
    `Check-in from the runner: you have been running for ${minutes} minutes (this is check-in number ${count}).`,
    'Judge whether this session is still moving the goal.',
    '',
    'If it is, say so in one line and go on — no other answer is needed.',
    '',
    'If it is not — you are going in circles, a test cannot be made green — commit',
    'what you have, publish it, end with `mc goal log` saying what the next session',
    'should do differently, and stop.',
  ].join('\n');
}

/* --------------------------------------------------------------- headless */

/**
 * The argument list for a session nobody sits in front of, per tool. The
 * model rides through the adapter's own `modelArgs`, and for claude the
 * effort and the advisor through its `effortArgs` and `advisorArgs`, and codex
 * its effort through its own `effortArgs` (`-c model_reasoning_effort`) and no
 * advisor; the instructions
 * (`all-sessions.md` + role overlay) through the same channel an interactive session uses;
 * the prompt is codex's last positional. Claude runs on stream-json both
 * ways (`stream: true`, the step lanes): the prompt is not an
 * argument at all but the first user message `deps.session` writes on stdin,
 * followed by the check-ins, and what comes back is one event per line ending
 * in a `result` line. The helper and intake turns pass `stream: false` and
 * keep the positional prompt and the one JSON object. Codex's `exec --json`
 * streams its own events. Both are parsed in `readSessionOutput`.
 *
 * Codex gets `--sandbox danger-full-access`, and not the `--full-auto` this
 * started as. `--full-auto` is codex's workspace-write sandbox: no network,
 * and no writes outside the working directory. A step has to `git commit`,
 * `git push` and `gh pr create` — the network half goes at once, and the
 * commit goes with it, because a workarea's `.git` is a file pointing into
 * the main checkout's `.git/worktrees/<name>`, which is outside the working
 * directory. So a codex step under `--full-auto` could never reach the one
 * thing its prompt ends with: "Stop when the PR exists." The workarea is the
 * boundary the runner trusts, not a sandbox inside it, and both tools are
 * given the same.
 *
 * The claude lane was `--permission-mode auto` until 2026-09-03. Auto mode
 * routes every Bash call through a classifier and tells the session to do
 * its work through Bash rather than the native tools — and the sessions did:
 * over 59 step sessions (2026-09-01..03) 5 397 Bash calls against 255
 * Read/Grep/Edit/Write, 2 699 of them `sed -n`/`grep -n` reads of a screen
 * at a time, each one a model turn on a large context. That was about half
 * of a step's turns and the largest single share of its wall-clock.
 * `acceptEdits` runs the same session without the classifier and without
 * that instruction; `~/.claude/settings.json` allows Bash outright, so
 * nothing a step needs waits on a prompt nobody is there to answer.
 *
 * Claude also gets `--autocompact` at `AUTOCOMPACT_TOKENS`, so a session's
 * context has a ceiling; codex has no such flag. The helper and intake turns
 * pass `autocompact: null` — they are not this runner's step lane, and
 * step-cost's contract leaves them as they were.
 *
 * Every claude launch gets the `CLAUDE_TOOLS` allowlist and
 * `--strict-mcp-config`, including the tool's own Agent without mc-defined
 * agents. The same adapter session switches enable native Codex delegation,
 * for every role and for fresh and resumed sessions. Tool definitions ride in
 * every request, so Claude's allowlist stays narrow; `Grep` and `Glob` keep
 * searches in native tools rather than Bash. `--strict-mcp-config` keeps
 * user-level MCP servers and their tool definitions out of the lane.
 */
export { CLAUDE_TOOLS };

export function headlessArgs({ toolId, adapter, model, effort = null, advisor = null, instructions, prompt, profileArgs, autocompact = AUTOCOMPACT_TOKENS, stream = true, resume = null, cache = '1h' }) {
  const modelArgs = adapter?.modelArgs?.(model) ?? [];
  const effortArgs = adapter?.effortArgs?.(effort) ?? [];
  // No CLAUDE.md, AGENTS.md or memory, and the role's TTL — new and resumed.
  const session = adapter?.sessionArgs?.({ cache }) ?? [];
  const instr = profileArgs(toolId, instructions);
  // `codex exec resume` takes no `--sandbox` (codex-cli 0.151.0): the same
  // setting goes through `-c`, and the session id is the first positional.
  if (toolId === 'codex' && resume) return ['exec', 'resume', '--json', ...modelArgs, ...effortArgs, '-c', 'sandbox_mode="danger-full-access"', ...session, ...instr, resume, prompt];
  if (toolId === 'codex') return ['exec', '--json', '--sandbox', 'danger-full-access', ...modelArgs, ...effortArgs, ...session, ...instr, prompt];
  const tuning = [...effortArgs, ...(adapter?.advisorArgs?.(advisor) ?? [])];
  const compact = autocompact ? ['--autocompact', String(autocompact)] : [];
  const io = stream
    ? ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
    : ['--output-format', 'json'];
  // `--resume` keeps the session's id and its whole history; the message on
  // stdin is the next turn of that conversation.
  const resumed = resume ? ['--resume', resume] : [];
  const tools = ['--tools', CLAUDE_TOOLS];
  return ['-p', ...resumed, ...(stream ? [] : [prompt]), ...modelArgs, ...tuning, '--permission-mode', 'acceptEdits', ...compact, ...tools, '--strict-mcp-config', ...session, ...instr, ...io];
}

/** One stream-json user message, as `deps.session` writes it on claude's stdin. */
export function userMessageLine(text) {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: String(text) } })}\n`;
}

/**
 * What the runner writes instead of killing a session that has been silent
 * for `stall_minutes` while a background task of its own runs. Waiting on
 * one is silence, and before this every wait longer than the stall guard was
 * killed as a hang (2026-09-12..25: 53 of 289 step sessions, the G6
 * comparison and `npm test` among them). An answer shows the session is
 * alive; none, and it is killed at the next stall.
 */
export function quietPrompt({ minutes, tasks }) {
  return [
    `From the runner: this session has written nothing for ${minutes} minutes, and`,
    'these background tasks of yours are still running:',
    ...tasks.map((t) => `- ${t.task_id || '?'}: ${t.description || ''}`),
    '',
    'Look at their output now. If one is making progress, say so in one line —',
    'you may end your turn again; you are woken when it finishes. If one is',
    'stuck, stop it and carry on without it. A session that answers nothing',
    `for another ${minutes} minutes is killed.`,
  ].join('\n');
}

const USAGE_SUMS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
const RESULT_SUMS = ['num_turns', 'duration_ms'];

const add = (a, b) => (typeof b === 'number' ? (typeof a === 'number' ? a + b : b) : a);

/**
 * What a stream-json run that never printed a `result` still says about
 * itself, read from its `assistant` events: the session id (on every
 * event), the turns (one per distinct message id — an event is printed per
 * content block, all of one message carrying the same `usage`), the four
 * usage counts and the per-model split, and a list-price cost for the whole.
 *
 * This is the ordinary end of a landed step since ruling 21: the session
 * runs `mc merge` itself, green writes `done` and ends the process — so
 * the `result` line never comes, and 2026-09-18..22 runs.tsv had turns and
 * usage for 6 of 220 step rows. Shaped like a `result` object so
 * `scripts/measure-steps.py` reads it as one, with `subtype: 'killed'` and
 * no `result` text: `sessionResult` does not return it, because a session
 * that answered and one that was ended are different things to
 * `readSessionOutput` (quota, `is_error`). Null when the stream has no
 * assistant event at all.
 */
export function streamSummary(stdout) {
  const messages = new Map();
  let session = null;
  let last = null;
  let model = null;
  for (const line of String(stdout || '').split('\n')) {
    if (!line.includes('"type":"assistant"')) continue;
    let event = null;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== 'assistant' || !event.message?.id) continue;
    // `<synthetic>` is claude's own placeholder message (an interrupted turn,
    // a check-in's acknowledgement); it carries no usage and is not a turn.
    if (event.message.model === '<synthetic>') continue;
    session = event.session_id || session;
    model = event.message.model || model;
    last = event.message.usage || last;
    messages.set(event.message.id, { model: event.message.model, usage: event.message.usage || {} });
  }
  if (!messages.size) return null;
  const usage = {};
  const modelUsage = {};
  for (const { model: m, usage: u } of messages.values()) {
    for (const key of USAGE_SUMS) usage[key] = add(usage[key], u[key]) ?? 0;
    const into = modelUsage[m] || (modelUsage[m] = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
    into.inputTokens += u.input_tokens || 0;
    into.outputTokens += u.output_tokens || 0;
    into.cacheReadInputTokens += u.cache_read_input_tokens || 0;
    into.cacheCreationInputTokens += u.cache_creation_input_tokens || 0;
    // The write's TTL split, priced at its own rate; absent, the total is the 1h default.
    if (u.cache_creation) {
      into.cacheWrite5mTokens = (into.cacheWrite5mTokens || 0) + (u.cache_creation.ephemeral_5m_input_tokens || 0);
      into.cacheWrite1hTokens = (into.cacheWrite1hTokens || 0) + (u.cache_creation.ephemeral_1h_input_tokens || 0);
    }
  }
  let cost = 0;
  for (const [m, u] of Object.entries(modelUsage)) {
    const c = estimateCost({ input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadInputTokens, cacheWrite: u.cacheCreationInputTokens, cacheWrite5m: u.cacheWrite5mTokens, cacheWrite1h: u.cacheWrite1hTokens }, m);
    if (c != null) { u.costUSD = c; cost += c; }
  }
  return { type: 'result', subtype: 'killed', is_error: false, session_id: session, num_turns: messages.size, usage, modelUsage, total_cost_usd: cost, model, last_usage: last };
}

/**
 * The session's result, read from what claude printed: the last `result`
 * line of a stream-json run, with the per-turn-group amounts of every result
 * line added up.
 *
 * One process can print more than one (proven 2026-09-11, step-cost step 3):
 * a check-in written just as the session finished starts a new turn with its
 * own `result`. `num_turns`, `duration_ms` and the four `usage` counts are
 * that turn group's, so they are summed. `total_cost_usd`, `duration_api_ms`
 * and `modelUsage` are running totals for the session (measured 2026-10-13,
 * ruling 42), so they are the last line's, as are `subtype`, `is_error`,
 * `result` and `session_id`.
 *
 * Output that is one JSON object and no `result` line — `--output-format
 * json`, which the helper still runs on — is read whole, as it always was.
 * A zero-turn `result` (the stale notification a resume opens with) is no
 * answer and is skipped. Null when there is neither.
 */
export function sessionResult(stdout) {
  const results = [];
  for (const line of String(stdout || '').split('\n')) {
    if (!line.includes('"result"')) continue;
    let event = null;
    try { event = JSON.parse(line); } catch { continue; }
    if (event && typeof event === 'object' && event.type === 'result' && event.num_turns !== 0) results.push(event);
  }
  if (!results.length) {
    let json = null;
    try { json = JSON.parse(stdout); } catch { json = null; }
    if (json?.type === 'result' && json.num_turns === 0) return null;
    return json && typeof json === 'object' && !Array.isArray(json) ? json : null;
  }
  const last = results.at(-1);
  if (results.length === 1) return last;
  const out = { ...last };
  for (const key of RESULT_SUMS) out[key] = results.reduce((sum, r) => add(sum, r[key]), undefined);
  const usage = { ...(last.usage || {}) };
  for (const key of USAGE_SUMS) usage[key] = results.reduce((sum, r) => add(sum, r.usage?.[key]), undefined);
  out.usage = usage;
  return out;
}

/**
 * The usage fields runs.tsv carries, read from what the session printed.
 * Fields the tool does not give are `-`, never a guess. A quota or rate
 * limit answer is its own note: the session did not do the step.
 *
 * `stalled` is the runner's kill — a session silent for `stall_minutes` —
 * and its note is `stalled`. `timedOut` alone is the helper turn's own
 * wall-clock cap, which that lane keeps, and stays `timeout`.
 */
export function readSessionOutput({ toolId, stdout, stderr = '', exitCode, timedOut = false, stalled = false, now = new Date() }) {
  const dash = { turns: '-', session: '-', input: '-', output: '-', cacheRead: '-', cacheWrite: '-', quotaReset: null };
  // A limit answer is what the tool says when it refuses: one or two turns
  // and the limit text as the whole result. Session prose that mentions a
  // quota (a PR body about quota rows, say) is not a limit — 2026-08-29 the
  // runner slept 30 min and left a finished PR unmerged on exactly that.
  if (stalled) return { ...dash, note: 'stalled', quota: false };
  if (timedOut) return { ...dash, note: 'timeout', quota: false };
  if (toolId === 'codex') {
    // Codex's own refusals are its `error` and `turn.failed` events; the rest
    // of the stream is the session's work, which may well say "quota" — on
    // 2026-10-29 a crashed step read as one and every lane slept 30 min.
    const text = `${codexErrors(stdout)}\n${stderr}`;
    const quota = exitCode !== 0 && quotaSeen(text);
    return { ...dash, ...readCodexEvents(stdout), note: quota ? 'quota' : (exitCode === 0 ? 'success' : 'failed'), quota, quotaReset: quota ? quotaResetAt(text, now) : null };
  }
  const json = sessionResult(stdout);
  if (!json) {
    // No answer: the runner killed the session (a landing through `mc merge`,
    // rc=143), or the API ended it without a result line. Whether the quota
    // did it is what the stream's own `rate_limit_event` says, or what claude
    // itself wrote on stderr — never the words in the session's work, which
    // is stdout. 2026-10-07: six 30-minute pauses in one day, every one a
    // step whose *work* mentioned rate limiting (the legal register,
    // merge-robustness) while every rate_limit_event said allowed.
    const refused = streamRateLimit(stdout);
    const quota = refused != null || quotaSeen(stderr);
    // The turns it took are in the stream: a session `mc merge` ended keeps
    // its row's turns, usage and session id.
    const stream = streamSummary(stdout);
    const counts = stream ? {
      turns: String(stream.num_turns),
      session: stream.session_id ?? '-',
      input: String(stream.usage.input_tokens),
      output: String(stream.usage.output_tokens),
      cacheRead: String(stream.usage.cache_read_input_tokens),
      cacheWrite: String(stream.usage.cache_creation_input_tokens),
    } : {};
    return { ...dash, ...counts, note: quota ? 'quota' : 'no-json', quota, quotaReset: quota ? (refused?.resetsAt ?? quotaResetAt(stderr, now)) : null };
  }
  const usage = json.usage || {};
  const pick = (v) => (v == null ? '-' : String(v));
  const fewTurns = !(Number(json.num_turns) > 2);
  const text = `${json.result ?? ''}\n${stderr}`;
  const interrupted = apiInterruption(json);
  // A classified refusal decides its own kind; the turn-count reading is for a
  // stream nothing classified. A workspace limit is `credits` at any turn count,
  // and `quotaSeen` would call it a quota (its `usage limit`) in a short session.
  const quota = interrupted ? interrupted.kind === 'quota' : (fewTurns && quotaSeen(text));
  return {
    // Only on a session the API ended.
    // `creditsUntil` is the date a workspace limit names, for `noteRefusal`.
    ...(quota || interrupted ? { interrupted: quota ? 'quota' : interrupted.kind, said: interrupted?.said ?? null, creditsUntil: interrupted?.until ?? null } : {}),
    turns: pick(json.num_turns),
    session: pick(json.session_id),
    input: pick(usage.input_tokens),
    output: pick(usage.output_tokens),
    cacheRead: pick(usage.cache_read_input_tokens),
    cacheWrite: pick(usage.cache_creation_input_tokens),
    note: quota ? 'quota' : (interrupted ? 'interrupted' : (json.is_error ? 'failed' : pick(json.subtype ?? '-'))),
    quota,
    quotaReset: quota ? quotaResetAt(text, now) : null,
  };
}

/** The messages of a `codex exec --json` stream's `error` and `turn.failed` events, one per line. */
export function codexErrors(stdout) {
  const said = [];
  for (const line of String(stdout || '').split('\n')) {
    if (!line.includes('"error"') && !line.includes('"turn.failed"')) continue;
    let event = null;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'error' && typeof event.message === 'string') said.push(event.message);
    if (event?.type === 'turn.failed' && typeof event.error?.message === 'string') said.push(event.error.message);
  }
  return said.join('\n');
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

/**
 * The last `rate_limit_event` in a stream-json run that was a refusal:
 * `{ status, resetsAt }` with `resetsAt` a Date (or null), or null when every
 * event said `allowed` (or there was none). claude writes one of these on
 * every turn with `rate_limit_info.status` — `allowed`, `allowed_warning`
 * near the limit, `rejected` past it — and `resetsAt` in epoch seconds. This
 * is the answer the stream carries; prose is not.
 */
export function streamRateLimit(stdout) {
  let refused = null;
  for (const line of String(stdout || '').split('\n')) {
    if (!line.includes('"rate_limit_event"')) continue;
    let event = null;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== 'rate_limit_event') continue;
    const info = event.rate_limit_info || {};
    const status = String(info.status || '');
    if (status === '' || status.startsWith('allowed')) { refused = null; continue; }
    const at = Number(info.resetsAt);
    refused = { status, resetsAt: Number.isFinite(at) && at > 0 ? new Date(at * 1000) : null };
  }
  return refused;
}

export function quotaSeen(text) {
  return /rate limit|usage limit|weekly limit|quota|hit your (?:weekly|daily|5-hour) limit/iu.test(String(text || ''));
}

/**
 * Whether a claude `result` is the API ending the session rather than the
 * session ending its step: `{ kind, said }`, or null.
 *
 * claude marks it `terminal_reason: "api_error"`, with the refusal as the
 * whole `result` — and `subtype: "success"` all the same, so the subtype says
 * nothing. The ten seen 2026-09-13..25 were `Not logged in · Please run
 * /login` (4, the same morning), the spend and rate limits (4, status 429) and
 * `API Error: 500` / `529 Overloaded` (2). `kind` is what waits it out:
 * `quota` until the reset the refusal names, `login` until somebody logs in,
 * `server` a few minutes.
 *
 * On the step credit (step-credits) two more come before the quota test, since
 * neither is waited out but handed back to the plan: `credits` for `Your
 * credit balance is too low to access the Anthropic API. …` (Anthropic's docs
 * for an exhausted credit), and `key` for `Invalid API key · Fix external API
 * key` (measured 2026-10-11: `terminal_reason: 'api_error'`, `subtype:
 * 'success'`, exit 1).
 *
 * A spent workspace limit is the same credit (2026-10-17, ruling 45 § 1):
 * `API Error: 400 You have reached your specified workspace API usage limits.
 * You will regain access on 2026-11-01 at 00:00 UTC.` It is read before the
 * quota test, which its `usage limit` would otherwise match, and `until` is the
 * instant the refusal names (`creditsResetAt`).
 */
export function apiInterruption(json) {
  if (!json || json.terminal_reason !== 'api_error') return null;
  const said = String(json.result ?? '').trim().split('\n')[0].slice(0, 200);
  if (/workspace api usage limits?/iu.test(said)) return { kind: 'credits', said, until: creditsResetAt(said) };
  if (/credit balance is too low/iu.test(said)) return { kind: 'credits', said };
  if (/invalid api key/iu.test(said)) return { kind: 'key', said };
  if (json.api_error_status === 429 || quotaSeen(said)) return { kind: 'quota', said };
  if (/not logged in|\/login/iu.test(said)) return { kind: 'login', said };
  return { kind: 'server', said };
}

const WORKSPACE_RESET_RE = /regain access on (\d{4}-\d{2}-\d{2})(?: at (\d{1,2}):(\d{2}) UTC)?/u;

/**
 * The instant a spent workspace limit says access returns: `You will regain
 * access on 2026-11-01 at 00:00 UTC.` is 2026-11-01T00:00Z, and 00:00 UTC when
 * the text names no time. Null when the text names no date, or a date or time
 * that is not one. Only UTC is read: the refusal says UTC, and nothing else is
 * guessed at.
 */
export function creditsResetAt(text) {
  const m = WORKSPACE_RESET_RE.exec(String(text || ''));
  if (!m) return null;
  const [, day, hourText = '0', minuteText = '0'] = m;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (hour > 23 || minute > 59) return null;
  const at = new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`);
  if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== day) return null;
  return at;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const RESET_RE = /resets (?:([a-z]{3}) (\d{1,2}) at )?(\d{1,2})(?::(\d{2}))?\s?(am|pm)(?: \(([^)]+)\))?/iu;
/** A reset further off than this is a misreading, not a limit. */
const QUOTA_RESET_MAX_MS = 8 * 24 * 60 * 60 * 1000;

/**
 * The time a quota refusal says it resets — `You've hit your weekly limit ·
 * resets Sep 11 at 3pm (Europe/Stockholm)` — as an instant, or null when the
 * text carries none that can be read. No date is today in that zone, or
 * tomorrow when the time has passed; a date more than a day behind `now` is
 * next year; no zone is the machine's. A time more than eight days out is
 * null: the pause is for a reset, not for a guess.
 */
export function quotaResetAt(text, now = new Date()) {
  const m = RESET_RE.exec(String(text || ''));
  if (!m) return null;
  const [, mon, dayText, hourText, minText, meridiem, zone] = m;
  const hour12 = Number(hourText);
  const minute = minText == null ? 0 : Number(minText);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const hour = (hour12 % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
  const month = mon == null ? null : MONTHS.indexOf(mon.toLowerCase());
  if (month === -1) return null;
  const day = dayText == null ? null : Number(dayText);
  if (day != null && (day < 1 || day > 31)) return null;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone || undefined, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    const wall = (instant) => {
      const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, Number(p.value)]));
      return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    };
    // The zone's wall time as an instant: guess it as UTC, take the zone's
    // offset there, and correct once for an offset that differs at the answer.
    const at = (y, mo, d) => {
      const guess = Date.UTC(y, mo, d, hour, minute);
      const first = guess - (wall(new Date(guess)) - guess);
      return new Date(guess - (wall(new Date(first)) - first));
    };
    const today = new Date(wall(now));
    let out;
    if (month == null) {
      out = at(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
      if (out.getTime() <= now.getTime()) out = at(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1);
    } else {
      out = at(today.getUTCFullYear(), month, day);
      if (out.getTime() < now.getTime() - 24 * 60 * 60 * 1000) out = at(today.getUTCFullYear() + 1, month, day);
    }
    if (Number.isNaN(out.getTime()) || out.getTime() > now.getTime() + QUOTA_RESET_MAX_MS) return null;
    return out;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------------- log */

export function tsvRow({ ts, name, kind, exit, seconds, pr, turns, input, output, cacheRead, cacheWrite, session, note, landSeconds, model, cls, tool, effort, billing }) {
  const cell = (v) => String(v ?? '-').replace(/[\t\n]/gu, ' ');
  // `seconds` is the session; `land_seconds` is the gated round that followed
  // it. They are separate because the gate costs 20–35 minutes on memoro where
  // the old `gh pr merge` cost seconds, and a reader of runs.tsv asking where
  // a night went can only see that if the two are not added up here.
  return [ts, name, kind, exit, seconds, pr, turns, input, output, cacheRead, cacheWrite, session, note, landSeconds, model, cls, tool, effort, billing].map(cell).join('\t');
}

export function tsvHeader() {
  return RUNS_HEADER.join('\t');
}

/* -------------------------------------------------------------- frontmatter */

/**
 * What a session runs on: the plan's `runner`, a step's own `runner`, and the
 * defaults for the session's kind (`SESSION_DEFAULTS`). `model`, `effort` and
 * `advisor` resolve step over plan over default, one key at a time, so a step
 * that names only its effort keeps the plan's model. `advisor: 'off'` at any
 * level means no advisor, and so is an advisor that is the model itself: a
 * plan or step on `opus` gets no advisor unless it names a different one
 * (Martin, 2026-09-12: "Om step har opus => advisor = null, inte
 * opus+opus."). `tool`, `check_in_minutes` and `stall_minutes` are the plan's
 * alone.
 *
 * The defaults belong to claude and to nothing else. `opus` is a claude
 * alias; handed to `codex -m` it names a model that tool does not have, and
 * the step dies on its own argument list before it has read a word of the
 * plan. A plan on another tool that names no model gets none — `modelArgs`
 * of nothing is `[]`, and the tool's own default is a better answer than
 * mc's guess at what that tool calls its best model. The advisor is claude's
 * flag, so another tool gets none, named or not. Effort is the plan's word on
 * either tool: claude's `--effort`, codex's `model_reasoning_effort`.
 */
export function sessionSettings(planRunner = {}, stepRunner = null, { kind = 'step' } = {}) {
  const plan = planRunner || {};
  const step = stepRunner || {};
  const minutes = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
  const tool = plan.tool || DEFAULT_TOOL;
  const claude = tool === DEFAULT_TOOL;
  const defaults = claude ? (SESSION_DEFAULTS[kind] || SESSION_DEFAULTS.step) : {};
  const named = (key) => [step[key], plan[key]].find((value) => value !== undefined && value !== null && value !== '');
  const advisor = named('advisor') ?? defaults.advisor ?? null;
  const effort = named('effort') ?? defaults.effort ?? null;
  const model = named('model') ?? defaults.model ?? null;
  return {
    tool,
    model,
    effort: EFFORT_LEVELS.includes(effort) ? effort : null,
    advisor: claude && advisor !== 'off' && advisor !== model ? advisor : null,
    checkInMinutes: minutes(plan.check_in_minutes, DEFAULT_CHECK_IN_MINUTES),
    stallMinutes: minutes(plan.stall_minutes, DEFAULT_STALL_MINUTES),
  };
}

/**
 * The part of the `starting` line that says what the session runs on:
 * `claude opus · effort medium`, or `claude sonnet · effort medium · advisor
 * opus` on a plan that names both. What is not set is left
 * out rather than printed as `null`, and a tool that picks its own model says
 * so.
 */

/**
 * What a class-routed step runs on: `sessionSettings` for the candidate the
 * router chose (`candidate` is `{ tool, model, effort }`, model-config.js). The
 * tool and the model are the candidate's, and the plan's own tool, model and
 * effort are not carried over — they name the plan's concrete choice, which a
 * routed step does not make. A step's explicit effort still wins, as it does on
 * a concrete step. The check-in, stall and advisor settings are the plan's, and
 * `sessionSettings` gives each to the tool it applies to.
 */
export function routedSettings(planRunner, stepRunner, { kind = 'step', candidate }) {
  const plan = planRunner || {};
  const step = stepRunner || {};
  return sessionSettings(
    { ...plan, tool: candidate.tool, model: null, effort: null },
    { ...step, model: candidate.model, effort: step.effort ?? candidate.effort },
    { kind },
  );
}

export function describeSettings(shortName, settings) {
  return [
    `${shortName} ${settings.model || 'own default model'}`,
    settings.effort ? `effort ${settings.effort}` : null,
    settings.advisor ? `advisor ${settings.advisor}` : null,
  ].filter(Boolean).join(' · ');
}

/**
 * The rest of the `starting` line: what the session is watched with. Codex
 * gets neither a check-in nor a stall guard (its stdin is not a pipe), so it
 * says so rather than printing numbers nothing acts on.
 */
export function describeWatch(toolId, settings) {
  if (toolId === 'codex') return 'no check-in, no stall guard';
  return `check-in every ${settings.checkInMinutes} min, killed after ${settings.stallMinutes} min silent`;
}
