/**
 * The manager's automatic turn, model-free (mc-run.md, "Manager turns").
 *
 * The runner starts the unattended manager itself for one turn, curation, when
 * an area repository's main has moved since the last one read it. Everything
 * here is what the runner decides around that session without a model: whether
 * the turn is due, the state file that records it, the worktrees it stands in
 * and the prompt it is given. The runner (`run.js`) supplies its own file reads,
 * lock and git, so a fixture drives all of it in memory. A manual `mc manager
 * --headless` run (`manager-turn.js`) is another thing and shares none of this.
 *
 * The manager creates no programme and has no horizon turn. A desk item of kind
 * `manager` or a state file under `runner/manager-turn/horizon/` left from the
 * removed horizon turn is only read: `readHorizonState` gives such an item its
 * label, and the item closes by source.
 */
import { join } from 'node:path';
import { readAreas } from './areas.js';

export const MANAGER_SCHEMA = 'mc-manager-turn';
export const MANAGER_VERSION = 1;
export const MANAGER_ITEM_KIND = 'manager';
/** The claim the curation turn takes: one manager turn at a time. */
export const MANAGER_CLAIM = 'manager';
/** A curation turn starts at most once in this long. */
export const CURATION_CADENCE_MS = 24 * 60 * 60 * 1000;

/** `runner/manager-turn/horizon/<slug>.json` under the work root: the state the removed horizon turn left, read for an old item's label. */
export const horizonStatePath = (root, slug) => join(root, 'runner', 'manager-turn', 'horizon', `${slug}.json`);
/** `runner/manager-turn/curation.json` under the work root. */
export const curationStatePath = (root) => join(root, 'runner', 'manager-turn', 'curation.json');
/** `runner/work/manager-curation/<stamp>`: one curation turn's branch worktrees, one per repository that declares areas. */
export const curationWorktreesDir = (root, stamp, kind = 'manager-curation') => join(root, 'runner', 'work', kind, stamp);

const lastLine = (text) => String(text ?? '').trim().split('\n').at(-1) || '';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * A state file: `{ status: 'none' }` when it is not there, `{ status: 'valid', state }`, or `{ status:
 * 'unreadable', problem }`. A file that is there and is not the schema is unreadable, never "no failures".
 */
function readState({ path, read, check }) {
  let text;
  try { text = read(path); } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { status: 'none' };
    return { status: 'unreadable', problem: `cannot be read: ${error.message}` };
  }
  if (text === null || text === undefined) return { status: 'none' };
  let state;
  try { state = JSON.parse(text); } catch (error) { return { status: 'unreadable', problem: `not JSON: ${error.message}` }; }
  const problems = [];
  if (!isObject(state)) problems.push('not an object');
  else {
    if (state.schema !== MANAGER_SCHEMA) problems.push(`schema is not ${MANAGER_SCHEMA}`);
    if (state.version !== MANAGER_VERSION) problems.push(`version is not ${MANAGER_VERSION}`);
    problems.push(...check(state));
  }
  return problems.length ? { status: 'unreadable', problem: problems.join('; ') } : { status: 'valid', state };
}

/** A horizon's state file, left by the removed horizon turn: `{ schema, version, kind: 'horizon', horizon, failures: [{ at, reason, log }], items: [{ id, opened_at }] }`. */
export function readHorizonState({ root, slug, read }) {
  return readState({ path: horizonStatePath(root, slug), read, check: (state) => {
    const problems = [];
    if (state.kind !== 'horizon') problems.push('kind is not horizon');
    if (state.horizon !== slug) problems.push(`horizon is not ${slug}`);
    if (!Array.isArray(state.failures) || !state.failures.every((f) => f && typeof f.at === 'string' && typeof f.reason === 'string')) problems.push('failures is not a list of { at, reason, log }');
    if (!Array.isArray(state.items) || !state.items.every((item) => item && typeof item.id === 'string' && typeof item.opened_at === 'string')) problems.push('items is not a list of { id, opened_at }');
    return problems;
  } });
}

/** The curation state file: `{ schema, version, kind: 'curation', started, bases: { <repo>: <commit> } }`; `started` is null before the first turn. */
export function readCurationState({ root, read }) {
  return readState({ path: curationStatePath(root), read, check: (state) => {
    const problems = [];
    if (state.kind !== 'curation') problems.push('kind is not curation');
    if (state.started !== null && !(typeof state.started === 'string' && Number.isFinite(Date.parse(state.started)))) problems.push('started is not an instant or null');
    if (!isObject(state.bases) || !Object.values(state.bases).every((base) => typeof base === 'string')) problems.push('bases is not { <repo>: <commit> }');
    return problems;
  } });
}

/** The commit `origin/main` of `repo` names now, or null. */
export function headOf({ git, repo }) {
  const head = git(repo.path, ['rev-parse', '--verify', '-q', 'origin/main']);
  const sha = head.ok ? String(head.stdout ?? '').trim() : '';
  return sha || null;
}

/**
 * The repositories that declare areas, read at origin/main: `{ repos: [{ name, path, areas }], problems }`. A
 * repository whose declaration cannot be read is a problem, said by the caller, and is left out.
 */
export function areaRepositories({ repos, git }) {
  const found = []; const problems = [];
  for (const repo of repos) {
    const read = readAreas(repo.path, { git, repo: repo.name });
    if (!read.ok) problems.push(read.reason);
    else if (read.declared) found.push({ ...repo, areas: read.areas });
  }
  return { repos: found, problems };
}

/**
 * Whether a curation turn is due (D7): `{ due: true }`, or `{ due: false, reason, notice }`. `repos()` is the
 * repositories that declare areas and `heads()` is `{ <repo>: <commit> }` for them; both are read only when the
 * 24 hours since the last start have passed, so a tick inside them costs no git. The first turn is due at once.
 */
export function curationDue({ state, now, repos, heads }) {
  if (state.status === 'unreadable') {
    return { due: false, reason: 'its state is unreadable', notice: `manager: ${curationStatePath('<work root>').replace('<work root>/', '')} is unreadable (${state.problem}) — no curation turn is started until it is repaired or removed` };
  }
  const started = state.status === 'valid' && state.state.started ? Date.parse(state.state.started) : null;
  if (started !== null && now.getTime() - started < CURATION_CADENCE_MS) return { due: false, reason: 'one started in the last 24 hours', notice: null };
  const declaring = repos();
  if (!declaring.length) return { due: false, reason: 'no repository declares areas', notice: null };
  if (state.status === 'none') return { due: true, moved: declaring.map((repo) => repo.name) };
  const read = heads();
  const moved = declaring.filter((repo) => read[repo.name] && read[repo.name] !== state.state.bases[repo.name]);
  if (!moved.length) return { due: false, reason: 'no area repository has moved since the last curation', notice: null };
  return { due: true, moved: moved.map((repo) => repo.name) };
}

/** The curation state after a turn starts (`started` now, the bases as they were) or succeeds (the bases the turn read). */
export function curationState({ started, bases }) {
  return { schema: MANAGER_SCHEMA, version: MANAGER_VERSION, kind: 'curation', started, bases };
}

/* ------------------------------------------------------------------ checkouts */

const checkoutClean = ({ git, path }) => {
  const status = git(path, ['status', '--porcelain']);
  return status.ok && String(status.stdout ?? '').trim() === '';
};
const reachable = ({ git, path, ref }) => git(path, ['merge-base', '--is-ancestor', 'HEAD', ref]).ok;

/**
 * The curation turn's worktrees: for each repository that declares areas a branch `manager/curation-<stamp>` made
 * from a fresh origin/main in its own worktree. `{ ok: true, paths, branches, heads }` — `heads` the commit each
 * branch starts at, which is what the turn read — or `{ ok: false, reason, fetch? }`, with what was made removed.
 */
export function setUpCurationWorktrees({ git, root, stamp, repos, kind = 'manager-curation' }) {
  const base = curationWorktreesDir(root, stamp, kind);
  const paths = {}; const branches = {}; const heads = {}; const made = [];
  const undo = () => { for (const repo of made) { git(repo.path, ['worktree', 'remove', '--force', paths[repo.name]]); git(repo.path, ['branch', '-D', branches[repo.name]]); } };
  for (const repo of repos) {
    const fetched = git(repo.path, ['fetch', '--quiet', 'origin']);
    if (!fetched.ok) return { ok: false, fetch: true, reason: `fetch ${repo.name}: ${lastLine(fetched.stderr) || 'git failed'}` };
  }
  for (const repo of repos) {
    const path = join(base, repo.name);
    const branch = kind === 'manager-curation' ? `manager/curation-${stamp}` : `learning/${stamp}`;
    const added = git(repo.path, ['worktree', 'add', '-q', '-b', branch, path, 'origin/main']);
    if (!added.ok) { undo(); return { ok: false, reason: `setup: ${lastLine(added.stderr) || 'git worktree add failed'}` }; }
    paths[repo.name] = path; branches[repo.name] = branch; made.push(repo);
    heads[repo.name] = headOf({ git, repo });
  }
  return { ok: true, paths, branches, heads };
}

/**
 * The curation worktrees after the session: one that holds nothing (clean, no commit beyond origin/main) or whose
 * branch is published (clean, HEAD on `origin/<branch>`) is removed, with its branch; any other is kept. Returns
 * `{ removed: [repo], kept: [{ repo, path, why }] }`.
 */
export function settleCurationWorktrees({ git, repos, paths, branches }) {
  const removed = []; const kept = [];
  for (const repo of repos) {
    const path = paths[repo.name]; const branch = branches[repo.name];
    if (!checkoutClean({ git, path })) { kept.push({ repo: repo.name, path, why: 'it holds uncommitted work' }); continue; }
    const ahead = git(path, ['rev-list', '--count', 'origin/main..HEAD']);
    const empty = ahead.ok && String(ahead.stdout ?? '').trim() === '0';
    const published = !empty && git(path, ['rev-parse', '--verify', '-q', `origin/${branch}`]).ok && reachable({ git, path, ref: `origin/${branch}` });
    if (!empty && !published) { kept.push({ repo: repo.name, path, why: `its branch ${branch} is not published` }); continue; }
    if (!git(repo.path, ['worktree', 'remove', path]).ok) { kept.push({ repo: repo.name, path, why: 'it could not be removed' }); continue; }
    git(repo.path, ['branch', '-D', branch]);
    removed.push(repo.name);
  }
  return { removed, kept };
}

/* -------------------------------------------------------------------- prompts */

/**
 * The area pages of the checkouts: for each repository, the `page` of every declared area that has one, as a path
 * in its read checkout. `{ repo, id, path }`.
 */
export function areaPages({ repos, checkouts }) {
  return repos.flatMap((repo) => (repo.areas ?? []).filter((area) => typeof area.page === 'string' && checkouts[repo.name])
    .map((area) => ({ repo: repo.name, id: area.id, path: join(checkouts[repo.name], area.page) })));
}

/**
 * The proposals the curation prompt lists, each file with its area and age: every direct `.md` in every area's
 * `~/mc/areas/<repo>/<area>/proposals/` (`areas` is `~/mc/areas`), never an archive.
 */
export function proposalBacklog({ areas, list, modified }) {
  const shown = (dir) => list(dir).filter((name) => !name.startsWith('.')).sort();
  const folders = shown(areas).flatMap((repo) => shown(join(areas, repo)).map((slug) => ({ area: `${repo}/${slug}`, folder: join(areas, repo, slug, 'proposals') })));
  return folders.flatMap(({ area, folder }) => shown(folder).filter((name) => name.endsWith('.md')).map((name) => ({ area, path: join(folder, name), at: modified(join(folder, name)) })))
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || (a.path < b.path ? -1 : 1));
}

/** What the curation session is told: the worktrees it works in, what it may write and where, and the backlog. */
export function curationPrompt({ paths, branches, pages, backlog, moved = [] }) {
  const trees = Object.entries(paths).map(([repo, path]) => `${repo}: \`${path}\` on branch ${branches[repo]}`).join('; ');
  const where = pages.length ? pages.map((page) => `${page.repo} ${page.id}: \`${page.path}\``).join('; ') : '(none)';
  const list = backlog.length ? backlog.map((entry) => `- ${entry.area ? `${entry.area}: ` : ''}${entry.path}`).join('\n') : '(no proposals)';
  const since = moved.length ? ` Main has moved since the last curation in: ${moved.join(', ')}.` : '';
  return `You are the headless manager, curating the area texts with nobody present.${since} Your worktrees, made from origin/main, are ${trees}. The area pages are ${where}. `
    + `Bring each page's Closer, Store and Standards into line with what the code and \`docs/technical/\` now say. Change nothing under ## Aim of a page and nothing outside \`docs/technical/\`. A line holding a dated decision of Martin's you change only when a later dated decision of his on the same page, which you keep as it is, and the code say otherwise: correct it to agree with them and keep its citation; \`mc publish\` refuses anything else. `
    + `Publish each worktree you changed with plain \`mc publish\` (never \`--no-merge\`): it opens the pull request and queues it for the merger, whose docs form lands a pull request whose every file is under docs/. A worktree you did not change needs nothing, and a turn that finds nothing to change is a success. What waits on Martin goes to the desk with \`mc martin propose\`; do not make a horizon or a goal. `
    + `Proposals in the areas, oldest first — bring what waits on Martin to the desk with \`mc martin propose\`:\n${list}`;
}
