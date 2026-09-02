/**
 * `mc run` — the plans on `origin/main` that cannot be read at all.
 *
 * `chooseKind` already answers `unparseable` and `runStep` prints it to
 * `runner.log`, which is the same nowhere the old queue's skip lines went:
 * `new-user`'s plan carried five `{ title, body }` entries whose `body` was a
 * string, so it failed the schema, and the runner logged that line every round
 * for a day while the project quietly stopped existing as far as any board was
 * concerned.
 *
 * So it is written where the other things a machine must not decide are
 * written — `~/mc/intake/`, beside `unplanned-workareas.md`, in the same shape
 * for the same reason: a table rewritten whole each round, so a plan somebody
 * fixed leaves the list by itself, and `mc brief --collect` raises it.
 *
 * A machine must not decide this one. The fault is in prose a session wrote,
 * and the repair is a judgement about what it meant to say — mc's whole
 * boundary is that it does not make that call. It says which plan, and what
 * the first problem was.
 *
 * Everything here is a function of the plan list the round already read, so
 * nothing below asks git or GitHub anything.
 */

export const UNREADABLE_HEADER = [
  '# Plans on origin/main that do not parse',
  '',
  'Written by `mc run` at the end of every round: the projects whose `PLAN.json`',
  'on `origin/main` fails the schema, so the runner can hand out no step from it.',
  'The line it used to leave in `runner.log` was read by nobody, and a project',
  'can sit here for days without anything saying so.',
  '',
  'Nothing here is repaired by a machine: the fault is in what a session wrote,',
  'and what it meant to say is not mc\'s to decide. `problem` is the first of',
  'them — `mc status <project>` prints the rest.',
  '',
  '| project | repo | problem | plan |',
  '|---|---|---|---|',
  '',
].join('\n');

const cell = (value) => String(value ?? '-').replace(/\s+/gu, ' ').replace(/\|/gu, '\\|').trim() || '-';

export function unreadableRow({ project, repo, problem, path }) {
  return `| ${[project, repo, problem, path].map(cell).join(' | ')} |`;
}

/**
 * The rows for one round's reading of both `origin/main`s, in queue order.
 *
 * A plan is unreadable when it is a `PLAN.json` the schema refused — `plan`
 * null with problems. A project still on a `PLAN.md` is *not* one of these: it
 * is unmigrated, which is a different answer and already has its own, and
 * putting it here would fill the table with rows nobody has to act on.
 */
export function unreadablePlans(plans = []) {
  return plans
    .filter((plan) => plan && !plan.legacy && !plan.plan)
    .map((plan) => ({
      project: plan.project,
      repo: plan.repo,
      problem: plan.problems?.[0] || 'the plan does not parse',
      path: plan.path,
    }));
}

/** The whole file, rewritten every round rather than appended to. */
export function unreadableFile(rows) {
  return rows.length ? `${UNREADABLE_HEADER}${rows.map(unreadableRow).join('\n')}\n` : UNREADABLE_HEADER;
}
