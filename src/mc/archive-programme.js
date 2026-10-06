/**
 * `mc plan <programme> --archive` — a programme that is over, taken off main
 * and off this machine.
 *
 * A project is archived by `mc run` the round its plan says done
 * (archive-plan.js), and that is where the machinery stopped: the programme
 * above it kept `docs/project/<programme>/` — its own document and its
 * rulings — and `~/mc/plan/<programme>/` kept two worktrees on
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
 * 2. **the planning session** — `~/mc/plan/<programme>/` released the way
 *    `mc work release` releases any area: each worktree handed back, its
 *    branch deleted, the conversations and the directory gone with them.
 *
 * Refused, with nothing touched, while any plan under the programme is still
 * on main in either repository (a done one is the runner's to archive first),
 * or while release would keep anything — uncommitted work, commits main
 * lacks, a shell standing in the directory, a file somebody put there. Main
 * goes first because it is the half that can fail on the network; a planning
 * session left behind by a failed PR is the state this command started from,
 * and running it again carries on: an archive PR still open from an earlier
 * attempt is landed rather than opened twice.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendRow, remoteSlug } from './archive-plan.js';
import { listPlans, listProgrammes } from './brief-collect.js';
import { landingNote } from './run-plan.js';

/** Every programme-archive branch starts with this — never `mc-archive-`, which the runner waits on. */
export const PROGRAMME_ARCHIVE_PREFIX = 'mc-programme-archive-';

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
 * `{ ok: true }` or `{ ok: false, lines }`, each line one reason.
 */
export function archiveVerdict({ programme, plans = [], homes = [], areaExists = false, forecast = null }) {
  const lines = [];
  for (const plan of plans) {
    lines.push(`${plan.repo} ${programme}/${plan.project} is still on main (${plan.status || 'no status'})`
      + (plan.status === 'done' ? ' — mc run archives it first' : ''));
  }
  for (const item of forecast?.kept || []) lines.push(`${item.path} would be kept: ${item.why}`);
  for (const entry of forecast?.held_by || []) lines.push(`~/mc/plan/${programme}/${entry} is not mc's to remove`);
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
  const plans = present.flatMap((repo) => listPlans(repo, { git: gitOut }))
    .filter((plan) => plan.programme === programme);
  const homes = present.filter((repo) => listProgrammes(repo, { git: gitOut }).includes(programme));
  const areaExists = existsSync(areaPath);
  const forecast = areaExists ? deps.release(areaName, { env, dryRun: true }) : null;

  const verdict = archiveVerdict({ programme, plans, homes, areaExists, forecast });
  if (!verdict.ok) {
    stderr.write(`mc: ${programme} is not archived — nothing was touched:\n`);
    for (const line of verdict.lines) stderr.write(`  ${line}\n`);
    return 1;
  }

  for (const repo of homes) {
    const pr = openPr(repo) || await archiveOnMain(repo, programme, { deps, gitOut, say, now });
    if (!pr) return 1;
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
    if (released.kept.length || released.held_by.length || existsSync(areaPath)) {
      stderr.write(`mc: ~/mc/plan/${programme}/ is still there — mc work release ${areaName} says why\n`);
      return 1;
    }
    say(`~/mc/plan/${programme}/ removed${released.conversations.length ? `, with ${released.conversations.length} conversation(s)` : ''}`);
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
    if (!deps.git(worktree, ['rm', '-r', '-q', '--', dir]).ok) {
      say(`${repo.name}: git rm ${dir} failed — nothing archived`);
      return null;
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
