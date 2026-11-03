/**
 * `mc goal` — a goal and its two text files and worktrees (`goals.js`).
 *
 *   mc goal new <programme>/<goal> --repo <repo>[,<repo>] --class fast|large --title "<title>" [--phase <n>] [--stage plan|build]
 *                                  GOAL.json (a skeleton), LOG.md and a worktree per repository on goal/<goal>,
 *                                  from origin/main; in phase <n> (1 by default), at most one past the last;
 *                                  in stage plan (by default) or build
 *   mc goal set <programme>/<goal> title|goal|contract|out-of-scope --text "…"   the field replaced; a blank line parts paragraphs
 *   mc goal document add <programme>/<goal> --label "…" --path "…"   a document the goal sends its reader to
 *   mc goal criterion add <programme>/<goal> --criterion "…" --check "…"   a success criterion, not met
 *   mc goal criterion met|unmet [<programme>/<goal>] <n>   criterion <n> recorded as holding, or not
 *   mc goal convert [<programme>]       every goal still in markdown, not in .archive/, turned into GOAL.json,
 *                                  and every goal that started after others given a phase (`phaseGoals`)
 *   mc goal from-project <programme>/<project>   a live project's remaining steps turned into goals, once
 *                                  (`project-convert.js`); a finished one is refused
 *   mc goal phase [<programme>/<goal>] <n>   the goal moved to phase <n>; the programme's phases renumbered
 *   mc goal log [<programme>/<goal>] [--done "…"] [--comment "…"] [--next "…"] [--stage <stage>] [--status ready|blocked]
 *                                  one session's entry appended to LOG.md; with --stage or --status GOAL.json's is set too
 *   mc goal stage [<programme>/<goal>] <stage> [--reason "…"] [--sha <sha>]   mc goal log --stage <stage> --comment <reason>;
 *                                  going to build, a worktree whose branch has no commits of its own is remade from origin/main;
 *                                  from a review, merging queues the pull request at the head it judged
 *   mc goal blocked|ready [<programme>/<goal>] [--reason "…"]   the status, the stage kept
 *   mc goal done [<programme>/<goal>] [--reason "…"]   stage done, a person's (the merger sets it when the pull request lands)
 *   mc goal drop [<programme>/<goal>] --reason "…"   let go without landing: `dropped`, never `done`
 *   mc goal pr <programme>/<goal> <repo>#<n>…   the pull requests named carry the goal (`prs`)
 *   mc goal archive <programme>/<goal>… | <programme>   a done or dropped goal to goals/.archive/, its
 *                                  worktrees and branch gone, one row in goals/goal_log.md; the runner
 *                                  does the same 24 hours after a goal is done or dropped
 *   mc goal show <programme>/<goal>      the goal as text (`renderGoalText`), the last three entries, each worktree's state
 *   mc goal list [<programme>]           every goal, one line each, under its programme's phases
 *
 * The goal defaults to MC_GOAL's in a goal session. No verb here owns a goal:
 * the worktree is anyone's. GOAL.json is written by these verbs only, each write
 * validated (`updateGoal`); nobody edits it by hand.
 * A goal's stage only moves forward (`goals.js` `STAGES`); only a person moves
 * it back (`refusedMove`). A build session moves `build` to `review` — not
 * while a criterion is not met (`unmetGoalWords`) — or sets `blocked`; a
 * review session moves `review` to `merging` or `finish`; a plan session any
 * stage forward.
 *
 * A goal's phase is not its stage: a goal in a later phase keeps the stage
 * it has, and the runner does not pick it until every goal of the programme in
 * a lower phase is done or dropped (`phaseOpen`). The phases are renumbered
 * when a goal is archived or moved (`renumberPhases`), so they run 1, 2, …
 * with no holes.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { commandUsage } from '../command-help.js';

import { writeFileAtomic } from '../atomic-write.js';
import { archiveGoal, moveDir } from '../goal-archive.js';
import { run as runGit } from '../git.js';
import { convertGoals, phaseGoals } from '../goal-convert.js';
import { convertProject } from '../project-convert.js';
import { addGoalWorktree, addPr, backward, criteriaWords, currentPhase, FINISHED, goalDirIn, GOAL_FILE, GOALS_DIR, appendEntry, appendLog, CLASSES, isGoalRef, LOG_FILE, listDirsOf, logStamp, noCriteria, parseGoal, parseLog, parsePrRef, programsGoals, PROSE_FIELDS, prRef, readTextOrNull, remakeUnbuiltBranches, renderEntry, renderGoal, renderGoalText, renumberPhases, PLAN_ROLE, REVIEW_FILE, REVIEW_ROLE, sessions, setGoalState, STAGES, stageWords, STATUSES, unmetGoalWords, updateGoal, waitsOnPerson } from '../goals.js';
import { queueMerge } from '../merger.js';
import { workRoot } from '../paths.js';
import { NAME_RE } from '../plan-schema.js';
import { programsHome } from '../paths.js';
import { repoNameOf } from '../repos.js';
import { knownRepositories } from '../work-area.js';
import { only, scanArgs } from './flags.js';

/** Every flag any verb takes as a value. */
const VALUE_FLAGS = ['--repo', '--class', '--title', '--phase', '--stage', '--sha', '--done', '--comment', '--next', '--status', '--reason', '--text', '--label', '--path', '--criterion', '--check'];
/** The flags each verb takes; any other given is refused with exit 2. */
const VERB_FLAGS = {
  new: ['--repo', '--class', '--title', '--phase', '--stage'],
  phase: [],
  set: ['--text'],
  'document add': ['--label', '--path'],
  'criterion add': ['--criterion', '--check'],
  'criterion met': [],
  'criterion unmet': [],
  convert: [],
  'from-project': [],
  log: ['--done', '--comment', '--next', '--stage', '--status'],
  stage: ['--reason', '--sha'],
  status: ['--reason'],
  pr: [],
  archive: [],
  show: [],
  list: [],
};
/** The verbs that set one field: `blocked` and `ready` the status, `done` and `drop` the final stage. */
const STATUS_VERBS = ['blocked', 'ready', 'done', 'drop'];
const STATUS_VERB_FIELDS = { blocked: { status: 'blocked' }, ready: { status: 'ready' }, done: { stage: 'done' }, drop: { stage: 'dropped' } };
/** Each verb and what it accepts, from the lists above (help-routes.test.js walks the help with it). */
export const ROUTES = Object.fromEntries([
  ...Object.entries(VERB_FLAGS).filter(([verb]) => verb !== 'status'),
  ...STATUS_VERBS.map((verb) => [verb, VERB_FLAGS.status]),
].map(([verb, names]) => [verb, only({ strictValues: VALUE_FLAGS }, names)]));

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const scanned = scanArgs(argv, { strictValues: VALUE_FLAGS });
  if (scanned.error) { stderr.write(`mc: ${scanned.error}\n${usage()}`); return 2; }
  let [verb, ...rest] = scanned.positional;
  // `document` and `criterion` take a second word: the form is both.
  if ((verb === 'document' || verb === 'criterion') && rest.length) verb = `${verb} ${rest.shift()}`;

  const verbFlags = STATUS_VERBS.includes(verb) ? VERB_FLAGS.status : (Object.hasOwn(VERB_FLAGS, verb) ? VERB_FLAGS[verb] : null);
  if (!verbFlags) { stderr.write(usage()); return 2; }
  const extra = onlyFlags(scanned, verbFlags);
  if (extra) { stderr.write(`mc: ${verb} takes no ${extra}\n`); return 2; }

  const ctx = {
    stdout, stderr, env,
    home: deps.home || programsHome(env),
    now: deps.now ? deps.now() : new Date(),
    read: deps.read || readTextOrNull,
    write: deps.write || writeFileAtomic,
    list: deps.list || listDirsOf,
    git: deps.git || gitIn,
    known: deps.known || (() => knownRepositories(env)),
    gh: deps.gh || ghIn,
    queue: deps.queue || ((options) => queueMerge({ root: workRoot(env), env, ...options })),
    move: deps.move || moveDir,
    appendText: deps.appendText || appendText,
    remove: deps.remove || unlinkSync,
  };
  const { flags } = scanned;

  if (verb === 'new') return newGoal(rest, flags, ctx);
  if (verb === 'phase') return setPhase(rest, ctx);
  if (verb === 'set') return setField(rest, flags, ctx);
  if (verb === 'document add') return addDocument(rest, flags, ctx);
  if (verb === 'criterion add') return addCriterion(rest, flags, ctx);
  if (verb === 'criterion met' || verb === 'criterion unmet') return markCriterion(rest, verb === 'criterion met', ctx);
  if (verb === 'convert') return convert(rest, ctx);
  if (verb === 'from-project') return fromProject(rest, ctx);
  if (verb === 'log') return logEntry(rest, { stage: flags.stage, status: flags.status, done: flags.done, comment: flags.comment, next: flags.next }, ctx);
  if (verb === 'stage') {
    if (rest.length < 1 || rest.length > 2) { stderr.write(`mc: stage [<programme>/<goal>] ${STAGES.join('|')}\n`); return 2; }
    const stage = rest.pop();
    return logEntry(rest, { stage, status: null, done: null, comment: flags.reason, next: null, sha: flags.sha }, ctx);
  }
  if (verb === 'drop' && !flags.reason) { stderr.write('mc: drop needs --reason "…" — why the goal is let go\n'); return 2; }
  if (STATUS_VERBS.includes(verb)) return logEntry(rest, { stage: null, status: null, ...STATUS_VERB_FIELDS[verb], done: null, comment: flags.reason, next: null }, ctx);
  if (verb === 'pr') return carryPrs(rest, ctx);
  if (verb === 'archive') return archiveGoals(rest, ctx);
  if (verb === 'show') return showGoal(rest, ctx);
  return listGoals(rest, ctx);
}

/**
 * `mc goal new <programme>/<goal>` — makes a goal. The programme must be a
 * directory under the programmes home, the goal must not exist, and every
 * repository named must be one mc knows. Each repository is fetched first, so
 * a fetch that fails leaves nothing behind; then GOAL.json — a skeleton with
 * the title and no criterion, which the runner starts no session on, in phase
 * `--phase` (1 by default; at most one past the programme's last) — and
 * LOG.md are written, and a worktree of each repository on `goal/<goal>`,
 * from origin/main, or on that branch as it is when it already exists.
 */
function newGoal(args, flags, ctx) {
  const { stdout, stderr, home, now } = ctx;
  if (args.length !== 1) { stderr.write(usage()); return 2; }
  const [name] = args;
  const parts = name.split('/');
  if (parts.length !== 2 || !NAME_RE.test(parts[0]) || !NAME_RE.test(parts[1])) {
    stderr.write(`mc: ${name} is not <programme>/<goal> — lower-case letters, digits and hyphens\n`);
    return 2;
  }
  const [programme, goal] = parts;

  const missing = [['--repo', flags.repo], ['--class', flags.class], ['--title', flags.title]]
    .filter(([, value]) => value === null || value.trim() === '')
    .map(([flag]) => flag);
  if (missing.length) { stderr.write(`mc: new needs ${missing.join(', ')}\n`); return 2; }
  if (!CLASSES.includes(flags.class)) { stderr.write(`mc: --class is ${CLASSES.join(' or ')}, not ${flags.class}\n`); return 2; }
  const repos = [...new Set(flags.repo.split(',').map((repo) => repo.trim()).filter(Boolean))];
  if (repos.length === 0) { stderr.write('mc: new needs --repo <repo>[,<repo>]\n'); return 2; }

  const stage = flags.stage ?? 'plan';
  if (stage !== 'plan' && stage !== 'build') { stderr.write(`mc: --stage is plan or build for a new goal, not ${stage}\n`); return 2; }
  const phase = flags.phase === null ? 1 : Number(flags.phase);
  if (!Number.isInteger(phase) || phase < 1) { stderr.write(`mc: --phase is a whole number from 1, not ${flags.phase}\n`); return 2; }

  const known = ctx.known();
  const unknown = repos.filter((repo) => !known.some((path) => repoNameOf(path) === repo));
  if (unknown.length) {
    stderr.write(`mc: ${unknown.join(', ')} is not a repository mc knows — ${known.map(repoNameOf).join(', ')}\n`);
    return 2;
  }
  if (!ctx.list(home).includes(programme)) { stderr.write(`mc: no programme ${programme} under ${home}\n`); return 1; }
  const dir = goalDirIn(home, programme, goal);
  if (ctx.list(join(home, programme, GOALS_DIR)).includes(goal)) { stderr.write(`mc: ${programme}/${goal} exists — ${dir}\n`); return 1; }
  const holed = phaseHole(phase, programme, null, ctx);
  if (holed) { stderr.write(`mc: ${holed}\n`); return 2; }

  const bares = repos.map((repo) => ({ repo, bare: known.find((path) => repoNameOf(path) === repo) }));
  for (const { repo, bare } of bares) {
    const fetched = ctx.git(bare, ['fetch', '-q', 'origin']);
    if (!fetched.ok) { stderr.write(`mc: could not fetch ${repo} — ${fetched.stderr.trim()}\n`); return 1; }
  }

  const created = stampSeconds(now);
  ctx.write(join(dir, GOAL_FILE), renderGoal({ stage, status: 'ready', phase, repos, class: flags.class, created, title: flags.title.trim(), success_criteria: [] }));
  ctx.write(join(dir, LOG_FILE), appendLog('', { at: logStamp(now), tool: ctx.env.MC_TOOL || 'person', model: ctx.env.MC_MODEL || null, stage, status: 'ready', done: phase > 1 ? `created, phase ${phase}` : 'created', comment: null, next: null }));
  stdout.write(`mc: ${programme}/${goal} · ${stage} · ready · phase ${phase} — ${dir}\n`);

  for (const { repo, bare } of bares) {
    const path = join(dir, repo);
    const added = addGoalWorktree({ git: ctx.git, bare, path, goal });
    if (!added.ok) {
      stderr.write(`mc: ${repo}'s worktree is not made — ${added.stderr.trim()}; the goal's files stand in ${dir}\n`);
      return 1;
    }
    stdout.write(`  ${repo}  ${path}  ${added.existed ? `${added.branch}, as it was` : `${added.branch} from origin/main`}\n`);
  }
  stdout.write(`${GOAL_FILE} is to be filled in by verbs: mc goal set ${programme}/${goal} goal|contract|out-of-scope --text "…", mc goal criterion add ${programme}/${goal} --criterion "…" --check "…"\n`);
  return 0;
}

/**
 * `mc goal log`, `mc goal stage` and `mc goal blocked|ready|done|drop` —
 * appends one entry to the goal's LOG.md, tagged with MC_TOOL and MC_MODEL
 * (`person` when neither is set), with the stage and status the goal then
 * has. With a stage or status GOAL.json's is set too; an unknown one is
 * refused naming the field. A goal whose GOAL.json does not parse is refused,
 * and so is a move the caller may not make (`refusedMove`): a session's
 * backward one, `review` while a criterion is not met, a review's `finish`
 * without REVIEW.md. A person's backward move is made and logged. A review's
 * `merging` queues the goal's pull request for the merger at the head it
 * judged (`queueJudged`) before anything is written; a queue that fails
 * writes nothing.
 */
function logEntry(args, fields, ctx) {
  const { stdout, stderr, env, read, write } = ctx;
  if (args.length > 1) { stderr.write(usage()); return 2; }
  const target = goalNamed(args[0], ctx);
  if (target.error) { stderr.write(`mc: ${target.error}\n`); return 2; }
  if (fields.stage !== null && !STAGES.includes(fields.stage)) { stderr.write(`mc: stage is ${STAGES.join(', ')}, not ${fields.stage}\n`); return 2; }
  if (fields.status !== null && !STATUSES.includes(fields.status)) { stderr.write(`mc: status is ${STATUSES.join(', ')}, not ${fields.status}\n`); return 2; }
  if ([fields.done, fields.comment, fields.next, fields.stage, fields.status].every((value) => value === null || value === undefined)) {
    stderr.write('mc: log needs --done, --comment, --next, --stage or --status\n');
    return 2;
  }
  const text = read(join(target.dir, GOAL_FILE));
  if (text === null) { stderr.write(`mc: no goal ${target.name} — ${target.dir} has no ${GOAL_FILE}\n`); return 1; }
  const goal = parseGoal(text);
  if (goal.problems) {
    for (const problem of goal.problems) stderr.write(`mc: ${target.name}: ${problem}\n`);
    return 1;
  }
  const refused = refusedMove({ from: goal.stage, to: fields.stage, status: fields.status, env, reviewWritten: read(join(target.dir, REVIEW_FILE)) !== null, dir: target.dir });
  if (refused) { stderr.write(`mc: ${refused}\n`); return 2; }
  if (fields.stage === 'review' && goal.stage !== 'review' && sessionNotPlan(env)) {
    const unmet = unmetGoalWords(goal, target.name);
    if (unmet) { stderr.write(`mc: ${target.name} is not moved to review — ${unmet}\n`); return 1; }
  }
  const moves = fields.stage !== null && fields.stage !== goal.stage;
  let done = fields.done;
  if (moves && fields.stage === 'merging' && env.MC_ROLE === REVIEW_ROLE && isSession(env)) {
    const queued = queueJudged(target, goal, fields.sha ?? env.MC_REVIEW_HEAD ?? null, ctx);
    if (queued.error) { stderr.write(`mc: ${target.name} is not moved to merging — ${queued.error}\n`); return 1; }
    done = [done, queued.text].filter(Boolean).join('; ');
  }
  const back = moves && backward(goal.stage, fields.stage);
  const comment = back ? [fields.comment, `moved back from ${goal.stage} to ${fields.stage} by a person`].filter(Boolean).join(' — ') : fields.comment;
  const entry = { at: logStamp(ctx.now), tool: env.MC_TOOL || 'person', model: env.MC_MODEL || null, done, comment, next: fields.next };
  let now = goal;
  if (fields.stage !== null || fields.status !== null) {
    const outcome = setGoalState({ dir: target.dir, stage: fields.stage ?? undefined, status: fields.status ?? undefined, entry, read, write });
    if (outcome.problems) {
      for (const problem of outcome.problems) stderr.write(`mc: ${target.name}: ${problem}\n`);
      return 1;
    }
    now = outcome.goal;
  } else {
    appendEntry({ dir: target.dir, entry: { ...entry, stage: goal.stage, status: goal.status }, read, write });
  }
  stdout.write(`mc: ${target.name} · ${stageWords(now)}${back ? ` — moved back from ${goal.stage}` : ''}\n`);
  if (done && done !== fields.done) stdout.write(`mc: ${done}\n`);
  if (now.stage === 'build' && goal.stage !== 'build') remakeBranches(target, goal, ctx);
  return 0;
}

/**
 * The goal's open pull request queued for the merger at `sha`, the head its
 * review judged, as `mc merge` queues — with the goal and that sha on the
 * job, so the merger lands that head and no other (`merger.js` `landJob`).
 * `{ text }` said into the entry, or `{ error }`: no sha, no pull request on
 * `goal/<goal>`, or a queue that fails.
 */
function queueJudged(target, goal, sha, ctx) {
  if (!sha) return { error: 'which head did the review judge? MC_REVIEW_HEAD is not set — --sha <sha>' };
  const [repoName] = goal.repos;
  const repoPath = ctx.known().find((path) => repoNameOf(path) === repoName);
  if (!repoPath) return { error: `${repoName} is not a repository mc knows` };
  const branch = `goal/${target.goal}`;
  const asked = ctx.gh(repoPath, ['pr', 'list', '--state', 'open', '--head', branch, '--json', 'number,headRefOid']);
  if (!asked.ok) return { error: `its pull request could not be read (${asked.stderr.trim() || 'gh failed'})` };
  let pr;
  try { [pr] = JSON.parse(asked.stdout || '[]'); } catch (error) { return { error: `gh answered what is not JSON (${error.message})` }; }
  if (!pr) return { error: `${branch} has no open pull request` };
  try {
    ctx.queue({ repo: repoName, repoPath, pr: pr.number, branch, holder: { name: `goal:${target.name}` }, goal: { programme: target.programme, goal: target.goal, dir: target.dir }, sha, now: ctx.now });
  } catch (error) {
    return { error: `#${pr.number} could not be queued (${error?.message || error})` };
  }
  return { text: `queued #${pr.number} at ${sha} for the merger` };
}

/** `remakeUnbuiltBranches` for a goal going open by a verb, each repository's answer on stdout. */
function remakeBranches(target, goal, { stdout, git }) {
  remakeUnbuiltBranches({ git, dir: target.dir, goal: target.goal, repos: goal.repos, say: (repo, text) => stdout.write(`  ${repo}  ${text}\n`) });
}

/**
 * Why `phase` would leave a hole in `programme`'s phases, or null: a phase is
 * at most one past the highest of the programme's other goals (`self` left
 * out, a goal being moved), so phases run 1, 2, … with nothing between.
 */
function phaseHole(phase, programme, self, ctx) {
  const others = programsGoals({ home: ctx.home, list: ctx.list, read: ctx.read })
    .filter((goal) => goal.programme === programme && goal.goal !== self && goal.problems.length === 0);
  const highest = others.reduce((most, goal) => Math.max(most, goal.phase), 0);
  return phase > highest + 1 ? `phase ${phase} would leave a hole — ${programme}'s phases run to ${highest}, so ${highest + 1} is the highest a goal may take` : null;
}

/**
 * `mc goal phase [<programme>/<goal>] <n>` — the goal moved to phase `n`, at
 * most one past the highest of its programme's other goals (`phaseHole`).
 * The programme's phases are then renumbered (`renumberPhases`), so a phase
 * the move left empty closes up. Logged as a person's (or session's) entry.
 */
function setPhase(args, ctx) {
  const { stdout, stderr, env, home, list, read, write } = ctx;
  if (args.length < 1 || args.length > 2) { stderr.write(usage()); return 2; }
  const [named, given] = args.length === 2 ? args : [undefined, args[0]];
  const phase = Number(given);
  if (!Number.isInteger(phase) || phase < 1) { stderr.write(`mc: ${given} is not a phase — 1, 2, …\n`); return 2; }
  const target = goalNamed(named, ctx);
  if (target.error) { stderr.write(`mc: ${target.error}\n`); return 2; }
  if (read(join(target.dir, GOAL_FILE)) === null) { stderr.write(`mc: no goal ${target.name} — ${target.dir} has no ${GOAL_FILE}\n`); return 1; }
  const holed = phaseHole(phase, target.programme, target.goal, ctx);
  if (holed) { stderr.write(`mc: ${holed}\n`); return 2; }
  const outcome = updateGoal({ dir: target.dir, change: (goal) => ({ ...goal, phase }), read, write });
  if (outcome.problems) {
    for (const problem of outcome.problems) stderr.write(`mc: ${target.name}: ${problem}\n`);
    return 1;
  }
  const entry = { at: logStamp(ctx.now), tool: env.MC_TOOL || 'person', model: env.MC_MODEL || null, stage: outcome.goal.stage, status: outcome.goal.status, done: `phase ${phase}`, comment: null, next: null };
  appendEntry({ dir: target.dir, entry, read, write });
  const moved = renumberPhases({ home, programme: target.programme, list, read, write });
  const own = moved.find((move) => move.goal.goal === target.goal);
  stdout.write(`mc: ${target.name} · phase ${own ? own.to : phase}\n`);
  for (const move of moved.filter((item) => item !== own)) stdout.write(`  ${move.goal.programme}/${move.goal.goal}  phase ${move.from} → ${move.to}\n`);
  return 0;
}

/**
 * `mc goal set <programme>/<goal> title|goal|contract|out-of-scope --text "…"`
 * — the field replaced by the text; a prose field takes a paragraph per block
 * between blank lines, and an empty text clears it.
 */
function setField(args, flags, ctx) {
  const { stdout, stderr } = ctx;
  const words = ['title', ...Object.keys(PROSE_FIELDS)];
  if (args.length !== 2 || !words.includes(args[1])) { stderr.write(`mc: set <programme>/<goal> ${words.join('|')} --text "…"\n`); return 2; }
  if (flags.text === null) { stderr.write('mc: set needs --text "…"\n'); return 2; }
  const [named, field] = args;
  const paragraphs = flags.text.split(/\n\s*\n/u).map((part) => part.trim()).filter(Boolean);
  return changeGoal(named, ctx, (goal) => (field === 'title'
    ? { ...goal, title: flags.text.trim() }
    : { ...goal, [PROSE_FIELDS[field]]: paragraphs }), () => `${field} set`);
}

/** `mc goal document add <programme>/<goal> --label "…" --path "…"` — a document appended to the goal's. */
function addDocument(args, flags, ctx) {
  const { stderr } = ctx;
  if (args.length !== 1) { stderr.write(usage()); return 2; }
  const missing = ['label', 'path'].filter((key) => !flags[key]?.trim()).map((key) => `--${key}`);
  if (missing.length) { stderr.write(`mc: document add needs ${missing.join(', ')}\n`); return 2; }
  return changeGoal(args[0], ctx, (goal) => ({ ...goal, documents: [...goal.documents, { label: flags.label.trim(), path: flags.path.trim() }] }),
    (goal) => `document ${goal.documents.length} added`);
}

/** `mc goal criterion add <programme>/<goal> --criterion "…" --check "…"` — a criterion appended, not met. */
function addCriterion(args, flags, ctx) {
  const { stderr } = ctx;
  if (args.length !== 1) { stderr.write(usage()); return 2; }
  const missing = ['criterion', 'check'].filter((key) => !flags[key]?.trim()).map((key) => `--${key}`);
  if (missing.length) { stderr.write(`mc: criterion add needs ${missing.join(', ')} — what must be true, and how it is checked\n`); return 2; }
  return changeGoal(args[0], ctx, (goal) => ({ ...goal, success_criteria: [...goal.success_criteria, { criterion: flags.criterion.trim(), check: flags.check.trim(), met: false }] }),
    (goal) => `criterion ${goal.success_criteria.length} added · ${criteriaWords(goal)}`);
}

/**
 * `mc goal criterion met|unmet [<programme>/<goal>] <n>` — criterion `n`
 * (1-based) recorded as holding, after its check was run, or taken back.
 */
function markCriterion(args, met, ctx) {
  const { stderr } = ctx;
  if (args.length < 1 || args.length > 2) { stderr.write(usage()); return 2; }
  const [named, given] = args.length === 2 ? args : [undefined, args[0]];
  const n = Number(given);
  if (!Number.isInteger(n) || n < 1) { stderr.write(`mc: ${given} is not a criterion's number — 1, 2, …\n`); return 2; }
  return changeGoal(named, ctx, (goal) => {
    if (n > goal.success_criteria.length) return { problems: [`it has ${goal.success_criteria.length} criteria, no criterion ${n}`] };
    return { ...goal, success_criteria: goal.success_criteria.map((item, i) => (i === n - 1 ? { ...item, met } : item)) };
  }, (goal) => `criterion ${n} ${met ? 'met' : 'unmet'} · ${criteriaWords(goal)}`);
}

/** One verb's change to a goal's GOAL.json (`updateGoal`), said on stdout, or why not on stderr. */
function changeGoal(named, ctx, change, said) {
  const { stdout, stderr, read, write } = ctx;
  const target = goalNamed(named, ctx);
  if (target.error) { stderr.write(`mc: ${target.error}\n`); return 2; }
  if (read(join(target.dir, GOAL_FILE)) === null) { stderr.write(`mc: no goal ${target.name} — ${target.dir} has no ${GOAL_FILE}\n`); return 1; }
  const outcome = updateGoal({ dir: target.dir, change, read, write });
  if (outcome.problems) {
    for (const problem of outcome.problems) stderr.write(`mc: ${target.name}: ${problem}\n`);
    return 1;
  }
  stdout.write(`mc: ${target.name} · ${said(outcome.goal)}\n`);
  return 0;
}

/**
 * `mc goal convert [<programme>]` — every goal of the programme (of every
 * programme when none is named) still written in markdown turned into
 * GOAL.json, and the markdown removed (`goal-convert.js`); then every goal
 * that started after others given its phase by the depth of that chain
 * (`phaseGoals`). Exit 1 when one could not be.
 */
function convert(args, ctx) {
  const { stdout, stderr, env, home, list, read, write, remove } = ctx;
  if (args.length > 1) { stderr.write(usage()); return 2; }
  const [programme = null] = args;
  if (programme !== null && !NAME_RE.test(programme)) { stderr.write(`mc: ${programme} is not a programme name\n`); return 2; }
  const answers = convertGoals({ home, programme, list, read, write, remove });
  const phased = phaseGoals({ home, programme, list, read, write, now: ctx.now, tool: env.MC_TOOL || 'person' });
  if (!answers.length && !phased.length) { stdout.write('mc: nothing to convert\n'); return 0; }
  for (const answer of answers) {
    if (answer.problems) stderr.write(`mc: ${answer.name} is not converted — ${answer.problems.join('; ')}\n`);
    else stdout.write(`mc: ${answer.name} · converted, ${answer.criteria} criteria\n`);
  }
  for (const answer of phased) {
    if (answer.problems) stderr.write(`mc: ${answer.name} is not given a phase — ${answer.problems.join('; ')}\n`);
    else stdout.write(`mc: ${answer.name} · ${answer.stage} · ${answer.status}${answer.from ? ` (was ${answer.from})` : ''}, phase ${answer.phase}${answer.after.length ? ` (was after ${answer.after.join(', ')})` : ''}\n`);
  }
  return [...answers, ...phased].some((answer) => answer.problems) ? 1 : 0;
}

/**
 * `mc goal from-project <programme>/<project>` — a live project turned into
 * goals (`convertProject`), each said with its status, branch, what it waits
 * on and the pull request it carries. A finished project, or one converted
 * already, is refused with exit 1.
 */
function fromProject(args, ctx) {
  const { stdout, stderr, env, home, now, list, read, write, git, known } = ctx;
  if (args.length !== 1 || !isGoalRef(args[0])) { stderr.write('mc: from-project <programme>/<project>\n'); return 2; }
  const [programme, project] = args[0].split('/');
  const answer = convertProject({ home, programme, project, now, tool: env.MC_TOOL || 'person', model: env.MC_MODEL || null, list, read, write, git, known });
  if (answer.refused) { stderr.write(`mc: ${args[0]} is not converted — ${answer.refused}\n`); return 1; }
  for (const goal of answer.made) {
    const extra = [goal.after.length ? `after ${goal.after.join(', ')}` : null, goal.prs.length ? `carries ${goal.prs.map(prRef).join(', ')}` : null].filter(Boolean);
    stdout.write(`mc: ${goal.name} · ${goal.status} · ${goal.branch}${extra.length ? ` · ${extra.join(' · ')}` : ''}\n`);
    if (goal.worktree) stderr.write(`mc: ${goal.name}'s worktree is not made — ${goal.worktree}; the goal's files stand\n`);
  }
  stdout.write(`mc: ${answer.made.length} goal${answer.made.length === 1 ? '' : 's'} made from ${args[0]}; the project's own files are left as they are\n`);
  return answer.made.some((goal) => goal.worktree) ? 1 : 0;
}

/**
 * `mc goal show <programme>/<goal>` — its status line, the goal as text
 * (`renderGoalText`: goal, contract, out of scope, documents, each criterion
 * with ✓/✗ and its check), the last three log entries, and for each repository's worktree its changed
 * files, its commits past origin/main and its last commit's date.
 */
function showGoal(args, ctx) {
  const { stdout, stderr, read, git } = ctx;
  if (args.length !== 1) { stderr.write(usage()); return 2; }
  const target = goalNamed(args[0], ctx);
  if (target.error) { stderr.write(`mc: ${target.error}\n`); return 2; }
  const text = read(join(target.dir, GOAL_FILE));
  if (text === null) { stderr.write(`mc: no goal ${target.name} — ${target.dir} has no ${GOAL_FILE}\n`); return 1; }
  const goal = parseGoal(text);
  if (goal.problems) {
    stderr.write(`mc: ${target.name} does not parse:\n`);
    for (const problem of goal.problems) stderr.write(`  ${problem}\n`);
    return 1;
  }
  stdout.write(`${target.name} · ${stageWords(goal)} · phase ${goal.phase} · ${goal.repos.join(', ')} · ${goal.class} · ${criteriaWords(goal)} · created ${goal.created ?? '—'}${goal.prs.length ? ` · prs ${goal.prs.map(prRef).join(', ')}` : ''}\n`);
  stdout.write(`\n${renderGoalText(goal)}`);

  const log = parseLog(read(join(target.dir, LOG_FILE)) ?? '');
  stdout.write('\nLOG\n');
  if (log.length === 0) stdout.write('  no entries yet\n');
  for (const entry of log.slice(-3)) stdout.write(renderEntry(entry));

  stdout.write('\nWORKTREES\n');
  for (const repo of goal.repos) {
    const path = join(target.dir, repo);
    const status = git(path, ['status', '--short']);
    if (!status.ok) { stdout.write(`  ${repo}  ${path} — no worktree\n`); continue; }
    const changed = status.stdout.split('\n').filter((line) => line.trim() !== '').length;
    const ahead = git(path, ['rev-list', '--count', 'origin/main..HEAD']);
    const last = git(path, ['log', '-1', '--format=%cI']);
    const lastDate = last.ok && last.stdout.trim() ? last.stdout.trim() : 'none';
    stdout.write(`  ${repo}  ${path}  ${changed} changed · ${ahead.ok ? ahead.stdout.trim() : '?'} commits past origin/main · last commit ${lastDate}\n`);
  }
  return 0;
}

/**
 * `mc goal list [<programme>]` — each programme's goals under a line per
 * phase: `<programme> · phase <n> · in progress` for the phase the programme
 * is in (`currentPhase`), `… · done` for one before it, `… · after phase <m>`
 * for one after it. Under it, one line per goal: `programme/goal · repos ·
 * stage · status · criteria <met>/<all> · n sessions · the last entry's Next`. A
 * goal in build with no criterion reads `build · ready, no criteria — not started`; a
 * blocked one `<stage> · blocked, waits on a person`. Goals that do not parse
 * have no phase; they are listed last, with their first problems, not skipped.
 */
function listGoals(args, ctx) {
  const { stdout, stderr, home, list, read } = ctx;
  if (args.length > 1) { stderr.write(usage()); return 2; }
  const [programme] = args;
  if (programme !== undefined && !NAME_RE.test(programme)) {
    stderr.write(`mc: ${programme} is not a programme name — lower-case letters, digits and hyphens\n`);
    return 2;
  }
  const all = programsGoals({ home, list, read });
  const goals = all.filter((goal) => programme === undefined || goal.programme === programme);
  if (goals.length === 0) { stdout.write('mc: no goals\n'); return 0; }
  for (const one of [...new Set(goals.map((goal) => goal.programme))]) {
    const own = goals.filter((goal) => goal.programme === one);
    const current = currentPhase(all, one);
    const phases = [...new Set(own.filter((goal) => !goal.problems.length).map((goal) => goal.phase))].sort((a, b) => a - b);
    for (const phase of phases) {
      const state = current === null || phase < current ? 'done' : phase === current ? 'in progress' : `after phase ${phase - 1}`;
      stdout.write(`${one} · phase ${phase} · ${state}\n`);
      for (const goal of own.filter((item) => !item.problems.length && item.phase === phase)) stdout.write(`  ${goalLine(goal)}\n`);
    }
    for (const goal of own.filter((item) => item.problems.length)) stdout.write(`  ${goal.programme}/${goal.goal} · does not parse — ${goal.problems.join('; ')}\n`);
  }
  return 0;
}

/** One goal's line in `mc goal list`. */
function goalLine(goal) {
  const name = `${goal.programme}/${goal.goal}`;
  // A finished goal has no next action, whatever its last entry said.
  const next = FINISHED.includes(goal.stage) ? '—' : (goal.log.at(-1)?.next ?? '—').replace(/\s*\n\s*/gu, ' ');
  const status = waitsOnPerson(goal) ? `${stageWords(goal)}, waits on a person`
    : goal.stage === 'build' && noCriteria(goal) ? `${stageWords(goal)}, no criteria — not started`
    : stageWords(goal);
  return `${name} · ${goal.repos.join(',')} · ${status} · ${criteriaWords(goal)} · ${sessions(goal.log)} sessions · ${next}`;
}

/**
 * `mc goal pr <programme>/<goal> <repo>#<n>…` — the pull requests named carry
 * the goal: each is written into its `prs`, so the goal is done once every one
 * has landed (the merger, or the runner's `settleLanded`). For work published
 * before `mc publish` wrote it there, or from somewhere it could not tell.
 */
function carryPrs(args, ctx) {
  const { stdout, stderr, env, read, write } = ctx;
  if (args.length < 2) { stderr.write(usage()); return 2; }
  const [named, ...refs] = args;
  const target = goalNamed(named, ctx);
  if (target.error) { stderr.write(`mc: ${target.error}\n`); return 2; }
  const given = refs.flatMap((ref) => ref.split(',')).map((ref) => ref.trim()).filter(Boolean);
  const parsed = given.map((ref) => ({ ref, pr: parsePrRef(ref) }));
  const bad = parsed.filter((item) => !item.pr).map((item) => item.ref);
  if (bad.length) { stderr.write(`mc: ${bad.join(', ')} is not <repo>#<number>\n`); return 2; }
  const text = read(join(target.dir, GOAL_FILE));
  if (text === null) { stderr.write(`mc: no goal ${target.name} — ${target.dir} has no ${GOAL_FILE}\n`); return 1; }
  const goal = parseGoal(text);
  if (goal.problems) {
    for (const problem of goal.problems) stderr.write(`mc: ${target.name}: ${problem}\n`);
    return 1;
  }
  for (const { pr } of parsed) {
    const entry = { at: logStamp(ctx.now), tool: env.MC_TOOL || 'person', model: env.MC_MODEL || null, stage: goal.stage, status: goal.status, done: `carries ${prRef(pr)}`, comment: null, next: null };
    const added = addPr({ dir: target.dir, repo: pr.repo, pr: pr.pr, entry, read, write });
    if (added.problems) { for (const problem of added.problems) stderr.write(`mc: ${target.name}: ${problem}\n`); return 1; }
    stdout.write(`mc: ${target.name} carries ${prRef(pr)}${added.added ? '' : ' already'}\n`);
  }
  return 0;
}

/**
 * `mc goal archive <programme>/<goal>…` or `mc goal archive <programme>` (its
 * every done or dropped goal) — a finished goal leaves the list, by
 * `archiveGoal` (goal-archive.js), which the runner also calls once a goal has
 * been finished for 24 hours. Each goal is answered on its own, and its refusal
 * is said with why; exit 1 if any refused.
 */
function archiveGoals(args, ctx) {
  const { stdout, stderr, home, list, read } = ctx;
  if (args.length < 1) { stderr.write(usage()); return 2; }
  const all = programsGoals({ home, list, read });
  let names;
  if (args.length === 1 && NAME_RE.test(args[0])) {
    names = all.filter((goal) => goal.programme === args[0] && FINISHED.includes(goal.stage)).map((goal) => `${goal.programme}/${goal.goal}`);
    if (!names.length) { stdout.write(`mc: ${args[0]} has no done or dropped goal\n`); return 0; }
  } else {
    const bad = args.filter((name) => !isGoalRef(name));
    if (bad.length) { stderr.write(`mc: ${bad.join(', ')} is not <programme>/<goal>, nor one programme alone\n`); return 2; }
    names = [...new Set(args)];
  }
  let refused = 0;
  for (const name of names) {
    const goal = all.find((item) => `${item.programme}/${item.goal}` === name);
    const result = goal ? archiveGoal(goal, ctx) : { refused: 'no such goal — mc goal list names them' };
    if (result.refused) {
      refused += 1;
      stderr.write(`mc: ${name} is not archived — ${result.refused}\n`);
      continue;
    }
    stdout.write(`mc: ${name} · archived — ${result.to}\n`);
    for (const move of result.renumbered) stdout.write(`  ${move.goal.programme}/${move.goal.goal}  phase ${move.from} → ${move.to}\n`);
  }
  return refused ? 1 : 0;
}

/** Text appended to a file, made when it is not there. */
function appendText(path, text) {
  appendFileSync(path, text);
}

/** `gh <args>` in `cwd`, as `{ ok, stdout, stderr }`. */
function ghIn(cwd, args) {
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8', timeout: 60_000 });
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * The goal a verb names: `<programme>/<goal>` as given, or MC_GOAL's when none
 * is, as `{ programme, goal, name, dir }`; `{ error }` when neither is a goal name.
 */
function goalNamed(arg, { env, home }) {
  const given = arg ?? env.MC_GOAL;
  if (!given) return { error: 'which goal? mc goal <programme>/<goal>, or MC_GOAL in a goal session' };
  const parts = given.split('/');
  if (parts.length !== 2 || !NAME_RE.test(parts[0]) || !NAME_RE.test(parts[1])) {
    return { error: `${given} is not <programme>/<goal> — lower-case letters, digits and hyphens` };
  }
  const [programme, goal] = parts;
  return { programme, goal, name: given, dir: goalDirIn(home, programme, goal) };
}

/**
 * Why this caller may not move the goal from stage `from` to `to` (null: no
 * move) or set `status` (null: none), or null when it may. A session is a
 * caller with MC_GOAL set and an MC_TOOL that is not `person`; anyone else is
 * a person, who may make any move, backward too (logged by `logEntry`). No
 * session moves a stage backward. A plan session makes any forward move: it
 * writes goals, finishes them and drops them (`canon/roles/plan-session.md`).
 * A review session moves a goal in `review` to `merging` (OK) or `finish`
 * (not OK, REVIEW.md written first), and sets no status. A build session
 * moves `build` to `review` or sets `blocked`, nothing else.
 */
export function refusedMove({ from, to = null, status = null, env, reviewWritten = false, dir = 'the goal\'s directory' }) {
  if (!isSession(env)) return null;
  const moves = to !== null && to !== from;
  if (moves && backward(from, to)) return `a session does not move a goal back — ${from} → ${to}; only a person does (mc goal stage <programme>/<goal> ${to}, MC_TOOL=person)`;
  if (env.MC_ROLE === PLAN_ROLE) return null;
  if (env.MC_ROLE === REVIEW_ROLE) {
    if (status !== null) return 'a review sets no status — it ends with mc goal stage merging (OK to land) or finish (not OK, with REVIEW.md)';
    if (!moves) return null;
    if (from !== 'review') return `a review moves only a goal in review, and this one is ${from}`;
    if (to !== 'merging' && to !== 'finish') return `a review ends in merging or finish, not ${to}`;
    if (to === 'finish' && !reviewWritten) return `a review sends a goal to finish with ${REVIEW_FILE} — write ${dir}/${REVIEW_FILE} first: the head judged, what is wrong and where`;
    return null;
  }
  if (to === 'done') return 'a session does not set done — move it to review; the merger sets done when the pull request lands';
  if (to === 'dropped') return 'only plan or a person drops a goal — set it blocked with the question';
  if (moves && !(from === 'build' && to === 'review')) return `a build session moves a goal only from build to review, not ${from} → ${to}`;
  if (status === 'ready') return 'a build session does not set a goal ready — a person does';
  return null;
}

/** Whether the caller is a session: MC_GOAL set, MC_TOOL not `person`. */
function isSession(env) {
  return Boolean(env.MC_GOAL) && (env.MC_TOOL || 'person') !== 'person';
}

/** Whether the caller is a session (MC_GOAL set, MC_TOOL not `person`) that is not plan's. */
function sessionNotPlan(env) {
  return isSession(env) && env.MC_ROLE !== PLAN_ROLE;
}

/** `git -C <cwd> <args>`, as `{ ok, stdout, stderr }`. */
function gitIn(cwd, args) {
  const r = runGit(undefined, ['-C', cwd, ...args]);
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** The first flag `scanned` was given that `allowed` does not name, with its dashes, or null. */
function onlyFlags(scanned, allowed) {
  for (const [key, value] of Object.entries(scanned.flags)) {
    const given = Array.isArray(value) ? value.length > 0 : value !== null && value !== false;
    if (given && !allowed.includes(`--${key}`)) return `--${key}`;
  }
  return null;
}

/** `2026-11-01T20:00:00Z`: the second a goal is created at, as the front matter writes it. */
function stampSeconds(date) {
  return date.toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

export function usage() {
  return commandUsage('goal');
}
