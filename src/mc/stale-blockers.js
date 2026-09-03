/**
 * A blocker nobody re-reads — the one thing on the page that says a stopped
 * plan has been waiting for nothing.
 *
 * A step is `blocked` with `blocked_by: { kind, name }`, and until this
 * existed nothing in mc ever read that name a second time. The runner hands
 * out `ready` steps and reads no further, so a step whose blocker finished
 * months ago is invisible to it for ever: a blocker does not flip itself.
 * Measured on `origin/main` 2026-09-03, memoro held 28 blocked plans against
 * 3 ready, and two of the twenty-eight were waiting on `inbox-finish`, which
 * had been delivered, logged and archived off main that same day. Clearing
 * those two took a person noticing.
 *
 * This is only the noticing. It reports; it never decides, and it never
 * writes a plan — flipping a step back to `ready` stays an edit somebody
 * makes and a pull request somebody reads.
 *
 * **Only `kind: project`.** A `decision` blocker names an answer from Martin,
 * and there is no artefact anywhere in either repository to check it against:
 * the decision-file apparatus was removed with `waiting-decision`, and a
 * decision's answer now lives in a plan's prose or in a conversation. So a
 * machine that claimed a decision was stale would be guessing, and twenty of
 * the twenty-one `decision` blockers on main are the deliberate `plan-review`
 * park #11152 put on every converted plan. They are not stale; they are the
 * queue of plans Martin has not read yet.
 *
 * **What counts as finished, and why the wording is careful.** A project
 * blocker is stale when the named project's plan on the same ref is `done`,
 * or when there is no plan by that name at all — `mc run` archives a plan the
 * round it says done, so a delivered project leaves nothing behind but a
 * `project_log.md` row. But a project also leaves main when it is abandoned
 * or superseded, and then the blocked step's premise may be dead rather than
 * satisfied. The line therefore says *is not on main* rather than *is done*,
 * because those are different facts and only a person can tell which one
 * applies.
 *
 * **It reads what the runner obeys.** The records this takes are
 * `listPlans`'s, which are read from `origin/main` without a checkout
 * (brief-collect.js) — the same source `queue()` and the page's plan cache
 * use. That is deliberate: `mc status <name>` reads the workarea's working
 * tree when there is one, and on 2026-09-03 it went on showing
 * `email-window-layout` step 5 as blocked after main already said `ready`.
 * A stale-blocker line drawn from a stale checkout would be the same fault
 * wearing a new hat.
 *
 * The blocker is matched **by name across every record given**, not within
 * one repository, because a plan may name a project in the other one. A
 * caller holding one repository's plans therefore under-reports rather than
 * inventing a project that is gone — the page holds both.
 */

/** Blocked steps whose `project` blocker is finished or gone, in plan order. */
export function staleBlockers(plans = []) {
  const known = new Map();
  for (const record of plans) {
    if (record?.project) known.set(record.project, record);
  }
  const out = [];
  for (const record of plans) {
    const steps = Array.isArray(record?.plan?.steps) ? record.plan.steps : [];
    steps.forEach((step, index) => {
      if (step?.status !== 'blocked') return;
      const blocker = step.blocked_by;
      if (!blocker || blocker.kind !== 'project' || !blocker.name) return;
      const held = known.get(blocker.name);
      const why = held ? (held.status === 'done' ? 'is done' : null) : 'is not on main';
      if (!why) return;
      out.push({
        repo: record.repo,
        programme: record.programme,
        project: record.project,
        step: index + 1,
        title: step.title,
        blocker: blocker.name,
        why,
      });
    });
  }
  return out;
}

/** `home-on-msr step 2 waits on inbox-finish, which is not on main` */
export function describeStale(item) {
  return `${item.project} step ${item.step} waits on ${item.blocker}, which ${item.why}`;
}
