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
 * per kind (ruling 18, 2026-09-11). A step is `sonnet` at `medium` effort
 * with `opus` as its advisor — the strong model at the decision points rather
 * than on every turn. A repair keeps `opus` with no effort flag and no
 * advisor: it is one session on a pull request somebody else could not land.
 * These are claude's aliases and nobody else's — see `sessionSettings`.
 */
export const SESSION_DEFAULTS = Object.freeze({
  step: Object.freeze({ model: 'sonnet', effort: 'medium', advisor: 'opus' }),
});
// The context window at which a claude step or repair session compacts
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
 * A hold at `repairs: 0` is not here either: that is one repair session owed,
 * which is a thing the runner starts.
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
 * one — a repair works on a step whose session already wrote its own `pr` —
 * and the deliverable step is the answer before that edit has landed.
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

/**
 * mc's own two trees: what a landed pull request has to touch for the runner
 * to be running stale code the moment it lands.
 *
 * `src/mc/` is the runner itself — node read its whole module graph at process
 * start, so a merge of `plan-schema.js` or `run.js` changes nothing about the
 * process that just merged it. `canon/` is the roles, which the runner reads
 * off disk and quotes into the next step's prompt. Those are the two, and the
 * list is short on purpose: a handover costs a round boundary and a fresh
 * process, and a change to `tests/`, `docs/` or `scripts/` cannot make the
 * running runner wrong. Widening this to "the repository" would hand over
 * after every memoro-cli landing, which is most of them.
 *
 * Prefixes, so `src/mcp/` is not `src/mc/` and a file named `canonical.md` is
 * not `canon/`.
 */
export const MC_OWN_TREES = ['src/mc/', 'canon/'];

/** The files of `files` that are mc's own code — empty when none are. PURE. */
export function mcOwnFiles(files) {
  return (files || [])
    .map((file) => (typeof file === 'string' ? file : file?.path))
    .filter((path) => typeof path === 'string' && MC_OWN_TREES.some((tree) => path.startsWith(tree)));
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
 * are counted separately in `summariseRuns`, `helperDue` is not closed for the
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
 * The runs.tsv note for one repository's collect. The outcome comes first and
 * the detail after, because `summariseRuns` reads a note that does not start
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
 * It used to be the whole file. The session has that file in its worktree and
 * edits it there, so the copy in the prompt was only ever for reading — and it
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
    `In the plan file you may edit that step's \`status\`, its \`pr\` (the number,`,
    'not the URL), and its',
    '`comments` — an array of paragraph strings, whatever the next session needs',
    'to know that the code in front of it does not show. Plus `met` on the',
    '`success_criteria` you actually met: the criterion and its check are',
    "Martin's words and stay as they are, only `met` is yours. Nothing else: not",
    'another step, not the goal, the contract or the scope. `mc merge` compares',
    'the plan on main with yours at the door and refuses the pull request if',
    'you changed anything else.',
    '',
    'If the contract must change, or a later step is wrong, set this step to',
    '`blocked` with `blocked_by: { "kind": "decision" | "project", "name": … }` —',
    'required, because a blocked step that does not say what it waits for is one',
    'nobody can unblock — and stop. Say it in the pull request too, with one',
    'recommendation rather than a menu; that is where it will be read.',
    '',
    'Build it, set your step `done` with its `pr`, open the pull request, then',
    `run \`mc merge ${repo} <pr>\` yourself until it says merged — a red comes`,
    'back to you: fix it and run it again. Never `gh pr merge`. Giving up is',
    '`mc step failed --reason "…"`. Do not ask questions.',
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
 * ways (`stream: true`, the step and repair lanes): the prompt is not an
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
 * Every claude launch gets `--disallowedTools Agent`. A headless session
 * has no use for a subagent: the step is bounded by its plan, the strong
 * model is reached through `--advisor`, and a subagent runs on whatever
 * model the repository's instruction files name, outside the plan's
 * `runner` choice. Measured 2026-09-12 over the first 41 sonnet step
 * sessions: 19 spawned opus subagents on memoro's `CLAUDE.md` instruction,
 * 2 111 of the era's 6 556 model requests, about a quarter of its cost, and
 * one 17-turn parent waited 41 minutes on a 319-turn child that runs.tsv
 * never saw. The flag holds whatever any repository's files say.
 */
export function headlessArgs({ toolId, adapter, model, effort = null, advisor = null, instructions, prompt, profileArgs, autocompact = AUTOCOMPACT_TOKENS, stream = true }) {
  const modelArgs = adapter?.modelArgs?.(model) ?? [];
  const instr = profileArgs(toolId, instructions);
  if (toolId === 'codex') return ['exec', '--json', '--sandbox', 'danger-full-access', ...modelArgs, ...instr, prompt];
  const tuning = [...(adapter?.effortArgs?.(effort) ?? []), ...(adapter?.advisorArgs?.(advisor) ?? [])];
  const compact = autocompact ? ['--autocompact', String(autocompact)] : [];
  const io = stream
    ? ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
    : ['--output-format', 'json'];
  return ['-p', ...(stream ? [] : [prompt]), ...modelArgs, ...tuning, '--permission-mode', 'acceptEdits', ...compact, '--disallowedTools', 'Agent', ...instr, ...io];
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
 * plan-schema.js, so the blocker is a name somebody can answer. A repair has
 * no step of its own to block, so it is asked to say so in the pull request.
 */
export function checkInPrompt({ project, minutes, count, kind = 'step' }) {
  const lines = [
    `Check-in from the runner: you have been running for ${minutes} minutes (this is check-in number ${count}).`,
    'Judge whether this step can be finished in this session.',
    '',
    'If it can, say so in one line and go on — no other answer is needed.',
    '',
  ];
  if (kind === 'repair') {
    lines.push(
      'If it cannot — you are going in circles, a test cannot be made green, the',
      'code does not match what the pull request needs — commit and push what you',
      'have, say in the pull request what you found and what a person should do',
      'next, and stop.',
    );
  } else {
    lines.push(
      'If it cannot — you are going in circles, a test cannot be made green, the',
      'plan does not match the code — commit what you have, set your step',
      `\`blocked\` with \`blocked_by: { "kind": "decision", "name": "${project}-check-in" }\``,
      "and in its `comments` what you found and what the next session should do",
      'differently, open the pull request, and stop.',
    );
  }
  lines.push('', 'Do not start anything new after a check-in that says it cannot be finished.');
  return lines.join('\n');
}

const USAGE_SUMS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
const RESULT_SUMS = ['num_turns', 'total_cost_usd', 'duration_ms', 'duration_api_ms'];
// Limits, not amounts: the last result's value is the value.
const MODEL_USAGE_KEPT = new Set(['contextWindow', 'maxOutputTokens']);

const add = (a, b) => (typeof b === 'number' ? (typeof a === 'number' ? a + b : b) : a);

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
export function readSessionOutput({ toolId, stdout, stderr = '', exitCode, timedOut = false, stalled = false }) {
  const dash = { turns: '-', session: '-', input: '-', output: '-', cacheRead: '-', cacheWrite: '-' };
  // A limit answer is what the tool says when it refuses: one or two turns
  // and the limit text as the whole result. Session prose that mentions a
  // quota (a PR body about quota rows, say) is not a limit — 2026-08-29 the
  // runner slept 30 min and left a finished PR unmerged on exactly that.
  if (stalled) return { ...dash, note: 'stalled', quota: false };
  if (timedOut) return { ...dash, note: 'timeout', quota: false };
  if (toolId === 'codex') {
    const quota = exitCode !== 0 && quotaSeen(`${stdout}\n${stderr}`);
    return { ...dash, ...readCodexEvents(stdout), note: quota ? 'quota' : (exitCode === 0 ? 'success' : 'failed'), quota };
  }
  const json = sessionResult(stdout);
  if (!json) {
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
 * `claude sonnet · effort medium · advisor opus`. What is not set is left
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
