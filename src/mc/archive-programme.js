/**
 * `mc plan <programme> --archive` — a programme that is over, taken off main
 * and off this machine.
 *
 * A project's plan used to be archived by `mc run` the round it said done,
 * and that is where the machinery stopped: the programme
 * above it kept `docs/project/<programme>/` — its own document and its
 * rulings — and the programme's planning directory kept two worktrees on
 * `plan/<programme>`, for ever. Nothing can decide that a programme is over;
 * a programme whose projects are all done is also exactly the place the next
 * piece of that work belongs. So this is typed, never triggered (Martin,
 * 2026-10-06).
 *
 * Two halves, in this order, and everything checked before either starts:
 *
 * 1. **main** — in every repository whose `docs/project/` holds the
 *    programme, the directory is removed and `project_log.md` gets one row
 *    for the programme itself (project `-`, outcome `closed`), in a
 *    docs-only PR landed through `mc merge --docs`, as the runner's archive
 *    PR is.
 * 2. **the planning session** — the planning directory released the way
 *    `mc work release` releases any area: each worktree handed back, its
 *    branch deleted, the conversations and the directory gone with them. In
 *    layout 2 the directory is the programme's own — its projects and
 *    documents — so it is moved whole to `~/mc/archive/programs/` instead
 *    (ruling 57).
 *
 * Refused, with nothing touched, while any plan under the programme is still
 * on main in either repository (a done one is the runner's to archive first),
 * while an autonomous (v2) goal has not landed or has pending follow-ups, or the programme's
 * autonomous work is anything but not started or resting at a reached planned
 * stop (`autonomousArchiveFacts`), or while release would keep anything — uncommitted work, commits main
 * lacks, a shell standing in the directory, a file somebody put there. Main
 * goes first because it is the half that can fail on the network; a planning
 * session left behind by a failed PR is the state this command started from,
 * and running it again carries on: an archive PR still open from an earlier
 * attempt is landed rather than opened twice.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendRow, keptFiles, keptParagraph, relinkRemoved, remoteSlug } from './archive-plan.js';
import { listPlans, listProgrammes } from './brief-collect.js';
import { archivedProgramsHome, programsHome, workRoot } from './paths.js';
import { autonomousPaths, readAutonomousState, readProgrammeState } from './autonomous-state.js';
import { goalCompletion } from './goal-followup.js';
import { readClaim, processAlive } from './resource-claim.js';
import { mergesPath } from './merge-queue.js';
import { readProgrammeIncidents } from './programme-recovery.js';
import { programsPlans } from './plan-source.js';
import { landingNote } from './run-plan.js';
import { tilde } from './status-project.js';
import { isProgrammeArea } from './work-area.js';

/** Every programme-archive branch starts with this — never `mc-archive-`, which the runner waits on. */
export const PROGRAMME_ARCHIVE_PREFIX = 'mc-programme-archive-';

/** `archiveOnMain`'s answer when every file left is one code reads: nothing to land, main is done. */
const KEPT_ONLY = Symbol('kept-only');

/** The project cell of a programme's own row: it is no project. */
export const PROGRAMME_ROW_PROJECT = '-';

/** The `project_log.md` row a closed programme leaves. */
export function programmeRow({ programme, date, pointer }) {
  return {
    date,
    programme,
    project: PROGRAMME_ROW_PROJECT,
    outcome: 'closed',
    summary: `Programme closed with \`mc plan ${programme} --archive\`: \`docs/project/${programme}/\` removed — its programme document and rulings are in the history (\`git log -- docs/project/${programme}\`).`,
    doc: 'none',
    pointer: pointer || '-',
  };
}

/**
 * Whether the programme may be archived, from facts gathered elsewhere:
 * `{ ok: true }` or `{ ok: false, lines }`, each line one reason. `area` is
 * the programme's directory as the lines name it; it is passed in, never
 * looked up, so the verdict reads no directory — not even the user's ~/mc.
 */
export function archiveVerdict({
  programme, plans = [], homes = [], areaExists = false, forecast = null, area, autonomy = null,
}) {
  const lines = [];
  for (const plan of plans) {
    // Autonomous execution and follow-ups are checked below, not by v1 status.
    if (plan.plan?.version === 2) continue;
    lines.push(`${plan.repo} ${programme}/${plan.project} is still on main (${plan.status || 'no status'})`
      + (plan.status === 'done' ? ' — mc run archives it first' : ''));
  }
  for (const goal of autonomy?.goals || []) {
    if (goal.done && !goal.pending_follow_ups?.length && !goal.owner && !goal.pending_work) continue;
    lines.push(`${goal.repo} ${programme}/${goal.project} is an autonomous goal `
      + (goal.problem ? `whose state is unreadable (${goal.problem})` : !goal.done ? `without verified landing (${goal.phase})`
        : goal.pending_follow_ups?.length ? `with pending follow-ups (${goal.pending_follow_ups.join(', ')})`
          : goal.owner ? `still owned by ${goal.owner}` : 'with pending work')
      + ' — its records stay with the programme');
  }
  if (autonomy?.problem) lines.push(`${programme}'s autonomous state is unreadable (${autonomy.problem}) — kept for recovery`);
  else if (autonomy?.mode && !['inactive', 'stopped'].includes(autonomy.mode)) {
    lines.push(`${programme} is ${autonomy.mode} — an autonomous programme is archived before its start or at a reached planned stop`);
  } else if (autonomy?.planner) lines.push(`${programme}'s plan session ${autonomy.planner} still holds its lease`);
  if (autonomy?.pending_work) lines.push(`${programme} has pending autonomous work — reconcile it before archiving`);
  for (const item of forecast?.kept || []) lines.push(`${item.path} would be kept: ${item.why}`);
  for (const entry of forecast?.held_by || []) lines.push(`${area}/${entry} is not mc's to remove`);
  if (!lines.length && !homes.length && !areaExists) lines.push(`no programme named ${programme} — not on main, not being planned`);
  return lines.length ? { ok: false, lines } : { ok: true };
}

/**
 * The whole command. `deps`:
 *   git(cwd, args) / gh(cwd, args) → `{ ok, stdout, stderr }`
 *   docsMerge(options)             → the `mc merge --docs` report
 *   release(name, { env, dryRun }) → `releaseWorkArea`'s result
 * Returns the exit code.
 */
export async function archiveProgramme(programme, { repos, env = process.env, areaName, areaPath, stdout, stderr, deps, now = () => new Date() }) {
  const say = (line) => stdout.write(`mc: ${line}\n`);
  const gitOut = (cwd, args) => {
    const r = deps.git(cwd, args);
    return r.ok ? r.stdout.trimEnd() : null;
  };

  const present = repos.filter((repo) => existsSync(repo.path));
  for (const repo of present) {
    if (!deps.git(repo.path, ['fetch', '-q', 'origin']).ok) {
      stderr.write(`mc: git fetch in ${repo.path} failed — origin/main may be stale\n`);
    }
  }
  const programs = () => programsPlans({ home: programsHome(env) });
  const plans = present.flatMap((repo) => listPlans(repo, { programs }))
    .filter((plan) => plan.programme === programme);
  const homes = present.filter((repo) => listProgrammes(repo, { git: gitOut }).includes(programme));
  const areaExists = existsSync(areaPath);
  const forecast = areaExists ? deps.release(areaName, { env, dryRun: true }) : null;
  const autonomy = autonomousArchiveFacts({ root: workRoot(env), programme, plans });

  const verdict = archiveVerdict({ programme, plans, homes, areaExists, forecast, area: tilde(areaPath), autonomy });
  if (!verdict.ok) {
    stderr.write(`mc: ${programme} is not archived — nothing was touched:\n`);
    for (const line of verdict.lines) stderr.write(`  ${line}\n`);
    return 1;
  }

  for (const repo of homes) {
    const pr = openPr(repo) || await archiveOnMain(repo, programme, { deps, gitOut, say, now });
    if (!pr) return 1;
    if (pr === KEPT_ONLY) continue;
    const report = await deps.docsMerge({
      repoPath: repo.path,
      pr: Number(pr),
      gh: (args) => deps.gh(repo.path, args),
      onProgress: (message) => say(`${repo.name}: ${message}`),
    });
    if (landingNote(report) !== 'merged') {
      stderr.write(`mc: ${repo.name} #${pr} did not merge — ${report?.reason || 'the docs merge said nothing'}; the planning session is kept. Run it again to carry on.\n`);
      return 1;
    }
    say(`${repo.name}: merged #${pr} — docs/project/${programme}/ is off main`);
  }

  if (areaExists) {
    const released = deps.release(areaName, { env, dryRun: false });
    for (const item of released.removed) say(`${item.path} — ${item.what} removed${item.branch ? ` (${item.branch})` : ''}`);
    // In layout 2 the directory is the programme's: release leaves it, and
    // what release keeps is the only thing left to refuse.
    const beside = isProgrammeArea(areaName, env);
    if (released.kept.length || (!beside && (released.held_by.length || existsSync(areaPath)))) {
      stderr.write(`mc: ${tilde(areaPath)}/ is still there — mc work release ${areaName} says why\n`);
      return 1;
    }
    if (beside) {
      // The programme is over, so its directory leaves programs/ whole — its
      // projects and documents with it — for archive/programs/ (ruling 57).
      let moved;
      try {
        moved = shelveProgramme(areaPath, programme, env);
      } catch (error) {
        stderr.write(`mc: ${tilde(areaPath)}/ could not be moved to ${tilde(archivedProgramsHome(env))}/ — ${error.message}. Run it again to carry on.\n`);
        return 1;
      }
      say(`${tilde(areaPath)} — the planning session's worktrees released; the programme's directory moved to ${tilde(moved)}`);
    } else {
      say(`${tilde(areaPath)}/ removed${released.conversations.length ? `, with ${released.conversations.length} conversation(s)` : ''}`);
    }
  }
  say(`${programme} archived`);
  return 0;

  /** An archive PR for this programme still open from an earlier attempt, or null. */
  function openPr(repo) {
    const r = deps.gh(repo.path, ['pr', 'list', '--state', 'open', '--json', 'number,headRefName',
      '-q', `.[] | select(.headRefName | startswith("${PROGRAMME_ARCHIVE_PREFIX}${programme}-")) | .number`]);
    const pr = r.ok ? r.stdout.trim().split('\n').filter(Boolean)[0] : null;
    if (pr) say(`${repo.name}: #${pr} is still open from an earlier attempt — landing that one`);
    return pr || null;
  }
}

/**
 * What the archive needs to know about a programme's autonomous work, read
 * under the state locks and never written: each v2 goal among `plans` with
 * its verified landing, pending follow-ups and ownership, and the
 * programme's job mode and planner lease. `{ goals: [], mode: null }` for a
 * programme without `PROGRAMME_STATE.json`. Unreadable state is a `problem`,
 * never an absent goal.
 */
export function autonomousArchiveFacts({ root, programme, plans = [] }) {
  let paths;
  try { paths = autonomousPaths(root, programme); } catch (error) {
    return { goals: plans.filter(plan => plan.plan?.version === 2).map(plan => ({
      repo: plan.repo, project: plan.project, done: false, problem: error.message,
    })), mode: null };
  }
  const candidates = new Map(plans.filter(plan => plan.plan?.version === 2).map(plan => [plan.project, plan]));
  // Unsent goals and goals absent from main still own records in the programme.
  if (existsSync(paths.dir)) for (const entry of readdirSync(paths.dir, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(paths.dir, entry.name, 'AUTONOMOUS_STATE.json')) && !candidates.has(entry.name)) {
      candidates.set(entry.name, { project: entry.name, repo: 'unknown' });
    }
  }
  const goals = [...candidates.values()].map((plan) => {
    try {
      const state = readAutonomousState(root, programme, plan.project);
      const claimPath = join(root, 'runner', 'autonomous-builds', programme, `${plan.project}.claim`);
      const claim = existsSync(claimPath) ? readClaim(claimPath) : null;
      const held = existsSync(claimPath) && (!claim || processAlive(claim.pid));
      let queued = false;
      if (existsSync(mergesPath(root))) {
        const entries = JSON.parse(readFileSync(mergesPath(root), 'utf8'));
        if (!Array.isArray(entries) || entries.some(item => !item || typeof item.repo !== 'string' || !Number.isSafeInteger(item.pr))) throw new Error('merge queue is unreadable');
        queued = entries.some(item => item.repo === state.contract.repo && item.pr === state.ownership.pr);
      }
      return { repo: state.contract.repo, project: plan.project, phase: state.phase, ...goalCompletion(state),
        owner: state.active_run?.run_id || (held ? `builder claim ${claim?.pid || 'unknown'}` : null),
        pending_work: queued || state.merge_handoff?.status === 'pending' || state.dependency_release?.status === 'waiting' };
    } catch (error) {
      return { repo: plan.repo, project: plan.project, phase: null, done: false, problem: error.message };
    }
  });
  if (!existsSync(paths.programme)) return { goals, mode: null };
  try {
    const state = readProgrammeState(root, programme); const journal = state.planner_jobs;
    return { goals, mode: journal?.mode || 'inactive', planner: journal?.lease?.actor.run_id || state.active_run?.run_id || null,
      pending_work: !!journal?.pending?.event_ids.length || !!journal?.operations.some(item => item.status === 'pending')
        || readProgrammeIncidents(root).some(item => item.status === 'open'
          && (item.owner === programme || item.dependents.some(item => item.programme === programme))) };
  } catch (error) {
    return { goals, mode: null, problem: error.message };
  }
}

/**
 * Moves a programme's directory to `archive/programs/<programme>`, or to
 * `<programme>-2`, `-3`, … when a programme of that name was archived before.
 * Returns where it went; throws when the move fails, with the directory where
 * it was.
 */
export function shelveProgramme(areaPath, programme, env = process.env) {
  const home = archivedProgramsHome(env);
  mkdirSync(home, { recursive: true });
  let to = join(home, programme);
  for (let n = 2; existsSync(to); n += 1) to = join(home, `${programme}-${n}`);
  renameSync(areaPath, to);
  return to;
}

/** The PR that removes `docs/project/<programme>/` in one repository, or null. */
async function archiveOnMain(repo, programme, { deps, gitOut, say, now }) {
  const stamp = now().toISOString();
  const branch = `${PROGRAMME_ARCHIVE_PREFIX}${programme}-${stamp.replace(/[-:]/gu, '').slice(0, 15)}`;
  const holder = mkdtempSync(join(tmpdir(), PROGRAMME_ARCHIVE_PREFIX));
  const worktree = join(holder, repo.name);
  if (!deps.git(repo.path, ['worktree', 'add', '-q', '-b', branch, worktree, 'origin/main']).ok) {
    say(`${repo.name}: could not make a worktree from origin/main — nothing archived`);
    rmSync(holder, { recursive: true, force: true });
    return null;
  }
  try {
    const dir = join('docs', 'project', programme);
    const pointer = gitOut(worktree, ['log', '-1', '--format=%h', 'origin/main', '--', dir]);
    // A file under the programme that code or a test reads stays where it
    // is; the rest goes. Nothing left to remove is nothing archived.
    const read = (path) => { try { return readFileSync(join(worktree, path), 'utf8'); } catch { return ''; } };
    const { kept, remove } = keptFiles(worktree, dir, { git: deps.git, read });
    for (const { file, by } of kept) say(`${repo.name}: ${file} kept — named by ${by}`);
    if (remove && !remove.length) {
      // Nothing left that may go: main is as archived as it can be (an
      // earlier run landed the rest), and the planning session goes next.
      say(`${repo.name}: every file left under ${dir} is read by code outside docs/ — nothing more to take off main`);
      return KEPT_ONLY;
    }
    const lines = (out) => String(out || '').split('\n').filter(Boolean);
    const before = lines(gitOut(worktree, ['ls-files', '--', dir]));
    const cutFrom = gitOut(worktree, ['rev-parse', 'HEAD']);
    const rm = remove ? ['rm', '-q', '--', ...remove] : ['rm', '-r', '-q', '--', dir];
    if (!deps.git(worktree, rm).ok) {
      say(`${repo.name}: git rm ${dir} failed — nothing archived`);
      return null;
    }
    // Main's links stay right: a link to a removed file points at it on
    // GitHub, at the commit this archive was cut from.
    const linkSlug = remoteSlug(gitOut(repo.path, ['remote', 'get-url', 'origin']));
    if (linkSlug && cutFrom) {
      const after = new Set(lines(gitOut(worktree, ['ls-files', '--', dir])));
      const gone = new Set(before.filter((file) => !after.has(file)));
      const under = (files, path) => [...files].some((file) => file.startsWith(`${path}/`));
      const isGone = (path) => (gone.has(path) ? 'blob' : (under(gone, path) && !under(after, path) ? 'tree' : null));
      let relinked = 0;
      for (const file of lines(gitOut(worktree, ['ls-files', '--', '*.md']))) {
        const { text, count } = relinkRemoved(read(file), file, { isGone, slug: linkSlug, sha: cutFrom });
        if (count) { writeFileSync(join(worktree, file), text); relinked += count; }
      }
      if (relinked) say(`${repo.name}: ${relinked} link(s) to removed files now point at ${cutFrom.slice(0, 10)} on GitHub`);
    }
    const logPath = join(worktree, 'docs', 'project', 'project_log.md');
    const logText = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    writeFileSync(logPath, appendRow(logText, programmeRow({ programme, date: stamp.slice(0, 10), pointer })));

    const slug = remoteSlug(gitOut(repo.path, ['remote', 'get-url', 'origin']));
    const title = `Archive programme ${programme}`;
    const body = [
      `\`mc plan ${programme} --archive\`: no plan under the programme is left on main,`,
      `so \`docs/project/${programme}/\` is removed and \`docs/project/project_log.md\``,
      'carries one row for the programme itself. The history is the record —',
      `\`git log -- docs/project/${programme}\` still answers every question the`,
      'removed directory could.',
      ...keptParagraph(kept),
    ].join('\n');
    deps.git(worktree, ['add', '-A']);
    if (!deps.git(worktree, ['commit', '-q', '-m', title, '-m', body]).ok
      || !deps.git(worktree, ['push', '-q', '-u', 'origin', 'HEAD']).ok) {
      say(`${repo.name}: commit or push failed — nothing archived`);
      return null;
    }
    const created = deps.gh(worktree, ['pr', 'create', '--base', 'main', '--head', branch, '--title', title, '--body', body]);
    const pr = /(\d+)\s*$/u.exec(created.stdout.trim())?.[1] || null;
    if (!pr) {
      say(`${repo.name}: the PR could not be opened (${created.stderr.trim().split('\n').at(-1) || 'no number'})`);
      return null;
    }
    say(`${repo.name}: opened ${slug ? `https://github.com/${slug}/pull/${pr}` : `#${pr}`}`);
    return pr;
  } finally {
    deps.git(repo.path, ['worktree', 'remove', '--force', worktree]);
    deps.git(repo.path, ['branch', '-D', branch]);
    rmSync(holder, { recursive: true, force: true });
  }
}
