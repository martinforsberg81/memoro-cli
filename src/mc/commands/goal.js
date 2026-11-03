/**
 * `mc goal` — a goal and its two text files and worktrees (`goals.js`).
 *
 *   mc goal new <programme>/<goal> --repo <repo>[,<repo>] --class fast|large --title "<title>" [--after <p>/<g>[,<p>/<g>]]
 *                                  GOAL.json (a skeleton), LOG.md and a worktree per repository on goal/<goal>,
 *                                  from origin/main; with --after it is `waiting` until those goals have landed
 *   mc goal set <programme>/<goal> title|goal|contract|out-of-scope --text "…"   the field replaced; a blank line parts paragraphs
 *   mc goal document add <programme>/<goal> --label "…" --path "…"   a document the goal sends its reader to
 *   mc goal criterion add <programme>/<goal> --criterion "…" --check "…"   a success criterion, not met
 *   mc goal criterion met|unmet [<programme>/<goal>] <n>   criterion <n> recorded as holding, or not
 *   mc goal convert [<programme>]       every goal still in markdown, not in .archive/, turned into GOAL.json
 *   mc goal after <programme>/<goal> [<p>/<g>…]   the goals it starts after, replaced; none given clears them
 *   mc goal log [<programme>/<goal>] [--done "…"] [--comment "…"] [--next "…"] [--status open|review|blocked|done]
 *                                  one session's entry appended to LOG.md; with --status the front matter's status is set too
 *   mc goal open|review|blocked|done [<programme>/<goal>] [--reason "…"]    mc goal log --status <s> --comment <reason>
 *                                  going open, a worktree whose branch has no commits of its own is remade from origin/main
 *   mc goal drop [<programme>/<goal>] --reason "…"   let go without landing: `dropped`, never `done`
 *   mc goal pr <programme>/<goal> <repo>#<n>…   the pull requests named carry the goal (`prs`)
 *   mc goal archive <programme>/<goal>… | <programme>   a done or dropped goal to goals/.archive/, its
 *                                  worktrees and branch gone, one row in goals/goal_log.md; the runner
 *                                  does the same 24 hours after a goal is done or dropped
 *   mc goal show <programme>/<goal>      the goal as text (`renderGoalText`), the last three entries, each worktree's state
 *   mc goal list [<programme>]           every goal, one line each
 *
 * The goal defaults to MC_GOAL's in a goal session. No verb here owns a goal:
 * the worktree is anyone's. GOAL.json is written by these verbs only, each write
 * validated (`updateGoal`); nobody edits it by hand.
 * A session never sets `done`: the merger does when the pull request lands, and
 * a person may by hand. A review session never sets `open`: plan does. Nobody
 * sets `waiting` by `--status`: a goal waits by its `after`, and the runner
 * lets it go when that has landed. A session other than plan does not set
 * `review` while a criterion is not met (`unmetGoalWords`).
 *
 * `after` is a verb of its own, not a flag on `log` or a status verb: it
 * changes GOAL.json's `after`, where those change the status, and
 * the status follows from it — waiting while anything named has not landed.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { commandUsage } from '../command-help.js';

import { writeFileAtomic } from '../atomic-write.js';
import { archiveGoal, moveDir } from '../goal-archive.js';
import { run as runGit } from '../git.js';
import { convertGoals } from '../goal-convert.js';
import { addGoalWorktree, addPr, afterCycle, afterOf, criteriaWords, FINISHED, goalDirIn, GOAL_FILE, GOALS_DIR, appendEntry, appendLog, CLASSES, isGoalRef, LOG_FILE, listDirsOf, logStamp, noCriteria, parseGoal, parseLog, parsePrRef, programsGoals, PROSE_FIELDS, prRef, readTextOrNull, remakeUnbuiltBranches, renderEntry, renderGoal, renderGoalText, PLAN_ROLE, REVIEW_ROLE, sessions, unmetGoalWords, updateGoal, waitsOnPerson, waitsOnPlan, setStatus, STATUSES } from '../goals.js';
import { NAME_RE } from '../plan-schema.js';
import { programsHome } from '../paths.js';
import { repoNameOf } from '../repos.js';
import { knownRepositories } from '../work-area.js';
import { only, scanArgs } from './flags.js';

/** Every flag any verb takes as a value. */
const VALUE_FLAGS = ['--repo', '--class', '--title', '--after', '--done', '--comment', '--next', '--status', '--reason', '--text', '--label', '--path', '--criterion', '--check'];
/** The flags each verb takes; any other given is refused with exit 2. */
const VERB_FLAGS = {
  new: ['--repo', '--class', '--title', '--after'],
  after: [],
  set: ['--text'],
  'document add': ['--label', '--path'],
  'criterion add': ['--criterion', '--check'],
  'criterion met': [],
  'criterion unmet': [],
  convert: [],
  log: ['--done', '--comment', '--next', '--status'],
  status: ['--reason'],
  pr: [],
  archive: [],
  show: [],
  list: [],
};
const STATUS_VERBS = ['open', 'review', 'blocked', 'done', 'drop'];
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
    move: deps.move || moveDir,
    appendText: deps.appendText || appendText,
    remove: deps.remove || unlinkSync,
  };
  const { flags } = scanned;

  if (verb === 'new') return newGoal(rest, flags, ctx);
  if (verb === 'after') return setAfter(rest, ctx);
  if (verb === 'set') return setField(rest, flags, ctx);
  if (verb === 'document add') return addDocument(rest, flags, ctx);
  if (verb === 'criterion add') return addCriterion(rest, flags, ctx);
  if (verb === 'criterion met' || verb === 'criterion unmet') return markCriterion(rest, verb === 'criterion met', ctx);
  if (verb === 'convert') return convert(rest, ctx);
  if (verb === 'log') return logEntry(rest, { status: flags.status, done: flags.done, comment: flags.comment, next: flags.next }, ctx);
  if (verb === 'drop' && !flags.reason) { stderr.write('mc: drop needs --reason "…" — why the goal is let go\n'); return 2; }
  if (STATUS_VERBS.includes(verb)) return logEntry(rest, { status: verb === 'drop' ? 'dropped' : verb, done: null, comment: flags.reason, next: null }, ctx);
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
 * the title and no criterion, which the runner starts no session on — and
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

  const after = afterNamed(flags.after === null ? [] : flags.after.split(','), `${programme}/${goal}`, ctx);
  if (after.error) { stderr.write(`mc: ${after.error}\n`); return 2; }

  const known = ctx.known();
  const unknown = repos.filter((repo) => !known.some((path) => repoNameOf(path) === repo));
  if (unknown.length) {
    stderr.write(`mc: ${unknown.join(', ')} is not a repository mc knows — ${known.map(repoNameOf).join(', ')}\n`);
    return 2;
  }
  if (!ctx.list(home).includes(programme)) { stderr.write(`mc: no programme ${programme} under ${home}\n`); return 1; }
  const dir = goalDirIn(home, programme, goal);
  if (ctx.list(join(home, programme, GOALS_DIR)).includes(goal)) { stderr.write(`mc: ${programme}/${goal} exists — ${dir}\n`); return 1; }

  const bares = repos.map((repo) => ({ repo, bare: known.find((path) => repoNameOf(path) === repo) }));
  for (const { repo, bare } of bares) {
    const fetched = ctx.git(bare, ['fetch', '-q', 'origin']);
    if (!fetched.ok) { stderr.write(`mc: could not fetch ${repo} — ${fetched.stderr.trim()}\n`); return 1; }
  }

  const created = stampSeconds(now);
  const status = after.pending.length ? 'waiting' : 'open';
  const comment = after.pending.length ? `waits on ${after.pending.join(', ')}` : null;
  ctx.write(join(dir, GOAL_FILE), renderGoal({ status, repos, class: flags.class, created, after: after.names, title: flags.title.trim(), success_criteria: [] }));
  ctx.write(join(dir, LOG_FILE), appendLog('', { at: logStamp(now), tool: 'person', model: null, status, done: 'created', comment, next: null }));
  stdout.write(`mc: ${programme}/${goal}${comment ? ` · waiting — ${comment}` : ''} — ${dir}\n`);

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
 * `mc goal log` and `mc goal open|review|blocked|done` — appends one entry to the
 * goal's LOG.md, tagged with MC_TOOL and MC_MODEL (`person` when neither is
 * set). With a status GOAL.json's status is set too. A goal whose GOAL.json
 * does not parse is refused, and so is `review` from a session other than plan
 * while a criterion is not met.
 */
function logEntry(args, fields, ctx) {
  const { stdout, stderr, env, read, write } = ctx;
  if (args.length > 1) { stderr.write(usage()); return 2; }
  const target = goalNamed(args[0], ctx);
  if (target.error) { stderr.write(`mc: ${target.error}\n`); return 2; }
  if (fields.status !== null && !STATUSES.includes(fields.status)) {
    stderr.write(`mc: --status is ${STATUSES.join(', ')}, not ${fields.status}\n`);
    return 2;
  }
  if ([fields.done, fields.comment, fields.next, fields.status].every((value) => value === null)) {
    stderr.write('mc: log needs --done, --comment, --next or --status\n');
    return 2;
  }
  if (fields.status === 'waiting') {
    stderr.write(`mc: a goal waits by its after, not by --status — mc goal after ${target.name} <programme>/<goal>…\n`);
    return 2;
  }
  const refused = refusedStatus(fields.status, env);
  if (refused) { stderr.write(`mc: ${refused}\n`); return 2; }
  const text = read(join(target.dir, GOAL_FILE));
  if (text === null) { stderr.write(`mc: no goal ${target.name} — ${target.dir} has no ${GOAL_FILE}\n`); return 1; }
  const goal = parseGoal(text);
  if (goal.problems) {
    for (const problem of goal.problems) stderr.write(`mc: ${target.name}: ${problem}\n`);
    return 1;
  }
  // Refused whatever the goal says now: an open goal whose after has not landed is opened by nobody.
  if (fields.status === 'open') {
    const { pending, gone } = afterOf(goal, programsGoals({ home: ctx.home, list: ctx.list, read }));
    if (pending.length || gone.length) {
      const why = [pending.length ? `waits on ${pending.join(', ')}, not landed` : null, gone.length ? `${gone.join(', ')} gone without landing` : null].filter(Boolean).join('; ');
      stderr.write(`mc: ${target.name} is not opened — it ${why}; the runner opens it when they land, or mc goal after ${target.name} changes what it waits on\n`);
      return 1;
    }
  }
  if (fields.status === 'review' && sessionNotPlan(env)) {
    const unmet = unmetGoalWords(goal, target.name);
    if (unmet) { stderr.write(`mc: ${target.name} is not set review — ${unmet}\n`); return 1; }
  }
  const status = fields.status ?? goal.status;
  const entry = {
    at: logStamp(ctx.now), tool: env.MC_TOOL || 'person', model: env.MC_MODEL || null, status,
    done: fields.done, comment: fields.comment, next: fields.next,
  };
  if (fields.status !== null) {
    const outcome = setStatus({ dir: target.dir, status, entry, read, write });
    if (outcome.problems) {
      for (const problem of outcome.problems) stderr.write(`mc: ${target.name}: ${problem}\n`);
      return 1;
    }
  } else {
    appendEntry({ dir: target.dir, entry, read, write });
  }
  stdout.write(`mc: ${target.name} · ${status}\n`);
  if (status === 'open' && goal.status !== 'open') remakeBranches(target, goal, ctx);
  return 0;
}

/** `remakeUnbuiltBranches` for a goal going open by a verb, each repository's answer on stdout. */
function remakeBranches(target, goal, { stdout, git }) {
  remakeUnbuiltBranches({ git, dir: target.dir, goal: target.goal, repos: goal.repos, say: (repo, text) => stdout.write(`  ${repo}  ${text}\n`) });
}

/**
 * The goals `names` gives as an `after` for `self`, checked against the goals
 * there are: `{ names, pending }` — each `<programme>/<goal>` once, and those
 * of them not landed — or `{ error }` for a name that is not a goal, the goal
 * itself, or a ring of goals waiting on each other.
 */
function afterNamed(names, self, ctx) {
  const given = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  const malformed = given.filter((name) => !isGoalRef(name));
  if (malformed.length) return { error: `after ${malformed.join(', ')} is not <programme>/<goal> — lower-case letters, digits and hyphens` };
  if (given.includes(self)) return { error: `${self} cannot wait on itself` };
  const goals = programsGoals({ home: ctx.home, list: ctx.list, read: ctx.read });
  const { pending, gone } = afterOf({ after: given }, goals);
  if (gone.length) return { error: `after ${gone.join(', ')} is not a goal — mc goal list names them` };
  const ring = afterCycle(self, given, goals);
  if (ring) return { error: `${ring} waits on ${self} already — goals that wait on each other never start` };
  return { names: given, pending };
}

/**
 * `mc goal after <programme>/<goal> [<p>/<g>…]` — replaces the goals it
 * starts after; none given clears them. A goal that is open, blocked or
 * waiting is `waiting` after it while any of them has not landed, and one
 * that was waiting is `open` when none is left, its branches remade as `mc
 * goal open` does. A goal in review or done does not wait, and is refused.
 * The change is logged as a person's (or session's) entry.
 */
function setAfter(args, ctx) {
  const { stdout, stderr, env, read, write } = ctx;
  if (args.length < 1) { stderr.write(usage()); return 2; }
  const [named, ...names] = args;
  if (!isGoalRef(named)) { stderr.write(`mc: ${named} is not <programme>/<goal> — lower-case letters, digits and hyphens\n`); return 2; }
  // `none` is the word the help gives for clearing: it names no goal, so it may stand alone only.
  const tokens = names.flatMap((name) => name.split(',')).map((name) => name.trim()).filter(Boolean);
  if (tokens.includes('none') && tokens.length > 1) { stderr.write(`mc: none clears after and names no goal — give none alone, or the goals it starts after\n`); return 2; }
  const target = goalNamed(named, ctx);
  const text = read(join(target.dir, GOAL_FILE));
  if (text === null) { stderr.write(`mc: no goal ${target.name} — ${target.dir} has no ${GOAL_FILE}\n`); return 1; }
  const goal = parseGoal(text);
  if (goal.problems) {
    for (const problem of goal.problems) stderr.write(`mc: ${target.name}: ${problem}\n`);
    return 1;
  }
  if (goal.status === 'review' || FINISHED.includes(goal.status)) {
    stderr.write(`mc: ${target.name} is ${goal.status} — a goal in ${goal.status} waits on nothing\n`);
    return 1;
  }
  const after = afterNamed(tokens.includes('none') ? [] : tokens, target.name, ctx);
  if (after.error) { stderr.write(`mc: ${after.error}\n`); return 2; }
  const status = after.pending.length ? 'waiting' : (goal.status === 'waiting' ? 'open' : goal.status);
  const entry = {
    at: logStamp(ctx.now), tool: env.MC_TOOL || 'person', model: env.MC_MODEL || null, status,
    done: after.names.length ? `after ${after.names.join(', ')}` : 'after cleared',
    comment: after.pending.length ? `waits on ${after.pending.join(', ')}` : null, next: null,
  };
  const outcome = setStatus({ dir: target.dir, status, after: after.names, entry, read, write });
  if (outcome.problems) {
    for (const problem of outcome.problems) stderr.write(`mc: ${target.name}: ${problem}\n`);
    return 1;
  }
  // A blocked goal stays blocked: a person or plan blocked it, and only they open it.
  const hint = status === 'blocked' && after.names.length && !after.pending.length
    ? ` — ${after.names.join(', ')} landed; it stays blocked, mc goal open ${target.name} opens it`
    : '';
  stdout.write(`mc: ${target.name} · ${status}${entry.comment ? ` — ${entry.comment}` : ''}${hint}\n`);
  if (status === 'open' && goal.status !== 'open') remakeBranches(target, goal, ctx);
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
 * GOAL.json, and the markdown removed (`goal-convert.js`). Exit 1 when one
 * could not be.
 */
function convert(args, ctx) {
  const { stdout, stderr, home, list, read, write, remove } = ctx;
  if (args.length > 1) { stderr.write(usage()); return 2; }
  const [programme = null] = args;
  if (programme !== null && !NAME_RE.test(programme)) { stderr.write(`mc: ${programme} is not a programme name\n`); return 2; }
  const answers = convertGoals({ home, programme, list, read, write, remove });
  if (!answers.length) { stdout.write('mc: nothing to convert\n'); return 0; }
  for (const answer of answers) {
    if (answer.problems) stderr.write(`mc: ${answer.name} is not converted — ${answer.problems.join('; ')}\n`);
    else stdout.write(`mc: ${answer.name} · converted, ${answer.criteria} criteria\n`);
  }
  return answers.some((answer) => answer.problems) ? 1 : 0;
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
  stdout.write(`${target.name} · ${goal.status} · ${goal.repos.join(', ')} · ${goal.class} · ${criteriaWords(goal)} · created ${goal.created ?? '—'}${goal.after.length ? ` · after ${goal.after.join(', ')}` : ''}${goal.prs.length ? ` · prs ${goal.prs.map(prRef).join(', ')}` : ''}\n`);
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
 * `mc goal list [<programme>]` — one line per goal: `programme/goal · repos ·
 * status · criteria <met>/<all> · n sessions · the last entry's Next`. An open
 * goal with no criterion reads `open, no criteria — not started`. A goal blocked by a red review,
 * a red merge or the runner reads `blocked, waits on plan` (`waitsOnPlan`), any
 * other blocked one `blocked, waits on a person`; a waiting one,
 * `waiting on <programme>/<goal>, …` — what in its `after` has not landed. A goal that does not parse is
 * listed with its first problems, not skipped.
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
  for (const goal of goals) {
    const name = `${goal.programme}/${goal.goal}`;
    if (goal.problems.length) {
      stdout.write(`${name} · does not parse — ${goal.problems.join('; ')}\n`);
      continue;
    }
    // A finished goal has no next action, whatever its last entry said.
    const next = FINISHED.includes(goal.status) ? '—' : (goal.log.at(-1)?.next ?? '—').replace(/\s*\n\s*/gu, ' ');
    const { pending } = afterOf(goal, all);
    const status = waitsOnPlan(goal) ? `${goal.status}, waits on plan`
      : waitsOnPerson(goal) ? `${goal.status}, waits on a person`
      : goal.status === 'open' && noCriteria(goal) ? 'open, no criteria — not started'
      : (goal.status === 'waiting' && pending.length ? `waiting on ${pending.join(', ')}` : goal.status);
    stdout.write(`${name} · ${goal.repos.join(',')} · ${status} · ${criteriaWords(goal)} · ${sessions(goal.log)} sessions · ${next}\n`);
  }
  return 0;
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
    const entry = { at: logStamp(ctx.now), tool: env.MC_TOOL || 'person', model: env.MC_MODEL || null, status: goal.status, done: `carries ${prRef(pr)}`, comment: null, next: null };
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
    names = all.filter((goal) => goal.programme === args[0] && FINISHED.includes(goal.status)).map((goal) => `${goal.programme}/${goal.goal}`);
    if (!names.length) { stdout.write(`mc: ${args[0]} has no done or dropped goal\n`); return 0; }
  } else {
    const bad = args.filter((name) => !isGoalRef(name));
    if (bad.length) { stderr.write(`mc: ${bad.join(', ')} is not <programme>/<goal>, nor one programme alone\n`); return 2; }
    names = [...new Set(args)];
  }
  let refused = 0;
  for (const name of names) {
    const goal = all.find((item) => `${item.programme}/${item.goal}` === name);
    const result = goal ? archiveGoal(goal, all, ctx) : { refused: 'no such goal — mc goal list names them' };
    if (result.refused) {
      refused += 1;
      stderr.write(`mc: ${name} is not archived — ${result.refused}\n`);
      continue;
    }
    stdout.write(`mc: ${name} · archived — ${result.to}\n`);
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
 * Why this caller may not set `status`, or null. A session is a caller with
 * MC_GOAL set and an MC_TOOL that is not `person`. A plan session sets every
 * status: it drives the programme toward its aim, and may finish a goal itself
 * (`canon/roles/plan-session.md`). Any other session never sets `done`, the
 * merger does when the goal's pull request lands, nor `dropped`. A review
 * session never sets `open`: a red review waits on plan.
 */
export function refusedStatus(status, env) {
  const session = Boolean(env.MC_GOAL) && (env.MC_TOOL || 'person') !== 'person';
  if (!session || env.MC_ROLE === PLAN_ROLE) return null;
  if (status === 'done') return 'a session does not set done — end in review; the merger sets done when the pull request lands';
  if (status === 'dropped') return 'only plan or a person drops a goal — end blocked with the question';
  if (status === 'open' && env.MC_ROLE === REVIEW_ROLE) return 'a review does not set open — red is blocked, and plan sets the goal open again';
  return null;
}

/** Whether the caller is a session (MC_GOAL set, MC_TOOL not `person`) that is not plan's. */
function sessionNotPlan(env) {
  return Boolean(env.MC_GOAL) && (env.MC_TOOL || 'person') !== 'person' && env.MC_ROLE !== PLAN_ROLE;
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
