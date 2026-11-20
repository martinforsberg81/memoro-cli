/**
 * A programme that is over, taken off main and off this machine: `mc plan
 * <programme> --archive` for a person, and the runner's archive turn for a
 * programme with a record (archive-turn.js).
 *
 * A project's plan used to be archived by `mc run` the round it said done,
 * and that is where the machinery stopped: the programme
 * above it kept `docs/project/<programme>/` — its own document and its
 * rulings — and the programme's planning directory kept two worktrees on
 * `plan/<programme>`, for ever. Nothing can decide that a programme is over;
 * a programme whose projects are all done is also exactly the place the next
 * piece of that work belongs. So this was typed, never triggered (Martin,
 * 2026-10-06) — until a programme got a record that says when it is done:
 * Martin, 2026-11-15, decided that a programme with a record is archived by
 * the system once its goals are finished and its write-back reads OK. The
 * runner calls this for such a programme and for no other, with `fence`; for
 * every other programme archiving is still a person's act.
 *
 * `fence` is the runner's guard on the local half and is passed by nobody
 * else. It is asked after each docs PR has landed and again immediately before
 * the planning session is released and before the directory moves; a reason
 * it returns (a live goal, restricted data that appeared) stops the next
 * local step. The landed docs PR stays and the programme directory remains
 * in place for a later pass. With a fence the
 * restricted data is never cleared: deleting it stays a person's act. The
 * person's call passes none and runs as it always did. `onShelved(destination)`
 * is told where the directory went (its `-2` or `-3` suffix included) the
 * moment it has moved, so the runner records it before anything else can fail.
 *
 * Two halves, in this order, and everything checked before either starts:
 *
 * 1. **main** — in each repository that holds the programme, files under
 *    `docs/project/<programme>/` that code still reads are retained. If any
 *    other files are removed, `project_log.md` gets a `closed` row in the
 *    same docs-only PR, landed through `mc merge --docs`.
 * 2. **the planning session** — the planning directory released the way
 *    `releaseWorkArea` releases any area: each worktree handed back, its
 *    branch deleted, the conversations and the directory gone with them. In
 *    layout 2 the directory is the programme's own — its projects and
 *    documents — so it is moved whole to `~/mc/archive/programs/` instead
 *    (ruling 57). Before it moves, `~/mc/restricted/<programme>/` is removed,
 *    each entry's README.md kept in the programme's `evidence/` (Martin,
 *    2026-11-09).
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
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeArchiveReceipt } from './archive-receipt.js';
import { appendRow, keptFiles, keptParagraph, relinkRemoved, remoteSlug } from './archive-plan.js';
import { listProgrammes } from './brief-collect.js';
import { FINISHED, programsGoals } from './goals.js';
import { archivedProgramsHome, programsHome, restrictedProgrammeDir } from './paths.js';
import { landingNote } from './run-plan.js';
import { isProgrammeArea } from './work-area.js';

/** `path` with the home directory folded to `~`, as every line here prints it. */
function tilde(path, home = homedir()) {
  return path && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

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
 * `isGone` for `relinkRemoved`: 'blob' for a file the archive of `dir`
 * removed, 'tree' for a directory inside `dir` it emptied, null for anything
 * else. `before` and `after` are the tracked files under `dir` either side of
 * the `git rm`. Only `dir` and what is under it can go: memoro's archives of
 * legal-readiness, surface-window-styling and language-voice (2026-10-29 to
 * 11-03) pointed README's `[docs/](docs/)` at a permalink, because `docs`
 * held a removed file and no file under `dir` was left.
 */
export function removedKind(dir, before, after) {
  const root = dir.replace(/\/+$/u, '');
  const left = new Set(after);
  const gone = before.filter((file) => !left.has(file));
  const goneSet = new Set(gone);
  const under = (files, path) => files.some((file) => file.startsWith(`${path}/`));
  const inside = (path) => path === root || path.startsWith(`${root}/`);
  return (path) => {
    if (goneSet.has(path)) return 'blob';
    return inside(path) && under(gone, path) && !under(after, path) ? 'tree' : null;
  };
}

/**
 * Whether the programme may be archived, from facts gathered elsewhere:
 * `{ ok: true }` or `{ ok: false, lines }`, each line one reason. `area` is
 * the programme's directory as the lines name it; it is passed in, never
 * looked up, so the verdict reads no directory — not even the user's ~/mc.
 */
export function archiveVerdict({
  programme, goals = [], homes = [], areaExists = false, forecast = null, area,
  restricted = [], restrictedDir = null, beside = true,
}) {
  const lines = [];
  for (const goal of goals) lines.push(`goal ${programme}/${goal.goal} is ${goal.stage || 'unreadable'} — it is finished or dropped first`);
  for (const item of forecast?.kept || []) lines.push(`${item.path} would be kept: ${item.why}`);
  for (const entry of forecast?.held_by || []) lines.push(`${area}/${entry} is not mc's to remove`);
  for (const entry of restricted) {
    if (!entry.readme) lines.push(`${restrictedDir}/${entry.name} has no README.md — say what it is and when it goes, then archive`);
  }
  if (restricted.length && !beside) lines.push(`${restrictedDir}/ holds restricted evidence and a layout 1 archive has no programme directory to keep its READMEs`);
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
export async function archiveProgramme(programme, { repos, env = process.env, areaName, areaPath, stdout, stderr, deps, now = () => new Date(), fence = null, onShelved = null }) {
  const say = (line) => stdout.write(`mc: ${line}\n`);
  const gitOut = (cwd, args) => {
    const r = deps.git(cwd, args);
    return r.ok ? r.stdout.trimEnd() : null;
  };

  /** True, with the reason said, when the fence stops the local half. */
  const fenced = (beforeMove = false) => {
    const reason = fence ? fence() : null;
    if (!reason) return false;
    const result = beforeMove ? 'the programme directory was not moved' : 'nothing local was released, deleted or moved';
    stderr.write(`mc: ${programme} is not archived any further — ${reason}; ${result}.\n`);
    return true;
  };

  const present = repos.filter((repo) => existsSync(repo.path));
  for (const repo of present) {
    if (!deps.git(repo.path, ['fetch', '-q', 'origin']).ok) {
      stderr.write(`mc: git fetch in ${repo.path} failed — origin/main may be stale\n`);
    }
  }
  const goals = programsGoals({ home: programsHome(env) })
    .filter((goal) => goal.programme === programme && !FINISHED.includes(goal.stage));
  const homes = present.filter((repo) => listProgrammes(repo, { git: gitOut }).includes(programme));
  const areaExists = existsSync(areaPath);
  const beside = isProgrammeArea(areaName, env);
  const forecast = areaExists ? deps.release(areaName, { env, dryRun: true }) : null;
  const restrictedDir = restrictedProgrammeDir(programme, env);
  const restricted = restrictedEntries(restrictedDir);

  const verdict = archiveVerdict({
    programme, goals, homes, areaExists, forecast, area: tilde(areaPath),
    restricted, restrictedDir: tilde(restrictedDir), beside,
  });
  if (!verdict.ok) {
    stderr.write(`mc: ${programme} is not archived — nothing was touched:\n`);
    for (const line of verdict.lines) stderr.write(`  ${line}\n`);
    return 1;
  }

  const inspections = [];
  for (const repo of homes) {
    const pending = openPr(repo);
    const step = pending ? { pr: pending } : await archiveOnMain(repo, programme, { deps, gitOut, say, now });
    if (!step) return 1;
    if (!step.pr) {
      if (step.keptAt) inspections.push({ ...repo, commit: step.keptAt });
      continue;
    }
    const { pr } = step;
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
    if (report.merge_commit) inspections.push({ ...repo, commit: report.merge_commit });
    say(`${repo.name}: merged #${pr} — repository archive landed`);
    if (fenced()) return 1;
  }

  if (areaExists) {
    // Fetch the results of the repository step before the last local checks.
    const inspected = beside ? inspections.filter((repo) => deps.git(repo.path, ['fetch', '-q', 'origin']).ok) : [];
    if (fenced()) return 1;
    const released = deps.release(areaName, { env, dryRun: false });
    for (const item of released.removed) say(`${item.path} — ${item.what} removed${item.branch ? ` (${item.branch})` : ''}`);
    // In layout 2 the directory is the programme's: release leaves it, and
    // what release keeps is the only thing left to refuse.
    if (released.kept.length || (!beside && (released.held_by.length || existsSync(areaPath)))) {
      stderr.write(`mc: ${tilde(areaPath)}/ is still there\n`);
      for (const item of released.kept) stderr.write(`mc:   kept ${item.repo}${item.branch ? ` (${item.branch})` : ''} — ${item.why}\n`);
      if (released.held_by?.length) stderr.write(`mc:   it still holds ${released.held_by.join(', ')}\n`);
      return 1;
    }
    if (beside) {
      // Its restricted evidence goes before the directory moves, so a failed
      // move is run again from programs/ with nothing restricted left. The
      // runner's call never clears it and checks again before the rename.
      if (!fence) {
        try {
          for (const line of clearRestricted(restricted, restrictedDir, areaPath)) say(line);
        } catch (error) {
          stderr.write(`mc: ${tilde(restrictedDir)}/ could not be cleared — ${error.message}. Run it again to carry on.\n`);
          return 1;
        }
      }
      // The programme is over, so its directory leaves programs/ whole — its
      // projects and documents with it — for archive/programs/ (ruling 57).
      let moved;
      try {
        writeArchiveReceipt(areaPath, programme, inspected, gitOut);
        if (fenced(true)) return 1;
        moved = shelveProgramme(areaPath, programme, env);
        onShelved?.(moved);
      } catch (error) {
        stderr.write(`mc: ${tilde(areaPath)}/ could not be moved to ${tilde(archivedProgramsHome(env))}/ — ${error.message}. Run it again to carry on.\n`);
        return 1;
      }
      say(`${tilde(areaPath)} — the planning session's worktrees released; the programme's directory moved to ${tilde(moved)}`);
    } else {
      say(`${tilde(areaPath)}/ removed${released.conversations.length ? `, with ${released.conversations.length} conversation(s)` : ''}`);
    }
  } else if (inspections.length && beside) {
    // No planning directory left: an older archive shelved it, or there never
    // was one, while files code reads keep docs/project/<programme>/ on main.
    // The receipt goes on the shelf, so the page stops listing the programme
    // (Martin, 2026-11-20: archived programmes leave mc ui).
    if (fenced(true)) return 1;
    try {
      const shelf = join(archivedProgramsHome(env), programme);
      mkdirSync(shelf, { recursive: true });
      writeArchiveReceipt(shelf, programme, inspections, gitOut);
      say(`${tilde(shelf)}/ — the receipt of the retained files recorded`);
    } catch (error) {
      stderr.write(`mc: the archive receipt could not be written — ${error.message}. Run it again to carry on.\n`);
      return 1;
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
 * The entries under `~/mc/restricted/<programme>/`: `{ name, readme }` for
 * each, `readme` whether it holds a README.md. A file directly there is an
 * entry with none. Empty when the directory is absent.
 */
export function restrictedEntries(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, readme: entry.isDirectory() && existsSync(join(dir, entry.name, 'README.md')) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Removes a programme's restricted evidence: each entry's README.md is copied
 * to `<area>/evidence/<entry>/RESTRICTED-README.md` first — the record of what
 * was there and why it went — then `dir` goes whole. Returns the lines to say.
 */
export function clearRestricted(entries, dir, areaPath) {
  if (!existsSync(dir)) return [];
  const lines = [];
  for (const entry of entries) {
    const to = join(areaPath, 'evidence', entry.name);
    mkdirSync(to, { recursive: true });
    copyFileSync(join(dir, entry.name, 'README.md'), join(to, 'RESTRICTED-README.md'));
    lines.push(`${tilde(join(dir, entry.name))} removed — its README kept as ${tilde(join(to, 'RESTRICTED-README.md'))}`);
  }
  rmSync(dir, { recursive: true, force: true });
  if (!entries.length) lines.push(`${tilde(dir)}/ removed — it was empty`);
  return lines;
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

/** The archive PR, the inspected commit when only retained files remain, or null on failure. */
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
    const cutFrom = gitOut(worktree, ['rev-parse', 'HEAD']);
    const pointer = gitOut(worktree, ['log', '-1', '--format=%h', 'HEAD', '--', dir]);
    // A file under the programme that code or a test reads stays where it
    // is; the rest goes. Nothing left to remove is nothing archived.
    const read = (path) => { try { return readFileSync(join(worktree, path), 'utf8'); } catch { return ''; } };
    const { kept, remove } = keptFiles(worktree, dir, { git: deps.git, read });
    for (const { file, by } of kept) say(`${repo.name}: ${file} kept — named by ${by}`);
    if (remove && !remove.length) {
      // Nothing left that may go: main is as archived as it can be (an
      // earlier run landed the rest), and the planning session goes next.
      say(`${repo.name}: every file left under ${dir} is read by code outside docs/ — nothing more to take off main`);
      return { keptAt: cutFrom };
    }
    const lines = (out) => String(out || '').split('\n').filter(Boolean);
    const before = lines(gitOut(worktree, ['ls-files', '--', dir]));
    const rm = remove ? ['rm', '-q', '--', ...remove] : ['rm', '-r', '-q', '--', dir];
    if (!deps.git(worktree, rm).ok) {
      say(`${repo.name}: git rm ${dir} failed — nothing archived`);
      return null;
    }
    // Main's links stay right: a link to a removed file points at it on
    // GitHub, at the commit this archive was cut from.
    const linkSlug = remoteSlug(gitOut(repo.path, ['remote', 'get-url', 'origin']));
    if (linkSlug && cutFrom) {
      const after = lines(gitOut(worktree, ['ls-files', '--', dir]));
      const isGone = removedKind(dir, before, after);
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
    return { pr };
  } finally {
    deps.git(repo.path, ['worktree', 'remove', '--force', worktree]);
    deps.git(repo.path, ['branch', '-D', branch]);
    rmSync(holder, { recursive: true, force: true });
  }
}
