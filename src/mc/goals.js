/**
 * `goals.js` — a goal: two text files and a worktree under its programme.
 *
 *   ~/mc/programs/<programme>/goals/<goal>/GOAL.md     the brief: front matter, then markdown
 *   ~/mc/programs/<programme>/goals/<goal>/LOG.md      one heading per session, newest last
 *   ~/mc/programs/<programme>/goals/<goal>/<repo>/     a worktree on goal/<goal>, from origin/main
 *
 * mc keeps nothing else for a goal. Only the front matter's `status` is ever
 * written by a verb, and the Markdown body is never rewritten here. A
 * `GOAL.md` that does not parse is reported with its problems, never skipped.
 *
 * The readers take `list` and `read` as arguments, so the tests use a file
 * model; `programsPlans` in `plan-source.js` works the same way. It skips a
 * programme's `goals/` directory on its own: no `PLAN.json` sits directly
 * under it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from './atomic-write.js';
import { programsHome } from './paths.js';
import { NAME_RE } from './plan-schema.js';

export const GOAL_FILE = 'GOAL.md';
export const LOG_FILE = 'LOG.md';
/** The directory under a programme that holds its goals. */
export const GOALS_DIR = 'goals';
/**
 * `status` is one of these; a goal starts `open`, or `waiting` when it names
 * goals in `after` that have not landed. A build session ends a goal it holds
 * met in `review`; the review session sets `blocked` on red; the merger sets
 * `done` when the pull request lands. Only a person sets `done` by hand, and
 * only plan sets a blocked goal `open` again. `waiting` is the runner's to
 * release (`waitingMoves`): no session is started on it and nothing wakes plan.
 */
export const STATUSES = ['open', 'review', 'blocked', 'done', 'waiting'];
/** The role a goal's review session runs with: `canon/roles/goal-review.md`. */
export const REVIEW_ROLE = 'goal-review';
/** `class` is the work class a goal's session runs on (ruling 59), as a step's is. */
export const CLASSES = ['fast', 'large'];

/** The labelled lines a log entry may carry, and the field each one names. */
const LABEL_FIELD = { Gjort: 'done', Kommentar: 'comment', 'Nästa': 'next' };
const LABEL = /^(Gjort|Kommentar|Nästa): ?(.*)$/u;
const HEADING = /^## (\S+) · (\S+)(?: (\S+))? · (\S+)$/u;
const FRONT = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/u;

/** The goals home of one programme: `<programsHome>/<programme>/goals`. */
export function goalsHome(programme, env = process.env) {
  return join(programsHome(env), programme, GOALS_DIR);
}

/** The directory of one goal, in a programmes home given by `home`. */
export function goalDirIn(home, programme, goal) {
  return join(home, programme, GOALS_DIR, goal);
}

/** The directory of one goal, under `programsHome(env)`. */
export function goalDir(programme, goal, env = process.env) {
  return goalDirIn(programsHome(env), programme, goal);
}

/** `<programme>/<goal>`: how `after` names a goal. */
export function isGoalRef(name) {
  const parts = String(name).split('/');
  return parts.length === 2 && NAME_RE.test(parts[0]) && NAME_RE.test(parts[1]);
}

/**
 * A GOAL.md, as `{ status, repos, class, created, after, title, body }`, or
 * `{ problems }` when it does not parse. `body` is everything after the front
 * matter, untouched; `title` is its first `# ` line, or null. `repos` is the
 * comma-separated list in order, the first being where a session starts.
 * `after` is the goals this one starts after, as `<programme>/<goal>`, none
 * when the line is absent.
 */
export function parseGoal(text) {
  const match = String(text ?? '').match(FRONT);
  if (!match) return { problems: ['GOAL.md has no front matter between --- lines'] };
  const fields = {};
  for (const line of match[1].split('\n')) {
    const field = line.match(/^([a-z]+):\s*(.*)$/u);
    if (field) fields[field[1]] = field[2].trim();
  }
  const body = text.slice(match[0].length);
  const repos = (fields.repos ?? '').split(',').map((repo) => repo.trim()).filter(Boolean);
  const problems = [];
  if (!STATUSES.includes(fields.status)) problems.push(`status is ${STATUSES.join(', ')}, not ${fields.status ?? 'missing'}`);
  if (!CLASSES.includes(fields.class)) problems.push(`class is ${CLASSES.join(' or ')}, not ${fields.class ?? 'missing'}`);
  if (repos.length === 0) problems.push('repos names no repository');
  for (const repo of repos) if (!NAME_RE.test(repo)) problems.push(`repo ${repo} is not a repository name — lower-case letters, digits and hyphens`);
  const after = [...new Set((fields.after ?? '').split(',').map((name) => name.trim()).filter(Boolean))];
  for (const name of after) if (!isGoalRef(name)) problems.push(`after ${name} is not <programme>/<goal>`);
  if (problems.length) return { problems };
  const title = body.match(/^# (.+)$/mu)?.[1].trim() ?? null;
  return { status: fields.status, repos, class: fields.class, created: fields.created || null, after, title, body };
}

/** GOAL.md's text for a goal of the shape `parseGoal` gives. The body is written as it is; no `after`, no line. */
export function renderGoal({ status, repos, class: cls, created, after = [], body }) {
  const front = [`status: ${status}`, `repos: ${repos.join(', ')}`, `class: ${cls}`];
  if (created) front.push(`created: ${created}`);
  if (after.length) front.push(`after: ${after.join(', ')}`);
  return `---\n${front.join('\n')}\n---\n${body}`;
}

/**
 * LOG.md's entries, in order: `[{ at, tool, model, status, done, comment, next }]`.
 * A heading that is not one (`## <at> · <tool> [<model>] · <status>`) is
 * skipped with its lines. A labelled line runs on until the next label or
 * heading, so a field may take several paragraphs. Absent fields are null.
 */
export function parseLog(text) {
  const blocks = [];
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('## ')) blocks.push({ head: line, lines: [] });
    else if (blocks.length) blocks.at(-1).lines.push(line);
  }
  return blocks.flatMap((block) => {
    const heading = block.head.match(HEADING);
    if (!heading) return [];
    const fields = { done: [], comment: [], next: [] };
    let field = null;
    for (const line of block.lines) {
      const label = line.match(LABEL);
      if (label) {
        field = LABEL_FIELD[label[1]];
        fields[field].push(label[2]);
      } else if (field) {
        fields[field].push(line);
      }
    }
    const value = (key) => {
      const joined = fields[key].join('\n').trim();
      return joined === '' ? null : joined;
    };
    return [{
      at: heading[1], tool: heading[2], model: heading[3] ?? null, status: heading[4],
      done: value('done'), comment: value('comment'), next: value('next'),
    }];
  });
}

/** One log entry as LOG.md writes it: its heading, then the labelled lines that are set. */
export function renderEntry(entry) {
  const who = [entry.tool, entry.model].filter(Boolean).join(' ');
  const lines = [`## ${entry.at} · ${who} · ${entry.status}`, ''];
  if (entry.done) lines.push(`Gjort: ${entry.done}`);
  if (entry.comment) lines.push(`Kommentar: ${entry.comment}`);
  if (entry.next) lines.push(`Nästa: ${entry.next}`);
  return `${lines.join('\n')}\n`;
}

/** LOG.md's text with `entry` appended, newest last. `text` is the file as it is, or '' for none. */
export function appendLog(text, entry) {
  const head = String(text ?? '').replace(/\s+$/u, '');
  return `${head ? `${head}\n\n` : ''}${renderEntry(entry)}`;
}

/** The sessions a log holds: every entry but the runner's and a person's. */
export function sessions(log) {
  return log.filter((entry) => entry.tool !== 'runner' && entry.tool !== 'person').length;
}

/**
 * Every goal under every programme, in listing order, each as
 * `{ programme, goal, dir, status, repos, class, created, after, title, log, problems }`.
 * A goal whose GOAL.md does not parse is listed with `problems` and no status.
 * A directory without a GOAL.md is not a goal and is skipped.
 */
export function programsGoals({ home = programsHome(), list = listDirsOf, read = readTextOrNull } = {}) {
  const goals = [];
  for (const programme of list(home)) {
    const goalsDir = join(home, programme, GOALS_DIR);
    for (const goal of list(goalsDir)) {
      const dir = join(goalsDir, goal);
      const text = read(join(dir, GOAL_FILE));
      if (text === null) continue;
      const log = parseLog(read(join(dir, LOG_FILE)) ?? '');
      const parsed = parseGoal(text);
      const base = { programme, goal, dir, log };
      if (parsed.problems) {
        goals.push({ ...base, status: null, repos: [], class: null, created: null, after: [], title: null, problems: parsed.problems });
      } else {
        goals.push({ ...base, status: parsed.status, repos: parsed.repos, class: parsed.class, created: parsed.created, after: parsed.after, title: parsed.title, problems: [] });
      }
    }
  }
  return goals;
}

/**
 * A review's verdict, from its entry's `Gjort:` line — `green <sha>` or
 * `red <sha>`, the head the review read — as `{ verdict, sha }`, or null for an
 * entry that is no verdict.
 */
export function verdictOf(entry) {
  const [first] = String(entry?.done ?? '').split('\n');
  const match = first.match(/^(green|red)\b.*?\b([0-9a-f]{7,40})\b/u);
  return match ? { verdict: match[1], sha: match[2] } : null;
}

/** The runner's entry for a green review it queued: `Gjort: queued #<pr> at <sha> for the merger`. */
export function queuedText(pr, sha) {
  return `queued #${pr} at ${sha} for the merger`;
}

/** `{ pr, sha }` of the runner's queued entry (`queuedText`), or null. */
export function queuedOf(entry) {
  if (entry?.tool !== 'runner') return null;
  const match = String(entry.done ?? '').match(/^queued #(\d+) at ([0-9a-f]+) for the merger/u);
  return match ? { pr: Number(match[1]), sha: match[2] } : null;
}

/**
 * The last entry a build session wrote: neither the runner's nor a person's,
 * and no review's verdict. Its heading's `<tool> <model>` is the model a review
 * of the goal may not run on. Null when no build session has written one.
 */
export function lastBuildEntry(log) {
  return log.findLast((entry) => entry.tool !== 'runner' && entry.tool !== 'person' && !verdictOf(entry)) ?? null;
}

/**
 * Whether a goal waits for a review session: it is in `review`, and the last
 * entry is not the runner's for a green it has queued — that one waits for the
 * merger, which writes the next entry.
 */
export function reviewDue(goal) {
  return goal.status === 'review' && !queuedOf(goal.log.at(-1));
}

/** The runner's entry for a red merge (`merger.js`): `Gjort: merger answered red on #<pr>`. */
export function redMergeText(pr) {
  return `merger answered red on #${pr}`;
}

/** The runner's entry for a goal whose `after` goal is gone without landing: its `Kommentar:`. */
export function afterGoneText(names) {
  return `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} gone without landing — waits on plan to change after`;
}

/**
 * Whether a blocked goal waits on plan: blocked by a red review (its last entry
 * is a `red` verdict), by a red merge (the runner's `redMergeText` entry), or
 * by an `after` goal gone without landing (`afterGoneText`). Nothing goes back
 * to a build session from there until plan sets it open.
 */
export function waitsOnPlan(goal) {
  if (goal.status !== 'blocked') return false;
  const last = goal.log.at(-1);
  return verdictOf(last)?.verdict === 'red'
    || (last?.tool === 'runner' && String(last.done ?? '').startsWith('merger answered red'))
    || (last?.tool === 'runner' && / gone without landing — waits on plan/u.test(String(last.comment ?? '')));
}

/**
 * Where a goal's `after` stands, against `goals` (`programsGoals`' answer):
 * `{ landed, pending, gone }`, each a list of `<programme>/<goal>`. Landed is
 * `done`; gone is no goal there any more — its directory or GOAL.md removed,
 * which is how a goal is discarded or archived; pending is everything else,
 * a `blocked` or unparsable one included: it may still land.
 */
export function afterOf(goal, goals) {
  const byName = new Map(goals.map((other) => [`${other.programme}/${other.goal}`, other]));
  const landed = [];
  const pending = [];
  const gone = [];
  for (const name of goal.after ?? []) {
    const other = byName.get(name);
    if (!other) gone.push(name);
    else if (other.status === 'done') landed.push(name);
    else pending.push(name);
  }
  return { landed, pending, gone };
}

/**
 * The status changes the runner makes for goals' `after`, as
 * `[{ goal, status, done, comment }]`: a `waiting` goal whose `after` has all
 * landed goes `open`, with what landed in `done`; one with an `after` goal
 * gone goes `blocked` for plan (`afterGoneText`); an `open` goal with an
 * `after` not landed goes `waiting`. A goal in review, blocked or done is not
 * moved: a person or plan put it there.
 */
export function waitingMoves(goals) {
  const moves = [];
  for (const goal of goals) {
    if (goal.problems.length || (goal.status !== 'waiting' && goal.status !== 'open')) continue;
    const { landed, pending, gone } = afterOf(goal, goals);
    if (gone.length) {
      moves.push({ goal, status: 'blocked', done: null, comment: afterGoneText(gone) });
    } else if (pending.length) {
      if (goal.status === 'open') moves.push({ goal, status: 'waiting', done: null, comment: `waits on ${pending.join(', ')}` });
    } else if (goal.status === 'waiting') {
      moves.push({ goal, status: 'open', done: landed.length ? `${landed.join(', ')} landed — starting` : 'waits on nothing — starting', comment: null });
    }
  }
  return moves;
}

/**
 * Whether naming `after` for `name` would make goals wait on each other in a
 * ring: the first goal of `after` from which `name` is reached again through
 * the goals' own `after`, or null.
 */
export function afterCycle(name, after, goals) {
  const afterBy = new Map(goals.map((other) => [`${other.programme}/${other.goal}`, other.after ?? []]));
  afterBy.set(name, after);
  for (const first of after) {
    const seen = new Set();
    const stack = [first];
    while (stack.length) {
      const at = stack.pop();
      if (at === name) return first;
      if (seen.has(at)) continue;
      seen.add(at);
      stack.push(...(afterBy.get(at) ?? []));
    }
  }
  return null;
}

/** A goal's name where a runner names sessions: `goal:<programme>/<goal>`, in its current file and its runs.tsv row. */
export function goalName({ programme, goal }) {
  return `goal:${programme}/${goal}`;
}

/**
 * The goal a lane of `repos` takes next, or null: of the goals that parse and
 * are open or due a review (`reviewDue`), whose first repository is one of
 * `repos`, whose name is not in `held` and that `may` allows, the one whose
 * last log entry is oldest, so goals share sessions fairly. A goal with no
 * entry is oldest of all, and a tie goes to the first listed. A log stamp is a
 * fixed-width UTC minute, so stamps compare as strings. `may` is how the runner
 * leaves out a review that cannot run now, so it does not stand in front of
 * every other goal.
 */
export function nextGoal(goals, { repos = [], held = new Set(), may = () => true } = {}) {
  const lastAt = (goal) => goal.log.at(-1)?.at ?? '';
  const eligible = goals.filter((goal) => (goal.status === 'open' || reviewDue(goal)) && goal.problems.length === 0
    && repos.includes(goal.repos[0]) && !held.has(goalName(goal)) && may(goal));
  return eligible.reduce((oldest, goal) => (oldest === null || lastAt(goal) < lastAt(oldest) ? goal : oldest), null);
}

/**
 * A worktree of the repository at `bare` at `path`, on `goal/<goal>`: from
 * origin/main, or on that branch as it is when it already exists. Gives git's
 * answer with `branch` and `existed` beside it. `mc goal new` makes a goal's
 * worktrees this way, and the runner makes one a goal has lost. A directory
 * deleted by hand stays registered with git, which then refuses to add its
 * branch anywhere, so an existing branch is added after a prune.
 */
export function addGoalWorktree({ git, bare, path, goal }) {
  const branch = `goal/${goal}`;
  const existed = git(bare, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
  if (existed) git(bare, ['worktree', 'prune']);
  const added = git(bare, existed
    ? ['worktree', 'add', '-q', path, branch]
    : ['worktree', 'add', '-q', '-b', branch, path, 'origin/main']);
  return { ...added, branch, existed };
}

/**
 * A goal's branch is made when the goal can start. A goal that waited got its
 * branch at `mc goal new`, before what it waits for landed; when it goes
 * `open`, each worktree whose branch has no commits of its own — nothing past
 * `origin/main` — is moved to `origin/main` as it is now, which is that branch
 * made again. A branch with commits is never moved, nor one under uncommitted
 * changes `git reset --keep` will not carry. `say(repo, text)` is told what
 * happened per repository; nothing here fails.
 */
export function remakeUnbuiltBranches({ git, dir, goal, repos, say }) {
  for (const repo of repos) {
    const path = join(dir, repo);
    const tell = (text) => say(repo, `goal/${goal} ${text}`);
    const fetched = git(path, ['fetch', '-q', 'origin']);
    if (!fetched.ok) { tell(`left as it is — could not fetch (${fetched.stderr.trim() || 'git failed'})`); continue; }
    const own = git(path, ['rev-list', '--count', 'origin/main..HEAD']);
    if (!own.ok) { tell(`left as it is — no worktree at ${path}`); continue; }
    const count = Number(own.stdout.trim());
    if (count > 0) { tell(`left as it is — ${count} commit${count === 1 ? '' : 's'} of its own`); continue; }
    const behind = Number(git(path, ['rev-list', '--count', 'HEAD..origin/main']).stdout.trim());
    if (!behind) { tell('is origin/main already'); continue; }
    const moved = git(path, ['reset', '-q', '--keep', 'origin/main']);
    tell(moved.ok
      ? `remade from origin/main — it had no commits of its own, and main has ${behind} more`
      : `left as it is — ${moved.stderr.trim() || 'git reset --keep refused'}`);
  }
}

/** `2026-11-01T21:30Z`: the minute a log entry is stamped with. */
export function logStamp(date) {
  return date.toISOString().replace(/:\d{2}\.\d{3}Z$/u, 'Z');
}

/** Appends `entry` to the goal's LOG.md in `dir`. */
export function appendEntry({ dir, entry, read = readTextOrNull, write = writeFileAtomic }) {
  const path = join(dir, LOG_FILE);
  write(path, appendLog(read(path) ?? '', entry));
}

/**
 * Sets the goal's status in its GOAL.md front matter — and its `after`, when
 * one is given — and appends `entry` to its LOG.md: the two writes that make a
 * status change. Nothing is written when the GOAL.md does not parse, or the
 * status is not one of `STATUSES`; it returns `{ problems }` then, and
 * `{ goal }` with the goal as it now is otherwise.
 */
export function setStatus({ dir, status, after = null, entry, read = readTextOrNull, write = writeFileAtomic }) {
  if (!STATUSES.includes(status)) return { problems: [`status is ${STATUSES.join(', ')}, not ${status}`] };
  const path = join(dir, GOAL_FILE);
  const parsed = parseGoal(read(path) ?? '');
  if (parsed.problems) return { problems: parsed.problems };
  const goal = { ...parsed, status, ...(after ? { after } : {}) };
  write(path, renderGoal(goal));
  appendEntry({ dir, entry, read, write });
  return { goal };
}

/** A file's text, or null when it cannot be read. */
export function readTextOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** The names of the directories in `path`, sorted, dot-directories left out; none when it cannot be read. */
export function listDirsOf(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}
