/**
 * `mc goal` — a goal and its two text files and worktrees (`goals.js`).
 *
 *   mc goal new <programme>/<goal> --repo <repo>[,<repo>] --class fast|large --title "<title>"
 *                                  GOAL.md, LOG.md and a worktree per repository on goal/<goal>, from origin/main
 *   mc goal log [<programme>/<goal>] [--done "…"] [--comment "…"] [--next "…"] [--status open|blocked|done]
 *                                  one session's entry appended to LOG.md; with --status the front matter's status is set too
 *   mc goal open|blocked|done [<programme>/<goal>] [--reason "…"]    mc goal log --status <s> --comment <reason>
 *   mc goal show <programme>/<goal>      the front matter, the body, the last three entries, each worktree's state
 *   mc goal list [<programme>]           every goal, one line each
 *
 * The goal defaults to MC_GOAL's in a goal session. No verb here owns a goal:
 * the worktree is anyone's, and mc writes the status line and the log, nothing else.
 */
import { join } from 'node:path';

import { writeFileAtomic } from '../atomic-write.js';
import { run as runGit } from '../git.js';
import { addGoalWorktree, goalDirIn, GOAL_FILE, GOALS_DIR, appendEntry, appendLog, CLASSES, LOG_FILE, listDirsOf, logStamp, parseGoal, parseLog, programsGoals, readTextOrNull, renderEntry, renderGoal, sessions, setStatus, STATUSES } from '../goals.js';
import { NAME_RE } from '../plan-schema.js';
import { programsHome } from '../paths.js';
import { repoNameOf } from '../repos.js';
import { knownRepositories } from '../work-area.js';
import { scanArgs } from './flags.js';

/** Every flag any verb takes as a value. */
const VALUE_FLAGS = ['--repo', '--class', '--title', '--done', '--comment', '--next', '--status', '--reason'];
/** The flags each verb takes; any other given is refused with exit 2. */
const VERB_FLAGS = {
  new: ['--repo', '--class', '--title'],
  log: ['--done', '--comment', '--next', '--status'],
  status: ['--reason'],
  show: [],
  list: [],
};
const STATUS_VERBS = ['open', 'blocked', 'done'];

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const scanned = scanArgs(argv, { strictValues: VALUE_FLAGS });
  if (scanned.error) { stderr.write(`mc: ${scanned.error}\n${usage()}`); return 2; }
  const [verb, ...rest] = scanned.positional;

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
  };
  const { flags } = scanned;

  if (verb === 'new') return newGoal(rest, flags, ctx);
  if (verb === 'log') return logEntry(rest, { status: flags.status, done: flags.done, comment: flags.comment, next: flags.next }, ctx);
  if (STATUS_VERBS.includes(verb)) return logEntry(rest, { status: verb, done: null, comment: flags.reason, next: null }, ctx);
  if (verb === 'show') return showGoal(rest, ctx);
  return listGoals(rest, ctx);
}

/**
 * `mc goal new <programme>/<goal>` — makes a goal. The programme must be a
 * directory under the programmes home, the goal must not exist, and every
 * repository named must be one mc knows. Each repository is fetched first, so
 * a fetch that fails leaves nothing behind; then GOAL.md and LOG.md are
 * written, and a worktree of each repository on `goal/<goal>`, from
 * origin/main, or on that branch as it is when it already exists.
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
  const body = `# ${flags.title}\n\n## Goal\n\n## Criteria\n\n## Out of scope\n`;
  ctx.write(join(dir, GOAL_FILE), renderGoal({ status: 'open', repos, class: flags.class, created, body }));
  ctx.write(join(dir, LOG_FILE), appendLog('', { at: logStamp(now), tool: 'person', model: null, status: 'open', done: 'skapat', comment: null, next: null }));
  stdout.write(`mc: ${programme}/${goal} — ${dir}\n`);

  for (const { repo, bare } of bares) {
    const path = join(dir, repo);
    const added = addGoalWorktree({ git: ctx.git, bare, path, goal });
    if (!added.ok) {
      stderr.write(`mc: ${repo}'s worktree is not made — ${added.stderr.trim()}; the goal's files stand in ${dir}\n`);
      return 1;
    }
    stdout.write(`  ${repo}  ${path}  ${added.existed ? `${added.branch}, as it was` : `${added.branch} from origin/main`}\n`);
  }
  stdout.write(`GOAL.md is to be filled in: ${join(dir, GOAL_FILE)}\n`);
  return 0;
}

/**
 * `mc goal log` and `mc goal open|blocked|done` — appends one entry to the
 * goal's LOG.md, tagged with MC_TOOL and MC_MODEL (`person` when neither is
 * set). With a status the front matter is rewritten too. A goal whose GOAL.md
 * does not parse is refused.
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
  const text = read(join(target.dir, GOAL_FILE));
  if (text === null) { stderr.write(`mc: no goal ${target.name} — ${target.dir} has no ${GOAL_FILE}\n`); return 1; }
  const goal = parseGoal(text);
  if (goal.problems) {
    for (const problem of goal.problems) stderr.write(`mc: ${target.name}: ${problem}\n`);
    return 1;
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
  return 0;
}

/**
 * `mc goal show <programme>/<goal>` — the front matter as one line, the body,
 * the last three log entries, and for each repository's worktree its changed
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
  stdout.write(`${target.name} · ${goal.status} · ${goal.repos.join(', ')} · ${goal.class} · created ${goal.created ?? '—'}\n`);
  const body = goal.body.trim();
  if (body) stdout.write(`\n${body}\n`);

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
 * status · n sessions · the last entry's Nästa`. A goal that does not parse is
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
  const goals = programsGoals({ home, list, read }).filter((goal) => programme === undefined || goal.programme === programme);
  if (goals.length === 0) { stdout.write('mc: no goals\n'); return 0; }
  for (const goal of goals) {
    const name = `${goal.programme}/${goal.goal}`;
    if (goal.problems.length) {
      stdout.write(`${name} · does not parse — ${goal.problems.join('; ')}\n`);
      continue;
    }
    const next = (goal.log.at(-1)?.next ?? '—').replace(/\s*\n\s*/gu, ' ');
    stdout.write(`${name} · ${goal.repos.join(',')} · ${goal.status} · ${sessions(goal.log)} sessions · ${next}\n`);
  }
  return 0;
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
  return [
    'usage — mc goal new <programme>/<goal> --repo <repo>[,<repo>] --class fast|large --title "<title>"   a goal: GOAL.md, LOG.md, and a worktree per repository on goal/<goal>, from origin/main\n',
    '        mc goal log [<programme>/<goal>] [--done "…"] [--comment "…"] [--next "…"] [--status open|blocked|done]   append a session\'s entry to LOG.md; the goal is MC_GOAL\'s when none is named\n',
    '        mc goal open|blocked|done [<programme>/<goal>] [--reason "…"]   set the goal\'s status, and log the reason\n',
    '        mc goal show <programme>/<goal>   the goal, its last three log entries, and each worktree\'s state\n',
    '        mc goal list [<programme>]   every goal, one line each\n',
  ].join('');
}
