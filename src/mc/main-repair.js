/**
 * Main's red, repaired as work of its own (Martin, 2026-11-10).
 *
 * A merge round judges the pull request against main. When a red in files the
 * change leaves alone is red by the same test names at the base too
 * (`repo-gate.js`, `redAtFrozenBase`), it is main's: the round goes on past it,
 * the pull request is not blamed and no mend is started for it. Main's red is a
 * side matter for the merge, but it is not left lying: the round's report
 * carries `main_repair`, and the merger asks for a repair here.
 *
 * A repair is an ordinary goal in the `main-health` programme, in `build ·
 * ready` with its criteria, so the runner takes it in a lane like any other
 * goal: its own worktree on `goal/<goal>` from origin/main, build, review and
 * the measured round. One repair per red file at a time: a file an unfinished
 * repair already names asks for nothing new, so every round that meets the same
 * red until the repair lands is quiet. Before 2026-11-10 the red went to each
 * blocked pull request's mend, which may not repair another programme's code,
 * and five unrelated goals reached `merge · Martin` on one fixture
 * (memoro#15168, repaired by memoro#15203).
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { writeFileAtomic } from './atomic-write.js';
import { FINISHED, GOAL_FILE, GOALS_DIR, LOG_FILE, appendLog, goalDirIn, listDirsOf, logStamp, parseGoal, readTextOrNull, renderGoal } from './goals.js';
import { programsHome } from './paths.js';

/** The programme every repair of main's red is a goal in. */
export const MAIN_HEALTH_PROGRAMME = 'main-health';

/** How much of each red test's error a repair's contract quotes. */
const ERROR_LINES = 6;

/** The goal name for a repair: the repository, the first file's stem and a digest of the set. */
export function mainRepairGoalName(repo, files) {
  const sorted = [...new Set(files)].sort();
  const stem = String(sorted[0] || 'main').split('/').pop().replace(/\.test\.[cm]?js$/u, '').replace(/[^a-z0-9]+/giu, '-').toLowerCase().replace(/^-+|-+$/gu, '').slice(0, 40) || 'main';
  const digest = createHash('sha256').update(`${repo}\n${sorted.join('\n')}`).digest('hex').slice(0, 8);
  return `${String(repo).toLowerCase().replace(/[^a-z0-9]+/gu, '-')}-${stem}-${digest}`;
}

/**
 * The unfinished repair goals of `repo` that already name one of `files`, from
 * the `main-health` programme as it is on disk now.
 */
export function openRepairsFor({ home, repo, files, list = listDirsOf, read = readTextOrNull }) {
  const dir = join(home, MAIN_HEALTH_PROGRAMME, GOALS_DIR);
  return list(dir).flatMap((goal) => {
    const parsed = parseGoal(read(join(dir, goal, GOAL_FILE)) ?? '');
    if (parsed.problems || FINISHED.includes(parsed.stage) || !(parsed.repos || []).includes(repo)) return [];
    const said = (parsed.contract || []).join('\n');
    return files.some((file) => said.includes(file)) ? [goal] : [];
  });
}

/** The contract a repair goal is written with. */
function repairContract({ repo, base, files, tests, pr }) {
  const where = pr ? `${repo}#${pr}` : repo;
  const named = tests.map((test) => {
    const error = (test.error || []).slice(0, ERROR_LINES).join('\n    ');
    return `- ${test.file} › ${test.name}${error ? `\n    ${error}` : ''}`;
  });
  return [
    `Main is red. The merge round of ${where} found these tests red on its candidate and red by the same names at the base ${base} run alone, in files the pull request does not touch: ${files.join(', ')}. The round let the pull request through (docs/technical/mc-merge.md, "Main's red is found by the merge round").`,
    `Red at ${base}:\n${named.join('\n')}`,
    'Find the cause from origin/main: which landing broke it (git log on the code and fixtures the failing tests reach) and whether the production code or the test disagrees with the repository\'s technical standards. Repair in the owning code or fixture so the failing assertions hold again. Never weaken, skip or delete a test or lower a threshold to make it green.',
  ];
}

/**
 * Ask for a repair of main's red in `repo`: write a `main-health` goal for the
 * red `files` unless an unfinished one already names one of them. Returns
 * `{ created: name }`, `{ open: [names] }` or `{ skipped: reason }`; never throws.
 */
export function requestMainRepair({
  repo, base, files, tests = [], pr = null, home = programsHome(), now = () => new Date(),
  list = listDirsOf, read = readTextOrNull, write = writeFileAtomic,
}) {
  try {
    const red = [...new Set(files || [])].filter(Boolean).sort();
    if (!repo || !base || !red.length) return { skipped: 'nothing to repair' };
    if (!list(home).includes(MAIN_HEALTH_PROGRAMME)) return { skipped: `no programme ${MAIN_HEALTH_PROGRAMME} under ${home}` };
    const open = openRepairsFor({ home, repo, files: red, list, read });
    if (open.length) return { open };
    const name = mainRepairGoalName(repo, red);
    const dir = goalDirIn(home, MAIN_HEALTH_PROGRAMME, name);
    // A finished repair of the same set and a red that came back: a new goal, dated.
    const goal = list(join(home, MAIN_HEALTH_PROGRAMME, GOALS_DIR)).includes(name)
      ? `${name}-${logStamp(now()).replace(/[^0-9]/gu, '').slice(0, 12)}` : name;
    const goalDir = goal === name ? dir : goalDirIn(home, MAIN_HEALTH_PROGRAMME, goal);
    const created = now().toISOString().replace(/\.\d{3}Z$/u, 'Z');
    const ownTests = tests.filter((test) => red.includes(test.file));
    write(join(goalDir, GOAL_FILE), renderGoal({
      stage: 'build', status: 'ready', phase: 1, repos: [repo], class: 'fast', created,
      title: `Repair main's red: ${red.join(', ')}`.slice(0, 200),
      goal: [`origin/main of ${repo} is green again in ${red.join(', ')}, by a repair of the cause.`],
      contract: repairContract({ repo, base, files: red, tests: ownTests, pr }),
      out_of_scope: ['Any change the failing tests do not need. Another red found on the way is its own repair: the merge round asks for it when it meets it.'],
      success_criteria: [
        {
          criterion: `The named tests pass on this goal's branch integrated with origin/main: ${red.join(', ')}.`,
          check: `From this goal's ${repo} worktree, integrated with origin/main, run mc gate ${red.join(' ')}; require GREEN with none of these files SETTLED.`,
          met: false,
        },
        {
          criterion: 'The repair keeps every assertion and passes the change\'s own affected selection.',
          check: 'git diff origin/main shows no test skipped, weakened or deleted and no threshold lowered; mc gate --whole-selection on the final worktree is GREEN.',
          met: false,
        },
      ],
      documents: [],
    }));
    write(join(goalDir, LOG_FILE), appendLog('', {
      at: logStamp(now()), tool: 'runner', model: null, role: null, stage: 'build', status: 'ready',
      done: `created by the merger: main red at ${String(base).slice(0, 12)}${pr ? `, found by the round of ${repo}#${pr}` : ''}`,
      comment: null, next: null,
    }));
    return { created: goal };
  } catch (error) {
    return { skipped: error?.message || String(error) };
  }
}
