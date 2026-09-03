#!/usr/bin/env node
/**
 * Every blocked step on a ref of both repositories, and the counts beside it.
 * This is the script `blocked-audit.md` was written from and re-counted with;
 * it is checked in so the numbers in that file can be reproduced rather than
 * believed.
 *
 *   node docs/project/mc/step-parallelism/blocked-scan.mjs            # origin/main
 *   node docs/project/mc/step-parallelism/blocked-scan.mjs --json
 *   node docs/project/mc/step-parallelism/blocked-scan.mjs --memoro-ref <sha>
 *
 * It reads the ref through `git show`, never a checkout, because the plan the
 * runner obeys is the one on `origin/main` and a workarea's copy lags it —
 * that lag is why `mc status` showed `email-window-layout` step 5 as blocked
 * after main already said `ready`. It fetches nothing: run `git fetch origin`
 * first if the ref may be behind.
 *
 * A plan has no status of its own: it is the state of the first step that is
 * not done, which is why the plan counts and the step counts differ — a plan
 * can be `ready` on its next step and still carry a blocked step further down.
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REPOS = [
  { name: 'memoro', path: join(homedir(), 'memoro') },
  { name: 'memoro-cli', path: join(homedir(), 'memoro-cli') },
];

const arg = (flag, fallback) => {
  const at = process.argv.indexOf(flag);
  return at === -1 ? fallback : process.argv[at + 1];
};
const REFS = {
  memoro: arg('--memoro-ref', 'origin/main'),
  'memoro-cli': arg('--memoro-cli-ref', 'origin/main'),
};

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });

/** Every plan on the ref, with the state the runner derives from its steps. */
function plansOf(repo) {
  const ref = REFS[repo.name];
  const files = git(repo.path, ['ls-tree', '-r', '--name-only', ref, '--', 'docs/project'])
    .split('\n')
    .filter((path) => path.split('/').length === 5 && path.endsWith('/PLAN.json'));
  return files.map((path) => {
    const parts = path.split('/');
    let plan = null;
    let unreadable = null;
    try { plan = JSON.parse(git(repo.path, ['show', `${ref}:${path}`])); } catch (error) { unreadable = String(error.message).split('\n')[0]; }
    const steps = Array.isArray(plan?.steps) ? plan.steps : [];
    const first = steps.findIndex((step) => step.status !== 'done');
    return {
      repo: repo.name,
      programme: parts[2],
      project: parts[3],
      path,
      unreadable,
      steps,
      state: unreadable ? 'unreadable' : (first === -1 ? 'done' : steps[first].status),
      firstUnfinished: first,
    };
  });
}

const plans = REPOS.flatMap(plansOf);
const byProject = new Map(plans.map((plan) => [plan.project, plan]));

const blocked = [];
for (const plan of plans) {
  plan.steps.forEach((step, index) => {
    if (step.status !== 'blocked') return;
    const by = step.blocked_by || null;
    const held = by?.kind === 'project' ? byProject.get(by.name) || null : null;
    blocked.push({
      repo: plan.repo,
      programme: plan.programme,
      project: plan.project,
      step: index + 1,
      of: plan.steps.length,
      title: step.title,
      kind: by?.kind || null,
      name: by?.name || null,
      first: index === plan.firstUnfinished,
      // Only a `project` blocker can be checked by a machine: a `decision`
      // names an answer from Martin and no decision file exists in either
      // repository since `waiting-decision` was removed.
      blockerState: by?.kind !== 'project' ? null : (held ? held.state : 'not on main'),
    });
  });
}

const tally = (items, key) => items.reduce((acc, item) => ({ ...acc, [item[key]]: (acc[item[key]] || 0) + 1 }), {});
const counts = {
  refs: REFS,
  plans: tally(plans, 'repo'),
  planState: Object.fromEntries(REPOS.map((repo) => [repo.name, tally(plans.filter((p) => p.repo === repo.name), 'state')])),
  blockedSteps: tally(blocked, 'repo'),
  byKind: tally(blocked, 'kind'),
  byName: tally(blocked, 'name'),
  stale: blocked.filter((b) => b.blockerState === 'done' || b.blockerState === 'not on main').length,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ counts, blocked }, null, 2));
} else {
  console.log(JSON.stringify(counts, null, 2));
  console.log();
  console.log('| repo | programme | project | step | blocked_by | blocker on main |');
  console.log('|---|---|---|---|---|---|');
  for (const b of blocked) {
    console.log(`| ${b.repo} | ${b.programme} | ${b.project} | ${b.step}/${b.of} ${b.title} | ${b.kind}:${b.name} | ${b.blockerState || '—'} |`);
  }
}
