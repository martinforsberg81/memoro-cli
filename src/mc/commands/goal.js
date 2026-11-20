/**
 * `mc goal` — a goal and its two text files and worktrees (`goals.js`).
 *
 *   mc goal new <programme>/<goal> --repo <repo>[,<repo>] --class fast|medium|large --title "<title>" [--phase <n>] [--stage draft] [--structure 1|2]
 *                                  GOAL.json (a skeleton) and LOG.md; no worktree yet — the runner makes each
 *                                  repository's worktree on goal/<goal> at the goal's first session;
 *                                  in phase <n> (1 by default), at most one past the last;
 *                                  in stage draft (a goal is moved on with mc goal stage); structure 2 (by default) is the brief as numbered parts (`goal-parts.js`), 1 the older form, as goal and contract prose
 *   mc goal set <programme>/<goal> title|goal|contract|out-of-scope --text "…"   the field of a version 1 goal replaced; a blank line parts paragraphs
 *   mc goal set <programme>/<goal> title|aim|outcome|latitude|protection --text "…"   the part of a version 2 goal replaced
 *   mc goal item add <programme>/<goal> problem|premise|decision|change|preserve|risk|out-of-scope --text "…" <the part's flags>   a version 2 item; its id printed
 *   mc goal item set <programme>/<goal> <id> [--text "…"] [the part's flags]   what is given changed, logged with what it was and is now
 *   mc goal item remove <programme>/<goal> <id> --reason "…"   the item taken out, logged; its id is not given again (`ids`)
 *   mc goal obligation set <programme>/<goal> <area> --stand touched|untouched --text "…" [--standard "<repo>/<path>#<section>"]   the area's obligation, replaced when there is one, logged
 *   mc goal obligation remove <programme>/<goal> <area> --reason "…"   the obligation taken out, logged
 *   mc goal document add <programme>/<goal> --label "…" --path "…"   a document the goal sends its reader to
 *   mc goal criterion add <programme>/<goal> --criterion "…" --check "…" [--evidence "…"]   a success criterion, not met
 *   mc goal criterion set [<programme>/<goal>] <n> [--criterion "…"] [--check "…"] [--evidence "…"]   criterion <n> rewritten, unmet, logged with the old and new text; not by a goal session (build, review, finish, mend)
 *   mc goal criterion remove [<programme>/<goal>] <n> --reason "…"   criterion <n> taken out, the later ones moved up one number, logged with its text and the reason; not by a goal session
 *   mc goal criterion met|unmet [<programme>/<goal>] <n>   criterion <n> recorded as holding, or not
 *   mc goal convert [<programme>]       every goal still in markdown, not in .archive/, turned into GOAL.json; stage plan written draft,
 *                                  and every goal that started after others given a phase (`phaseGoals`)
 *   mc goal from-project <programme>/<project>   a live project's remaining steps turned into goals, once
 *                                  (`project-convert.js`); a finished one is refused
 *   mc goal phase [<programme>/<goal>] <n>   the goal moved to phase <n>; the programme's phases renumbered
 *   mc goal log [<programme>/<goal>] [--done "…"|--done-file <path|->] [--comment "…"|--comment-file <path|->] [--next "…"|--next-file <path|->] [--stage <stage>] [--status ready|blocked]
 *                                  (--status Martin is refused with a return instruction: a question goes through mc ask)
 *                                  one session's entry appended to LOG.md; with --stage or --status GOAL.json's is set too;
 *                                  a --*-file is read verbatim (`-` is stdin) and takes the place of its inline flag
 *   mc goal stage [<programme>/<goal>] <stage> [--reason "…"]   mc goal log --stage <stage> --comment <reason>;
 *                                  out of draft (not to dropped) the goal must be complete (version 2: `partsLacks`);
 *                                  going to build, a worktree whose branch has no commits of its own is remade from origin/main;
 *                                  merge executes the session decision for all registered pull requests
 *   mc goal blocked|ready [<programme>/<goal>] [--reason "…"]   the status, the stage kept
 *   mc goal hold [<programme>/<goal>] --reason "…"   an interactive takeover's hold: the runner starts no session on the goal until release; stage and status stay
 *   mc goal release [<programme>/<goal>] [--reason "…"]   the hold removed; one log entry with each worktree's state
 *   mc goal martin …   gone: exits 2 and prints the mc ask call to make (`retiredMartin`)
 *   mc goal defect [<programme>/<goal>] --part "…" --found "…" [--evidence "…"|--evidence-file <path|->] [--next "…"|--next-file <path|->]
 *                  the goal itself is wrong: one entry, status Martin, no options and no jev (`reportDefect`)
 *   mc goal done [<programme>/<goal>] [--reason "…"]   stage done, a person's (the merger sets it when the pull request lands)
 *   mc goal drop [<programme>/<goal>] --reason "…"   let go without landing: `dropped`, never `done`
 *   mc goal pr <programme>/<goal> <repo>#<n>…   the pull requests named carry the goal (`prs`)
 *   mc goal archive <programme>/<goal>… | <programme> | --all   a done or dropped goal to goals/.archive/, its
 *                                  worktrees and branch gone, one row in goals/goal_log.md; --all is every
 *                                  programme's; a goal a live session owns is refused; the runner does
 *                                  the same for every finished goal at its next pass
 *   mc goal show <programme>/<goal>      the goal as text (`renderGoalText`), the last three entries, each worktree's state
 *   mc goal list [<programme>]           every goal, one line each, under its programme's phases
 *   mc goal areas <repo>|<programme>/<goal> [--at <rev>]   a repository's areas (`.mc/areas.json` at origin/main) with each page, or a goal's: each rule area with its stand or `no stand`; a source area asks no stand
 *
 * The goal defaults to MC_GOAL's in a goal session. No verb here owns a goal:
 * the worktree is anyone's. GOAL.json is written by these verbs only, each write
 * validated (`updateGoal`); nobody edits it by hand.
 * A goal's stage only moves forward (`goals.js` `STAGES`); only a person moves
 * it back (`refusedMove`). A build session moves `build` to `review` — not
 * while a criterion is not met (`unmetGoalWords`) — or sets `blocked`; a
 * review session moves `review` to `merge`, or back to `build` when its
 * verdict (REVIEW.md) has a NOT OK line. After two automatic repairs a
 * failed verdict holds the goal for desk decision. A mend session
 * sets a status and requeues `merge`, and moves no stage; the interactive
 * plan session any stage forward.
 *
 * A goal's phase is not its stage: a goal in a later phase keeps the stage
 * it has, and the runner does not pick it until every goal of the programme in
 * a lower phase is done or dropped (`phaseOpen`). The phases are renumbered
 * when a goal is archived or moved (`renumberPhases`), so they run 1, 2, …
 * with no holes.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

import { commandUsage } from '../command-help.js';
import { buildDispatches } from '../goal-dispatch-evidence.js';
import { isSourceArea, proposedStand, proposedWords, readAreas } from '../areas.js';
import { checkVerdict, trippedAreas } from '../review-verdict.js';
import { dropItems, evidenceIds, readEvidence, evidenceLines, evidenceRefusal, itemKey, makeRecord, removeCriterionItem, setItem as setEvidence, worktreeHeads } from '../goal-evidence.js';

import { writeFileAtomic } from '../atomic-write.js';
import { archiveGoal, finalizeDroppedGoal, moveDir } from '../goal-archive.js';
import { run as runGit } from '../git.js';
import { convertGoals, phaseGoals } from '../goal-convert.js';
import { convertProject } from '../project-convert.js';
import { readGoalDeskItem } from '../desk-items.js';
import { addPr, backward, criteriaWords, currentPhase, FINISHED, HOLD_FILE, readHold, goalDirIn, GOAL_FILE, GOALS_DIR, appendEntry, appendLog, CLASSES, goalReferences, inStage, isGoalRef, LOG_FILE, listDirsOf, logStamp, noCriteria, parseGoal, parseLog, rejections, parsePrRef, phaseOpen, phaseStanding, programmeOrder, programsGoals, PROSE_FIELDS, prRef, prState, readTextOrNull, remakeUnbuiltBranches, renderEntry, renderGoal, renderGoalText, renumberPhases, MEND_ROLE, PLAN_ROLE, REVIEW_FILE, REVIEW_ROLE, sessions, setGoalState, STAGES, stageWords, STATUSES, unmetGoalWords, updateGoal, waitsOnPerson } from '../goals.js';
import { addItem, ITEM_PARTS, ITEM_WORDS, moveGate, partsLacks, PROSE_PARTS, STANDS, V1_PROSE_WORDS, emptyIds, flagOf, itemWords, partOfId, removeItem, removeObligation, setItem, setObligation } from '../goal-parts.js';
import { checkAgainstMain, conflictReason } from '../main-conflict.js';
import { buildWaitsForMain } from '../main-repair.js';
import { queueMerge } from '../merger.js';
import { workRoot } from '../paths.js';
import { wakeRunner } from '../run-control.js';
import { realLock } from '../runner-lock.js';
import { mergesPath, parseQueue } from '../merge-queue.js';
import { pidAlive, readCurrents } from '../status-collect.js';
import { NAME_RE } from '../plan-schema.js';
import { readRecord, repairDraftRefusal } from '../programme-record.js';
import { programsHome } from '../paths.js';
import { repoNameOf } from '../repos.js';
import { MERGE_HANDOFF_FILE } from '../session-role.js';
import { documentPath, LOG_ENTRIES, redactText, returnInstruction, secretsOf } from '../jev.js';
import { readKeysDotenv } from '../keys-dotenv.js';
import { knownRepositories } from '../work-area.js';
import { only, scanArgs } from './flags.js';

/** Every flag any verb takes as a value. */
const VALUE_FLAGS = ['--part', '--found', '--repo', '--class', '--title', '--phase', '--stage', '--done', '--done-file', '--comment', '--comment-file', '--next', '--next-file', '--status', '--reason', '--text', '--label', '--path', '--criterion', '--check', '--evidence', '--evidence-file', '--structure', '--source', '--basis', '--at', '--by', '--on', '--where', '--upheld-by', '--settled-by', '--owner', '--stand', '--standard', '--avoid', '--file'];
const SCAN = { booleans: ['--all'], strictValues: VALUE_FLAGS };
/** The flags the fields of the numbered parts are given by (`item add|set`); a part takes its own and refuses the others. */
const ITEM_FLAGS = Object.freeze([...new Set(Object.values(ITEM_PARTS).flatMap((part) => part.fields.map((field) => `--${flagOf(field)}`)))]);
/** The flags each verb takes; any other given is refused with exit 2. */
const VERB_FLAGS = {
  new: ['--repo', '--class', '--title', '--phase', '--stage', '--structure'],
  phase: [],
  set: ['--text'],
  'document add': ['--label', '--path'],
  'item add': ['--text', ...ITEM_FLAGS],
  'item set': ['--text', ...ITEM_FLAGS],
  'item remove': ['--reason'],
  'obligation set': ['--stand', '--text', '--standard'],
  'obligation remove': ['--reason'],
  'criterion add': ['--criterion', '--check', '--evidence'],
  'criterion set': ['--criterion', '--check', '--evidence'],
  'criterion remove': ['--reason'],
  'criterion met': ['--evidence', '--evidence-file'],
  'criterion unmet': [],
  evidence: ['--text', '--file'],
  convert: [],
  'from-project': [],
  log: ['--done', '--done-file', '--comment', '--comment-file', '--next', '--next-file', '--stage', '--status'],
  stage: ['--reason'],
  status: ['--reason'],
  hold: ['--reason'],
  release: ['--reason'],
  defect: ['--part', '--found', '--evidence', '--evidence-file', '--next', '--next-file'],
  pr: [],
  archive: ['--all'],
  show: [],
  list: [],
  areas: ['--at'],
};
/** The verbs that set one field: `blocked` and `ready` the status, `done` and `drop` the final stage. */
const STATUS_VERBS = ['blocked', 'ready', 'done', 'drop'];
const STATUS_VERB_FIELDS = { blocked: { status: 'blocked' }, ready: { status: 'ready' }, done: { stage: 'done' }, drop: { stage: 'dropped' } };
/** Each verb and what it accepts, from the lists above (help-routes.test.js walks the help with it). */
export const ROUTES = Object.fromEntries([
  ...Object.entries(VERB_FLAGS).filter(([verb]) => verb !== 'status'),
  ...STATUS_VERBS.map((verb) => [verb, verbFlagsOf(verb)]),
].map(([verb, names]) => [verb, only(SCAN, names)]));

/** The flags verb `verb` takes, or null when it is not one: a status verb takes --reason. */
function verbFlagsOf(verb) {
  if (STATUS_VERBS.includes(verb)) return VERB_FLAGS.status;
  return Object.hasOwn(VERB_FLAGS, verb) ? VERB_FLAGS[verb] : null;
}

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const env = deps.env || process.env;
  const rawStderr = deps.stderr || process.stderr;
  if (argv[0] === 'martin') return retiredMartin(argv, rawStderr);
  // Preparation has no goal mutation authority, including goal-less calls.
  if (env.MC_ROLE === 'desk-prepare' && !['show', 'list', 'areas'].includes(argv[0])) {
    rawStderr.write(`mc: ${refusedMove({ env })}\n`); return 2;
  }
  if (env.MC_ROLE === 'programme-review' && !['show', 'list', 'areas'].includes(argv[0])) {
    rawStderr.write(`mc: ${refusedMove({ env })}\n`); return 2;
  }
  // An ask-reader reads, and records its verdict with mc ask answer.
  if (env.MC_ROLE === 'ask-reader' && !['show', 'list', 'areas'].includes(argv[0])) {
    rawStderr.write(`mc: ${refusedMove({ env })}\n`); return 2;
  }
  let refusalSecrets = [];
  if (argv[0] === 'log' && argv.includes('Martin')) {
    try { refusalSecrets = secretsOf((deps.readKeys || (() => readKeysDotenv({ env, home: env.HOME || process.env.HOME }).values))()); } catch { refusalSecrets = []; }
  }
  const stderr = { write: (text) => rawStderr.write(redactText(text, refusalSecrets)) };
  const scanned = scanArgs(argv, SCAN);
  if (scanned.error) { stderr.write(`mc: ${scanned.error}\n${usage()}`); return 2; }
  let [verb, ...rest] = scanned.positional;
  // `document`, `criterion`, `item` and `obligation` take a second word: the form is both.
  if (['document', 'criterion', 'item', 'obligation'].includes(verb) && rest.length) verb = `${verb} ${rest.shift()}`;

  const verbFlags = verb === 'status' || verb === undefined ? null : verbFlagsOf(verb);
  if (!verbFlags) { stderr.write(usage()); return 2; }
  const extra = onlyFlags(scanned, verbFlags);
  if (extra) { stderr.write(`mc: ${verb} takes no ${extra}\n`); return 2; }

  const ctx = {
    stdout, stderr, env,
    home: deps.home || programsHome(env),
    now: deps.now ? deps.now() : new Date(),
    lock: deps.lock || realLock,
    alive: deps.alive || pidAlive,
    active: (goal) => {
      const root = workRoot(env);
      const read = deps.read || readTextOrNull;
      const currents = readCurrents(join(root, 'runner'), (path) => {
        try { return JSON.parse(read(path) ?? ''); } catch { return null; }
      }, deps.listFiles || readdirSync);
      // The runner names a session `goal:<programme>/<goal>` (as the page reads `running`),
      // or carries `goal_reference`; a bare `<programme>/<goal>` is read too.
      const ref = `${goal.programme}/${goal.goal}`;
      const named = (current) => [current?.name, current?.goal_reference, current?.goal_reference && `goal:${current.goal_reference}`].some((name) => name === ref || name === `goal:${ref}`);
      return currents.some((current) => named(current)
        && Number.isInteger(Number(current.pid)) && (deps.alive || pidAlive)(Number(current.pid)));
    },
    read: deps.read || readTextOrNull,
    realpath: deps.realpath,
    write: deps.write || writeFileAtomic,
    list: deps.list || listDirsOf,
    listFiles: deps.listFiles || ((path) => { try { return readdirSync(path); } catch { return []; } }),
    git: deps.git || gitIn,
    // The merge check before review and merge (main-conflict.js); a test stands in for it.
    mainCheck: deps.mainCheck,
    // A repository with no worktree in the goal's directory is not checked (mainConflictRefusal).
    exists: deps.exists || existsSync,
    known: deps.known || (() => knownRepositories(env)),
    gh: deps.gh || ghIn,
    queue: deps.queue || ((options) => queueMerge({ root: workRoot(env), env, ...options })),
    move: deps.move || moveDir,
    appendText: deps.appendText || appendText,
    remove: deps.remove || unlinkSync,
    readFile: deps.readFile || readEntryFile,
    // The keys source's values (a defect's redaction); a test stands in for it.
    readKeys: deps.readKeys || (() => readKeysDotenv({ env, home: env.HOME || process.env.HOME }).values),
    // A stage move or a release wakes the runner's idle lanes (`wakeRunner`); a test stands in for it.
    wake: deps.wake || (() => wakeRunner(workRoot(env))),
  };
  const { flags } = scanned;

  if (env.MC_ROLE === LEARNING_ROLE) {
    const refused = learningRefusal(verb);
    if (refused) { stderr.write(`mc: ${refused}\n`); return 2; }
  }

  if (verb === 'new') return newGoal(rest, flags, ctx);
  if (verb === 'phase') return setPhase(rest, ctx);
  if (verb === 'set') return setField(rest, flags, ctx);
  if (verb === 'item add') return addItemVerb(rest, flags, ctx);
  if (verb === 'item set') return setItemVerb(rest, flags, ctx);
  if (verb === 'item remove') return removeItemVerb(rest, flags, ctx);
  if (verb === 'obligation set') return setObligationVerb(rest, flags, ctx);
  if (verb === 'obligation remove') return removeObligationVerb(rest, flags, ctx);
  if (verb === 'document add') return addDocument(rest, flags, ctx);
  if (verb === 'criterion add') return addCriterion(rest, flags, ctx);
  if (verb === 'criterion set') return setCriterion(rest, flags, ctx);
  if (verb === 'criterion remove') return removeCriterion(rest, flags, ctx);
  if (verb === 'criterion met' || verb === 'criterion unmet') return markCriterion(rest, verb === 'criterion met', flags, ctx);
  if (verb === 'evidence') return evidenceVerb(rest, flags, ctx);
  if (verb === 'convert') return convert(rest, ctx);
  if (verb === 'from-project') return fromProject(rest, ctx);
  if (verb === 'log') {
    if (flags.status === 'Martin') {
      stderr.write(returnInstruction(['mc goal log --status Martin is not how Martin is asked: a question goes through mc ask, with its options and your recommendation'], rest[0] ?? env.MC_GOAL, 'mc: log is not written'));
      return 2;
    }
    const texts = entryTexts(flags, ctx);
    if (texts.error) { stderr.write(`mc: ${texts.error}\n`); return texts.code; }
    return logEntry(rest, { stage: flags.stage, status: flags.status, via: 'log', ...texts.fields }, ctx);
  }
  if (verb === 'stage') {
    if (rest.length < 1 || rest.length > 2) { stderr.write(`mc: stage [<programme>/<goal>] ${STAGES.join('|')}\n`); return 2; }
    const stage = rest.pop();
    return logEntry(rest, { stage, status: null, done: null, comment: flags.reason, next: null, via: 'stage', reason: flags.reason }, ctx);
  }
  if (verb === 'defect') return reportDefect(rest, flags, ctx);
  if (verb === 'drop' && !flags.reason) { stderr.write('mc: drop needs --reason "…" — why the goal is let go\n'); return 2; }
  if (STATUS_VERBS.includes(verb)) return logEntry(rest, { stage: null, status: null, ...STATUS_VERB_FIELDS[verb], done: null, comment: flags.reason, next: null }, ctx);
  if (verb === 'pr') return carryPrs(rest, ctx);
  if (verb === 'archive') return archiveGoals(rest, ctx, flags.all);
  if (verb === 'show') return showGoal(rest, ctx);
  if (verb === 'areas') return areasVerb(rest, flags, ctx);
  if (verb === 'hold') return holdVerb(rest, flags, ctx);
  if (verb === 'release') return releaseVerb(rest, flags, ctx);
  return listGoals(rest, ctx);
}

/** The reason a creation hold (`created: true`) carries: a draft an interactive session makes is held until its author moves it on or releases it. */
const CREATION_HOLD_REASON = 'draft being written by its author';

/**
 * `mc goal new <programme>/<goal>` — makes a goal. The programme must be a
 * directory under the programmes home, the goal must not exist, and every
 * repository named must be one mc knows. Each repository is fetched first, so
 * a fetch that fails leaves nothing behind; then GOAL.json — a skeleton with
 * the title and no criterion, which the runner starts no session on, in phase
 * `--phase` (1 by default; at most one past the programme's last) — and
 * LOG.md are written. No worktree is made: the runner makes each repository's
 * worktree on `goal/<goal>` before the goal's first session (`placeGoalWorktrees`),
 * so a goal several phases away holds no checkout until it can be used.
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

  if (flags.structure !== null && !['1', '2'].includes(flags.structure)) { stderr.write(`mc: --structure is 1 or 2, not ${flags.structure}\n`); return 2; }
  const structure = flags.structure === '1' ? 1 : 2;
  const stage = flags.stage ?? 'draft';
  if (stage === 'build') { stderr.write('mc: a new goal is written in draft — write it in draft and move it with mc goal stage <programme>/<goal> build\n'); return 2; }
  if (stage !== 'draft') { stderr.write(`mc: --stage is draft for a new goal, not ${stage}\n`); return 2; }
  const phase = flags.phase === null ? 1 : Number(flags.phase);
  if (!Number.isInteger(phase) || phase < 1) { stderr.write(`mc: --phase is a whole number from 1, not ${flags.phase}\n`); return 2; }

  const known = ctx.known();
  const unknown = repos.filter((repo) => !known.some((path) => repoNameOf(path) === repo));
  if (unknown.length) {
    stderr.write(`mc: ${unknown.join(', ')} is not a repository mc knows — ${known.map(repoNameOf).join(', ')}\n`);
    return 2;
  }
  if (!ctx.list(home).includes(programme)) { stderr.write(`mc: no programme ${programme} under ${home}\n`); return 1; }
  const record = readRecord(join(home, programme), { read: ctx.read });
  const refusal = record.status === 'valid' && repairDraftRefusal(record.record, programme);
  if (refusal) { stderr.write(`mc: ${refusal}\n`); return 1; }
  if (record.status === 'valid' && record.record.state === 'draft') {
    stderr.write(`mc: ${programme} is draft — mc programs show ${programme}\n`); return 1;
  }
  if (record.status === 'none' && ctx.env.MC_HEADLESS === '1') {
    stderr.write(`mc: ${programme} has no record — a goal here is made at the desk\n`); return 1;
  }
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
  const made = { stage, status: 'ready', phase, repos, class: flags.class, created, title: flags.title.trim(), success_criteria: [] };
  // A draft an interactive session makes is held from creation (D1, D3): the hold is written first, so no reader finds the goal without it.
  const held = ctx.env.MC_HEADLESS !== '1';
  if (held) ctx.write(join(dir, HOLD_FILE), `${JSON.stringify({ by: writerRole(ctx.env) || 'person', tool: ctx.env.MC_TOOL || 'person', at: logStamp(now), reason: CREATION_HOLD_REASON, created: true }, null, 2)}\n`);
  ctx.write(join(dir, GOAL_FILE), renderGoal(structure === 2 ? { ...made, version: 2, ids: emptyIds() } : made));
  ctx.write(join(dir, LOG_FILE), appendLog('', { at: logStamp(now), tool: ctx.env.MC_TOOL || 'person', model: ctx.env.MC_MODEL || null, role: writerRole(ctx.env), stage, status: 'ready', done: phase > 1 ? `created, phase ${phase}` : 'created', comment: held ? `held from creation: ${CREATION_HOLD_REASON}` : null, next: null }));
  stdout.write(`mc: ${programme}/${goal} · ${stage} · ready · phase ${phase} — ${dir}\n`);
  stdout.write(`  no worktree yet: the runner makes ${repos.join(', ')} on goal/${goal} at the goal's first session\n`);
  if (held) stdout.write(`  held from creation: mc goal stage ${programme}/${goal} build moves it on and frees it; mc goal release ${programme}/${goal} hands the draft to headless planning\n`);
  if (structure === 2) {
    stdout.write(`${GOAL_FILE} (version 2) is to be filled in by verbs: mc goal set ${programme}/${goal} ${PROSE_PARTS.join('|')} --text "…", mc goal item add ${programme}/${goal} ${ITEM_WORDS.join('|')} --text "…" …, mc goal obligation set ${programme}/${goal} <area> --stand touched|untouched --text "…", mc goal criterion add ${programme}/${goal} --criterion "…" --check "…"\n`);
    return 0;
  }
  stdout.write(`${GOAL_FILE} is to be filled in by verbs: mc goal set ${programme}/${goal} goal|contract|out-of-scope --text "…", mc goal criterion add ${programme}/${goal} --criterion "…" --check "…"\n`);
  return 0;
}

/**
 * The word a log entry names its writer by: from `MC_ROLE`, as the role's name before its `:`. A word
 * that is not one token (it holds whitespace, or is empty) is left out, and the entry is written without the
 * `· by` segment, because HEADING would not read it back and parseLog would drop the entry. With no role, none is written.
 */
const WRITER_WORDS = { 'build-session:goal': 'build', [REVIEW_ROLE]: 'review', [MEND_ROLE]: 'mend', [PLAN_ROLE]: 'plan', 'plan-session': 'plan', manager: 'manager' };
export function writerRole(env) {
  const role = env.MC_ROLE || '';
  if (!role) return null;
  const word = Object.hasOwn(WRITER_WORDS, role) ? WRITER_WORDS[role] : role.split(':')[0];
  return /^\S+$/u.test(word) ? word : null;
}

/**
 * `mc goal log`, `mc goal stage` and `mc goal blocked|martin|ready|done|drop` —
 * appends one entry to the goal's LOG.md, tagged with MC_TOOL and MC_MODEL
 * (`person` when neither is set), with the stage and status the goal then
 * has. With a stage or status GOAL.json's is set too; an unknown one is
 * refused naming the field. A goal whose GOAL.json does not parse is refused,
 * and so is a move the caller may not make (`refusedMove`): a session's
 * backward one, `review` while a criterion is not met, a review's move without a
 * complete REVIEW.md, or to `finish`. A person's backward move is made and logged. A review's
 * `merge` records the session's decision before queueing every registered PR.
 * A queue failure leaves that decision available for retry and runner recovery.
 */
function logEntry(args, fields, ctx) {
  const { stdout, stderr, env, read, write } = ctx;
  if (args.length > 1) { stderr.write(usage()); return 2; }
  const target = goalNamed(args[0], ctx);
  if (target.error) { stderr.write(`mc: ${target.error}\n`); return 2; }
  if (isSession(env) && env.MC_GOAL && env.MC_GOAL !== target.name) { stderr.write(`mc: goal session ${env.MC_GOAL} cannot change ${target.name}\n`); return 2; }
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
  const refused = refusedMove({ from: goal.stage, to: fields.stage, status: fields.status, env });
  if (refused) { stderr.write(`mc: ${refused}\n`); return 2; }
  if (env.MC_ROLE === 'decision' && goal.stage === 'review' && goal.status === 'Martin'
      && (fields.stage !== null || fields.status === 'ready')) {
    const log = parseLog(read(join(target.dir, LOG_FILE)) ?? '');
    if (reviewRecoveryExhausted(log)) {
      stderr.write('mc: the decision recovery already returned to the review repair limit. Record what remains with mc martin item <id> brief --sort mechanical.\n');
      return 2;
    }
  }
  // A review's move out of review follows its verdict (REVIEW.md): complete for the heads judged and the tripped areas, no NOT OK to merge, one to build.
  const verdict = reviewMove(goal, target, fields.stage, ctx);
  if (verdict.refusal) { stderr.write(`mc: ${verdict.refusal}\n`); return 2; }
  // Out of draft a goal is complete; a build session never gets here: refusedMove said so.
  const gate = moveGate({ goal, name: target.name, to: fields.stage, probe: planProbe(goal, target, ctx) });
  if (gate?.refusal) { stderr.write(`mc: ${gate.refusal}\n`); return 1; }
  if (fields.stage === 'review' && goal.stage !== 'review' && sessionNotPlan(env)) {
    const unmet = unmetGoalWords(goal, target.name);
    if (unmet) { stderr.write(`mc: ${target.name} is not moved to review — ${unmet}\n`); return 1; }
    // Only a build session (a repair too) is asked for its evidence at the head it publishes; the desk's roles are not (D5).
    if (writerRole(env) === 'build') {
      const missing = evidenceRefusal({ goal, dir: target.dir, name: target.name, git: ctx.git, exists: ctx.exists, read });
      if (missing) { stderr.write(`mc: ${target.name} is not moved to review — ${missing}\n`); return 1; }
    }
  }
  if (fields.stage === 'review' || fields.stage === 'merge') {
    const conflicted = mainConflictRefusal(goal, target, ctx);
    if (conflicted) { stderr.write(`mc: ${target.name} is not moved to ${fields.stage} — ${conflicted}\n`); return 1; }
  }
  if (verdict.repairLimit) {
    const reason = `${REVIEW_REPAIR_STOP} after ${MAX_REVIEW_REPAIRS} automatic repairs. Failed: ${verdict.failed.join(', ')}. See REVIEW.md.`;
    fields = { ...fields, stage: null, status: 'Martin', comment: [reason, fields.comment].filter(Boolean).join('\n') };
  }
  const moves = fields.stage !== null && fields.stage !== goal.stage;
  if (verdict.round) write(join(target.dir, `REVIEW-${verdict.round}.md`), verdict.text);
  let done = fields.done;
  const back = moves && backward(goal.stage, fields.stage);
  const base = fields.comment;
  const comment = back ? [base, `moved back from ${goal.stage} to ${fields.stage} by ${writerRole(env) || 'a person'}`].filter(Boolean).join(' — ') : base;
  const entry = { at: logStamp(ctx.now), tool: env.MC_TOOL || 'person', model: env.MC_MODEL || null, role: writerRole(env), done, comment, next: fields.next };
  let now = goal;
  let freed = false;
  if (fields.stage !== null || fields.status !== null) {
    const outcome = setGoalState({ dir: target.dir, stage: fields.stage ?? undefined, status: fields.status ?? (fields.stage === 'merge' ? 'ready' : undefined), entry, read, write });
    if (outcome.problems) {
      for (const problem of outcome.problems) stderr.write(`mc: ${target.name}: ${problem}\n`);
      return 1;
    }
    now = outcome.goal;
    if (moves || verdict.repairLimit) ctx.wake();
    // The first move out of draft by an interactive caller frees a creation hold (`created: true`) and no other hold (D3, C3).
    if (goal.stage === 'draft' && now.stage !== 'draft' && env.MC_HEADLESS !== '1' && readHold(target.dir, read)?.created === true) {
      ctx.remove(join(target.dir, HOLD_FILE));
      freed = true;
    }
    // A review's rejection removes the records of the items it judged NOT OK: the repair gives new evidence for them (D2).
    if (verdict.failed?.length) {
      const dropped = dropItems(target.dir, verdict.failed, { read, write });
      if (dropped.problem) stderr.write(`mc: ${dropped.problem} — the rejected items' records are not removed\n`);
    }
  } else {
    appendEntry({ dir: target.dir, entry: { ...entry, stage: goal.stage, status: goal.status }, read, write });
  }
  if (now.stage === 'merge' && fields.stage === 'merge') {
    const queued = queueGoal(target, now, ctx);
    if (queued.error) { stderr.write(`mc: ${target.name} · merge — ${queued.error}; run mc goal stage merge again to retry\n`); return 1; }
    done = queued.text;
  }
  if (now.stage === 'dropped') {
    const root = workRoot(env);
    const active = ctx.active;
    const allGoals = () => goalReferences({ home: ctx.home, list: ctx.list, read: ctx.read });
    const result = finalizeDroppedGoal({ ...now, dir: target.dir, programme: target.programme, goal: target.goal, log: parseLog(read(join(target.dir, LOG_FILE)) ?? ''), problems: [] }, {
      ...ctx, allGoals, root, lock: ctx.lock, active,
      readQueue: (path) => ctx.read(path),
      writeQueue: (path, entries) => ctx.write(path, `${JSON.stringify(entries, null, 2)}\n`),
    });
    if (result.refused) {
      const comment = `drop finalization pending — ${result.refused}`;
      const currentLog = parseLog(read(join(target.dir, LOG_FILE)) ?? '');
      if (currentLog.at(-1)?.tool !== 'runner' || currentLog.at(-1)?.comment !== comment) {
        appendEntry({ dir: target.dir, entry: { at: logStamp(ctx.now), tool: 'runner', model: null, stage: 'dropped', status: now.status, done: null, comment, next: null }, read, write });
      }
      stderr.write(`mc: ${target.name} is dropped but not finalized — ${result.refused}; retry with mc goal drop --reason "…"\n`);
      return 1;
    }
    stdout.write(`mc: ${target.name} · dropped — archived to ${result.to}\n`);
    if (freed) stdout.write('  creation hold released\n');
    for (const { pr, owners } of result.preserved ?? []) stdout.write(`mc: ${pr.repo}#${pr.pr} remains open and queued for ${owners.map((owner) => `${owner.programme}/${owner.goal}`).join(', ')}\n`);
    for (const move of result.renumbered) stdout.write(`  ${move.goal.programme}/${move.goal.goal}  phase ${move.from} → ${move.to}\n`);
    return 0;
  }
  stdout.write(`mc: ${target.name} · ${stageWords(now)}${back ? ` — moved back from ${goal.stage}` : ''}\n`);
  if (freed) stdout.write('  creation hold released\n');
  if (done && done !== fields.done) stdout.write(`mc: ${done}\n`);
  // Queueing is complete before the runner may end this session. A failed or
  // partial enqueue leaves no receipt, so the session can repair and retry.
  if (fields.stage === 'merge' && env.MC_HEADLESS === '1' && env.MC_GOAL === target.name
      && [REVIEW_ROLE, MEND_ROLE].includes(env.MC_ROLE) && env.MC_SCRATCH) {
    write(join(env.MC_SCRATCH, MERGE_HANDOFF_FILE), JSON.stringify({ goal: target.name }));
  }
  if (now.stage === 'build' && goal.stage !== 'build') remakeBranches(target, goal, ctx);
  return 0;
}

/**
 * `mc goal martin` is gone: a question goes through `mc ask` (docs/technical/mc-jev.md). The refusal reads no goal,
 * no keys source and no jev, writes nothing, and prints the call to make with flag names only — a value the caller
 * gave never comes back (the goal id is the one exception, when it is a goal id), and neither does the retired `--kind`.
 */
function retiredMartin(argv, stderr) {
  const reserved = argv.includes('--reserved');
  // The goal argument comes back only when it is a goal id (two short lowercase slugs); any other value is not echoed.
  const goal = /^[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9-]{0,63}$/u.test(argv[1] || '') ? argv[1] : '<p>/<g>';
  stderr.write(`mc: mc goal martin is gone — ask with: mc ask ${goal} --reason "<the question>" --option "<key>: <text>" --option "<key>: <text>" --recommend <key>${reserved ? ' --reserved <act>' : ''}\n`);
  return 2;
}

/**
 * `mc goal defect [<programme>/<goal>] --part "…" --found "…" [--evidence "…" | --evidence-file <path|->]
 * [--next "…" | --next-file <path|->]` — the goal itself is wrong (a premise that does not hold, clauses that
 * cannot both be met, a check that cannot run or prove its criterion, a standard the goal contradicts).
 * One entry with status `Martin`, in the stage the goal is in, whose comment's first line is
 * `goal defect: <part> — <found>`; no "Martin is asked:" line, no options, no jev, no ledger row: the runner
 * starts nothing on a `Martin` goal (`goalSession`) and the desk opens an item for it (`syncDeskItems`).
 * It is the session's ending entry. `--part` and `--found` are required: a call without them exits 2 and
 * writes nothing. A finished goal is refused; a build or review session reports only the goal in its
 * own stage, and a mend session never; plan, the desk roles and a person any.
 */
export function reportDefect(args, flags, ctx) {
  const { stderr, env, read, write } = ctx;
  if (args.length > 1) { stderr.write(usage()); return 2; }
  const named = args[0] ?? env.MC_GOAL;
  const problems = [];
  const part = oneLine(flags.part ?? '').trim();
  const found = oneLine(flags.found ?? '').trim();
  if (!part) problems.push('--part "<the part or criterion that is wrong>" is required');
  if (!found) problems.push('--found "<what is wrong, with the file and line or the command and output>" is required');
  if (flags.evidence !== null && flags['evidence-file'] !== null) problems.push('--evidence and --evidence-file are one or the other, not both');
  if (flags.next !== null && flags['next-file'] !== null) problems.push('--next and --next-file are one or the other, not both');
  if (flags['evidence-file'] === '-' && flags['next-file'] === '-') problems.push('stdin is read once: only one of --evidence-file and --next-file may be -');
  let evidence = flags.evidence ?? '';
  let next = flags.next;
  for (const [name, set] of [['evidence', (text) => { evidence = text; }], ['next', (text) => { next = text; }]]) {
    if (problems.length || flags[`${name}-file`] === null) continue;
    try { set(ctx.readFile(flags[`${name}-file`]).replace(/\n$/u, '')); }
    catch (error) { problems.push(`--${name}-file ${flags[`${name}-file`]} cannot be read (${error.message})`); }
  }
  if (problems.length) {
    stderr.write(`mc: goal defect is not reported\n${problems.map((problem) => `  - ${problem}`).join('\n')}\nCall it again as: mc goal defect ${named ?? '<programme>/<goal>'} --part "<the part or criterion that is wrong>" --found "<what is wrong, with the file and line or the command and output>" [--evidence "…"] [--next "…"]\n`);
    return 2;
  }

  const target = goalNamed(args[0], ctx);
  if (target.error) { stderr.write(`mc: ${target.error}\n`); return 2; }
  if (isSession(env) && env.MC_GOAL && env.MC_GOAL !== target.name) { stderr.write(`mc: goal session ${env.MC_GOAL} cannot change ${target.name}\n`); return 2; }
  const text = read(join(target.dir, GOAL_FILE));
  if (text === null) { stderr.write(`mc: no goal ${target.name} — ${target.dir} has no ${GOAL_FILE}\n`); return 1; }
  const goal = parseGoal(text);
  if (goal.problems) {
    for (const problem of goal.problems) stderr.write(`mc: ${target.name}: ${problem}\n`);
    return 1;
  }
  if (FINISHED.includes(goal.stage)) { stderr.write(`mc: ${target.name} is ${goal.stage} — a finished goal has no defect to report\n`); return 1; }
  const refused = refusedMove({ from: goal.stage, to: null, status: 'Martin', env });
  if (refused) { stderr.write(`mc: ${refused}\n`); return 2; }
  const role = isSession(env) ? writerRole(env) : null;
  if (role === 'mend') { stderr.write('mc: a mend session does not report a goal defect — a merge failure it cannot repair is Martin\'s (ask it with mc ask)\n'); return 2; }
  if (['build', 'review'].includes(role) && goal.stage !== role) { stderr.write(`mc: a ${role} session reports a goal defect only for a goal in ${role}, and this one is ${goal.stage}\n`); return 2; }

  const secrets = (() => { try { return secretsOf(ctx.readKeys()); } catch { return []; } })();
  const comment = redactText([`goal defect: ${part} — ${found}`, ...(evidence ? [`Evidence: ${evidence}`] : [])].join('\n'), secrets);
  const entry = { at: logStamp(ctx.now), tool: env.MC_TOOL || 'person', model: env.MC_MODEL || null, role: writerRole(env), done: null, comment, next: next === null ? null : redactText(next, secrets) };
  const outcome = setGoalState({ dir: target.dir, status: 'Martin', entry, read, write });
  if (outcome.problems) {
    for (const problem of outcome.problems) stderr.write(`mc: ${target.name}: ${problem}\n`);
    return 1;
  }
  ctx.stdout.write(`mc: ${target.name} · ${stageWords(outcome.goal)} — goal defect reported; the goal starts no session until the desk has amended it. End the session now: no separate mc goal log.\n`);
  return 0;
}

/**
 * What jev reads beside the question: the goal (its text, criteria with met,
 * stage and status), the programme's README, the goal's documents and each
 * `--document` (path and text; one that cannot be read is said and not sent),
 * and the last LOG.md entries.
 */
export function jevContext(target, goal, extra, ctx) {
  const { read, env } = ctx;
  const documents = [];
  const seen = new Set();
  for (const { label, path, explicit } of [...goal.documents.map((item) => ({ ...item, explicit: false })), ...extra.map((path) => ({ label: null, path, explicit: true }))]) {
    const at = documentPath(path, { goalDir: target.dir, home: env.HOME || process.env.HOME });
    if (seen.has(at)) continue;
    seen.add(at);
    const roots = goal.repos.map((repo) => join(target.dir, repo));
    const safePath = explicit ? confinedDocumentPath(at, roots, ctx.realpath) : at;
    if (!safePath) {
      ctx.stderr.write(`mc: ${path} is outside the goal's and programme's repositories — not sent to jev\n`);
      continue;
    }
    const text = read(safePath);
    if (text === null) { ctx.stderr.write(`mc: ${path} cannot be read — not sent to jev\n`); continue; }
    documents.push({ path, ...(label ? { label } : {}), text });
  }
  const log = parseLog(read(join(target.dir, LOG_FILE)) ?? '').slice(-LOG_ENTRIES).map((entry) => renderEntry(entry));
  const criteria = goal.success_criteria.map((item) => ({ criterion: item.criterion, check: item.check, met: item.met }));
  // Version 2 gives jev the parts a question is judged by — the outcome, what is decided and what must hold, the criteria and what is out — and not the whole brief (jev's core budget).
  const brief = goal.version === 2
    ? { title: goal.title, outcome: goal.outcome.join('\n\n'), decisions: goal.decisions.map((item) => `${item.id} ${item.text}`), preserve: goal.preserve.map((item) => `${item.id} ${item.text}`), criteria, out_of_scope: goal.out_of_scope.map((item) => item.text), stage: goal.stage, status: goal.status }
    : { title: goal.title, goal: goal.goal.join('\n\n'), contract: goal.contract.join('\n\n'), out_of_scope: goal.out_of_scope.join('\n\n'), criteria, stage: goal.stage, status: goal.status };
  return {
    goal: brief,
    programme: { readme: read(join(ctx.home, target.programme, 'README.md')) },
    documents,
    log,
  };
}

function confinedDocumentPath(path, roots, realpath = realpathSync) {
  try {
    const actual = realpath(path);
    const inside = roots.some((root) => {
      const base = realpath(root);
      const rel = relative(base, actual);
      return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
    });
    return inside ? actual : null;
  } catch { return false; }
}

/**
 * The entry's `done`, `comment` and `next` texts: each inline flag's value, or
 * each `--<field>-file` read verbatim (`-` is stdin) with one final newline
 * left out, as a line's end is not part of its text. A field given both ways,
 * stdin given for two fields, a file that cannot be read and an empty text are
 * refused before anything is written: `{ code, error }`; else `{ fields }`.
 */
function entryTexts(flags, ctx) {
  const names = ['done', 'comment', 'next'];
  const both = names.find((name) => flags[name] !== null && flags[`${name}-file`] !== null);
  if (both) return { code: 2, error: `--${both} and --${both}-file are one or the other, not both` };
  if (names.filter((name) => flags[`${name}-file`] === '-').length > 1) {
    return { code: 2, error: 'stdin is read once: only one of --done-file, --comment-file and --next-file may be -' };
  }
  const fields = {};
  for (const name of names) {
    const path = flags[`${name}-file`];
    if (path === null) { fields[name] = flags[name]; continue; }
    let text;
    try {
      text = ctx.readFile(path);
    } catch (error) {
      return { code: 1, error: `--${name}-file ${path} cannot be read — ${error.message}` };
    }
    const verbatim = text.replace(/\n$/u, '');
    if (verbatim === '') return { code: 2, error: `--${name}-file ${path} is empty — nothing to log` };
    fields[name] = verbatim;
  }
  return { fields };
}

/** A file's text as it is; `-` is stdin's. */
function readEntryFile(path) {
  return readFileSync(path === '-' ? 0 : path, 'utf8');
}

/**
 * Why the goal may not be moved to review or merge, or null: a repository of
 * the goal whose branch merges into origin/main with a conflict, its paths
 * named as `<repo>/<path>` (main-conflict.js). A failed fetch is a warning, and
 * that repository is checked against the origin/main it already holds. A
 * repository with no worktree in the goal's directory is not checked at all:
 * one line says so, and the move goes on.
 */
function mainConflictRefusal(goal, target, ctx) {
  const check = ctx.mainCheck || ((dir) => checkAgainstMain(dir));
  const paths = [];
  for (const repo of goal.repos) {
    const dir = join(target.dir, repo);
    if (!ctx.exists(dir)) { ctx.stderr.write(`mc: ${repo}: no worktree — not checked against origin/main\n`); continue; }
    const checked = check(dir);
    if (!checked.fetch.ok) ctx.stderr.write(`mc: warning: ${repo}: git fetch origin failed (${checked.fetch.text}) — checked against the origin/main already held\n`);
    paths.push(...checked.paths.map((path) => `${repo}/${path}`));
  }
  return paths.length ? conflictReason(paths) : null;
}

const MAX_REVIEW_REPAIRS = 2;
const REVIEW_REPAIR_STOP = 'no progress: review repair limit reached';

/** A human can restart a stopped goal. Between those interventions a decision gets one recovery handoff. */
function reviewRecoveryExhausted(log) {
  const limitStop = entry => entry?.role === 'review' && entry.stage === 'review'
    && entry.status === 'Martin' && entry.comment?.startsWith(REVIEW_REPAIR_STOP);
  const held = log.slice(log.findLastIndex(entry => entry.status !== 'Martin') + 1);
  if (!held.some(limitStop)) return false;
  const restarted = log.findLastIndex((entry, index) => entry.status === 'ready' && log[index - 1]?.status === 'Martin'
    && (entry.role === 'martin' || entry.tool === 'person' && !entry.role));
  return log.slice(restarted + 1).filter(limitStop).length >= 2;
}

/**
 * What a review session's move out of review asks of REVIEW.md (D4, D5, D8), as `{}` for any other move, `{ refusal }`,
 * or the verdict, its archive number, the rejected evidence ids and whether the automatic repairs are exhausted.
 * The head of the first repository must be MC_REVIEW_HEAD; every id the goal requires has one line.
 * A move to merge has no NOT OK line and a move to build has one.
 */
function reviewMove(goal, target, to, ctx) {
  const { env, read } = ctx;
  if (env.MC_ROLE !== REVIEW_ROLE || !isSession(env) || goal.stage !== 'review' || (to !== 'merge' && to !== 'build')) return {};
  const file = `${target.dir}/${REVIEW_FILE}`;
  if (!env.MC_REVIEW_HEAD) return { refusal: 'a review judges the head the runner named: MC_REVIEW_HEAD is not set' };
  const text = read(join(target.dir, REVIEW_FILE));
  if (text === null) return { refusal: `a review moves a goal to ${to} with ${REVIEW_FILE} — write ${file} first: a \`head: <repo> <sha>\` line per repository, then \`<id>: OK\` or \`<id>: NOT OK — <what and where>\` per item` };
  const found = trippedAreas({ goal, dir: target.dir, head: env.MC_REVIEW_HEAD, git: ctx.git, exists: ctx.exists });
  if (found.error) return { refusal: found.error };
  // The areas the review was told of at its launch, never asked of main again (`seenAreas`, run.js): a session started
  // before an area declared `seen`, or by a runner from before the key, is held to no `seen` line.
  const seen = String(env.MC_REVIEW_SEEN ?? '').split(/\s+/u).filter(Boolean);
  // Likewise the write-back line: held only when the runner launched this review with MC_REVIEW_WRITE_BACK=1 (a version 2
  // goal of a programme with a record), so a review launched without it is held to no such line.
  const writeBack = env.MC_REVIEW_WRITE_BACK === '1' && goal.version === 2;
  const checked = checkVerdict({ text, goal, tripped: found.tripped, heads: found.heads, seen, writeBack, isFile: (path) => ctx.exists(join(target.dir, path)) });
  if (checked.problems.length) return { refusal: `${file} is not complete for the head judged (${env.MC_REVIEW_HEAD}) —\n  ${checked.problems.join('\n  ')}` };
  const ids = checked.failed.map((one) => one.id).join(', ');
  if (to === 'merge' && checked.failed.length) return { refusal: `${REVIEW_FILE} has NOT OK lines (${ids}) — a goal with a rejected item does not merge: mc goal stage build` };
  if (to === 'build' && !checked.failed.length) return { refusal: `${REVIEW_FILE} has no NOT OK line — every item is OK, so the goal is moved to merge: mc goal stage merge` };
  const repairs = rejections(parseLog(read(join(target.dir, LOG_FILE)) ?? ''));
  let round = repairs + 1;
  // A decision hold can archive a verdict without adding a move to build.
  const archived = new Set(ctx.listFiles(target.dir));
  while (archived.has(`REVIEW-${round}.md`)) round++;
  return {
    text,
    round,
    failed: to === 'build' ? checked.failed.map((one) => one.id) : [],
    repairLimit: to === 'build' && repairs >= MAX_REVIEW_REPAIRS,
  };
}

/**
 * Execute the session's merge decision for every PR it registered on the goal.
 * A PR GitHub says is closed or already merged is not queued, and is named.
 */
function queueGoal(target, goal, ctx) {
  const queued = [];
  const closed = [];
  const merged = [];
  for (const item of goal.prs) {
    const repoPath = ctx.known().find((path) => repoNameOf(path) === item.repo);
    if (!repoPath) return { error: `${item.repo} is not a repository mc knows` };
    const state = prState(ctx.gh, repoPath, item.pr);
    if (state === 'CLOSED') { closed.push(prRef(item)); continue; }
    if (state === 'MERGED') { merged.push(prRef(item)); continue; }
    try {
      ctx.queue({ repo: item.repo, repoPath, pr: item.pr, holder: { name: `goal:${target.name}` }, goal: { programme: target.programme, goal: target.goal, dir: target.dir }, now: ctx.now });
      queued.push(prRef(item));
    } catch (error) {
      return { error: `${prRef(item)} could not be queued (${error?.message || error})` };
    }
  }
  const said = queued.length ? [`queued ${queued.join(', ')} for the merger`] : [];
  for (const ref of closed) said.push(`${ref} closed without merging — not queued`);
  for (const ref of merged) said.push(`${ref} already merged — not queued`);
  return { text: said.length ? said.join('; ') : 'no pull requests registered on the goal' };
}

/** `remakeUnbuiltBranches` for a goal going open by a verb, each repository's answer on stdout. */
function remakeBranches(target, goal, { stdout, git, exists }) {
  remakeUnbuiltBranches({ git, dir: target.dir, goal: target.goal, repos: goal.repos, exists, say: (repo, text) => stdout.write(`  ${repo}  ${text}\n`) });
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
 * the move left empty closes up. In a programme whose record states its
 * phases the move is refused, writing nothing, when it would leave with no goal
 * a phase another phase waits for, and says in a line each what a phase it
 * emptied no longer waits for. Logged as a person's (or session's) entry.
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
  const order = programmeOrder(target.programme, { home, read });
  const emptied = emptiedPhase(target, phase, order, ctx);
  if (emptied !== null) {
    const waiting = Object.entries(order.after).filter(([, list]) => list.includes(emptied)).map(([key]) => Number(key)).sort((a, b) => a - b);
    if (waiting.length) {
      stderr.write(`mc: phase ${emptied} would be left with no goal, and phase ${waiting.join(', ')} waits for it — state what ${waiting.length === 1 ? 'that phase waits' : 'those phases wait'} for first: mc programs after ${target.programme} ${waiting[0]} …\n`);
      return 2;
    }
  }
  const outcome = updateGoal({ dir: target.dir, change: (goal) => ({ ...goal, phase }), read, write });
  if (outcome.problems) {
    for (const problem of outcome.problems) stderr.write(`mc: ${target.name}: ${problem}\n`);
    return 1;
  }
  const entry = { at: logStamp(ctx.now), tool: env.MC_TOOL || 'person', model: env.MC_MODEL || null, role: writerRole(env), stage: outcome.goal.stage, status: outcome.goal.status, done: `phase ${phase}`, comment: null, next: null };
  appendEntry({ dir: target.dir, entry, read, write });
  const moved = renumberPhases({ home, programme: target.programme, list, read, write });
  const own = moved.find((move) => move.goal.goal === target.goal);
  stdout.write(`mc: ${target.name} · phase ${own ? own.to : phase}\n`);
  for (const move of moved.filter((item) => item !== own)) stdout.write(`  ${move.goal.programme}/${move.goal.goal}  phase ${move.from} → ${move.to}\n`);
  if (emptied !== null && order.kind === 'stated' && order.after[emptied]?.length) stdout.write(`  phase ${emptied} no longer waits for phase ${order.after[emptied].join(', ')} — it has no goal left\n`);
  return 0;
}

/**
 * The phase that moving `target` to `phase` would leave with no goal that
 * parses, or null: the goal's own phase when it is the only goal in it and
 * goes elsewhere.
 */
function emptiedPhase(target, phase, order, ctx) {
  if (order.kind !== 'stated') return null;
  const own = programsGoals({ home: ctx.home, list: ctx.list, read: ctx.read })
    .filter((goal) => goal.programme === target.programme && goal.problems.length === 0);
  const mine = own.find((goal) => goal.goal === target.goal);
  if (!mine || mine.phase === phase) return null;
  return own.some((goal) => goal !== mine && goal.phase === mine.phase) ? null : mine.phase;
}

/**
 * `mc goal set <programme>/<goal> title|goal|contract|out-of-scope --text "…"`
 * — the field replaced by the text; a prose field takes a paragraph per block
 * between blank lines, and an empty text clears it.
 */
function setField(args, flags, ctx) {
  const { stderr, env } = ctx;
  const words = ['title', ...Object.keys(PROSE_FIELDS), ...PROSE_PARTS];
  if (args.length !== 2 || !words.includes(args[1])) { stderr.write(`mc: set <programme>/<goal> title|${Object.keys(PROSE_FIELDS).join('|')} (version 1) or title|${PROSE_PARTS.join('|')} (version 2) --text "…"\n`); return 2; }
  const writer = goalSessionWord(env);
  if (writer && !['martin', 'decision'].includes(writer)) { stderr.write(`mc: a ${writer} session does not rewrite goal text — the brief is written by plan, interactive Martin or a person\n`); return 2; }
  if (flags.text === null) { stderr.write('mc: set needs --text "…"\n'); return 2; }
  const [named, field] = args;
  const paragraphs = flags.text.split(/\n\s*\n/u).map((part) => part.trim()).filter(Boolean);
  return changeGoal(named, ctx, (goal) => {
    if (field === 'title') return { ...goal, title: flags.text.trim() };
    if (goal.version === 2) {
      if (!PROSE_PARTS.includes(field)) return { problems: [`it is a version 2 goal — set ${field} is for version 1; version 2 has set ${PROSE_PARTS.join('|')} and the verbs item and obligation`], code: 2 };
      return { ...goal, [field]: paragraphs };
    }
    if (PROSE_PARTS.includes(field)) return { problems: [`it is a version 1 goal — set ${field} is for version 2 (mc goal new); version 1 has set ${Object.keys(PROSE_FIELDS).join('|')}`], code: 2 };
    return { ...goal, [PROSE_FIELDS[field]]: paragraphs };
  }, () => `${field} set`);
}

/** `mc goal document add <programme>/<goal> --label "…" --path "…"` — a document appended to the goal's. */
function addDocument(args, flags, ctx) {
  const { stderr, env } = ctx;
  if (args.length !== 1) { stderr.write(usage()); return 2; }
  const writer = goalSessionWord(env);
  if (writer && !['martin', 'decision'].includes(writer)) { stderr.write(`mc: a ${writer} session does not change goal documents — the brief is written by plan, interactive Martin or a person\n`); return 2; }
  const missing = ['label', 'path'].filter((key) => !flags[key]?.trim()).map((key) => `--${key}`);
  if (missing.length) { stderr.write(`mc: document add needs ${missing.join(', ')}\n`); return 2; }
  return changeGoal(args[0], ctx, (goal) => ({ ...goal, documents: [...goal.documents, { label: flags.label.trim(), path: flags.path.trim() }] }),
    (goal) => `document ${goal.documents.length} added`);
}

/** `mc goal criterion add <programme>/<goal> --criterion "…" --check "…"` — a criterion appended, not met. */
function addCriterion(args, flags, ctx) {
  const { stderr, env } = ctx;
  if (args.length !== 1) { stderr.write(usage()); return 2; }
  const writer = goalSessionWord(env);
  if (writer && !['martin', 'decision'].includes(writer)) { stderr.write(`mc: a ${writer} session does not add a criterion — acceptance is written by plan, interactive Martin or a person\n`); return 2; }
  const missing = ['criterion', 'check'].filter((key) => !flags[key]?.trim()).map((key) => `--${key}`);
  if (missing.length) { stderr.write(`mc: criterion add needs ${missing.join(', ')} — what must be true, and how it is checked\n`); return 2; }
  if (flags.evidence !== null && !flags.evidence.trim()) { stderr.write('mc: criterion add needs --evidence with text in it, or leave it out\n'); return 2; }
  return changeGoal(args[0], ctx, (goal) => {
    if (flags.evidence !== null && goal.version !== 2) return v1Refusal('--evidence');
    return { ...goal, success_criteria: [...goal.success_criteria, { criterion: flags.criterion.trim(), check: flags.check.trim(), ...(flags.evidence === null ? {} : { evidence: flags.evidence.trim() }), met: false }] };
  },
    (goal) => `criterion ${goal.success_criteria.length} added · ${criteriaWords(goal)}`,
    (goal, target) => warnAbsentTests(goal, target, flags.check.trim(), ctx));
}

/**
 * `mc goal criterion met|unmet [<programme>/<goal>] <n>` — criterion `n`
 * (1-based) recorded as holding, after its check was run, or taken back.
 */
function markCriterion(args, met, flags, ctx) {
  const { stderr, env } = ctx;
  if (args.length < 1 || args.length > 2) { stderr.write(usage()); return 2; }
  const [named, given] = args.length === 2 ? args : [undefined, args[0]];
  const n = Number(given);
  if (!Number.isInteger(n) || n < 1) { stderr.write(`mc: ${given} is not a criterion's number — 1, 2, …\n`); return 2; }
  // The mark records the heads of the goal's worktrees and the evidence given (`goal-evidence.js`); a build session's is
  // refused on an unclean or absent worktree and, for a version 2 goal, without evidence.
  const written = met ? evidenceText(flags, ctx) : { text: null };
  if (written.error) { stderr.write(`mc: ${written.error}\n`); return written.code; }
  const build = writerRole(env) === 'build' && isSession(env);
  let record = null;
  return changeGoal(named, ctx, (goal) => {
    if (n > goal.success_criteria.length) return { problems: [`it has ${goal.success_criteria.length} criteria, no criterion ${n}`], code: 2 };
    if (met) {
      const dir = goalNamed(named, ctx).dir;
      const states = worktreeHeads({ goal, dir, git: ctx.git, exists: ctx.exists });
      const problems = [];
      if (build) {
        for (const state of states.filter((one) => !one.present)) problems.push(`${state.repo} has no worktree at ${state.path} — a build session marks a criterion from its worktrees, after running the check there`);
        for (const state of states.filter((one) => one.dirty)) problems.push(`${state.repo} has uncommitted changes — commit them, run the check at that head, then record it`);
        if (goal.version === 2 && written.text === null) problems.push('criterion met needs --evidence "…" or --evidence-file <path|-> — what the check ran and what it showed');
      }
      const readable = readEvidence(dir, ctx.read);
      if (readable.problem) problems.push(readable.problem);
      if (problems.length) return { problems, code: 2 };
      record = makeRecord({ states, at: logStamp(ctx.now), tool: env.MC_TOOL || 'person', model: env.MC_MODEL || null, role: writerRole(env), text: written.text ?? '', criterion: goal.success_criteria[n - 1].criterion });
    }
    return { ...goal, success_criteria: goal.success_criteria.map((item, i) => (i === n - 1 ? { ...item, met } : item)) };
  }, (goal) => `criterion ${n} ${met ? 'met' : 'unmet'} · ${criteriaWords(goal)}`, (goal, target) => {
    const io = { read: ctx.read, write: ctx.write };
    const kept = met ? setEvidence(target.dir, `criterion ${n}`, record, io) : dropItems(target.dir, [`criterion ${n}`], io);
    if (kept.problem) stderr.write(`mc: ${kept.problem} — criterion ${n}'s record is not ${met ? 'written' : 'removed'}\n`);
  });
}

/**
 * The evidence text of a call (`--evidence` or `--evidence-file`, `-` for stdin, one final newline left out as an
 * entry's is), as `{ text }` (null when none or blank) or `{ error, code }` for both given or a file that cannot be read.
 */
function evidenceText(flags, ctx) {
  if (flags.evidence !== null && flags['evidence-file'] !== null) return { error: '--evidence and --evidence-file are one or the other, not both', code: 2 };
  let text = flags.evidence;
  if (flags['evidence-file'] !== null) {
    try { text = ctx.readFile(flags['evidence-file']).replace(/\n$/u, ''); }
    catch (error) { return { error: `--evidence-file ${flags['evidence-file']} cannot be read — ${error.message}`, code: 1 }; }
  }
  return { text: text === null || !text.trim() ? null : text };
}

/**
 * `mc goal evidence [<programme>/<goal>] <id> --text "…" | --file <path|->` — the evidence for a preserve item (its id)
 * or a touched obligation (its area), recorded with the heads of the goal's worktrees as a criterion's mark is
 * (`goal-evidence.js`), and not tied to a head: it is often a reading and not a run. The goal's text and LOG.md are not
 * touched. A build session, a person, plan and the desk may call it; a review and a mend session are refused (the
 * early refusals of `run` already hold desk-prepare and learning).
 */
function evidenceVerb(args, flags, ctx) {
  const { stdout, stderr, env, read } = ctx;
  if (args.length < 1 || args.length > 2) { stderr.write(usage()); return 2; }
  const [named, id] = args.length === 2 ? args : [undefined, args[0]];
  const role = writerRole(env);
  if (isSession(env) && ['review', 'mend'].includes(role)) { stderr.write(`mc: a ${role} session does not record evidence — the build records it, and a review reads it with mc goal show\n`); return 2; }
  if (env.MC_ROLE === 'martin' && env.MC_HEADLESS === '1') { stderr.write('mc: the Martin role is interactive-only; unattended sessions cannot change goals\n'); return 2; }
  if (flags.text !== null && flags.file !== null) { stderr.write('mc: --text and --file are one or the other, not both\n'); return 2; }
  if (flags.text === null && flags.file === null) { stderr.write('mc: evidence needs --text "…" or --file <path|-> — what was read or run, and what it showed\n'); return 2; }
  const target = goalNamed(named, ctx);
  if (target.error) { stderr.write(`mc: ${target.error}\n`); return 2; }
  if (isSession(env) && env.MC_GOAL && env.MC_GOAL !== target.name) { stderr.write(`mc: goal session ${env.MC_GOAL} cannot change ${target.name}\n`); return 2; }
  const text = read(join(target.dir, GOAL_FILE));
  if (text === null) { stderr.write(`mc: no goal ${target.name} — ${target.dir} has no ${GOAL_FILE}\n`); return 1; }
  const goal = parseGoal(text);
  if (goal.problems) {
    for (const problem of goal.problems) stderr.write(`mc: ${target.name}: ${problem}\n`);
    return 1;
  }
  const key = itemKey(goal, id);
  if (key === null) {
    const { preserve, areas } = evidenceIds(goal);
    const ids = [...preserve, ...areas];
    stderr.write(`mc: ${target.name}: ${id} is not a preserve item or a touched obligation — ${ids.length ? `the ids are ${ids.join(', ')}` : `it has none${goal.version === 2 ? '' : ' (a version 1 goal has no preserve items or obligations)'}`}\n`);
    return 2;
  }
  let said = flags.text;
  if (flags.file !== null) {
    try { said = ctx.readFile(flags.file).replace(/\n$/u, ''); }
    catch (error) { stderr.write(`mc: --file ${flags.file} cannot be read — ${error.message}\n`); return 1; }
  }
  if (!said.trim()) { stderr.write('mc: evidence needs text in it\n'); return 2; }
  const states = worktreeHeads({ goal, dir: target.dir, git: ctx.git, exists: ctx.exists });
  const record = makeRecord({ states, at: logStamp(ctx.now), tool: env.MC_TOOL || 'person', model: env.MC_MODEL || null, role, text: said });
  const kept = setEvidence(target.dir, key, record, { read, write: ctx.write });
  if (kept.problem) { stderr.write(`mc: ${kept.problem}\n`); return 1; }
  stdout.write(`mc: ${target.name} · evidence recorded for ${key}\n`);
  return 0;
}

/** `text` with `stale` written beside each of the met criteria numbered in `numbers`; the goal's text itself is not changed. */
function markStale(text, numbers) {
  if (!numbers.length) return text;
  let inCriteria = false;
  return text.split('\n').map((line) => {
    if (line.startsWith('CRITERIA')) inCriteria = true;
    else if (/^\S/u.test(line)) inCriteria = false;
    const found = inCriteria ? /^ {2}(\d+) ✓ /u.exec(line) : null;
    return found && numbers.includes(Number(found[1])) ? `${line}  [stale — its mark is at an earlier head]` : line;
  }).join('\n');
}

/**
 * `mc goal criterion set [<programme>/<goal>] <n> [--criterion "…"] [--check "…"]`
 * — criterion `n`'s text and/or check rewritten, and the criterion unmet, its
 * check to be run again. Logged with the old and new text; the stage and status
 * kept. Acceptance is written by plan or a person: a goal session (build,
 * review, mend) is refused, and so is a call with no flag. A check given is read for the test
 * files it names (`warnAbsentTests`).
 */
function setCriterion(args, flags, ctx) {
  const { stderr, env } = ctx;
  if (args.length < 1 || args.length > 2) { stderr.write(usage()); return 2; }
  const role = writerRole(env);
  if (goalSessionWord(env) && !['martin', 'decision'].includes(role)) { stderr.write(`mc: a ${role} session does not rewrite a criterion — acceptance is written by plan, Martin or a person\n`); return 2; }
  const given = ['criterion', 'check', 'evidence'].filter((key) => flags[key] !== null);
  if (!given.length) { stderr.write('mc: criterion set needs --criterion "…", --check "…" or --evidence "…" — what is rewritten\n'); return 2; }
  const blank = given.filter((key) => !flags[key].trim()).map((key) => `--${key}`);
  if (blank.length) { stderr.write(`mc: criterion set needs ${blank.join(', ')} with text in it\n`); return 2; }
  const [named, number] = args.length === 2 ? args : [undefined, args[0]];
  const n = Number(number);
  if (!Number.isInteger(n) || n < 1) { stderr.write(`mc: ${number} is not a criterion's number — 1, 2, …\n`); return 2; }
  const criterion = flags.criterion === null ? null : flags.criterion.trim();
  const check = flags.check === null ? null : flags.check.trim();
  const evidence = flags.evidence === null ? null : flags.evidence.trim();
  let was = null;
  return changeGoal(named, ctx, (goal) => {
    if (evidence !== null && goal.version !== 2) return v1Refusal('--evidence');
    if (n > goal.success_criteria.length) return { problems: [`it has ${goal.success_criteria.length} criteria, no criterion ${n}`], code: 2 };
    was = goal.success_criteria[n - 1];
    const kept = evidence ?? was.evidence;
    return { ...goal, success_criteria: goal.success_criteria.map((item, i) => (i === n - 1
      ? { criterion: criterion ?? item.criterion, check: check ?? item.check, ...(kept === undefined ? {} : { evidence: kept }), met: false }
      : item)) };
  }, (goal) => `criterion ${n} rewritten, unmet · ${criteriaWords(goal)}`, (goal, target) => {
    const changed = [
      criterion === null ? null : `criterion was "${oneLine(was.criterion)}", now "${oneLine(criterion)}"`,
      check === null ? null : `check was "${oneLine(was.check)}", now "${oneLine(check)}"`,
      evidence === null ? null : `evidence was ${was.evidence === undefined ? 'none' : `"${oneLine(was.evidence)}"`}, now "${oneLine(evidence)}"`,
    ].filter(Boolean);
    const entry = { at: logStamp(ctx.now), tool: env.MC_TOOL || 'person', model: env.MC_MODEL || null, role, done: null, comment: `criterion ${n} rewritten, unmet — ${changed.join('; ')}`, next: null, stage: goal.stage, status: goal.status };
    appendEntry({ dir: target.dir, entry, read: ctx.read, write: ctx.write });
    dropItems(target.dir, [`criterion ${n}`], { read: ctx.read, write: ctx.write });
    if (check !== null) warnAbsentTests(goal, target, check, ctx);
  });
}

/**
 * `mc goal criterion remove [<programme>/<goal>] <n> --reason "…"` — criterion
 * `n` taken out, the later ones moved up one number with their text, check and
 * met kept. Logged with the removed text, its check, whether it was met and the
 * reason; the stage and status kept. Acceptance is written by plan or a person:
 * a goal session (build, review, mend) is refused. Every refusal exits 2 and writes nothing:
 * no reason or a blank one, a number that is not one, a number past the criteria,
 * and the only criterion (its replacement is added first).
 */
function removeCriterion(args, flags, ctx) {
  const { stderr, env } = ctx;
  if (args.length < 1 || args.length > 2) { stderr.write(usage()); return 2; }
  const role = writerRole(env);
  if (goalSessionWord(env) && !['martin', 'decision'].includes(role)) { stderr.write(`mc: a ${role} session does not remove a criterion — acceptance is written by plan, Martin or a person\n`); return 2; }
  if (flags.reason === null || !flags.reason.trim()) { stderr.write('mc: criterion remove needs --reason "…" with text in it — why the criterion is obsolete\n'); return 2; }
  const reason = oneLine(flags.reason.trim());
  const [named, number] = args.length === 2 ? args : [undefined, args[0]];
  const n = Number(number);
  if (!Number.isInteger(n) || n < 1) { stderr.write(`mc: ${number} is not a criterion's number — 1, 2, …\n`); return 2; }
  let removed = null;
  return changeGoal(named, ctx, (goal) => {
    if (n > goal.success_criteria.length) return { problems: [`it has ${goal.success_criteria.length} criteria, no criterion ${n}`], code: 2 };
    if (goal.success_criteria.length === 1) return { problems: [`criterion ${n} is the goal's only criterion — add its replacement first, or drop the goal`], code: 2, prefix: false };
    removed = goal.success_criteria[n - 1];
    return { ...goal, success_criteria: goal.success_criteria.filter((_, i) => i !== n - 1) };
  }, (goal) => `criterion ${n} removed · ${criteriaWords(goal)}`, (goal, target) => {
    const comment = `criterion ${n} removed — "${oneLine(removed.criterion)}", check "${oneLine(removed.check)}", was ${removed.met ? 'met' : 'not met'}; reason: ${reason}`;
    const entry = { at: logStamp(ctx.now), tool: env.MC_TOOL || 'person', model: env.MC_MODEL || null, role, done: null, comment, next: null, stage: goal.stage, status: goal.status };
    appendEntry({ dir: target.dir, entry, read: ctx.read, write: ctx.write });
    removeCriterionItem(target.dir, n, { read: ctx.read, write: ctx.write });
  });
}

/**
 * Why a version 2 verb cannot be used on a version 1 goal, as a refusal for `changeGoal`: exit 2, nothing written,
 * naming the goal's version and the verbs that apply to it.
 */
function v1Refusal(what) {
  return { problems: [`it is a version 1 goal — ${what} is for version 2 goals (mc goal new); version 1 has mc goal set goal|contract|out-of-scope, document add and criterion add|set|remove|met|unmet`], code: 2 };
}

/** Why the caller may not write the brief's parts, or null: only plan, interactive Martin or a person writes them. */
function partsWriterRefusal(env, what) {
  const writer = goalSessionWord(env);
  return writer && !['martin', 'decision'].includes(writer)
    ? `a ${writer} session does not ${what} — the brief is written by plan, interactive Martin or a person`
    : null;
}

/** The flags `given` of `flags` among `names` (flag words, `--` kept), as `[field, value]` pairs by field name. */
const givenOf = (flags, fields) => fields.filter((field) => flags[flagOf(field)] !== null).map((field) => [field, flags[flagOf(field)]]);

/**
 * The fields of a part's item given on the command line — `--text` as the part's text key — or why not: a field of
 * another part, a blank text, a value outside the part's choices.
 */
function itemFields(part, flags, verb) {
  const given = [];
  const foreign = ITEM_FLAGS.map((flag) => flag.slice(2)).find((key) => flags[key] !== null && !part.fields.map(flagOf).includes(key));
  if (foreign) return { error: `${verb} ${part.word} takes no --${foreign} — its flags are --text${part.fields.map((field) => ` --${flagOf(field)}`).join('')}` };
  if (flags.text !== null) given.push([part.textKey, flags.text]);
  given.push(...givenOf(flags, part.fields));
  const blank = given.filter(([, value]) => !value.trim()).map(([field]) => `--${field === part.textKey ? 'text' : flagOf(field)}`);
  if (blank.length) return { error: `${verb} ${part.word} needs ${blank.join(', ')} with text in it` };
  const bad = given.find(([field, value]) => part.choices[field] && !part.choices[field].includes(value.trim()));
  if (bad) return { error: `--${flagOf(bad[0])} is ${part.choices[bad[0]].join(', ')}, not ${bad[1].trim()}` };
  return { fields: Object.fromEntries(given.map(([field, value]) => [field, value.trim()])) };
}

/** `mc goal item add <programme>/<goal> <part> --text "…" [the part's flags]` — an item appended, its id printed. */
function addItemVerb(args, flags, ctx) {
  const { stderr, env } = ctx;
  if (args.length !== 2 || !ITEM_WORDS.includes(args[1])) { stderr.write(`mc: item add <programme>/<goal> ${ITEM_WORDS.join('|')} --text "…" and the part's flags\n`); return 2; }
  const refused = partsWriterRefusal(env, 'add to the goal\'s parts');
  if (refused) { stderr.write(`mc: ${refused}\n`); return 2; }
  const part = ITEM_PARTS[args[1]];
  const read = itemFields(part, flags, 'item add');
  if (read.error) { stderr.write(`mc: ${read.error}\n`); return 2; }
  const missing = [part.textKey, ...part.fields].filter((field) => read.fields[field] === undefined).map((field) => `--${field === part.textKey ? 'text' : flagOf(field)}`);
  if (missing.length) { stderr.write(`mc: item add ${part.word} needs ${missing.join(', ')} — each is required\n`); return 2; }
  let id = null;
  return changeGoal(args[0], ctx, (goal) => {
    if (goal.version !== 2) return v1Refusal('item add');
    const added = addItem(goal, part.word, read.fields);
    id = added.id;
    return added.goal;
  }, () => `${part.word} ${id} added`);
}

/**
 * `mc goal item set <programme>/<goal> <id> [--text "…"] [the part's flags]` — what is given changed, the rest
 * kept; logged with what each field was and is now.
 */
function setItemVerb(args, flags, ctx) {
  const { stderr, env } = ctx;
  const part = args.length === 2 ? partOfId(args[1]) : null;
  if (!part) { stderr.write(`mc: item set <programme>/<goal> <id> — an id like ${ITEM_WORDS.map((word) => `${ITEM_PARTS[word].letter}1`).join(', ')} — and --text or the part's flags\n`); return 2; }
  const refused = partsWriterRefusal(env, 'rewrite the goal\'s parts');
  if (refused) { stderr.write(`mc: ${refused}\n`); return 2; }
  const read = itemFields(part, flags, 'item set');
  if (read.error) { stderr.write(`mc: ${read.error}\n`); return 2; }
  if (!Object.keys(read.fields).length) { stderr.write(`mc: item set needs --text or ${part.fields.map((field) => `--${flagOf(field)}`).join(', ')} — what is rewritten\n`); return 2; }
  const [named, id] = args;
  let changed = null;
  return changeGoal(named, ctx, (goal) => {
    if (goal.version !== 2) return v1Refusal('item set');
    const set = setItem(goal, id, read.fields);
    if (!set) return { problems: [`it has no item ${id}`], code: 2 };
    changed = Object.keys(read.fields).map((field) => `${flagOf(field)} was "${oneLine(set.was[field])}", now "${oneLine(set.item[field])}"`);
    return set.goal;
  }, () => `${id} rewritten`, (goal, target) => {
    logChange(ctx, goal, target, `${id} rewritten — ${changed.join('; ')}`);
  });
}

/** `mc goal item remove <programme>/<goal> <id> --reason "…"` — the item taken out, logged with its fields and the reason; its id is not given again. */
function removeItemVerb(args, flags, ctx) {
  const { stderr, env } = ctx;
  if (args.length !== 2 || !partOfId(args[1])) { stderr.write('mc: item remove <programme>/<goal> <id> --reason "…"\n'); return 2; }
  const refused = partsWriterRefusal(env, 'remove from the goal\'s parts');
  if (refused) { stderr.write(`mc: ${refused}\n`); return 2; }
  if (flags.reason === null || !flags.reason.trim()) { stderr.write('mc: item remove needs --reason "…" with text in it — why the item goes\n'); return 2; }
  const reason = oneLine(flags.reason.trim());
  const [named, id] = args;
  let removed = null;
  return changeGoal(named, ctx, (goal) => {
    if (goal.version !== 2) return v1Refusal('item remove');
    const out = removeItem(goal, id);
    if (!out) return { problems: [`it has no item ${id}`], code: 2 };
    removed = out.was;
    return out.goal;
  }, () => `${id} removed`, (goal, target) => {
    logChange(ctx, goal, target, `${id} removed — ${itemWords(removed)}; reason: ${reason}`);
  });
}

/** `mc goal obligation set <programme>/<goal> <area> --stand touched|untouched --text "…" [--standard "<repo>/<path>#<section>"]`. */
function setObligationVerb(args, flags, ctx) {
  const { stderr, env } = ctx;
  if (args.length !== 2) { stderr.write('mc: obligation set <programme>/<goal> <area> --stand touched|untouched --text "…" [--standard "<repo>/<path>#<section>"]\n'); return 2; }
  const refused = partsWriterRefusal(env, 'write the goal\'s obligations');
  if (refused) { stderr.write(`mc: ${refused}\n`); return 2; }
  const missing = [['--stand', flags.stand], ['--text', flags.text]].filter(([, value]) => value === null || !value.trim()).map(([flag]) => flag);
  if (missing.length) { stderr.write(`mc: obligation set needs ${missing.join(', ')} with text in it\n`); return 2; }
  if (!STANDS.includes(flags.stand.trim())) { stderr.write(`mc: --stand is ${STANDS.join(' or ')}, not ${flags.stand.trim()}\n`); return 2; }
  if (flags.standard !== null && !/^[^\s#]+\/[^#]+#\S.*$/u.test(flags.standard.trim())) { stderr.write('mc: --standard is <repo>/<path>#<section>\n'); return 2; }
  const [named, area] = [args[0], args[1].trim()];
  if (!area) { stderr.write('mc: obligation set needs the area, in words\n'); return 2; }
  let replaced = null;
  let after = null;
  const given = { stand: flags.stand.trim(), text: flags.text.trim(), standard: flags.standard === null ? null : flags.standard.trim() };
  const code = changeGoal(named, ctx, (goal) => {
    if (goal.version !== 2) return v1Refusal('obligation set');
    const read = goalDeclarations(goal, null, ctx);
    if (read.error) return { problems: [read.error], code: 1 };
    const refusal = areaRefusal(area, read.declared);
    if (refusal) return { problems: [refusal], code: 2 };
    const set = setObligation(goal, area, given);
    replaced = set.was;
    after = read.declared.some((one) => ruleAreas(one).length) ? stillWithoutStand(read.declared, set.goal.obligations) : null;
    return set.goal;
  }, () => `obligation "${area}" ${replaced ? 'replaced' : 'set'}`, (goal, target) => {
    if (replaced) logChange(ctx, goal, target, `obligation "${area}" replaced — it was ${itemWords(replaced)}`);
  });
  if (code === 0 && after) ctx.stdout.write(`${after}\n`);
  return code;
}

/**
 * The declarations of the goal's repositories at `at` (`origin/main` unless given): `{ declared: [{ repo, path, areas }] }`
 * in the goal's order, or `{ error }` naming a repository mc does not know or the reader's reason. A git failure is never
 * no declaration (`readAreas`).
 */
function goalDeclarations(goal, at, ctx) {
  const declared = [];
  for (const repo of goal.repos) {
    const path = ctx.known().find((known) => repoNameOf(known) === repo);
    if (!path) return { error: `${repo} is not a repository mc knows — ${ctx.known().map(repoNameOf).join(', ')}` };
    const read = readAreas(path, { git: ctx.git, at: at ?? 'origin/main', repo });
    if (!read.ok) return { error: read.reason };
    declared.push({ repo, path, areas: read.areas });
  }
  return { declared };
}

/** A declaration's rule areas: the ones that ask a goal for a stand (a source area asks none). */
const ruleAreas = (one) => one.areas.filter((area) => !isSourceArea(area));

/**
 * Why `area` is not one the goal may take a stand on (D7: any word where nothing is declared), or null. A source
 * area's own id is refused first; a repository that declares source areas alone counts as one that declares none.
 */
function areaRefusal(area, declared) {
  const slash = area.indexOf('/');
  const own = slash > 0 ? declared.find((one) => one.repo === area.slice(0, slash)) : null;
  const source = own?.areas.find((one) => isSourceArea(one) && `${own.repo}/${one.id}` === area);
  if (source) return `"${area}" is a source area that asks no stand — read its page ${source.page} instead`;
  if (!declared.some((one) => ruleAreas(one).length)) return null;
  if (own && !ruleAreas(own).length && slash < area.length - 1) return null;
  if (own && ruleAreas(own).some((one) => `${own.repo}/${one.id}` === area)) return null;
  const listed = declared.map((one) => (ruleAreas(one).length ? `${one.repo}: ${ruleAreas(one).map((a) => `${one.repo}/${a.id}`).join(', ')}` : `${one.repo}: declares none, any <${one.repo}/…> is taken`));
  return `"${area}" is not a rule area of the goal's repositories — an area is <repo>/<id>\n  ${listed.join('\n  ')}`;
}

/** The line `obligation set` ends with: the declared areas with no obligation, or that none lacks one. */
function stillWithoutStand(declared, obligations) {
  const taken = new Set((obligations ?? []).map((one) => one.area));
  const lacking = declared.flatMap((one) => ruleAreas(one).map((a) => `${one.repo}/${a.id}`)).filter((id) => !taken.has(id));
  return lacking.length ? `  no stand yet: ${lacking.join(', ')}` : '  every declared area has a stand';
}

/** `mc goal obligation remove <programme>/<goal> <area> --reason "…"` — the obligation taken out, logged with the reason. */
function removeObligationVerb(args, flags, ctx) {
  const { stderr, env } = ctx;
  if (args.length !== 2) { stderr.write('mc: obligation remove <programme>/<goal> <area> --reason "…"\n'); return 2; }
  const refused = partsWriterRefusal(env, 'remove the goal\'s obligations');
  if (refused) { stderr.write(`mc: ${refused}\n`); return 2; }
  if (flags.reason === null || !flags.reason.trim()) { stderr.write('mc: obligation remove needs --reason "…" with text in it — why the area has none\n'); return 2; }
  const reason = oneLine(flags.reason.trim());
  const [named, area] = [args[0], args[1].trim()];
  let removed = null;
  return changeGoal(named, ctx, (goal) => {
    if (goal.version !== 2) return v1Refusal('obligation remove');
    const out = removeObligation(goal, area);
    if (!out) return { problems: [`it has no obligation for "${area}"`], code: 2 };
    removed = out.was;
    return out.goal;
  }, () => `obligation "${area}" removed`, (goal, target) => {
    logChange(ctx, goal, target, `obligation "${area}" removed — ${itemWords(removed)}; reason: ${reason}`);
  });
}

/** One LOG.md entry saying what a verb changed in the brief, written by the caller's role. */
function logChange(ctx, goal, target, comment) {
  const { env } = ctx;
  const entry = { at: logStamp(ctx.now), tool: env.MC_TOOL || 'person', model: env.MC_MODEL || null, role: writerRole(env), done: null, comment, next: null, stage: goal.stage, status: goal.status };
  appendEntry({ dir: target.dir, entry, read: ctx.read, write: ctx.write });
}

/** A text on one line, for a LOG.md comment. */
const oneLine = (text) => String(text).replace(/\s*\n\s*/gu, ' ');

/** The test files a check names: `tests/<path>.test.(js|mjs|cjs|ts)`. */
const TEST_FILE_RE = /tests\/[\w./-]+\.test\.(?:js|mjs|cjs|ts)\b/gu;

/**
 * A warning, never a refusal, for each test file `check` names that is on no
 * repository's origin/main of the goal: once per path, saying the repositories.
 * A git failure is no answer, and warns nothing (`onOriginMain`).
 */
function warnAbsentTests(goal, target, check, ctx) {
  for (const path of new Set(check.match(TEST_FILE_RE) ?? [])) {
    const answers = goal.repos.map((repo) => onOriginMain(repo, path, target, ctx));
    if (answers.length && answers.every((answer) => answer === 'absent')) {
      ctx.stderr.write(`mc: warning: ${path} is not on origin/main of ${goal.repos.join(', ')} — a new file the build creates, or a wrong name?\n`);
    }
  }
}

/**
 * Whether `path` is on origin/main of `repo`: `present`, `absent` (git says it
 * does not exist there) or `unknown` (no answer). Asked in the goal's worktree
 * of the repository when there is one, else in the repository mc knows.
 */
function onOriginMain(repo, path, target, ctx) {
  const worktree = join(target.dir, repo);
  const cwd = ctx.exists(worktree) ? worktree : ctx.known().find((known) => repoNameOf(known) === repo);
  if (!cwd) return 'unknown';
  const r = ctx.git(cwd, ['cat-file', '-e', `origin/main:${path}`]);
  if (r.ok) return 'present';
  return /does not exist in/u.test(r.stderr || '') ? 'absent' : 'unknown';
}

/**
 * What the parts check asks of the repositories (`partsLacks`): the declared areas of the goal's repositories at
 * origin/main, read once, and whether a standard's path is on origin/main of the repository it names. Asked only
 * when a version 2 goal moves out of draft.
 */
function planProbe(goal, target, ctx) {
  let declared = null;
  return {
    declarations: () => (declared ??= goalDeclarations(goal, 'origin/main', ctx)),
    onMain: (repo, path) => {
      if (!ctx.known().some((known) => repoNameOf(known) === repo)) return { state: 'unknown', why: `${repo} is not a repository mc knows` };
      const state = onOriginMain(repo, path, target, ctx);
      return state === 'unknown' ? { state, why: `git gave no answer for ${path} in ${repo}` } : { state };
    },
  };
}

/**
 * One verb's change to a goal's GOAL.json (`updateGoal`), said on stdout, or why
 * not on stderr. `after(goal, target)` runs once the write is made.
 */
function changeGoal(named, ctx, change, said, after = null) {
  const { stdout, stderr, read, write } = ctx;
  if (ctx.env.MC_ROLE === 'martin' && ctx.env.MC_HEADLESS === '1') { stderr.write('mc: the Martin role is interactive-only; unattended sessions cannot change goals\n'); return 2; }
  const target = goalNamed(named, ctx);
  if (target.error) { stderr.write(`mc: ${target.error}\n`); return 2; }
  if (read(join(target.dir, GOAL_FILE)) === null) { stderr.write(`mc: no goal ${target.name} — ${target.dir} has no ${GOAL_FILE}\n`); return 1; }
  const outcome = updateGoal({ dir: target.dir, change, read, write });
  if (outcome.problems) {
    for (const problem of outcome.problems) stderr.write(`mc: ${outcome.prefix === false ? '' : `${target.name}: `}${problem}\n`);
    return outcome.code ?? 1;
  }
  if (['martin', 'decision'].includes(ctx.env.MC_ROLE)) {
    appendEntry({ dir: target.dir, entry: { at: logStamp(ctx.now), tool: ctx.env.MC_TOOL || 'person', model: ctx.env.MC_MODEL || null,
      role: writerRole(ctx.env), stage: outcome.goal.stage, status: outcome.goal.status,
      done: `goal updated: ${said(outcome.goal)}`, comment: null, next: null }, read, write });
  }
  if (after) after(outcome.goal, target);
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
 * goals (`convertProject`), each said with its stage and status, its phase,
 * its branch and the pull request it carries. A finished project, or one converted
 * already, is refused with exit 1.
 */
function fromProject(args, ctx) {
  const { stdout, stderr, env, home, now, list, read, write, git, known } = ctx;
  if (args.length !== 1 || !isGoalRef(args[0])) { stderr.write('mc: from-project <programme>/<project>\n'); return 2; }
  const [programme, project] = args[0].split('/');
  const record = readRecord(join(home, programme), { read });
  const refusal = record.status === 'valid' && repairDraftRefusal(record.record, programme);
  if (refusal) { stderr.write(`mc: ${refusal}\n`); return 1; }
  const answer = convertProject({ home, programme, project, now, tool: env.MC_TOOL || 'person', model: env.MC_MODEL || null, list, read, write, git, known });
  if (answer.refused) { stderr.write(`mc: ${args[0]} is not converted — ${answer.refused}\n`); return 1; }
  for (const goal of answer.made) {
    const carries = goal.prs.length ? ` · carries ${goal.prs.map(prRef).join(', ')}` : '';
    stdout.write(`mc: ${goal.name} · ${goal.stage} · ${goal.status} · phase ${goal.phase} · ${goal.branch}${carries}\n`);
    if (goal.worktree) stderr.write(`mc: ${goal.name}'s worktree is not made — ${goal.worktree}; the goal's files stand\n`);
  }
  stdout.write(`mc: ${answer.made.length} goal${answer.made.length === 1 ? '' : 's'} made from ${args[0]}; the project's own files are left as they are\n`);
  return answer.made.some((goal) => goal.worktree) ? 1 : 0;
}

/**
 * Why a hold is not for this caller, or null: a headless caller, which is never a holder, or a session of another goal
 * (the refusal `logEntry` gives). Both hold verbs use it.
 */
function headlessHoldRefusal(env) {
  return env.MC_HEADLESS === '1' ? 'a hold is set by a person or an interactive session — a headless session that cannot continue asks with mc ask or reports with mc goal defect' : null;
}

function holdCallerRefusal(target, env) {
  const headless = headlessHoldRefusal(env);
  if (headless) return headless;
  if (isSession(env) && env.MC_GOAL && env.MC_GOAL !== target.name) return `goal session ${env.MC_GOAL} cannot change ${target.name}`;
  return null;
}

/**
 * `mc goal hold [<programme>/<goal>] --reason "…"` — the goal is held: the runner starts no session on it until
 * `mc goal release`. Stage and status stay, so nothing is asked of Martin and no desk item opens. Writes
 * `.hold.json` (by, tool, at, reason) and one log entry, `held: <reason>`. Refused, with nothing written, for a
 * headless caller, a session of another goal, no reason, a goal in done or dropped, and a goal already held.
 */
function holdVerb(args, flags, ctx) {
  const { stdout, stderr, env, read, write } = ctx;
  if (args.length > 1) { stderr.write(usage()); return 2; }
  const target = goalNamed(args[0], ctx);
  if (target.error) { stderr.write(`mc: ${target.error}\n`); return 2; }
  const refusal = holdCallerRefusal(target, env);
  if (refusal) { stderr.write(`mc: ${refusal}\n`); return 2; }
  const reason = typeof flags.reason === 'string' ? flags.reason.trim() : '';
  if (!reason) { stderr.write('mc: hold needs --reason "…" — why the goal is held\n'); return 2; }
  const text = read(join(target.dir, GOAL_FILE));
  if (text === null) { stderr.write(`mc: no goal ${target.name} — ${target.dir} has no ${GOAL_FILE}\n`); return 1; }
  const goal = parseGoal(text);
  if (goal.problems) {
    for (const problem of goal.problems) stderr.write(`mc: ${target.name}: ${problem}\n`);
    return 1;
  }
  if (FINISHED.includes(goal.stage)) { stderr.write(`mc: ${target.name} is ${goal.stage} — a finished goal is not held\n`); return 2; }
  const held = readHold(target.dir, read);
  if (held) {
    stderr.write(`mc: ${target.name} is already held by ${held.by ?? '—'} since ${held.at ?? '—'} — mc goal release ${target.name} hands it back\n`);
    return 2;
  }
  const running = ctx.active(target);
  const hold = { by: writerRole(env) || 'person', tool: env.MC_TOOL || 'person', at: logStamp(ctx.now), reason };
  write(join(target.dir, HOLD_FILE), `${JSON.stringify(hold, null, 2)}\n`);
  const comment = `held: ${reason}${running ? ' — a session is running on it now; the hold does not stop it' : ''}`;
  appendEntry({ dir: target.dir, entry: { at: hold.at, tool: hold.tool, model: env.MC_MODEL || null, role: writerRole(env), stage: goal.stage, status: goal.status, done: null, comment, next: null }, read, write });
  stdout.write(`mc: ${target.name} held — the runner starts no session on it until mc goal release ${target.name}\n`);
  if (running) stdout.write(`mc: a session is running on ${target.name} now; the hold does not stop it\n`);
  return 0;
}

/**
 * `mc goal release [<programme>/<goal>] [--reason "…"]` — hands a held goal back: one log entry at its stage and
 * status, whose comment says who held it and since when and then each worktree's state (`worktreeStates`), and
 * the hold file removed. Refused, with nothing written, for a headless caller, and a
 * goal that is not held.
 */
function releaseVerb(args, flags, ctx) {
  const { stdout, stderr, env, read, write } = ctx;
  if (args.length > 1) { stderr.write(usage()); return 2; }
  const target = goalNamed(args[0], ctx);
  if (target.error) { stderr.write(`mc: ${target.error}\n`); return 2; }
  const refusal = headlessHoldRefusal(env);
  if (refusal) { stderr.write(`mc: ${refusal}\n`); return 2; }
  const text = read(join(target.dir, GOAL_FILE));
  if (text === null) { stderr.write(`mc: no goal ${target.name} — ${target.dir} has no ${GOAL_FILE}\n`); return 1; }
  const goal = parseGoal(text);
  if (goal.problems) {
    for (const problem of goal.problems) stderr.write(`mc: ${target.name}: ${problem}\n`);
    return 1;
  }
  const held = readHold(target.dir, read);
  if (!held) { stderr.write(`mc: ${target.name} is not held\n`); return 2; }
  const note = typeof flags.reason === 'string' && flags.reason.trim() ? ` — ${flags.reason.trim()}` : '';
  const lines = worktreeStates(goal, target.dir, ctx).map(worktreeWords);
  const comment = [`released: held by ${held.by ?? '—'} since ${held.at ?? '—'} (${held.reason ?? '—'})${note}`, ...lines].join('\n');
  appendEntry({ dir: target.dir, entry: { at: logStamp(ctx.now), tool: env.MC_TOOL || 'person', model: env.MC_MODEL || null, role: writerRole(env), stage: goal.stage, status: goal.status, done: null, comment, next: null }, read, write });
  ctx.remove(join(target.dir, HOLD_FILE));
  stdout.write(`mc: ${target.name} released\n`);
  for (const line of lines) stdout.write(`${line}\n`);
  ctx.wake();
  return 0;
}

/**
 * Each repository of a goal's worktree in `dir`: its changed files, its commits past origin/main and its last commit's
 * date, or `worktree: false` when it has none. `mc goal show` and a release both read it.
 */
function worktreeStates(goal, dir, ctx) {
  return goal.repos.map((repo) => {
    const path = join(dir, repo);
    const status = ctx.git(path, ['status', '--short']);
    if (!status.ok) return { repo, path, worktree: false };
    const changed = status.stdout.split('\n').filter((line) => line.trim() !== '').length;
    const ahead = ctx.git(path, ['rev-list', '--count', 'origin/main..HEAD']);
    const last = ctx.git(path, ['log', '-1', '--format=%cI']);
    return {
      repo, path, worktree: true, changed,
      ahead: ahead.ok ? ahead.stdout.trim() : '?',
      last: last.ok && last.stdout.trim() ? last.stdout.trim() : 'none',
    };
  });
}

/** One repository's state as a release logs it: `<repo>: 3 changed · 2 commits past origin/main · last commit <date>`, or `<repo>: no worktree`. */
function worktreeWords(state) {
  if (!state.worktree) return `${state.repo}: no worktree`;
  return `${state.repo}: ${state.changed} changed · ${state.ahead} commits past origin/main · last commit ${state.last}`;
}

/**
 * `mc goal show <programme>/<goal>` — its status line, the goal as text
 * (`renderGoalText`: goal, contract, out of scope, documents, each criterion
 * with ✓/✗ and its check), the last three log entries, and for each repository's worktree its changed
 * files, its commits past origin/main and its last commit's date.
 */
function showGoal(args, ctx) {
  const { stdout, stderr, home, list, read } = ctx;
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
  const hold = readHold(target.dir, read);
  if (hold) stdout.write(`held by ${hold.by ?? '—'} since ${hold.at ?? '—'}: ${hold.reason ?? '—'}\n`);
  // The records are in a file of their own (`goal-evidence.js`): the goal's text is the same with or without them,
  // and a met criterion whose record is at another head than the worktrees' has `stale` written beside it.
  const evidence = evidenceLines({ goal, dir: target.dir, git: ctx.git, exists: ctx.exists, read });
  stdout.write(`\n${markStale(renderGoalText(goal), evidence.stale)}`);
  if (evidence.lines.length) stdout.write(`\nEVIDENCE\n${evidence.lines.join('\n')}\n`);

  const log = parseLog(read(join(target.dir, LOG_FILE)) ?? '');
  const worktrees = worktreeStates(goal, target.dir, ctx);
  const isPhaseOpen = (named) => {
    const own = programsGoals({ home, read, list: (path) => path === home ? [named.programme] : list(path) });
    return phaseOpen(named, own, programmeOrder(named.programme, { home, read }));
  };
  const outcome = buildOutcome({ ...goal, ...target, log }, ctx, { hold, isPhaseOpen, worktrees });
  if (outcome) stdout.write(`\nBUILD OUTCOME\n  ${outcome}\n`);
  stdout.write('\nLOG\n');
  if (log.length === 0) stdout.write('  no entries yet\n');
  for (const entry of log.slice(-3)) stdout.write(renderEntry(entry));

  stdout.write('\nWORKTREES\n');
  for (const state of worktrees) {
    if (!state.worktree) { stdout.write(`  ${state.repo}  ${state.path} — no worktree\n`); continue; }
    stdout.write(`  ${state.repo}  ${state.path}  ${state.changed} changed · ${state.ahead} commits past origin/main · last commit ${state.last}\n`);
  }
  return 0;
}

/**
 * `mc goal areas <repo>|<programme>/<goal> [--at <rev>]` — a repository's rule areas, or a goal's: each area of each of
 * its repositories with the goal's stand or `no stand`, the obligations no repository declares, and a count. Reads
 * `.mc/areas.json` at `--at` (`origin/main` unless given) and writes nothing, for any role.
 */
function areasVerb(args, flags, ctx) {
  const { stderr } = ctx;
  if (args.length > 1) { stderr.write(usage()); return 2; }
  const given = args[0] ?? ctx.env.MC_GOAL;
  if (!given) { stderr.write(usage()); return 2; }
  const at = flags.at === null ? 'origin/main' : flags.at.trim();
  if (!at) { stderr.write('mc: --at needs a revision\n'); return 2; }
  return given.includes('/') ? goalAreas(given, at, ctx) : repoAreas(given, at, ctx);
}

/**
 * One area as text: `<repo>/<id> — <name>`, what it covers, its page, its standards and paths (`(missing)` when not
 * in `at`), its questions. A source area says it is one, asks no stand and has no questions.
 */
function areaBlock(repo, path, area, at, ctx, stand = undefined, proposal = null) {
  const exists = (file) => ctx.git(path, ['cat-file', '-e', `${at}:${file}`]).ok;
  const marked = (files) => files.map((file) => `${file}${exists(file) ? '' : ' (missing)'}`).join(', ');
  const lines = [`${repo}/${area.id} — ${area.name}`];
  const source = isSourceArea(area);
  if (source) lines.push('  source area: it asks no stand of a goal');
  if (stand !== undefined && (stand || !source)) lines.push(stand ? `  stand: ${stand.stand} — ${oneLine(stand.text)}${stand.standard ? ` [${stand.standard}]` : ''}` : '  no stand');
  if (stand === null && proposal && !source) lines.push(proposedWords(proposal));
  lines.push(`  covers: ${area.covers}`);
  if (area.seen === true) lines.push('  seen: work on it is judged as the user sees it — the goal review names the screenshots it judged, or says none and why');
  if (area.page) lines.push(`  page: ${marked([area.page])}`);
  lines.push(`  standards: ${area.standards.length ? marked(area.standards) : 'none'}`, `  paths: ${area.paths.length ? marked(area.paths) : 'none'}`);
  if (source) return `${lines.join('\n')}\n`;
  lines.push('  questions:');
  for (const question of area.questions) lines.push(`    when ${question.when}`, `      ask ${question.ask}`);
  return `${lines.join('\n')}\n`;
}

/** `mc goal areas <repo>`. */
function repoAreas(repo, at, ctx) {
  const { stdout, stderr } = ctx;
  const path = ctx.known().find((known) => repoNameOf(known) === repo);
  if (!path) { stderr.write(`mc: ${repo} is not a repository mc knows — ${ctx.known().map(repoNameOf).join(', ')} (a goal is <programme>/<goal>)\n`); return 2; }
  const read = readAreas(path, { git: ctx.git, at, repo });
  if (!read.ok) { stderr.write(`mc: ${read.reason}\n`); return 1; }
  if (!read.declared) { stdout.write(`${repo} declares no rule areas (no .mc/areas.json at ${at})\n`); return 0; }
  stdout.write(read.areas.map((area) => areaBlock(repo, path, area, at, ctx)).join('\n'));
  return 0;
}

/** `mc goal areas <programme>/<goal>`. */
function goalAreas(named, at, ctx) {
  const { stdout, stderr, read } = ctx;
  const target = goalNamed(named, ctx);
  if (target.error) { stderr.write(`mc: ${target.error}\n`); return 2; }
  const text = read(join(target.dir, GOAL_FILE));
  if (text === null) { stderr.write(`mc: no goal ${target.name} — ${target.dir} has no ${GOAL_FILE}\n`); return 1; }
  const goal = parseGoal(text);
  if (goal.problems) {
    stderr.write(`mc: ${target.name} does not parse:\n`);
    for (const problem of goal.problems) stderr.write(`  ${problem}\n`);
    return 1;
  }
  if (goal.version !== 2) { stderr.write(`mc: ${target.name} is a version 1 goal — it has no obligations to hold against areas (mc goal areas <repo> shows a repository's)\n`); return 2; }
  const declarations = goalDeclarations(goal, at, ctx);
  if (declarations.error) { stderr.write(`mc: ${declarations.error}\n`); return 1; }
  const obligations = goal.obligations ?? [];
  const known = new Set();
  let total = 0;
  let stood = 0;
  const sections = declarations.declared.map(({ repo, path, areas }) => {
    if (!areas.length) return `${repo} declares no rule areas (no .mc/areas.json at ${at})\n`;
    return areas.map((area) => {
      const stand = obligations.find((one) => one.area === `${repo}/${area.id}`) ?? null;
      known.add(`${repo}/${area.id}`);
      if (!isSourceArea(area)) {
        total += 1;
        if (stand) stood += 1;
      }
      return areaBlock(repo, path, area, at, ctx, stand, stand ? null : proposedStand(goal, repo, area));
    }).join('\n');
  });
  stdout.write(sections.join('\n'));
  const loose = obligations.filter((one) => !known.has(one.area));
  if (loose.length) {
    stdout.write('\nObligations whose area no repository declares:\n');
    for (const one of loose) stdout.write(`  ${one.area} — ${one.stand} — ${oneLine(one.text)}\n`);
  }
  stdout.write(`\n${stood} of ${total} areas have a stand\n`);
  return 0;
}

/**
 * `mc goal list [<programme>]` — each programme's goals under a line per
 * phase: `<programme> · phase <n> · in progress` for the phase the programme
 * is in (`currentPhase`), `… · done` for one before it, `… · after phase <m>`
 * for one after it. A programme whose record states its phases says instead,
 * by the stated rule (`phaseStanding`), `done`, `in progress` for an open phase
 * or `waiting`, each ending ` · after phase <m>[, <m>…]` where the record
 * states what the phase waits for; one whose record is invalid has the line
 * `<programme> · record invalid — no phase is open` and every unfinished phase
 * `waiting`. Under it, one line per goal: `programme/goal · repos ·
 * stage · status · criteria <met>/<all> · n sessions · outcome or Next`. A
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
    const order = programmeOrder(one, { home, read });
    const isPhaseOpen = (goal) => phaseOpen(goal, own, order);
    const standing = order.kind === 'sequential' ? null : phaseStanding(own, order);
    if (order.kind === 'invalid') stdout.write(`${one} · record invalid — no phase is open\n`);
    for (const phase of phases) {
      let state = current === null || phase < current ? 'done' : phase === current ? 'in progress' : `after phase ${phase - 1}`;
      if (standing) {
        const at = standing.phases.find((item) => item.phase === phase);
        state = at.state === 'finished' ? 'done' : at.state === 'current' ? 'in progress' : 'waiting';
        if (at.after.length) state += ` · after phase ${at.after.join(', ')}`;
      }
      stdout.write(`${one} · phase ${phase} · ${state}\n`);
      for (const goal of own.filter((item) => !item.problems.length && item.phase === phase)) {
        stdout.write(`  ${goalLine(goal, ctx, isPhaseOpen)}\n`);
      }
    }
    for (const goal of own.filter((item) => item.problems.length)) stdout.write(`  ${goal.programme}/${goal.goal} · does not parse — ${goal.problems.join('; ')}\n`);
  }
  return 0;
}

/** One goal's line in `mc goal list`. */
function goalLine(goal, ctx, isPhaseOpen) {
  const name = `${goal.programme}/${goal.goal}`;
  const hold = readHold(goal.dir, ctx.read);
  // A finished goal has no next action, whatever its last entry said.
  const next = buildOutcome(goal, ctx, { hold, isPhaseOpen }) ?? (FINISHED.includes(goal.stage) ? '—' : oneLine(goal.log.at(-1)?.next ?? '—'));
  let status = stageWords(goal);
  if (waitsOnPerson(goal)) {
    const item = readGoalDeskItem(goal, { env: ctx.env });
    status = item?.state === 'for-martin' ? `${status}, waits on a person` : `${goal.stage} · decision`;
  } else if (goal.stage === 'build' && noCriteria(goal)) {
    status += ', no criteria — not started';
  }
  const held = hold ? `, held by ${hold.by ?? '—'}` : '';
  return `${name} · ${goal.repos.join(',')} · ${status}${held} · ${criteriaWords(goal)} · ${sessions(goal.log)} sessions · ${next}`;
}

/** A registered PR does not establish the existence of a local checkout or branch. */
function retainedWork(goal, ctx, states) {
  const trees = states.filter((state) => state.worktree);
  const hasBranch = trees.some(({ path }) => {
    const head = ctx.git(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return head.ok && head.stdout.trim() !== '' && head.stdout.trim() !== 'HEAD';
  });
  const facts = hasBranch ? ['existing branch'] : trees.length ? ['existing worktree'] : [];
  if (goal.prs.length) facts.push(`registered PR: ${goal.prs.map(prRef).join(', ')}`);
  return facts.join('; ') || 'none confirmed';
}

/** The committed stage, status and hold govern the assignment, not the dispatch history. */
function buildOutcome(goal, ctx, { hold, isPhaseOpen, worktrees }) {
  if (hold) return null;
  const entries = inStage(goal.log, goal.stage);
  if (goal.stage === 'review' && entries[0]?.role === 'build') {
    const current = goal.status === 'ready' && isPhaseOpen(goal);
    return `build handed to review · ${current ? 'independent review' : 'historical handoff'}`;
  }
  if (goal.stage !== 'build') return null;
  if (goal.status === 'Martin') {
    const heldEntries = entries.slice(entries.findLastIndex((entry) => entry.status !== 'Martin') + 1);
    const stop = heldEntries.findLast((entry) => /^(?:no progress:|goal defect:|three sessions ended without a word)/u.test(entry.comment ?? ''));
    if (!stop) return null;
    const retained = retainedWork(goal, ctx, worktrees ?? worktreeStates(goal, goal.dir, ctx));
    return `build stopped — ${oneLine(stop.comment)} · technical desk · retained work: ${retained} · LOG.md`;
  }
  if (goal.status !== 'ready') return null;
  const state = { root: workRoot(ctx.env), read: ctx.read };
  const latest = buildDispatches({ ...state, programme: goal.programme, goal: goal.goal, list: ctx.listFiles }).at(-1);
  const waits = buildWaitsForMain(goal, state);
  if (!latest && !waits.length) return null;
  // Runner accounting entries have no Next. Do not look past a stage change for one.
  const next = oneLine(entries.findLast((entry) => entry.next)?.next ?? 'no bounded continuation recorded');
  const start = latest?.start === 'started' ? 'build started' : latest?.start === 'refused' ? 'build not started — provider preflight refused' : 'build start unknown — no tool boundary recorded';
  const eligibility = noCriteria(goal) ? 'build has no criteria'
    : !isPhaseOpen(goal) ? 'build phase not open'
    : waits.length ? `runner waits for main-red repair in ${waits.map(({ repo, ids }) => `${repo} (${ids.join(', ')})`).join('; ')}`
    : 'build remains eligible';
  return `${start} · ${eligibility} · Next: ${next}`;
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
 * `mc goal archive <programme>/<goal>…`, `mc goal archive <programme>` (its
 * every done or dropped goal) or `mc goal archive --all` (every programme's) —
 * a finished goal leaves the list, by `archiveGoal` (goal-archive.js), which the
 * runner also calls for every finished goal at its next pass. Each goal is
 * answered on its own, and its refusal is said with why: a goal a live runner
 * session owns is refused like any other (`ctx.active`). Exit 1 if any refused,
 * 2 for bad arguments (`--all` beside a name writes nothing).
 */
function archiveGoals(args, ctx, all = false) {
  const { stdout, stderr, home, list, read } = ctx;
  if (all && args.length) { stderr.write('mc: archive --all takes no name — mc goal archive --all, or mc goal archive <programme>[/<goal>]…\n'); return 2; }
  if (!all && args.length < 1) { stderr.write(usage()); return 2; }
  const goals = programsGoals({ home, list, read });
  let names;
  if (all) {
    names = goals.filter((goal) => FINISHED.includes(goal.stage)).map((goal) => `${goal.programme}/${goal.goal}`);
    if (!names.length) { stdout.write('mc: no done or dropped goal\n'); return 0; }
  } else if (args.length === 1 && NAME_RE.test(args[0])) {
    names = goals.filter((goal) => goal.programme === args[0] && FINISHED.includes(goal.stage)).map((goal) => `${goal.programme}/${goal.goal}`);
    if (!names.length) { stdout.write(`mc: ${args[0]} has no done or dropped goal\n`); return 0; }
  } else {
    const bad = args.filter((name) => !isGoalRef(name));
    if (bad.length) { stderr.write(`mc: ${bad.join(', ')} is not <programme>/<goal>, nor one programme alone\n`); return 2; }
    names = [...new Set(args)];
  }
  let refused = 0;
  for (const name of names) {
    const goal = goals.find((item) => `${item.programme}/${item.goal}` === name);
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

/**
 * Every done and dropped goal of every programme archived, as `mc goal archive
 * --all`: the one function the verb and the page's `c` key share. `deps` are
 * `run`'s; its lines go to `deps.stdout` and `deps.stderr`. Returns the exit code.
 */
export function archiveAllFinished(deps = {}) {
  return run(['archive', '--all'], deps);
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
 * session moves a stage backward. The interactive plan session makes any
 * forward move: it writes goals, finishes them and drops them
 * (`canon/roles/plan-session.md`). Nothing moves a goal to `finish`: a rejected
 * review returns the goal to build. A merge-only mend session sets a status and requeues a goal in `merge` with
 * `mc goal stage merge`; it moves no stage
 * (`canon/roles/mend-session.md`). A review session moves a goal in `review`
 * to `merge` (OK) or back to `build` (NOT OK; `reviewMove` holds the verdict
 * to REVIEW.md), and sets no status. A build session moves `build` to `review` or sets `blocked`,
 * nothing else; build and review may also set Martin for an actual unresolved
 * decision or reserved act.
 */
export function refusedMove({ from, to = null, status = null, env }) {
  if (to === 'finish') return 'finish is no longer a goal stage to move to — use mc goal stage build for a rejected review';
  if (env.MC_ROLE === 'desk-prepare') return 'desk-prepare cannot write goals';
  if (env.MC_ROLE === 'ask-reader') return 'an ask-reader session reads (mc goal show, list, areas) and answers with mc ask answer; it changes no goal and asks no one';
  if (env.MC_ROLE === 'programme-review') return 'a programme-review session reads and writes only PROGRAMME-REVIEW.md; it changes no goal and asks no one';
  if (['martin', 'decision'].includes(env.MC_ROLE)) {
    if (env.MC_ROLE === 'martin' && env.MC_HEADLESS === '1') return 'the Martin role is interactive-only; unattended sessions cannot use Martin authority';
    if (to === 'done') return 'Martin does not mark a goal done administratively — preserve the normal review, publish and merger handoff';
    return null;
  }
  if (env.MC_ROLE === LEARNING_ROLE) return learningRefusal('stage');
  if (!isSession(env)) return null;
  const moves = to !== null && to !== from;
  const rejects = env.MC_ROLE === REVIEW_ROLE && from === 'review' && to === 'build';
  if (moves && !rejects && backward(from, to)) return `a session does not move a goal back — ${from} → ${to}; only a person does (mc goal stage <programme>/<goal> ${to}, MC_TOOL=person)`;
  if ([PLAN_ROLE, 'plan-session'].includes(env.MC_ROLE)) return null;
  if (env.MC_ROLE === MEND_ROLE) {
    if (from !== 'merge') return `a mend session is only for merge failures, and this goal is in ${from}`;
    if (moves) return `a mend session moves no stage (${from} → ${to}): it returns merge to ready with mc goal ready, or requeues it with mc goal stage merge; a goal to move is Martin's`;
    return null;
  }
  if (status === 'Martin') {
    const expected = { 'build-session:goal': 'build', [REVIEW_ROLE]: 'review', [MEND_ROLE]: 'merge' }[env.MC_ROLE];
    if (expected && from !== expected) return `${env.MC_ROLE} cannot set Martin for a goal in ${from}`;
    if (!expected && ![PLAN_ROLE, 'plan-session'].includes(env.MC_ROLE)) return 'only build, review, mend, plan or a person sets Martin';
  }
  if (env.MC_ROLE === REVIEW_ROLE) {
    if (status !== null && status !== 'blocked' && status !== 'Martin') return 'a review sets Martin for an unrecoverable in-role obstacle, or ends with mc goal stage merge (every item OK) or mc goal stage build (a NOT OK item, with REVIEW.md)';
    if (!moves) return null;
    if (from !== 'review') return `a review moves only a goal in review, and this one is ${from}`;
    if (to !== 'merge' && to !== 'build') return `a review ends in merge or build, not ${to}`;
    return null;
  }
  if (to === 'done') return 'a session does not set done — move it to review; the merger sets done when the pull request lands';
  if (to === 'dropped') return 'only plan or a person drops a goal — set it blocked with the question';
  if (moves && !(from === 'build' && to === 'review')) return `a build session moves a goal only from build to review, not ${from} → ${to}`;
  if (status === 'ready') return 'a build session does not set a goal ready — a person does';
  return null;
}

const LEARNING_ROLE = 'learning';
function learningRefusal(verb) {
  return ['show', 'list', 'areas'].includes(verb) ? null
    : `the learning role cannot use mc goal ${verb} — use mc learning record or mc learning publish for lesson evidence`;
}

/** Whether the caller is a session: MC_GOAL or MC_ROLE set, MC_TOOL not `person`. */
function isSession(env) {
  return Boolean(env.MC_GOAL || env.MC_ROLE) && (env.MC_TOOL || 'person') !== 'person';
}

/** Whether the caller is a session (MC_GOAL set, MC_TOOL not `person`) that is not the interactive plan session's. */
function sessionNotPlan(env) {
  return isSession(env) && ![PLAN_ROLE, 'plan-session'].includes(env.MC_ROLE);
}

/**
 * Whether the caller is a headless goal session — build, review or
 * mend — which never writes the goal's acceptance: a criterion's text or check
 * is the goal's, and a change to the goal is plan's or a person's
 * (`canon/roles/mend-session.md`).
 */
function goalSessionWord(env) {
  const role = writerRole(env);
  return ['build', 'review', 'mend', 'martin', 'decision'].includes(role) ? role : null;
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
