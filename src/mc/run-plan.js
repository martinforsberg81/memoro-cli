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
import { deliverableStep, EFFORT_LEVELS } from './plan-schema.js';
import { estimateCost } from './prices.js';
import { describePr, openPrsFor } from './project-prs.js';

/**
 * The runs.tsv columns. `land_seconds` is last and not beside `seconds` on
 * purpose: the header is written once, when the file is created, and the file
 * on this machine still carries the thirteen it was made with. A column
 * appended is a cell a header-keyed reader ignores; a column inserted would
 * shift `note` one to the left for every reader of the old header, and
 * `close-workarea.js` decides whether a workarea may go by reading it.
 * `model` (step-cost, 2026-09-11) is appended after it for the same reason:
 * the alias the session was launched on, `-` on every row that is not a
 * session and on every row written before it.
 */
export const RUNS_HEADER = ['ts', 'name', 'kind', 'exit', 'seconds', 'pr', 'turns', 'input', 'output', 'cache_read', 'cache_write', 'session', 'note', 'land_seconds', 'model'];

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
});
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
 * A name leaves it when its plan is `done` or has left `main`, and not
 * before (2026-09-08). It used to leave the moment one step had run, which
 * made sense while a round walked every name once; with NEXT as the only
 * order there is, a prioritised five-step project would drop to alphabetical
 * after its first step and the file would stop meaning *these first*.
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

/* --------------------------------------------------------------- refusals */

/**
 * The words a round refuses a project on for a reason that is not in its plan,
 * in the order `runStepClaimed` asks them — the vocabulary the round and the
 * reading beside `kindFor` (`machineState`, status-collect.js) share.
 *
 * Two lists maintained by hand is the failure this exists to stop. The round
 * says these words (`refuse` in run.js returns `skipped:<reason>`), the reading
 * answers with them, and the agreement test drives one case per word through
 * both — so a reason added to `runStepClaimed` that the reading does not know
 * fails the suite rather than quietly making `mc status` wrong.
 *
 * The plan-shaped words — `blocked`, `done`, `unparseable`, `unmigrated`,
 * `no-plan` — are not here. They are `chooseKind`'s, already shared through
 * `kindFor`, and both readings get them from the same call. `no-plan` is the
 * word for a name with neither a workarea nor a plan on main as well: the
 * round meets that fact one question later than the reading does, and it is
 * the same fact.
 *
 * `read: false` is a refusal the reading cannot answer, and every one of them
 * has to say why. They are all the same shape: the outcome of work the round
 * did and the reading refuses to do — `mc status` may not fetch, merge, create
 * a worktree or spawn a tool while the runner is working. A reading that says
 * `ready` and a round that then fails on one of these is not a disagreement
 * about what is in the way; it is the round finding out something no file on
 * this machine said beforehand.
 */
export const RUN_REFUSALS = Object.freeze([
  { reason: 'stop', read: true },
  { reason: 'worktree', read: false, why: 'the round makes a missing worktree; that `git worktree add` failed is the outcome of that action' },
  { reason: 'dirty', read: true },
  { reason: 'prs-unknown', read: true },
  { reason: 'in-flight', read: true },
  { reason: 'branch', read: false, why: 'the branch a step starts on is made by the round (`freshBranch`); that `git checkout -b` failed is the outcome of that action' },
  { reason: 'sync', read: false, why: 'the fetch and the merge of origin/main are the round\'s own writes, and their failure is what they returned' },
  // There was a tenth word here until 2026-09-08, and it was the only one the
  // reading answered out of a file the runner had written rather than out of
  // the machine as it stands: a merge that stopped on a `PLAN.json` the plan's
  // own rule refused was aborted, and an aborted merge leaves the worktree
  // clean. The word and its file are both gone, because the case is — such a
  // conflict now takes main's copy and the merge commits
  // (`resolvePlanConflict`, run.js), so no state is left for a reading to miss.
  { reason: 'role-missing', read: false, why: 'the kind is only known after the merge, and the role file is read out of the worktree the round has just synced' },
  { reason: 'tool-missing', read: false, why: 'whether the tool is on this machine is asked of the launch adapter, which spawns it' },
].map((item) => Object.freeze(item)));

/** The same words, by name, so a call site cannot invent one with a typo. */
export const REFUSAL = Object.freeze(Object.fromEntries(RUN_REFUSALS.map((item) => [item.reason, item.reason])));

/**
 * The refusals above that are facts about the workarea or this machine, and the
 * name each one is written into a plan under (`blocked_by: { kind: 'workarea',
 * name }`, `blockStep` in run.js). Keyed by the refusal word, so the two lists
 * are one list.
 *
 * A refusal in here is **persistent**: nothing the runner does next changes it,
 * and a person has to act. That is the whole test. Until 2026-09-08 they were
 * skips like any other, which meant the runner met the same dirty worktree
 * every ten minutes for days and nothing on `main` said the project was stuck —
 * `sql-w1-universe-closure` was `dirty worktree (.gitattributes, … +1039)`
 * every round of 2026-09-08, and the plan said `ready` throughout.
 *
 * What is **not** here is transient and not the project's fault, and the lane
 * waits on it instead: `stop`, `prs-unknown`, `sync` when the *fetch* failed
 * (the same word, told apart at the call site by what `syncMain` returned),
 * the quota pause, and `in-flight` — an open pull request is work, not a fault.
 *
 * The names are a fixed list because a person reads them in a plan and the page
 * spells them: they say what to fix, not what the code was doing when it found
 * out. Every one matches `NAME_RE` (plan-schema.js).
 */
export const WORKAREA_BLOCKS = Object.freeze({
  dirty: 'dirty-worktree',
  worktree: 'worktree-missing',
  branch: 'branch-unmovable',
  sync: 'merge-uncommittable',
  'role-missing': 'role-missing',
  'tool-missing': 'tool-missing',
});

/** The names alone, for a reader that spells them rather than maps to them. */
export const WORKAREA_BLOCK_NAMES = Object.freeze([...new Set(Object.values(WORKAREA_BLOCKS))]);

/* ------------------------------------------------------------------- kind */

/**
 * An open pull request on this project ends its round, whatever the plan
 * says. Returns the refusal, or null when nothing is open.
 *
 * This is the one rule that also covers the two cases nothing else did: a
 * session that timed out with commits pushed and no pull request (`no-json`,
 * rc 143), and a step that ended `plan-trespass`. Both leave a branch
 * carrying unlanded work, and the old runner came back the next round, read
 * the worktree's plan, found the next step ready and built on top of it —
 * which is how #11250 came to exist. A draft counts as open: it is work in
 * flight, and that is the whole question here.
 */
export function inFlight(openPrs = []) {
  if (!openPrs.length) return null;
  const [pr] = openPrs;
  const rest = openPrs.length > 1 ? ` (+${openPrs.length - 1} more)` : '';
  return {
    kind: null,
    reason: 'in-flight',
    skip: `${describePr(pr)}${rest} — not starting a step`,
    prs: openPrs,
  };
}


/**
 * The step a pull request carries, for judging what a session was allowed to
 * change in the plan. The step that names it is the answer when the plan has
 * one — a session that already wrote its own `pr` on its step — and the
 * deliverable step is the answer before that edit has landed.
 */
export function stepOfPr(plan, pr) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const at = steps.findIndex((step) => step && Number(step.pr) === Number(pr));
  return at >= 0 ? at : deliverableStep(plan).index;
}

/**
 * The branch a workarea moves to when the one it stands on has already
 * landed: `<name>-<n>`, the smallest `<n>` no branch is using. `<name>` is
 * the first of them, so the count starts at two.
 */
export function nextBranch(name, taken = []) {
  const held = taken instanceof Set ? taken : new Set(taken);
  for (let n = 2; ; n += 1) if (!held.has(`${name}-${n}`)) return `${name}-${n}`;
}

/**
 * What a project gets this round. `openPrs` non-empty means its work is
 * already in flight and nothing is started; `plan` is null when no PLAN.md
 * exists in the worktree.
 *
 * A merge left in conflict is not one of the answers here. It used to be the
 * first of them — `conflicts.length` returned a kind of its own before the
 * plan was so much as looked at, and the round did not even read the plan
 * while a merge was in progress. A conflict is now something the step session
 * is *told* about (`stepPrompt`'s preamble): it resolves the merge and then
 * does its step, in the session that had to read the code anyway, rather than
 * a cold session that finishes a merge and stops.
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
export function chooseKind({ plan, openPrs = [] }) {
  const flight = inFlight(openPrs);
  if (flight) return flight;
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

/**
 * What the runner would do with a name, from the plan on `origin/main` alone:
 * `step`, or `skip:<reason>` — a word the page can count, not the sentence
 * beside it.
 *
 * It lives here rather than in status-collect.js (where it was until
 * 2026-09-08) because `nextFor` below is the runner's own picker and needs it;
 * status-collect re-exports it, so both readings still come from one call.
 */
export function kindFor(name, { plans }) {
  const plan = plans.find((p) => p.project === name) || null;
  const choice = chooseKind({ plan });
  if (choice.kind) return choice.kind;
  if (!plan) return 'skip:no-plan';
  return `skip:${choice.reason || 'no-status'}`;
}

/**
 * The plan-and-GitHub half of *would the runner start this*: the plan on
 * `origin/main`, then what that project has open. `{ runnable: true, kind }`,
 * or `{ runnable: false, reason }` in the word both surfaces refuse in.
 *
 * It is the same order `runStepClaimed` asks in and the same order
 * `machineState` asks in, minus everything that needs a worktree — this is
 * read from what `queue()` already fetched, so a pick costs no git at all.
 */
function pickState(name, { plans = [], prs = [], prsFailed = [] } = {}) {
  const kind = kindFor(name, { plans });
  if (kind.startsWith('skip:')) return { runnable: false, reason: kind.slice('skip:'.length) };
  const repo = plans.find((p) => p.project === name)?.repo || null;
  // What is open decides whether a project may start anything at all, so a
  // repository GitHub could not be asked about starts nothing — the lane says
  // so once and sleeps, rather than picking a name it would refuse a fetch
  // later. `queue()` has already written the line naming the repository.
  if (prsFailed.includes(repo)) return { runnable: false, reason: 'prs-unknown' };
  const openPrs = openPrsFor({ prs, name, names: plans.map((p) => p.project), repo });
  const flight = inFlight(openPrs);
  if (flight) return { runnable: false, reason: flight.reason };
  return { runnable: true, kind };
}

/**
 * The next step a lane takes: the first name in the queue's order, in this
 * repository, that nothing stops. `{ name, kind, repo }`, or null when this
 * repository has nothing to run.
 *
 * This is the whole of what replaced the round on 2026-09-08. A round built a
 * repository's name list, split it by index between the lanes (`splitLanes`,
 * `index % count === lane`) and walked every name of its slice — so lane 2 of
 * 2 took the second name whether or not the first lane could run it, and a
 * project nothing could start was tried again ten minutes later, for days.
 * A lane now picks one name, runs it, and picks again.
 *
 * `claimed` is the runner's own set of projects a lane is holding this second
 * (`claims`, run.js) and is read live — the lane adds its pick to it before
 * the session is awaited, so two lanes reading the world ten minutes apart
 * still cannot take one project. `passed` is this pass's own: a name the
 * machine refused for a reason the plan does not know about, so the lane moves
 * on rather than spinning on it until the world is read again.
 *
 * `state` is the per-name reading, and the page passes its own: `nextSection`
 * has already asked `machineState` about a dirty worktree, which this cannot
 * see. Given none, the reading is the plan and the open pull requests.
 */
export function nextFor({
  repo = null, world = {}, claimed = new Set(), passed = new Set(), state = null,
} = {}) {
  const { names = [], plans = [], prs = [], prsFailed = [] } = world;
  const byProject = new Map(plans.map((plan) => [plan.project, plan]));
  const read = state || ((name) => pickState(name, { plans, prs, prsFailed }));
  for (const name of names) {
    const at = byProject.get(name)?.repo || null;
    if (repo != null && at !== repo) continue;
    if (claimed.has(name) || passed.has(name)) continue;
    const answer = read(name);
    if (!answer?.runnable) continue;
    return { name, kind: answer.kind || null, repo: at };
  }
  return null;
}

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
export function nightlyDue({ tsv = '', now = new Date(), intervalMs = NIGHTLY_INTERVAL_MS } = {}) {
  const times = parseRuns(tsv)
    .filter((row) => row.kind === NIGHTLY_KIND)
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

const today = (now) => now.toISOString().slice(0, 10);

/**
 * What a step session is told before anything else when the worktree it is
 * handed has a merge in progress: which files, that it stopped there, and
 * that the merge is the first thing it does rather than the job.
 *
 * It goes above the body and the body does not change — the step, its
 * `done_when` and what may be written in the plan are all still true. That is
 * the whole of what the runner used to spend a session of its own on: a cold
 * session that read the conflicting code, resolved it, and stopped. This
 * session has to read that code anyway.
 */
function conflictPreamble(conflicts, then = null) {
  if (!conflicts.length) return [];
  return [
    'A `git merge origin/main` is in progress in this worktree and stopped on',
    `conflicts in: ${conflicts.join(' ')}`,
    '',
    "Resolve them first: keep this branch's intent and main's changes both,",
    ...(then || [
      'commit the merge, and then do your step below. It is the first thing you',
      'do and not the job — one session, one pull request, and the step is what',
      'the pull request is for.',
    ]),
    '',
    // A modify/delete is the one conflict "keep both" does not answer, and
    // guessing it wrong restores something a finished project removed on
    // purpose. `role-instructions`' #614 is exactly this: its branch edits
    // `canon/roles/reconcile.md`, which `no-reconcile` deleted from main.
    'A file main deleted stays deleted — `git rm` it and carry whatever your',
    'branch was doing to it wherever main moved it, if anywhere. Restoring it',
    'undoes a project that finished on purpose, and no test will say so.',
    '',
  ];
}

/** A field that is prose — one string, or an array of paragraph strings. */
const paragraphs = (value) => (Array.isArray(value) ? value : (value == null ? [] : [value])).map(String);

/** One field of the session's own step, as the prompt shows it. */
function stepField(key, value) {
  if (Array.isArray(value)) return [`${key}:`, '', ...paragraphs(value).flatMap((p) => [p, ''])];
  if (value && typeof value === 'object') return [`${key}: ${JSON.stringify(value)}`];
  return [`${key}: ${value ?? 'null'}`];
}

/**
 * The part of the plan a step session needs, rendered from the parsed plan:
 * the project's own terms in full, the session's step in full, and every
 * other step as one line.
 *
 * It used to be the whole file. The session has that file in its worktree,
 * so the copy in the prompt was only ever for reading — and it
 * was read on every turn, because it was in the prompt. The other steps'
 * instructions are what made it large (memoro's `sql-w1-universe-closure` was
 * 115k characters on 2026-09-11); a session that needs one reads the file.
 *
 * Every key of the session's own step is shown, not a known list, so a key the
 * schema gains later reaches the session without a change here.
 */
function planExcerpt(plan, index, step) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const lines = [];
  const section = (heading, body) => lines.push(`----- ${heading} -----`, ...body, '');
  section('goal', paragraphs(plan?.goal).flatMap((p) => [p, '']));
  section('contract', paragraphs(plan?.contract).flatMap((p) => [`- ${p}`, '']));
  section('out_of_scope', paragraphs(plan?.out_of_scope).flatMap((p) => [`- ${p}`, '']));
  section('success_criteria', (plan?.success_criteria || []).flatMap((c, i) => [
    `success_criteria[${i}] · met: ${c?.met === true}`,
    `criterion: ${c?.criterion ?? ''}`,
    `check: ${c?.check ?? ''}`,
    '',
  ]));
  section('documents', (plan?.documents || []).map((d) => `- ${d?.label ?? ''}: ${d?.path ?? ''}`));
  if (plan?.runner) section('runner', [JSON.stringify(plan.runner)]);
  const own = steps[index] || step || {};
  section(`Your step: steps[${index}]`, Object.entries(own).flatMap(([key, value]) => stepField(key, value)));
  const others = steps.flatMap((s, i) => (i === index ? [] : [
    [`steps[${i}]`, s?.status, s?.title, `done when: ${s?.done_when ?? ''}`, ...(s?.pr ? [`PR #${s.pr}`] : [])].join(' · '),
  ]));
  section('The other steps', others.length ? others : ['(none)']);
  return lines.join('\n').replace(/\n{3,}/gu, '\n\n').trimEnd();
}

/**
 * What a step session is told. `plan` is the parsed plan (`readPlanText`'s
 * `plan`); the prompt quotes the part of it this step needs and says where the
 * whole file is, rather than carrying the file — see `planExcerpt`.
 */
export function stepPrompt({ name, repo, planPath, plan, step, index, conflicts = [], now = new Date() }) {
  const ordinal = Number.isInteger(index) ? index + 1 : 1;
  return [
    ...conflictPreamble(conflicts),
    `You are working in the \`${name}\` workarea of ${repo} (this worktree; origin/main`,
    `is merged in). Your plan is on disk in this worktree at \`${planPath}\`;`,
    'what follows below is the part of it this step needs — the frozen fields,',
    'your step in full, and every other step as one line. Read the file for',
    'anything else.',
    '',
    `Your step is \`steps[${index}]\` — ${ordinal}, "${step?.title || ''}".`,
    `Done when: ${step?.done_when || ''}`,
    'That sentence is your success criterion for this session — verify it before',
    'you stop, and say in the PR body how you verified it.',
    '',
    'Where your step stands is not in the plan file. It is in the register mc',
    'keeps, and `mc step` is how you write it — the file\'s `status`, `pr`,',
    '`blocked_by` and `comments` are read by nothing, and a state written there',
    'is a state nobody sees (2026-09-12: a step blocked in the file showed',
    '`ready` for six days). In the plan file exactly one thing is yours: `met`',
    'on the `success_criteria` you actually met — the criterion and its check',
    "are Martin's words and stay as they are. `mc merge` compares the plan on",
    'main with yours at the door and refuses the pull request if you changed',
    'another step, the goal, the contract or the scope.',
    '',
    'What the next session needs to know that the code in front of it does not',
    'show goes in the pull request body, and as `mc step note "…"` — one',
    'paragraph a call, shown to whoever reads this step next.',
    '',
    'If the contract must change, or a later step is wrong, stop: run',
    '`mc step blocked --on <decision-name> --reason "…"` (or `--on-project',
    '<project>` when it waits for another project) — the name is a name, lower',
    'case and hyphens, because a blocked step that does not say what it waits for',
    'is one nobody can unblock. Say it in the pull request too, with one',
    'recommendation rather than a menu; that is where it will be read.',
    '',
    'Build all of it — a pull request that lands is a `done` step, whatever its',
    'body says is left; what you cannot finish is `mc step failed`, not a partial',
    'landing. `mc gate` runs this tree\'s gate and prints the verdict, not the',
    'suite; `mc publish` pushes this branch and opens the pull request, and',
    `prints its number. Then run \`mc merge ${repo} <pr>\` yourself`,
    'until it says merged — that writes `done` and the pull request for you; a',
    'red comes back to you: fix it and run it again. Never `gh pr merge`. Giving',
    'up is `mc step failed --reason "…"`. Do not ask questions.',
    '',
    planExcerpt(plan, index, step),
  ].join('\n');
}


/* --------------------------------------------------------------- headless */

/**
 * The argument list for a session nobody sits in front of, per tool. The
 * model rides through the adapter's own `modelArgs`, and for claude the
 * effort and the advisor through its `effortArgs` and `advisorArgs` — codex
 * gets neither; the instructions
 * (Coding Profile + role overlay) through the same channel `mc work` uses;
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
 * `--strict-mcp-config`. The allowlist replaced `--disallowedTools Agent`
 * on 2026-09-25: a headless session has no use for a subagent — the step is
 * bounded by its plan, the strong model is reached through `--advisor`, and a
 * subagent runs on whatever model the repository's instruction files name,
 * outside the plan's `runner` choice (measured 2026-09-12 over the first 41
 * sonnet step sessions: 19 spawned opus subagents on memoro's `CLAUDE.md`
 * instruction, a quarter of the era's cost) — and it has no use for Skill,
 * Workflow, Cron, Web or Task tools either. Tool definitions ride in every
 * request: claude 2.1.280 measured 18 687 tokens/request with the default
 * set minus Agent, 13 073 with these six, on a context that is re-read ~90
 * times per step session. The six include `Grep` and `Glob`, which the
 * default set omits — until this flag a step searched with `grep` through
 * Bash (2 866 such calls against 466 native reads, 2026-09-15..25).
 * `--strict-mcp-config` keeps a user-level MCP server, with its own tool
 * definitions, out of the lane. Whatever any repository's files say, the
 * session has these tools and no others.
 */
export const CLAUDE_TOOLS = 'Bash,Read,Edit,Write,Grep,Glob';

export function headlessArgs({ toolId, adapter, model, effort = null, advisor = null, instructions, prompt, profileArgs, autocompact = AUTOCOMPACT_TOKENS, stream = true }) {
  const modelArgs = adapter?.modelArgs?.(model) ?? [];
  const instr = profileArgs(toolId, instructions);
  if (toolId === 'codex') return ['exec', '--json', '--sandbox', 'danger-full-access', ...modelArgs, ...instr, prompt];
  const tuning = [...(adapter?.effortArgs?.(effort) ?? []), ...(adapter?.advisorArgs?.(advisor) ?? [])];
  const compact = autocompact ? ['--autocompact', String(autocompact)] : [];
  const io = stream
    ? ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
    : ['--output-format', 'json'];
  return ['-p', ...(stream ? [] : [prompt]), ...modelArgs, ...tuning, '--permission-mode', 'acceptEdits', ...compact, '--tools', CLAUDE_TOOLS, '--strict-mcp-config', ...instr, ...io];
}

/** One stream-json user message, as `deps.session` writes it on claude's stdin. */
export function userMessageLine(text) {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: String(text) } })}\n`;
}

/**
 * What the runner writes to a running session every `check_in_minutes`
 * (ruling 18). Nothing is killed on elapsed time; instead the session is
 * asked to judge its own step and, if it cannot finish it, to leave it
 * `blocked` on a decision named after the project — `NAME_RE` in
 * plan-schema.js, so the blocker is a name somebody can answer.
 */
export function checkInPrompt({ project, minutes, count }) {
  return [
    `Check-in from the runner: you have been running for ${minutes} minutes (this is check-in number ${count}).`,
    'Judge whether this step can be finished in this session.',
    '',
    'If it can, say so in one line and go on — no other answer is needed.',
    '',
    'If it cannot — you are going in circles, a test cannot be made green, the',
    'plan does not match the code — commit what you have, set your step',
    `\`blocked\` with \`blocked_by: { "kind": "decision", "name": "${project}-check-in" }\``,
    "and in its `comments` what you found and what the next session should do",
    'differently, open the pull request, and stop.',
    '',
    'Do not start anything new after a check-in that says it cannot be finished.',
  ].join('\n');
}

const USAGE_SUMS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
const RESULT_SUMS = ['num_turns', 'total_cost_usd', 'duration_ms', 'duration_api_ms'];
// Limits, not amounts: the last result's value is the value.
const MODEL_USAGE_KEPT = new Set(['contextWindow', 'maxOutputTokens']);

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
  }
  let cost = 0;
  for (const [m, u] of Object.entries(modelUsage)) {
    const c = estimateCost({ input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadInputTokens, cacheWrite: u.cacheCreationInputTokens }, m);
    if (c != null) { u.costUSD = c; cost += c; }
  }
  return { type: 'result', subtype: 'killed', is_error: false, session_id: session, num_turns: messages.size, usage, modelUsage, total_cost_usd: cost, model, last_usage: last };
}

/**
 * The session's result, read from what claude printed: the last `result`
 * line of a stream-json run, with the amounts of every result line added up.
 *
 * One process can print more than one (proven 2026-09-11, step-cost step 3):
 * a check-in written just as the session finished starts a new turn with its
 * own `result`, and each carries its own `num_turns`, `usage` and
 * `total_cost_usd` for that turn group, not a running total. So turns, cost,
 * durations, the four usage counts and `modelUsage` per model are summed;
 * `subtype`, `is_error`, `result` and `session_id` are the last one's.
 *
 * Output that is one JSON object and no `result` line — `--output-format
 * json`, which the helper still runs on — is read whole, as it always was.
 * Null when there is neither.
 */
export function sessionResult(stdout) {
  const results = [];
  for (const line of String(stdout || '').split('\n')) {
    if (!line.includes('"result"')) continue;
    let event = null;
    try { event = JSON.parse(line); } catch { continue; }
    if (event && typeof event === 'object' && event.type === 'result') results.push(event);
  }
  if (!results.length) {
    let json = null;
    try { json = JSON.parse(stdout); } catch { json = null; }
    return json && typeof json === 'object' && !Array.isArray(json) ? json : null;
  }
  const last = results.at(-1);
  if (results.length === 1) return last;
  const out = { ...last };
  for (const key of RESULT_SUMS) out[key] = results.reduce((sum, r) => add(sum, r[key]), undefined);
  const usage = { ...(last.usage || {}) };
  for (const key of USAGE_SUMS) usage[key] = results.reduce((sum, r) => add(sum, r.usage?.[key]), undefined);
  out.usage = usage;
  const models = {};
  for (const r of results) {
    for (const [model, counts] of Object.entries(r.modelUsage || {})) {
      const into = models[model] || (models[model] = {});
      for (const [key, value] of Object.entries(counts || {})) {
        into[key] = MODEL_USAGE_KEPT.has(key) ? value : add(into[key], value);
      }
    }
  }
  if (results.some((r) => r.modelUsage)) out.modelUsage = models;
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
    const text = `${stdout}\n${stderr}`;
    const quota = exitCode !== 0 && quotaSeen(text);
    return { ...dash, ...readCodexEvents(stdout), note: quota ? 'quota' : (exitCode === 0 ? 'success' : 'failed'), quota, quotaReset: quota ? quotaResetAt(text, now) : null };
  }
  const json = sessionResult(stdout);
  if (!json) {
    const text = `${stdout}\n${stderr}`;
    const quota = quotaSeen(text);
    // No answer, but the turns it took are in the stream: a session `mc
    // merge` ended keeps its row's turns, usage and session id.
    const stream = streamSummary(stdout);
    const counts = stream ? {
      turns: String(stream.num_turns),
      session: stream.session_id ?? '-',
      input: String(stream.usage.input_tokens),
      output: String(stream.usage.output_tokens),
      cacheRead: String(stream.usage.cache_read_input_tokens),
      cacheWrite: String(stream.usage.cache_creation_input_tokens),
    } : {};
    return { ...dash, ...counts, note: quota ? 'quota' : 'no-json', quota, quotaReset: quota ? quotaResetAt(text, now) : null };
  }
  const usage = json.usage || {};
  const pick = (v) => (v == null ? '-' : String(v));
  const fewTurns = !(Number(json.num_turns) > 2);
  const text = `${json.result ?? ''}\n${stderr}`;
  const quota = fewTurns && quotaSeen(text);
  return {
    turns: pick(json.num_turns),
    session: pick(json.session_id),
    input: pick(usage.input_tokens),
    output: pick(usage.output_tokens),
    cacheRead: pick(usage.cache_read_input_tokens),
    cacheWrite: pick(usage.cache_creation_input_tokens),
    note: quota ? 'quota' : (json.is_error ? 'failed' : pick(json.subtype ?? '-')),
    quota,
    quotaReset: quota ? quotaResetAt(text, now) : null,
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

export function tsvRow({ ts, name, kind, exit, seconds, pr, turns, input, output, cacheRead, cacheWrite, session, note, landSeconds, model }) {
  const cell = (v) => String(v ?? '-').replace(/[\t\n]/gu, ' ');
  // `seconds` is the session; `land_seconds` is the gated round that followed
  // it. They are separate because the gate costs 20–35 minutes on memoro where
  // the old `gh pr merge` cost seconds, and a reader of runs.tsv asking where
  // a night went can only see that if the two are not added up here.
  return [ts, name, kind, exit, seconds, pr, turns, input, output, cacheRead, cacheWrite, session, note, landSeconds, model].map(cell).join('\t');
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
 * mc's guess at what that tool calls its best model. Effort and advisor are
 * claude's flags, so another tool gets neither, named or not.
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
    effort: claude && EFFORT_LEVELS.includes(effort) ? effort : null,
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
