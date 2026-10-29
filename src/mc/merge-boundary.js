/**
 * The door a plan's last step passes: its pull request does not land while a
 * success criterion of the plan is not `met` (`criteriaDoor`, below). In a
 * branch-flow plan a step before the review is refused too (`stop:
 * 'before-review'`): it is built on the project's branch and lands with the review step.
 *
 * Plans are not in pull requests (ruling 48), so nothing here compares a pull
 * request's plan with its base's: the plan is the one under `~/mc/programs/`,
 * and whether a criterion is met is the register's to say.
 */
import { spawnSync } from 'node:child_process';

import { branchFlow, readPlanText, unmetCriteria, unmetWords } from './plan-schema.js';
import { stepForMerge } from './merge-step.js';
import { projectForBranch } from './project-prs.js';
import { applyEntry, readEntry } from './register.js';
import { workRoot } from './paths.js';
import { programsPlans } from './plan-source.js';
import { autonomousMergeDoor } from './autonomous-pr.js';

function run(tool) {
  return (args, options = {}) => spawnSync(tool, args, { cwd: options.cwd, encoding: 'utf8' });
}

const notChecked = { checked: false, ok: true, problems: [] };

/**
 * The project and its plan, from the programmes plans: `project` when named,
 * else the one the branch's name begins with (`projectForBranch`). Null when
 * there is none, or its plan does not read.
 */
export function projectPlan({ project = null, head = null, programs = programsPlans } = {}) {
  const all = programs();
  const name = project || projectForBranch(head, all.map((one) => one.project));
  if (!name) return null;
  const held = all.find((one) => one.project === name);
  if (!held) return null;
  const { plan } = readPlanText(held.text);
  if (!plan || !Array.isArray(plan.steps)) return null;
  return { project: name, plan };
}

/**
 * The last step is where a plan becomes done, and done means its success
 * criteria met (Martin, 2026-10-18), so the last step's pull request does not
 * land while its plan leaves one `met: false`: the session measures, or fails
 * visibly (`mc step failed`). photo-analysis was archived on 2026-10-11 with
 * three criteria unmet on main.
 *
 * `mc merge`, `mc merge --docs` and the runner's own queueing each call this,
 * a docs-only pull request, the usual close-out, included. The step is the one
 * handed in (the register's), else the one the pull request is (`stepForMerge`);
 * nobody's step is not checked. Fails open on anything it cannot read.
 *
 * `met` is the register's, not the file's (ruling 48): `mc project criterion
 * met` writes it, and a pull request carries none to read. So the plan is the
 * project's under `~/mc/programs/`, with the register's criteria laid over it;
 * a project with none there is not checked. The project is the step's, else
 * the one whose name the branch begins with among the programs plans
 * (`projectForBranch`). No repository is read: `git` is accepted and not used.
 *
 * `{ checked, ok, problems }`, and `unmet` (1-based) and `stop` on a refusal:
 * `before-review` (a step before a branch flow's review) or `unmet-criteria`.
 */
export async function criteriaDoor({ repoPath, pr, gh, git, step = undefined, env = process.env, entries = [], root = workRoot(env), read, programs = programsPlans } = {}) {
  const askGh = gh || run('gh');
  const asked = await askGh(['pr', 'view', String(pr), '--json', 'number,state,headRefName,headRefOid,baseRefName,body'], { cwd: repoPath });
  let raw = null;
  if (asked?.status === 0 || asked?.ok === true) { try { raw = JSON.parse(asked.stdout); } catch { /* unknown below */ } }
  const autonomous = await autonomousMergeDoor({ repoPath, pr, root, view: raw, env, git });
  if (autonomous.checked) return autonomous;
  if (!raw) return notChecked;
  const head = raw?.headRefName;
  const base = raw?.baseRefName;
  if (!head || !base) return notChecked;

  const target = step !== undefined ? step : stepForMerge({ env, head, entries });
  if (!target) return notChecked;

  const found = projectPlan({ project: target.project, head, programs });
  if (!found) return notChecked;
  const { project, plan } = found;
  if (branchFlow(plan) && target.index !== plan.steps.length - 1) {
    return { checked: true, ok: false, stop: 'before-review', problems: [`step ${target.index + 1} is built on the project's branch and does not land by itself — the project lands with its review step, step ${plan.steps.length}`] };
  }
  if (target.index !== plan.steps.length - 1) return { checked: true, ok: true, problems: [] };
  const entry = readEntry(root, project, read ? { read } : {});
  const judged = entry ? applyEntry({ plan }, entry).plan : plan;
  const unmet = unmetCriteria(judged);
  if (!unmet.length) return { checked: true, ok: true, problems: [] };
  return {
    checked: true,
    ok: false,
    stop: 'unmet-criteria',
    unmet,
    problems: [`step ${target.index + 1} is the plan's last, and ${unmetWords(unmet)} — or mc step failed --reason "…" naming what could not be measured`],
  };
}
