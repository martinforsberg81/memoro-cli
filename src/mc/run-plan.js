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
import { describePr } from './project-prs.js';

/**
 * The runs.tsv columns. `land_seconds` is last and not beside `seconds` on
 * purpose: the header is written once, when the file is created, and the file
 * on this machine still carries the thirteen it was made with. A column
 * appended is a cell a header-keyed reader ignores; a column inserted would
 * shift `note` one to the left for every reader of the old header, and
 * `close-workarea.js` decides whether a workarea may go by reading it.
 */
export const RUNS_HEADER = ['ts', 'name', 'kind', 'exit', 'seconds', 'pr', 'turns', 'input', 'output', 'cache_read', 'cache_write', 'session', 'note', 'land_seconds'];

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
  { reason: 'held-after-repair', read: true },
  { reason: 'in-flight', read: true },
  { reason: 'branch', read: true },
  { reason: 'sync', read: false, why: 'the fetch and the merge of origin/main are the round\'s own writes, and their failure is what they returned' },
  { reason: 'role-missing', read: false, why: 'the kind is only known after the merge, and the role file is read out of the worktree the round has just synced' },
  { reason: 'tool-missing', read: false, why: 'whether the tool is on this machine is asked of the launch adapter, which spawns it' },
].map((item) => Object.freeze(item)));

/** The same words, by name, so a call site cannot invent one with a typo. */
export const REFUSAL = Object.freeze(Object.fromEntries(RUN_REFUSALS.map((item) => [item.reason, item.reason])));

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
 * A pull request the runner would not land is not simply work in flight.
 *
 * `inFlight` refuses the project every round while such a pull request is
 * open, and that refusal is right for work a session is still doing and wrong
 * for work nothing is going to finish: the seven held on 2026-09-03..04 each
 * stood still until a person read runner.log. So before the refusal, the round
 * asks `held.json` — a pull request held with no repair yet gets one repair
 * session, in the workarea, on its own branch, told exactly why it was held.
 *
 * One repair per pull request, and no loop: still held after it, and it is the
 * brief's. `repairs` is the whole memory of that, and the skip says so, because
 * `#N is open — not starting a step` says nothing about who is expected to act.
 *
 * Pure over the entries and the open list. Returns `{ kind: 'repair', entry }`,
 * a `{ kind: null, skip }` refusal, or null when nothing of this project's is
 * held and the ordinary rules apply.
 */
export function heldRepair({ entries = [], openPrs = [], project = null, repo = null } = {}) {
  if (!openPrs.length) return null;
  const open = new Map(openPrs.map((pr) => [Number(pr.number), pr]));
  const mine = entries.filter((entry) => entry.project === project
    && (entry.repo == null || repo == null || entry.repo === repo)
    && open.has(Number(entry.pr)));
  if (!mine.length) return null;
  const first = mine.find((entry) => !entry.repairs);
  if (!first) {
    const [waiting] = mine;
    return {
      kind: null,
      reason: 'held-after-repair',
      skip: `#${waiting.pr} is held before merge after a repair — the brief's`,
      entry: waiting,
    };
  }
  // The branch off GitHub when the entry does not name one: an entry written
  // by an older runner, or by hand, still has a pull request that is on
  // something, and a repair session has to stand on it.
  const branch = first.branch || open.get(Number(first.pr))?.headRefName || null;
  return { kind: 'repair', entry: { ...first, branch } };
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

/* --------------------------------------------------------------- landing */

/**
 * The order a project's open pull requests must land in, bottom first.
 *
 * The runner lands what a session left behind, and a session that could not
 * branch its later steps from `main` leaves a stack. `mc merge` refuses a
 * batch aimed at several bases, so a stack needs an order rather than a call:
 * land the bottom, retarget the one above it at `main`, rebase it onto the
 * squash that just landed, land it, and so on (memoro's `AGENTS.md` §
 * *Landing a stack*, measured on a three-step memoro-cli stack 2026-09-01).
 *
 * The shape a stack has: exactly one pull request aimed at the default
 * branch, and every other one aimed at the head of exactly one of the
 * others. Anything else — two aimed at `main`, two aimed at the same branch,
 * a cycle, a base that is nobody's head — is not a stack this understands,
 * and then nothing lands. #11250 was the cost of not asking: a pull request
 * based on the branch of #11249, squash-merged into it, logged
 * `success,merged`, and `main` received nothing.
 *
 * Pure, over the list `queue()` already fetches: `{ number, headRefName,
 * baseRefName }` and nothing else, so the whole decision is tested with no
 * network.
 *
 * Returns `{ ok: true, order }` bottom first, or `{ ok: false, reason }`.
 */
export function stackOrder(prs = [], { defaultBranch = 'main' } = {}) {
  const list = (prs || []).filter(Boolean);
  if (!list.length) return { ok: true, order: [] };
  const heads = new Map();
  for (const pr of list) {
    const seen = heads.get(pr.headRefName);
    if (seen) return { ok: false, reason: `#${seen.number} and #${pr.number} are both on ${pr.headRefName}` };
    heads.set(pr.headRefName, pr);
  }
  const bottom = list.filter((pr) => pr.baseRefName === defaultBranch);
  if (!bottom.length) {
    const aimed = list.map((pr) => `#${pr.number} is aimed at ${pr.baseRefName}`).join(', ');
    return { ok: false, reason: `${aimed} — none of them is aimed at ${defaultBranch}` };
  }
  if (bottom.length > 1) {
    return { ok: false, reason: `${names(bottom)} are both aimed at ${defaultBranch} — two stacks, not one` };
  }
  const above = new Map();
  for (const pr of list) {
    if (pr === bottom[0]) continue;
    if (!heads.has(pr.baseRefName)) {
      return { ok: false, reason: `#${pr.number} is aimed at ${pr.baseRefName}, which is neither ${defaultBranch} nor another open pull request's branch` };
    }
    const rival = above.get(pr.baseRefName);
    if (rival) return { ok: false, reason: `#${rival.number} and #${pr.number} are both aimed at ${pr.baseRefName} — a fork, not a stack` };
    above.set(pr.baseRefName, pr);
  }
  const order = [];
  for (let at = bottom[0]; at; at = above.get(at.headRefName)) order.push(at);
  if (order.length !== list.length) {
    const loose = list.filter((pr) => !order.includes(pr));
    return { ok: false, reason: `${names(loose)} do not sit above #${bottom[0].number} — the bases form a cycle` };
  }
  return { ok: true, order };
}

const names = (prs) => prs.map((pr) => `#${pr.number}`).join(' and ');

/**
 * What a landing round leaves in the runs.tsv note, after `success,`.
 *
 * The two fields that are read are `merged_into` and `off_default`, and they
 * exist because a round on #363 said "merged as 7dcbf96" and was right — into
 * the stacked base it was aimed at — while everyone read "on main". A merge
 * that did not land on the default branch is not a merge this reports as one:
 * `off-main` is its own outcome, not `merged` and not `open`.
 *
 * A red gate is not a failure to work around. It is `open,gate-red`: the pull
 * request stays where it is, and `inFlight` then keeps the project from
 * starting anything else until somebody has dealt with it.
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
 * ten minutes — beside a lane's ninety-minute step, that is noise. One file a
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

export function stepPrompt({ name, repo, planPath, planText, step, index, conflicts = [], now = new Date() }) {
  const ordinal = Number.isInteger(index) ? index + 1 : 1;
  return [
    ...conflictPreamble(conflicts),
    `You are working in the \`${name}\` workarea of ${repo} (this worktree; origin/main`,
    `is merged in). Below is your plan, \`${planPath}\`.`,
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
    'another step, not the goal, the contract or the scope. The runner compares',
    'the file before and after and will leave your PR unmerged if you changed',
    'anything else.',
    '',
    'If the contract must change, or a later step is wrong, set this step to',
    '`blocked` with `blocked_by: { "kind": "decision" | "project", "name": … }` —',
    'required, because a blocked step that does not say what it waits for is one',
    'nobody can unblock — and stop. Say it in the pull request too, with one',
    'recommendation rather than a menu; that is where it will be read.',
    '',
    'Do not merge. Do not ask questions. Stop when the PR exists.',
    '',
    '----- PLAN.json -----',
    planText,
  ].join('\n');
}

/**
 * The one repair session a held pull request gets, told what the gate saw.
 *
 * Everything the session needs that it cannot read off the branch: which pull
 * request, which branch, why the runner would not land it, and — where the
 * hold came from a gate — every red test by name and the output of every
 * command gate that failed. A session told `sql:pr-ci — exit 1` and nothing
 * else guesses; that is what happened on 2026-09-03, three rounds long.
 */
export function repairPrompt({ name, repo, pr, branch, reason, note = null, red = [], gates = [], conflicts = [] }) {
  const lines = [
    `You are in the \`${name}\` workarea of ${repo} (this worktree), on branch`,
    `\`${branch}\`, whose pull request #${pr} the runner would not land:`,
    '',
    reason,
    '',
  ];
  if (red.length) {
    lines.push(`The ${red.length} test${red.length === 1 ? '' : 's'} the gate found red, all of them:`, ...red.map((test) => `  ${test}`), '');
  }
  for (const gate of gates) {
    lines.push(`The gate \`${gate.name}\` failed. What it printed:`, ...String(gate.output).split('\n').map((line) => `  ${line}`), '');
  }
  // A pull request held *because* it conflicts with main is the common case:
  // the gate refused it for the conflict, and the runner's own sync then hits
  // the same one. Resolving it is not a detour from the repair, it is the
  // repair — see `runProject`, where a conflict no longer refuses this session.
  lines.push(...conflictPreamble(conflicts, [
    'commit the merge, and push. For a pull request held because it conflicts',
    'with main, that is the whole repair; where the reason names something else',
    'as well, it is the first thing and the reason below is the rest.',
  ]));
  lines.push(
    'Make it green and push to the same branch — the runner lands it after you.',
    'Do not open another pull request, do not merge it yourself, do not lower a',
    'threshold and do not delete or skip a test to pass. The gate decides; a',
    'repair obeys it.',
    '',
  );
  if (note === 'plan-trespass') {
    lines.push(
      'The problems above are the plan boundary: undo the change to any step that',
      "is not the one this pull request carries, and to the goal, the contract, the",
      "scope and the criteria themselves. Keep that step's own `status`, `pr` and",
      '`comments`, and `met` on the criteria it met.',
      '',
    );
  }
  lines.push(
    'If green needs a decision — an SQL admission, a change to the contract, a',
    'threshold somebody has to agree to — do not take it. Set the step this pull',
    'request carries to `blocked` with `blocked_by: { "kind": "decision" |',
    '"project", "name": … }`, say in the pull request what the answer is about with',
    'one recommendation rather than a menu, push, and stop.',
    '',
    'This is the one repair session this pull request gets. If it is still held',
    "after you, it is a person's, through the brief — so say what you found either",
    'way.',
  );
  return lines.join('\n');
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
 */
export function headlessArgs({ toolId, adapter, model, instructions, prompt, profileArgs }) {
  const modelArgs = adapter?.modelArgs?.(model) ?? [];
  const instr = profileArgs(toolId, instructions);
  if (toolId === 'codex') return ['exec', '--json', '--sandbox', 'danger-full-access', ...modelArgs, ...instr, prompt];
  return ['-p', prompt, ...modelArgs, '--permission-mode', 'acceptEdits', ...instr, '--output-format', 'json'];
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

export function tsvRow({ ts, name, kind, exit, seconds, pr, turns, input, output, cacheRead, cacheWrite, session, note, landSeconds }) {
  const cell = (v) => String(v ?? '-').replace(/[\t\n]/gu, ' ');
  // `seconds` is the session; `land_seconds` is the gated round that followed
  // it. They are separate because the gate costs 20–35 minutes on memoro where
  // the old `gh pr merge` cost seconds, and a reader of runs.tsv asking where
  // a night went can only see that if the two are not added up here.
  return [ts, name, kind, exit, seconds, pr, turns, input, output, cacheRead, cacheWrite, session, note, landSeconds].map(cell).join('\t');
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
