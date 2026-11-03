/**
 * `goals.js` — a goal: two files and a worktree under its programme.
 *
 *   ~/mc/programs/<programme>/goals/<goal>/GOAL.json   the brief, as data (`validateGoal`)
 *   ~/mc/programs/<programme>/goals/<goal>/LOG.md      one heading per session, newest last
 *   ~/mc/programs/<programme>/goals/<goal>/<repo>/     a worktree on goal/<goal>, from origin/main
 *
 * mc keeps nothing else for a goal. GOAL.json is written only by verbs (`mc
 * goal new`, `set`, `document add`, `criterion add|met|unmet`, the status
 * verbs), each write validated: an invalid GOAL.json is never written. One
 * that does not parse is reported with its problems, never skipped.
 *
 * The readers take `list` and `read` as arguments, so the tests use a file
 * model; `programsPlans` in `plan-source.js` works the same way. It skips a
 * programme's `goals/` directory on its own: no `PLAN.json` sits directly
 * under it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { writeFileAtomic } from './atomic-write.js';
import { samePr } from './merge-queue.js';
import { programsHome } from './paths.js';
import { criteriaCount, plain, prose, text, unknownKeys, unmetCriteria, validateCriteria, validateDocuments } from './criteria.js';
import { NAME_RE } from './plan-schema.js';

export const GOAL_FILE = 'GOAL.json';
export const GOAL_SCHEMA = 'mc-goal';
export const GOAL_VERSION = 1;
export const LOG_FILE = 'LOG.md';
/** The directory under a programme that holds its goals. */
export const GOALS_DIR = 'goals';
/**
 * `status` is one of these; a goal starts `open`, or `waiting` when it names
 * goals in `after` that have not landed. A build session ends a goal it holds
 * met in `review`; the review session sets `blocked` on red; the merger or the
 * runner sets `done` when every pull request the goal carries (`prs`) has
 * landed. A person or a plan session sets any status by hand; a build or
 * review session never sets `done` or `dropped`, and a review never `open`. `waiting` is the runner's to release (`waitingMoves`): no
 * session is started on it and nothing wakes plan. `dropped` is a goal let go
 * without landing — a person's or plan's word, never done: a goal that starts
 * after it does not start (`afterOf` reads it as gone).
 */
export const STATUSES = ['open', 'review', 'blocked', 'done', 'waiting', 'dropped'];
/** The statuses a goal ends in; only a goal in one of them is archived. */
export const FINISHED = ['done', 'dropped'];
/** Where an archived goal goes, under its programme's `goals/`: a dot-directory, so `listDirsOf` leaves it out. */
export const ARCHIVE_DIR = '.archive';
/** The file under a programme's `goals/` with one row per archived goal. */
export const GOAL_LOG_FILE = 'goal_log.md';
/** The role a goal's review session runs with: `canon/roles/review-session.md`, its `goal` part. */
export const REVIEW_ROLE = 'review-session:goal';
/** `class` is the work class a goal's session runs on (ruling 59), as a step's is. */
export const CLASSES = ['fast', 'large'];

/**
 * The labelled lines a log entry may carry, and the field each one names. An
 * entry is written `Done:`, `Comment:` and `Next:`; the Swedish labels logs
 * were written with before 2026-11-03 are still read, so no log is rewritten.
 */
const LABEL_FIELD = { Done: 'done', Comment: 'comment', Next: 'next', Gjort: 'done', Kommentar: 'comment', 'Nästa': 'next' };
const LABEL = /^(Done|Comment|Next|Gjort|Kommentar|Nästa): ?(.*)$/u;
const HEADING = /^## (\S+) · (\S+)(?: (\S+))? · (\S+)$/u;

/** GOAL.json's keys, in the order it is written. */
export const GOAL_KEYS = Object.freeze([
  'schema', 'version', 'status', 'repos', 'class', 'created', 'after', 'prs',
  'title', 'goal', 'contract', 'out_of_scope', 'success_criteria', 'documents',
]);
/** The prose fields `mc goal set` writes, by the word it takes for each. */
export const PROSE_FIELDS = Object.freeze({ goal: 'goal', contract: 'contract', 'out-of-scope': 'out_of_scope' });

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

/** `<repo>#<n>`: how a goal's front matter names one of its pull requests. */
export function prRef({ repo, pr }) {
  return `${repo}#${pr}`;
}

const PR_REF = /^([a-z0-9][a-z0-9-]*)#(\d+)$/u;

/** `{ repo, pr }` of `<repo>#<n>`, or null. */
export function parsePrRef(text) {
  const match = String(text ?? '').trim().replace(/^#/u, '').match(PR_REF);
  return match ? { repo: match[1], pr: Number(match[2]) } : null;
}

/**
 * What is wrong with a GOAL.json's value, field by field — everything, not the
 * first thing. `success_criteria` takes at least one criterion, each with a
 * `check`, as PLAN.json's does (`criteria.js`); `draft` lets a goal that has no
 * criterion yet through — `mc goal new`'s skeleton, filled by `mc goal
 * criterion add` — and nothing else. A goal with none is not started by the
 * runner (`nextGoal`) and cannot go to review.
 */
export function validateGoal(value, { draft = false } = {}) {
  if (!plain(value)) return ['GOAL.json must be a JSON object'];
  const problems = [];
  for (const key of unknownKeys(value, GOAL_KEYS)) problems.push(`${key}: unknown key`);
  if (value.schema !== GOAL_SCHEMA) problems.push(`schema: must be "${GOAL_SCHEMA}"`);
  if (value.version !== GOAL_VERSION) problems.push(`version: must be ${GOAL_VERSION}`);
  if (!STATUSES.includes(value.status)) problems.push(`status: one of ${STATUSES.join(', ')}, not ${value.status ?? 'missing'}`);
  if (!CLASSES.includes(value.class)) problems.push(`class: ${CLASSES.join(' or ')}, not ${value.class ?? 'missing'}`);
  if (!Array.isArray(value.repos) || value.repos.length === 0) problems.push('repos: at least one repository, the first being where a session starts');
  else for (const repo of value.repos) if (typeof repo !== 'string' || !NAME_RE.test(repo)) problems.push(`repos: ${repo} is not a repository name — lower-case letters, digits and hyphens`);
  if (value.created !== undefined && value.created !== null && !(typeof value.created === 'string' && Number.isFinite(Date.parse(value.created)))) problems.push('created: an ISO instant, or null');
  if (value.after !== undefined && !Array.isArray(value.after)) problems.push('after: an array of <programme>/<goal>, possibly empty');
  else for (const name of value.after ?? []) if (!isGoalRef(name)) problems.push(`after: ${name} is not <programme>/<goal>`);
  if (value.prs !== undefined && !Array.isArray(value.prs)) problems.push('prs: an array of <repo>#<number>, possibly empty');
  else for (const ref of value.prs ?? []) if (!parsePrRef(ref)) problems.push(`prs: ${ref} is not <repo>#<number>`);
  if (!text(value.title)) problems.push('title: what the goal is, in one line');
  for (const key of ['goal', 'contract', 'out_of_scope']) {
    if (value[key] !== undefined && !prose(value[key], { min: 0 })) problems.push(`${key}: an array of paragraphs, possibly empty`);
  }
  validateCriteria(value.success_criteria, problems, { min: draft ? 0 : 1, what: 'a goal' });
  if (value.documents !== undefined) validateDocuments(value.documents, problems);
  return problems;
}

/**
 * A GOAL.json, as `{ status, repos, class, created, after, prs, title, goal,
 * contract, out_of_scope, success_criteria, documents }`, or `{ problems }`
 * when it does not parse or validate (`validateGoal`, as a draft: a goal with
 * no criterion yet parses). `repos` is in order, the first being where a
 * session starts; `after` is the goals this one starts after, as
 * `<programme>/<goal>`; `prs` is `[{ repo, pr }]`, each once.
 */
export function parseGoal(text) {
  let value;
  try {
    value = JSON.parse(String(text ?? ''));
  } catch (error) {
    return { problems: [`GOAL.json is not JSON: ${error.message.replace(/\s+/gu, ' ')}`] };
  }
  const problems = validateGoal(value, { draft: true });
  if (problems.length) return { problems };
  const prs = [];
  for (const ref of (value.prs ?? []).map(parsePrRef)) if (!prs.some((other) => other.repo === ref.repo && other.pr === ref.pr)) prs.push(ref);
  return {
    status: value.status, repos: [...value.repos], class: value.class, created: value.created ?? null,
    after: [...new Set(value.after ?? [])], prs, title: value.title.trim(),
    goal: value.goal ?? [], contract: value.contract ?? [], out_of_scope: value.out_of_scope ?? [],
    success_criteria: value.success_criteria, documents: value.documents ?? [],
  };
}

/**
 * GOAL.json's text for a goal of the shape `parseGoal` gives: every key, in
 * `GOAL_KEYS`' order. Throws when the goal would not validate, so no caller
 * writes an invalid GOAL.json.
 */
export function renderGoal(goal) {
  const value = {
    schema: GOAL_SCHEMA, version: GOAL_VERSION, status: goal.status, repos: goal.repos, class: goal.class,
    created: goal.created ?? null, after: goal.after ?? [], prs: (goal.prs ?? []).map((item) => (typeof item === 'string' ? item : prRef(item))),
    title: goal.title, goal: goal.goal ?? [], contract: goal.contract ?? [], out_of_scope: goal.out_of_scope ?? [],
    success_criteria: goal.success_criteria ?? [], documents: goal.documents ?? [],
  };
  const problems = validateGoal(value, { draft: true });
  if (problems.length) throw new Error(`GOAL.json would not validate: ${problems.join('; ')}`);
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * A goal as text, the way `mc goal show` prints it and a session is briefed
 * with it: the title, the goal, contract and out of scope as paragraphs, the
 * documents, and each criterion numbered with ✓ or ✗ and its check.
 */
export function renderGoalText(goal) {
  const lines = [`# ${goal.title}`];
  const section = (heading, paragraphs) => {
    lines.push('', heading);
    if (!paragraphs.length) { lines.push('  none yet'); return; }
    paragraphs.forEach((paragraph, i) => { if (i) lines.push(''); lines.push(...paragraph.split('\n').map((line) => `  ${line}`)); });
  };
  section('GOAL', goal.goal ?? []);
  section('CONTRACT', goal.contract ?? []);
  section('OUT OF SCOPE', goal.out_of_scope ?? []);
  section('DOCUMENTS', (goal.documents ?? []).map((doc) => `${doc.label} — ${doc.path}`));
  const criteria = goal.success_criteria ?? [];
  const { met, all } = criteriaCount(goal);
  lines.push('', `CRITERIA ${met}/${all}`);
  if (!criteria.length) lines.push('  none yet — mc goal criterion add <programme>/<goal> --criterion "…" --check "…"');
  criteria.forEach((item, i) => {
    lines.push(`  ${i + 1} ${item.met ? '✓' : '✗'} ${item.criterion}`);
    lines.push(`      check: ${item.check}`);
  });
  return `${lines.join('\n')}\n`;
}

/** `criteria <met>/<all>`: how a goal's criteria stand, as `mc goal list` and the page say it. */
export function criteriaWords(goal) {
  const { met, all } = criteriaCount(goal);
  return `criteria ${met}/${all}`;
}

/**
 * Why a goal may not go to review, or null: it has no criterion, or one is not
 * met — named by number, with the verb that records it.
 */
export function unmetGoalWords(goal, name = '<programme>/<goal>') {
  if (!(goal.success_criteria ?? []).length) return `${name} has no criterion — mc goal criterion add ${name} --criterion "…" --check "…"`;
  const unmet = unmetCriteria(goal);
  if (!unmet.length) return null;
  return unmet.length === 1
    ? `criterion ${unmet[0]} is not met — run its check and record it with mc goal criterion met ${name} ${unmet[0]}`
    : `criteria ${unmet.join(', ')} are not met — run their checks and record each with mc goal criterion met ${name} <n>`;
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
  if (entry.done) lines.push(`Done: ${entry.done}`);
  if (entry.comment) lines.push(`Comment: ${entry.comment}`);
  if (entry.next) lines.push(`Next: ${entry.next}`);
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
 * `{ programme, goal, dir, status, repos, class, created, after, prs, title,
 * goal_text, contract, out_of_scope, success_criteria, documents, log, problems }`
 * — `goal_text` is GOAL.json's `goal`, which `goal` (the name) would shadow.
 * A goal whose GOAL.json does not parse is listed with `problems` and no status.
 * A directory without a GOAL.json is not a goal and is skipped.
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
        goals.push({ ...base, status: null, repos: [], class: null, created: null, after: [], prs: [], title: null, goal_text: [], contract: [], out_of_scope: [], success_criteria: [], documents: [], problems: parsed.problems });
      } else {
        const { goal: goalText, ...rest } = parsed;
        goals.push({ ...base, ...rest, goal_text: goalText, problems: [] });
      }
    }
  }
  return goals;
}

/** A goal record of `programsGoals` as the shape `parseGoal` gives, for `renderGoalText`. */
export function goalOfRecord(record) {
  return { ...record, goal: record.goal_text ?? [] };
}

/**
 * A review's verdict, from its entry's `Done:` line — `green <sha>` or
 * `red <sha>`, the head the review read — as `{ verdict, sha }`, or null for an
 * entry that is no verdict.
 */
export function verdictOf(entry) {
  const [first] = String(entry?.done ?? '').split('\n');
  const match = first.match(/^(green|red)\b.*?\b([0-9a-f]{7,40})\b/u);
  return match ? { verdict: match[1], sha: match[2] } : null;
}

/** The runner's entry for a green review it queued: `Done: queued #<pr> at <sha> for the merger`. */
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
 * Whether a goal waits for a review session: it is in `review`, the last
 * entry is not the runner's for a green it has queued, and none of its pull
 * requests is in the merger's line (`inLine`, merge-queue.js) — a session that
 * fixed a red mechanically queues it with `mc merge` itself. Either waits for
 * the merger, which writes the next entry: landed is done, red is blocked,
 * moved past its head is reviewed again.
 */
export function reviewDue(goal, inLine = []) {
  if (goal.status !== 'review' || queuedOf(goal.log.at(-1))) return false;
  return !(goal.prs ?? []).some((item) => inLine.some((entry) => samePr(entry, item)));
}

/** The runner's entry for a red merge (`merger.js`): `Done: merger answered red on #<pr>`. */
export function redMergeText(pr) {
  return `merger answered red on #${pr}`;
}

/** The runner's entry for a goal whose `after` goal is gone without landing: its `Comment:`. */
export function afterGoneText(names) {
  return `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} gone without landing — waits on plan to change after`;
}

/**
 * The runner's entry after a plan session that left the goal `blocked`: its
 * `Done:`. A goal whose last entry is this one waits on a person, and wakes no
 * plan session again (`waitsOnPlan`).
 */
export function planHeldText(spoke) {
  return spoke ? 'plan session ended; the goal stays blocked — waits on Martin'
    : 'plan session ended without a log entry; the goal stays blocked — waits on Martin';
}

/** Whether `entry` is the runner's `planHeldText` entry. */
export function planHeld(entry) {
  return entry?.tool === 'runner' && String(entry.done ?? '').startsWith('plan session ended');
}

/**
 * Whether a blocked goal waits on plan, which the runner wakes headless
 * (`planDue`): blocked by a red review (its last entry is a `red` verdict), or
 * by the runner — a red merge (`redMergeText`), three sessions in a row without
 * a word, a review with no verdict or no pull request, an `after` goal gone
 * without landing (`afterGoneText`). Nothing goes back to a build session from
 * there until plan sets it open. A goal blocked by a person or by a build
 * session's question, or still blocked after a plan session (`planHeld`),
 * waits on a person (`waitsOnPerson`) and wakes nothing.
 */
export function waitsOnPlan(goal) {
  if (goal.status !== 'blocked') return false;
  const last = goal.log.at(-1);
  if (verdictOf(last)?.verdict === 'red') return true;
  return last?.tool === 'runner' && last.status === 'blocked' && !planHeld(last);
}

/**
 * When a goal took its current status, as the `at` of the log entry that set
 * it: the first of the entries at the end of the log that carry that status (a
 * session's entries after it keep the status, so the run begins where it was
 * set). Null when the log holds no such entry, as a status set by hand in the
 * front matter has none.
 */
export function statusSince(goal) {
  let at = null;
  for (let i = goal.log.length - 1; i >= 0 && goal.log[i].status === goal.status; i -= 1) at = goal.log[i].at;
  return at;
}

/** Whether a blocked goal waits on a person: blocked, and not on plan (`waitsOnPlan`). */
export function waitsOnPerson(goal) {
  return goal.status === 'blocked' && !waitsOnPlan(goal);
}

/** The role every plan session runs with, `mc plan`'s and the runner's: `canon/roles/plan-session.md`. */
export const PLAN_ROLE = 'plan-session';

/** Whether the runner starts a plan session on `goal`: it parses and waits on plan. */
export function planDue(goal) {
  return goal.problems.length === 0 && waitsOnPlan(goal);
}

/**
 * Where a goal's `after` stands, against `goals` (`programsGoals`' answer):
 * `{ landed, pending, gone }`, each a list of `<programme>/<goal>`. Landed is
 * `done`; gone is no goal there any more — its directory or GOAL.json removed,
 * which is how a goal is discarded or archived — or one `dropped`, which never
 * lands; pending is everything else, a `blocked` or unparsable one included:
 * it may still land.
 */
export function afterOf(goal, goals) {
  const byName = new Map(goals.map((other) => [`${other.programme}/${other.goal}`, other]));
  const landed = [];
  const pending = [];
  const gone = [];
  for (const name of goal.after ?? []) {
    const other = byName.get(name);
    if (!other || other.status === 'dropped') gone.push(name);
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
export function nextGoal(goals, { repos = [], held = new Set(), may = () => true, inLine = [] } = {}) {
  const lastAt = (goal) => goal.log.at(-1)?.at ?? '';
  const eligible = goals.filter((goal) => ((goal.status === 'open' && !noCriteria(goal)) || reviewDue(goal, inLine)) && goal.problems.length === 0
    && repos.includes(goal.repos[0]) && !held.has(goalName(goal)) && may(goal));
  return eligible.reduce((oldest, goal) => (oldest === null || lastAt(goal) < lastAt(oldest) ? goal : oldest), null);
}

/** Whether a goal has no criterion yet: `mc goal new`'s skeleton, which no session is started on. */
export function noCriteria(goal) {
  return Array.isArray(goal.success_criteria) && goal.success_criteria.length === 0;
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
 * The branch a goal's worktree of `repo` is on: `goal/<goal>`, as `mc goal
 * new` makes it, or the branch it took over from a project (`mc goal
 * from-project`), whose pull request is already open on it. Read from the
 * worktree; `goal/<goal>` when it cannot say.
 */
export function goalBranch({ git, dir, goal, repo }) {
  const head = git(join(dir, repo), ['rev-parse', '--abbrev-ref', 'HEAD']);
  const name = head.ok ? head.stdout.trim() : '';
  return /^[\w./-]+$/u.test(name) && name !== 'HEAD' ? name : `goal/${goal}`;
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

/**
 * The goal that carries `repo`'s pull request `pr` in its `prs`, of `goals`
 * (`programsGoals`' answer), or null. A pull request carries one goal; were
 * two to name it, the first listed is the one.
 */
export function goalOfPr(goals, repo, pr) {
  return goals.find((goal) => (goal.prs ?? []).some((item) => item.repo === repo && item.pr === Number(pr))) ?? null;
}

/**
 * Where a goal's pull requests stand, from `stateOf({ repo, pr })` — GitHub's
 * `OPEN`, `MERGED` or `CLOSED`, or null when it cannot say: `{ landed, open,
 * closed, unknown }`, each a list of `<repo>#<n>`, and `done` — every one has
 * landed or closed, at least one landed, none unknown. A goal with no `prs` is
 * never done here: only the merger's answer on its own branch, or a person, says so.
 */
export function prsLanded(prs, stateOf) {
  const out = { landed: [], open: [], closed: [], unknown: [] };
  for (const item of prs ?? []) {
    const state = stateOf(item);
    const key = state === 'MERGED' ? 'landed' : state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : 'unknown';
    out[key].push(prRef(item));
  }
  return { ...out, done: out.landed.length > 0 && out.open.length === 0 && out.unknown.length === 0 };
}

/**
 * The goal whose worktree `cwd` stands in, as `{ programme, goal }`: a path
 * `<home>/<programme>/goals/<goal>/<repo>/…`. Null anywhere else. How `mc
 * publish` knows the goal of a session a person opened in a goal's worktree.
 */
export function goalOfPath(cwd, home) {
  const rel = relative(home, cwd);
  if (!rel || rel.startsWith('..')) return null;
  const [programme, dir, goal, repo] = rel.split(sep);
  if (dir !== GOALS_DIR || !repo || !NAME_RE.test(programme ?? '') || !NAME_RE.test(goal ?? '')) return null;
  return { programme, goal };
}

/**
 * The goal's GOAL.json with `repo`'s pull request `pr` added to `prs`, and
 * `entry` appended to its log; nothing written when it is already there.
 * Returns `{ added, goal }`, or `{ problems }` when GOAL.json does not parse.
 */
export function addPr({ dir, repo, pr, entry, read = readTextOrNull, write = writeFileAtomic }) {
  const path = join(dir, GOAL_FILE);
  const parsed = parseGoal(read(path) ?? '');
  if (parsed.problems) return { problems: parsed.problems };
  if (parsed.prs.some((item) => item.repo === repo && item.pr === Number(pr))) return { added: false, goal: parsed };
  const goal = { ...parsed, prs: [...parsed.prs, { repo, pr: Number(pr) }] };
  write(path, renderGoal(goal));
  if (entry) appendEntry({ dir, entry, read, write });
  return { added: true, goal };
}

/** The archive directory of one programme's goals: `<home>/<programme>/goals/.archive`. */
export function archiveDirIn(home, programme) {
  return join(home, programme, GOALS_DIR, ARCHIVE_DIR);
}

/**
 * The row `mc goal archive` appends to `goals/goal_log.md`: date, goal,
 * status, pull requests, and the last `Done:` the log has. A `|` in the text
 * is escaped so the row stays one table row.
 */
export function goalLogRow({ date, goal, status, prs, log }) {
  const cell = (text) => String(text ?? '—').replace(/\s*\n\s*/gu, ' ').replace(/\|/gu, '\\|');
  const done = [...(log ?? [])].reverse().find((entry) => entry.done)?.done ?? null;
  return `| ${date} | ${cell(goal)} | ${status} | ${cell((prs ?? []).map(prRef).join(' ') || '—')} | ${cell(done)} |`;
}

/** `goal_log.md`'s heading and table head, written when the file is new. */
export const GOAL_LOG_HEAD = '# Archived goals\n\nOne row per goal `mc goal archive` moved to `.archive/`.\n\n| Archived | Goal | Status | Pull requests | Last done |\n|---|---|---|---|---|\n';

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
 * Sets the goal's status in its GOAL.json — and its `after`, when one is
 * given — and appends `entry` to its LOG.md: the two writes that make a
 * status change. Nothing is written when the GOAL.json does not parse, or the
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

/**
 * Changes a goal's GOAL.json by `change(goal)`, which returns the goal as it
 * is to be, or `{ problems }` to refuse. The result is validated before it is
 * written, so an invalid GOAL.json is never written. Returns `{ goal }` or
 * `{ problems }`.
 */
export function updateGoal({ dir, change, read = readTextOrNull, write = writeFileAtomic }) {
  const path = join(dir, GOAL_FILE);
  const text = read(path);
  if (text === null) return { problems: [`${dir} has no ${GOAL_FILE}`] };
  const parsed = parseGoal(text);
  if (parsed.problems) return { problems: parsed.problems };
  const next = change(parsed);
  if (next?.problems) return { problems: next.problems };
  let rendered;
  try { rendered = renderGoal(next); } catch (error) { return { problems: [error.message] }; }
  write(path, rendered);
  return { goal: parseGoal(rendered) };
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
