/**
 * The door a plan's last step passes: its pull request does not land while a
 * success criterion of the plan is not `met` (`criteriaDoor`, below).
 *
 * Plans are not in pull requests (ruling 48), so nothing here compares a pull
 * request's plan with its base's: the plan is the one under `~/mc/programs/`,
 * and whether a criterion is met is the register's to say.
 */
import { spawnSync } from 'node:child_process';

import { readPlanText, unmetCriteria, unmetWords } from './plan-schema.js';
import { stepForMerge } from './merge-step.js';
import { projectForBranch } from './project-prs.js';
import { applyEntry, readEntry } from './register.js';
import { workRoot } from './paths.js';
import { programsPlans } from './plan-source.js';

function run(tool) {
  return (args, options = {}) => spawnSync(tool, args, { cwd: options.cwd, encoding: 'utf8' });
}

const notChecked = { checked: false, ok: true, problems: [] };

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
 * `{ checked, ok, problems }`, and `unmet` (1-based) on a refusal.
 */
export async function criteriaDoor({ repoPath, pr, gh, step = undefined, env = process.env, entries = [], root = workRoot(env), read, programs = programsPlans } = {}) {
  const askGh = gh || run('gh');

  const asked = askGh(['pr', 'view', String(pr), '--json', 'headRefName,baseRefName'], { cwd: repoPath });
  if (asked?.status !== 0) return notChecked;
  let raw = null;
  try { raw = JSON.parse(asked.stdout); } catch { return notChecked; }
  const head = raw?.headRefName;
  const base = raw?.baseRefName;
  if (!head || !base) return notChecked;

  const target = step !== undefined ? step : stepForMerge({ env, head, entries });
  if (!target) return notChecked;

  const all = programs();
  const project = target.project || projectForBranch(head, all.map((one) => one.project));
  if (!project) return notChecked;
  const held = all.find((one) => one.project === project);
  if (!held) return notChecked;
  const { plan } = readPlanText(held.text);
  if (!plan || !Array.isArray(plan.steps)) return notChecked;
  if (target.index !== plan.steps.length - 1) return { checked: true, ok: true, problems: [] };
  const entry = readEntry(root, project, read ? { read } : {});
  const judged = entry ? applyEntry({ plan }, entry).plan : plan;
  const unmet = unmetCriteria(judged);
  if (!unmet.length) return { checked: true, ok: true, problems: [] };
  return {
    checked: true,
    ok: false,
    unmet,
    problems: [`step ${target.index + 1} is the plan's last, and ${unmetWords(unmet)} — or mc step failed --reason "…" naming what could not be measured`],
  };
}
