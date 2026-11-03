/**
 * `project-convert.js` — `mc goal from-project <programme>/<project>`: a live
 * project, as its PLAN.json and STATE.json left it, turned into goals, once.
 *
 * Projects were mc's other unit of work: a plan of several steps, each with a
 * check, run one after the other. A goal carries everything a plan did; the
 * steps become goals in consecutive phases. This is the one place in mc that
 * reads PLAN.json and STATE.json (`docs/technical/mc-goals.md` § *From a
 * project*); a project with every step done is not read by anything else, and
 * is refused here.
 *
 *   - One goal per step not `done` (STATE.json's status laid over the plan's,
 *     step by step), named `<project>-<n>` after the step's number. The first
 *     is in the phase its programme is in now (1 when it has no goal left to
 *     finish), and each after it one phase later, so the steps still run one
 *     after the other. A step blocked on another project of the same
 *     programme goes one phase past that project's last goal, which must be
 *     converted first; one blocked on a project in another programme, which a
 *     phase cannot wait on, is `blocked` and says so.
 *   - A step's title is the goal's title, its instruction the goal, its
 *     `done_when` a criterion with that check. The project's contract, out of
 *     scope and documents go to every goal, its success criteria to the last.
 *   - A step that is `built` or `landing` with a pull request is a goal in
 *     `review · ready` carrying it, its criterion met; a `blocked` step is
 *     `build · blocked`, its first log entry the blocker; any other is
 *     `build · ready`. A step with a branch of its own has its goal's
 *     worktree on that branch, so the work goes on there.
 *   - A branch-flow project (its last step `kind: review`) is one goal, named
 *     after the project, on the project's branch, with every remaining step's
 *     criterion: a session builds what is left and the review lands it all.
 *
 * `planGoals` is pure: it says which goals a project makes. `convertProject`
 * writes them and makes their worktrees.
 */
import { join } from 'node:path';

import { addGoalWorktree, appendLog, CLASSES, currentPhase, FINISHED, GOAL_FILE, GOALS_DIR, goalDirIn, listDirsOf, LOG_FILE, logStamp, programsGoals, readTextOrNull, renderGoal } from './goals.js';
import { repoNameOf } from './repos.js';

const PLAN = 'PLAN.json';
const STATE = 'STATE.json';
const CLOSEOUT = 'CLOSEOUT.json';

/** A file's JSON, or null when it is absent or does not parse. */
function json(read, path) {
  const text = read(path);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** Paragraphs as GOAL.json takes them: strings, trimmed, none empty. */
function paragraphs(value) {
  return (Array.isArray(value) ? value : [value]).filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim());
}

/**
 * A project's steps with STATE.json laid over PLAN.json, step by step, as
 * `[{ n, title, instruction, done_when, kind, class, status, pr, branch,
 * blocked_by, reason }]`. A step STATE.json does not hold keeps the plan's.
 */
export function projectSteps(plan, state) {
  const held = Array.isArray(state?.steps) ? state.steps : [];
  return (Array.isArray(plan?.steps) ? plan.steps : []).map((step, i) => {
    const at = held[i] ?? {};
    const status = at.status ?? step.status ?? 'ready';
    const model = step.runner?.model ?? plan.runner?.model;
    return {
      n: i + 1, title: String(step.title ?? `Step ${i + 1}`).trim(), instruction: paragraphs(step.instruction), done_when: String(step.done_when ?? '').trim(),
      kind: step.kind ?? null, class: CLASSES.includes(model) ? model : null, status,
      pr: Number.isInteger(at.pr ?? step.pr) ? (at.pr ?? step.pr) : null, branch: typeof at.branch === 'string' && at.branch ? at.branch : null,
      blocked_by: status === 'blocked' ? (at.blocked_by ?? step.blocked_by ?? null) : null, reason: at.reason ?? step.reason ?? null,
    };
  });
}

/** Whether a project still has work: a step not done. A project with a CLOSEOUT.json is archived, and finished. */
function live({ dir, read }) {
  if (read(join(dir, CLOSEOUT)) !== null) return false;
  const plan = json(read, join(dir, PLAN));
  if (!plan) return false;
  return projectSteps(plan, json(read, join(dir, STATE))).some((step) => step.status !== 'done');
}

/** What a blocker says, as one line: its kind and name, and why. */
function blockerWords(step) {
  const by = step.blocked_by;
  const what = by ? `blocked on ${by.kind ?? 'something'}${by.name ? ` ${by.name}` : ''}${by.at ? ` until ${by.at}` : ''}${by.kind === 'deploy' && by.step ? ` (step ${by.step}'s deploy${by.hours ? ` + ${by.hours} h` : ''})` : ''}` : 'blocked';
  return step.reason ? `${what} — ${String(step.reason).trim()}` : what;
}

/**
 * What a step blocked on project `name` waits on, of `goals` (`programsGoals`'
 * answer, every programme): `{ phase }`, the phase of the last goal that
 * project was converted into in `programme`; `{ elsewhere }`, that goal's name
 * when it is in another programme, whose phases this one does not wait on;
 * `{}` when that goal is finished or the project is finished or not there; or
 * `{ refused }` when the project is live and not converted yet.
 */
function projectWait(name, { programme, goals, home, list, read }) {
  // A project's name is a goal's name too (lower-case letters, digits and
  // hyphens), so a name that is not one is no project, and needs no escaping.
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) return { refused: `it is blocked on project "${name}", which is not a project's name` };
  const pattern = new RegExp(`^${name}(?:-(\\d+))?$`, 'u');
  const step = (goal) => Number(pattern.exec(goal.goal)[1] ?? 0);
  const made = goals.filter((goal) => goal.problems.length === 0 && pattern.test(goal.goal));
  const own = made.filter((goal) => goal.programme === programme);
  const mine = (own.length ? own : made.filter((goal) => goal.programme === made[0]?.programme)).sort((a, b) => step(a) - step(b));
  if (mine.length) {
    const last = mine.at(-1);
    if (FINISHED.includes(last.stage)) return {};
    return last.programme === programme ? { phase: last.phase ?? 1 } : { elsewhere: `${last.programme}/${last.goal}` };
  }
  for (const other of list(home)) {
    if (live({ dir: join(home, other, name), read })) return { refused: `it waits on project ${other}/${name}, which is not converted yet — convert that one first` };
  }
  return {};
}

/** The first sentence of the project's goal, as a title; the project's name when it has none. */
function titleOf(plan, project) {
  const first = paragraphs(plan.goal)[0]?.replace(/\s+/gu, ' ') ?? '';
  const sentence = first.match(/^(.+?[.!?])(?:\s|$)/u)?.[1] ?? first;
  if (!sentence) return project;
  return sentence.length > 120 ? `${sentence.slice(0, 119).trim()}…` : sentence;
}

/** A step's criterion: its title, checked by its `done_when`. */
function stepCriterion(step, met) {
  return { criterion: step.title, check: step.done_when || step.title, met };
}

/** The project's success criteria, with `met` as STATE.json holds it (matched by text), else as the plan says. */
function successCriteria(plan, state) {
  const held = Array.isArray(state?.criteria) ? state.criteria : [];
  return (Array.isArray(plan.success_criteria) ? plan.success_criteria : [])
    .filter((item) => item && typeof item.criterion === 'string' && item.criterion.trim())
    .map((item) => {
      const found = held.find((other) => other?.criterion === item.criterion);
      return { criterion: item.criterion.trim(), check: String(item.check ?? item.criterion).trim(), met: Boolean(found ? found.met : item.met) };
    });
}

/**
 * The goals a project makes, as `{ goals: [{ name, goal, branch, entry }] }`
 * — `goal` the shape `renderGoal` takes, `branch` the project's branch its
 * worktree takes over (null for a new `goal/<name>` from origin/main), `entry`
 * its first LOG.md entry — or `{ refused }`. `existing` names the goal
 * directories already under the programme; a project whose goals are among
 * them was converted already. `phase` is the phase the first goal takes, the
 * programme's own now. `waitsOn(project)` answers for a step blocked on
 * another project (`projectWait`).
 */
export function planGoals({ programme, project, plan, state, existing = [], phase = 1, waitsOn = () => ({}), now, tool = 'person', model = null }) {
  if (!plan || !Array.isArray(plan.steps)) return { refused: `${programme}/${project} has no ${PLAN} that reads` };
  const steps = projectSteps(plan, state);
  const left = steps.filter((step) => step.status !== 'done');
  if (!left.length) return { refused: `every step of ${programme}/${project} is done — a finished project is left as it is` };
  const repo = typeof plan.repo === 'string' && plan.repo ? plan.repo : null;
  if (!repo) return { refused: `${programme}/${project}'s ${PLAN} names no repo` };

  const flow = steps.at(-1)?.kind === 'review';
  const names = flow ? [project] : left.map((step) => `${project}-${step.n}`);
  const taken = names.filter((name) => existing.includes(name));
  if (taken.length) return { refused: `${programme}/${project} is converted already — ${taken.map((name) => `${programme}/${name}`).join(', ')} ${taken.length === 1 ? 'exists' : 'exist'}` };

  const shared = { repos: [repo], created: now.toISOString().replace(/\.\d{3}Z$/u, 'Z'), contract: paragraphs(plan.contract), out_of_scope: paragraphs(plan.out_of_scope), documents: (plan.documents ?? []).filter((doc) => doc?.label && doc?.path).map(({ label, path }) => ({ label, path })) };
  const success = successCriteria(plan, state);
  const at = logStamp(now);
  const from = (n) => `converted from project ${programme}/${project}${n ? `, step ${n}` : ''}`;
  const built = (step) => step.status === 'built' || step.status === 'landing';

  /**
   * What holds a step: `{ after }`, the phase it must come after (0 for
   * none), and `blocker`, the words of what blocks it on a person — a
   * blocker that is not a project, or a project in another programme.
   */
  const holdOf = (step) => {
    const by = step.blocked_by;
    if (step.status !== 'blocked') return { after: 0, blocker: null };
    if (by?.kind !== 'project' || !by.name) return { after: 0, blocker: blockerWords(step) };
    const waits = waitsOn(by.name);
    if (waits.refused) return { refused: waits.refused };
    if (waits.elsewhere) return { after: 0, blocker: `${blockerWords(step)} — its last goal is ${waits.elsewhere}, in another programme, and a phase waits only on its own programme's goals` };
    return { after: waits.phase ?? 0, blocker: null };
  };

  if (flow) {
    const holds = left.map(holdOf);
    const refused = holds.find((hold) => hold.refused);
    if (refused) return { refused: refused.refused };
    const blocker = holds.find((hold) => hold.blocker)?.blocker ?? null;
    const work = left.filter((step) => step.kind !== 'review');
    const pr = [...steps].reverse().find((step) => step.pr)?.pr ?? null;
    const branch = [...steps].reverse().find((step) => step.branch)?.branch ?? null;
    const where = blocker ? { stage: 'build', status: 'blocked' } : (pr && work.every(built) ? { stage: 'review', status: 'ready' } : { stage: 'build', status: 'ready' });
    const goalText = [...paragraphs(plan.goal), ...left.flatMap((step) => [`**Step ${step.n} — ${step.title}.**`, ...step.instruction])];
    const goal = {
      ...shared, ...where, phase: Math.max(phase, ...holds.map((hold) => hold.after + 1)),
      class: left.find((step) => step.class)?.class ?? 'large', prs: pr ? [{ repo, pr }] : [],
      title: titleOf(plan, project), goal: goalText,
      success_criteria: [...left.map((step) => stepCriterion(step, built(step))), ...success],
    };
    return { goals: [{ name: project, goal, branch, entry: { at, tool, model, ...where, done: `${from(null)} (branch flow, steps ${left.map((step) => step.n).join(', ')}), phase ${goal.phase}${pr ? ` — carries ${repo}#${pr}` : ''}`, comment: blocker, next: null } }] };
  }

  const goals = [];
  let before = null;
  for (const [i, step] of left.entries()) {
    const hold = holdOf(step);
    if (hold.refused) return { refused: hold.refused };
    const review = Boolean(step.pr) && built(step);
    const where = review ? { stage: 'review', status: 'ready' } : { stage: 'build', status: hold.blocker ? 'blocked' : 'ready' };
    const stepPhase = Math.max(before === null ? phase : before + 1, hold.after + 1);
    before = stepPhase;
    const last = i === left.length - 1;
    const goal = {
      ...shared, ...where, phase: stepPhase, class: step.class ?? 'large', prs: review ? [{ repo, pr: step.pr }] : [],
      title: step.title, goal: step.instruction,
      success_criteria: [stepCriterion(step, review), ...(last ? success : [])],
    };
    goals.push({ name: names[i], goal, branch: step.branch, entry: { at, tool, model, ...where, done: `${from(step.n)}, phase ${stepPhase}${review ? ` — carries ${repo}#${step.pr}` : ''}`, comment: hold.blocker, next: null } });
  }
  return { goals };
}

/**
 * `mc goal from-project <programme>/<project>`, made: the goals `planGoals`
 * says, each GOAL.json and LOG.md written and its worktree made — on the
 * project's branch when it has one (`git worktree add <path> <branch>`, from
 * origin's when there is no local one), else on `goal/<name>` from
 * origin/main (`addGoalWorktree`). Every repository is fetched and every
 * branch to be taken over is checked first, so a refusal leaves nothing
 * written. Returns `{ made: [{ name, stage, status, phase, path, branch, prs,
 * worktree }] }` or `{ refused }`.
 */
export function convertProject({ home, programme, project, now, tool, model, list = listDirsOf, read = readTextOrNull, write, git, known }) {
  const dir = join(home, programme, project);
  if (read(join(dir, PLAN)) === null) return { refused: `no project ${programme}/${project} — ${dir} has no ${PLAN}` };
  if (read(join(dir, CLOSEOUT)) !== null) return { refused: `${programme}/${project} is archived — a finished project is left as it is` };
  const goals = programsGoals({ home, list, read });
  const planned = planGoals({
    programme, project, plan: json(read, join(dir, PLAN)), state: json(read, join(dir, STATE)),
    existing: list(join(home, programme, GOALS_DIR)), phase: currentPhase(goals, programme) ?? 1,
    waitsOn: (name) => projectWait(name, { programme, goals, home, list, read }), now, tool, model,
  });
  if (planned.refused) return planned;

  const repo = planned.goals[0].goal.repos[0];
  const bare = known().find((path) => repoNameOf(path) === repo);
  if (!bare) return { refused: `${repo} is not a repository mc knows` };
  const fetched = git(bare, ['fetch', '-q', 'origin']);
  if (!fetched.ok) return { refused: `could not fetch ${repo} — ${fetched.stderr.trim()}` };
  const checkedOut = worktreeBranches(git(bare, ['worktree', 'list', '--porcelain']).stdout);
  for (const { branch } of planned.goals) {
    if (!branch) continue;
    const local = git(bare, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
    const remote = git(bare, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).ok;
    if (!local && !remote) return { refused: `the project's branch ${branch} is neither in ${repo} nor on origin` };
    if (checkedOut.has(branch)) return { refused: `${branch} is checked out in ${checkedOut.get(branch)} — remove that worktree (git worktree remove) and run this again` };
  }

  const made = [];
  for (const { name, goal, branch, entry } of planned.goals) {
    const goalDir = goalDirIn(home, programme, name);
    write(join(goalDir, GOAL_FILE), renderGoal(goal));
    write(join(goalDir, LOG_FILE), appendLog('', entry));
    const path = join(goalDir, repo);
    let added;
    if (branch) {
      const local = git(bare, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
      added = { ...git(bare, local ? ['worktree', 'add', '-q', path, branch] : ['worktree', 'add', '-q', '-b', branch, path, `origin/${branch}`]), branch };
    } else {
      added = addGoalWorktree({ git, bare, path, goal: name });
    }
    made.push({ name: `${programme}/${name}`, stage: goal.stage, status: goal.status, phase: goal.phase, path, branch: added.branch, prs: goal.prs, worktree: added.ok ? null : added.stderr.trim() || 'git failed' });
  }
  return { made };
}

/** `git worktree list --porcelain`'s branches, each with the worktree it is checked out in. */
function worktreeBranches(text) {
  const out = new Map();
  let path = null;
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    else if (line.startsWith('branch refs/heads/')) out.set(line.slice('branch refs/heads/'.length), path);
  }
  return out;
}
