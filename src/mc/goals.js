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
/** `status` is one of these; a goal starts `open`. */
export const STATUSES = ['open', 'blocked', 'done'];
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

/**
 * A GOAL.md, as `{ status, repos, class, created, title, body }`, or
 * `{ problems }` when it does not parse. `body` is everything after the front
 * matter, untouched; `title` is its first `# ` line, or null. `repos` is the
 * comma-separated list in order, the first being where a session starts.
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
  if (problems.length) return { problems };
  const title = body.match(/^# (.+)$/mu)?.[1].trim() ?? null;
  return { status: fields.status, repos, class: fields.class, created: fields.created || null, title, body };
}

/** GOAL.md's text for a goal of the shape `parseGoal` gives. The body is written as it is. */
export function renderGoal({ status, repos, class: cls, created, body }) {
  const front = [`status: ${status}`, `repos: ${repos.join(', ')}`, `class: ${cls}`];
  if (created) front.push(`created: ${created}`);
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
 * `{ programme, goal, dir, status, repos, class, created, title, log, problems }`.
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
        goals.push({ ...base, status: null, repos: [], class: null, created: null, title: null, problems: parsed.problems });
      } else {
        goals.push({ ...base, status: parsed.status, repos: parsed.repos, class: parsed.class, created: parsed.created, title: parsed.title, problems: [] });
      }
    }
  }
  return goals;
}

/** A goal's name where a runner names sessions: `goal:<programme>/<goal>`, in its current file and its runs.tsv row. */
export function goalName({ programme, goal }) {
  return `goal:${programme}/${goal}`;
}

/**
 * The goal a lane of `repos` takes next, or null: of the open goals that parse,
 * whose first repository is one of `repos` and whose name is not in `held`, the
 * one whose last log entry is oldest, so goals share sessions fairly. A goal
 * with no entry is oldest of all, and a tie goes to the first listed. A log
 * stamp is a fixed-width UTC minute, so stamps compare as strings.
 */
export function nextGoal(goals, { repos = [], held = new Set() } = {}) {
  const lastAt = (goal) => goal.log.at(-1)?.at ?? '';
  const eligible = goals.filter((goal) => goal.status === 'open' && goal.problems.length === 0
    && repos.includes(goal.repos[0]) && !held.has(goalName(goal)));
  return eligible.reduce((oldest, goal) => (oldest === null || lastAt(goal) < lastAt(oldest) ? goal : oldest), null);
}

/**
 * A worktree of the repository at `bare` at `path`, on `goal/<goal>`: from
 * origin/main, or on that branch as it is when it already exists. Gives git's
 * answer with `branch` and `existed` beside it. `mc goal new` makes a goal's
 * worktrees this way, and the runner makes one a goal has lost.
 */
export function addGoalWorktree({ git, bare, path, goal }) {
  const branch = `goal/${goal}`;
  const existed = git(bare, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
  const added = git(bare, existed
    ? ['worktree', 'add', '-q', path, branch]
    : ['worktree', 'add', '-q', '-b', branch, path, 'origin/main']);
  return { ...added, branch, existed };
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
 * Sets the goal's status in its GOAL.md front matter and appends `entry` to its
 * LOG.md: the two writes that make a status change. Nothing is written when the
 * GOAL.md does not parse, or the status is not one of `STATUSES`; it returns
 * `{ problems }` then, and `{ goal }` with the goal as it now is otherwise.
 */
export function setStatus({ dir, status, entry, read = readTextOrNull, write = writeFileAtomic }) {
  if (!STATUSES.includes(status)) return { problems: [`status is ${STATUSES.join(', ')}, not ${status}`] };
  const path = join(dir, GOAL_FILE);
  const parsed = parseGoal(read(path) ?? '');
  if (parsed.problems) return { problems: parsed.problems };
  const goal = { ...parsed, status };
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
