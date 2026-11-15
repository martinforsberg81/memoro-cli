/**
 * The manager's two automatic turns, model-free (mc-run.md, "Manager turns").
 *
 * The runner starts the unattended manager itself, twice over: a horizon turn
 * when an open horizon has no open programme record naming it, and a curation
 * turn when an area repository's main has moved since the last one read it.
 * Everything here is what the runner decides around those sessions without a
 * model: whether a turn is due, the state files that count what happened, the
 * success check after a horizon turn, the desk item the second failure opens,
 * the checkouts the sessions stand beside and the prompts they are given. The
 * runner (`run.js`) supplies its own file reads, lock and git, so a fixture
 * drives all of it in memory. A manual `mc manager --headless` run
 * (`manager-turn.js`) is another thing and shares none of this.
 */
import { join } from 'node:path';
import { deskItemId } from './desk-items.js';
import { horizonsDir } from './desk-horizons.js';
import { NAME_RE } from './plan-schema.js';
import { readRecord } from './programme-record.js';
import { FAILURES_TO_ITEM } from './programme-turn.js';
import { readAreas } from './areas.js';

export const MANAGER_SCHEMA = 'mc-manager-turn';
export const MANAGER_VERSION = 1;
export const MANAGER_ITEM_KIND = 'manager';
/** The one claim both turns take: they never run side by side. */
export const MANAGER_CLAIM = 'manager';
/** A curation turn starts at most once in this long. */
export const CURATION_CADENCE_MS = 24 * 60 * 60 * 1000;

/** `manager:<slug>`: a desk item's reference and a horizon turn's name in a current record and a runs.tsv row. */
export const managerReference = (slug) => `manager:${slug}`;
/** The text item the horizon ending names: `horizon:<slug>`. */
export const horizonTextName = (slug) => `horizon:${slug}`;

/** `runner/manager-turn/horizon/<slug>.json` under the work root. */
export const horizonStatePath = (root, slug) => join(root, 'runner', 'manager-turn', 'horizon', `${slug}.json`);
/** `runner/manager-turn/curation.json` under the work root. */
export const curationStatePath = (root) => join(root, 'runner', 'manager-turn', 'curation.json');
/** `runner/work/manager-horizon-<slug>`: the horizon turn's read checkouts, one per repository that declares areas. */
export const horizonCheckoutsDir = (root, slug) => join(root, 'runner', 'work', `manager-horizon-${slug}`);
/** `runner/work/manager-curation/<stamp>`: one curation turn's branch worktrees, one per repository that declares areas. */
export const curationWorktreesDir = (root, stamp) => join(root, 'runner', 'work', 'manager-curation', stamp);

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

/** A horizon's state file: `{ schema, version, kind: 'horizon', horizon, failures: [{ at, reason, log }], items: [{ id, opened_at }] }`. */
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

/** The failures since the last item opened: the count the second-failure rule reads. */
export function failuresSinceItem(state) {
  const since = state.items.map((item) => item.opened_at).sort().at(-1) ?? null;
  return state.failures.filter((failure) => since === null || failure.at > since);
}

/**
 * Every programme record under `home`: the valid open ones as `{ programme, record }`, the invalid ones as `{
 * programme, problems }`. A record with state done is neither; a directory without a record is skipped.
 */
export function scanRecords({ home, list, read }) {
  const open = []; const invalid = [];
  for (const programme of list(home).filter((name) => NAME_RE.test(name)).sort()) {
    const found = readRecord(join(home, programme), { read });
    if (found.status === 'valid' && found.record.state === 'open') open.push({ programme, record: found.record });
    else if (found.status === 'invalid') invalid.push({ programme, problems: found.problems });
  }
  return { open, invalid };
}

const openItem = (item) => item.state !== 'closed';

/** Whether an open desk item holds `slug` back: the text `horizon:<slug>` or the manager item `manager:<slug>`. */
export function horizonHeldByItem(items, slug) {
  return items.some((item) => openItem(item) && ((item.kind === 'text' && item.text === horizonTextName(slug)) || (item.kind === MANAGER_ITEM_KIND && item.reference === managerReference(slug))));
}

/**
 * Whether a horizon turn is due now (D4), read through the runner's own `list`/`read`: `{ slug, reason: null,
 * notices }` for the first open horizon, in position order, that needs one, or `{ slug: null, reason, notices }`.
 * `notices` is `[{ key, text }]`: what the runner says once while it lasts (an invalid record that holds every
 * horizon turn, a state file that cannot be read). `horizons` are the open horizons in position order, `items` the
 * desk items.
 */
export function horizonDue({ root, home, list, read, horizons, items = [] }) {
  const notices = [];
  const { open, invalid } = scanRecords({ home, list, read });
  if (invalid.length) {
    const names = invalid.map((entry) => entry.programme).join(', ');
    notices.push({ key: 'records', text: `manager: no horizon turn is started — the record of ${names} is invalid (mc programs show ${invalid[0].programme}); it holds every horizon turn until it is repaired` });
    return { slug: null, reason: 'a programme record is invalid', notices };
  }
  const named = new Set(open.map((entry) => entry.record.horizon).filter(Boolean));
  for (const horizon of horizons) {
    if (horizon.state !== 'open') continue;
    const slug = horizon.slug;
    if (named.has(slug)) continue;
    if (horizonHeldByItem(items, slug)) continue;
    const state = readHorizonState({ root, slug, read });
    if (state.status === 'unreadable') {
      notices.push({ key: `state:${slug}`, text: `manager: ${horizonStatePath('<work root>', slug).replace('<work root>/', '')} is unreadable (${state.problem}) — no horizon turn is started for ${slug} until it is repaired or removed` });
      continue;
    }
    return { slug, reason: null, notices };
  }
  return { slug: null, reason: 'no open horizon needs a programme', notices };
}

/**
 * What a horizon turn left (D5), judged without a model and without timestamps: `{ ok: true, how }` when a valid
 * open record now names the horizon, the horizon is no longer open or the text item `horizon:<slug>` is open;
 * otherwise `{ ok: false, reason }`. `horizon` is the horizon read again (null when it cannot be read).
 */
export function horizonOutcome({ slug, home, list, read, horizon, items = [] }) {
  const { open, invalid } = scanRecords({ home, list, read });
  if (open.some((entry) => entry.record.horizon === slug)) return { ok: true, how: 'programme' };
  if (horizon && horizon.state !== 'open') return { ok: true, how: horizon.state };
  if (items.some((item) => openItem(item) && item.kind === 'text' && item.text === horizonTextName(slug))) return { ok: true, how: 'text' };
  const why = invalid.length ? `; the record of ${invalid.map((entry) => entry.programme).join(', ')} is invalid` : '';
  return { ok: false, reason: `the session ended with no open programme record naming ${slug}, the horizon still open and no open text item ${horizonTextName(slug)}${why}` };
}

/**
 * A horizon turn that ended in none of the three ways, counted (D12). Under the lock, on the state read inside it:
 * the failure is added, and the second since the last item opens the item — the first is `prepared` with a
 * `prepared.md` for the decision lane, a later one `for-martin` with a Swedish `brief.md`. Returns `{ count, item }`
 * (`item` null below the limit), or throws when the state file is unreadable: nothing is written then.
 */
export function recordHorizonFailure({ root, slug, reason, log = null, at, read, write, writeJson, lock, env, itemDirectory }) {
  return lock(root, () => {
    const found = readHorizonState({ root, slug, read });
    if (found.status === 'unreadable') throw new Error(`${horizonStatePath(root, slug)} is unreadable (${found.problem})`);
    const state = found.status === 'valid' ? found.state : { schema: MANAGER_SCHEMA, version: MANAGER_VERSION, kind: 'horizon', horizon: slug, failures: [], items: [] };
    state.failures.push({ at, reason, log });
    const recent = failuresSinceItem(state);
    let item = null;
    if (recent.length >= FAILURES_TO_ITEM) {
      const reference = managerReference(slug);
      const first = state.items.length === 0;
      const id = deskItemId(MANAGER_ITEM_KIND, reference, at);
      item = { schema: 'mc-desk-item', version: 1, id, kind: MANAGER_ITEM_KIND, reference, source_at: at, opened_at: at,
        state: first ? 'prepared' : 'for-martin', sort: 'mechanical', reversible: first ? null : false, due_at: null, outcome: null };
      const dir = itemDirectory(item, env);
      // The text is written before the item names it: a decision pass that finds the item finds what it reads.
      if (first) write(join(dir, 'prepared.md'), preparedText({ slug, failures: recent, item }));
      else write(join(dir, 'brief.md'), briefText({ slug, failures: recent }));
      writeJson(join(dir, 'item.json'), item);
      state.items.push({ id, opened_at: at });
    }
    writeJson(horizonStatePath(root, slug), state);
    return { count: recent.length, item };
  }, { strict: true, name: 'manager-turn' });
}

const failureLines = (failures) => failures.map((failure) => `- ${failure.at}: ${failure.reason}${failure.log ? ` (session log: ${failure.log})` : ''}`).join('\n');

/** What the decision session reads for the first item: the turns that failed, and where to look. */
function preparedText({ slug, failures, item }) {
  return `# Horizon ${slug}: the manager's horizon turn failed twice\n\n`
    + `The runner's horizon turn for the open horizon ${slug} ended twice without a programme record naming it, without the horizon reached or dropped and without an open text item horizon:${slug}. `
    + `Nothing was asked of Martin; this is a mechanical failure to repair within reach.\n\n`
    + `## The failures\n${failureLines(failures)}\n\n`
    + `## Where to look\n- The horizon: mc martin horizon show ${slug}.\n`
    + `- The turn's state: runner/manager-turn/horizon/${slug}.json under the work root.\n`
    + `- Item: ${item.id}.\n\n`
    + `## What closes it\nRepair what failed, then close the item (--by decision) so the runner starts the horizon turn again. `
    + `A text of Martin's that would have to change goes to a brief instead.\n`;
}

/** The brief a later item carries: the turn failed again after a decision pass closed the first. Swedish, as the desk reads it. */
function briefText({ slug, failures }) {
  return `## Vad det gäller\nManagerns horisontpass för horisonten ${slug} slutade igen utan att något program, ingen nådd horisont och inget textärende ${horizonTextName(slug)} fanns efteråt; arbetet kan inte fortsätta automatiskt.\n\n`
    + `## Alternativ och konsekvenser\n- Undersök underlaget: horisontpasset kan köras igen när felet är löst.\n- Låt horisonten vänta: den får inget program.\n\n`
    + `## Rekommendation och skäl\nUndersök underlaget; horisontpasset har misslyckats igen sedan ett tidigare ärende stängts.\n\n`
    + `## Vad som står still\nHorisonten ${slug} väntar på Martin. Felunderlag:\n${failureLines(failures)}\n\n`
    + `## Kan valet ändras efteråt?\nIngen automatisk tillämpning; detta är ett mekaniskt fel som kräver undersökning.\n`;
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
 * The horizon turn's read checkouts: one detached checkout of origin/main per repository that declares areas under
 * `horizonCheckoutsDir`, made by `git` as the runner's seam (`git(cwd, args) → { ok, stdout, stderr }`). A clean
 * leftover whose HEAD origin/main holds is removed and made again; a dirty one, or one holding a commit origin/main
 * lacks, is never touched and refuses the turn. `{ ok: true, paths }`, `{ ok: false, reason, retained? }`, or
 * `{ ok: false, fetch: true, reason }` when a fetch fails — the network's, nothing counts against the turn.
 */
export function setUpHorizonCheckouts({ git, root, slug, repos, exists }) {
  const base = horizonCheckoutsDir(root, slug);
  const paths = {}; const made = [];
  const undo = () => removeHorizonCheckouts({ git, root, slug, repos: repos.filter((repo) => made.includes(repo.name)), exists });
  for (const repo of repos) {
    const fetched = git(repo.path, ['fetch', '--quiet', 'origin']);
    if (!fetched.ok) { undo(); return { ok: false, fetch: true, reason: `fetch ${repo.name}: ${lastLine(fetched.stderr) || 'git failed'}` }; }
  }
  for (const repo of repos) {
    const path = join(base, repo.name);
    if (exists(path)) {
      if (!checkoutClean({ git, path }) || !reachable({ git, path, ref: 'origin/main' }) || !git(repo.path, ['worktree', 'remove', path]).ok) { undo(); return { ok: false, retained: path, reason: `read checkout retained: ${path}` }; }
    }
    const added = git(repo.path, ['worktree', 'add', '-q', '--detach', path, 'origin/main']);
    if (!added.ok) { undo(); return { ok: false, reason: `setup: ${lastLine(added.stderr) || 'git worktree add failed'}` }; }
    made.push(repo.name);
    paths[repo.name] = path;
  }
  return { ok: true, paths };
}

/** The horizon turn's read checkouts removed after it: each clean and reachable, the others left. Returns the paths left. */
export function removeHorizonCheckouts({ git, root, slug, repos, exists }) {
  const kept = [];
  for (const repo of repos) {
    const path = join(horizonCheckoutsDir(root, slug), repo.name);
    if (!exists(path)) continue;
    if (!checkoutClean({ git, path }) || !reachable({ git, path, ref: 'origin/main' }) || !git(repo.path, ['worktree', 'remove', path]).ok) kept.push(path);
  }
  return kept;
}

/**
 * The curation turn's worktrees: for each repository that declares areas a branch `manager/curation-<stamp>` made
 * from a fresh origin/main in its own worktree. `{ ok: true, paths, branches, heads }` — `heads` the commit each
 * branch starts at, which is what the turn read — or `{ ok: false, reason, fetch? }`, with what was made removed.
 */
export function setUpCurationWorktrees({ git, root, stamp, repos }) {
  const base = curationWorktreesDir(root, stamp);
  const paths = {}; const branches = {}; const heads = {}; const made = [];
  const undo = () => { for (const repo of made) { git(repo.path, ['worktree', 'remove', '--force', paths[repo.name]]); git(repo.path, ['branch', '-D', branches[repo.name]]); } };
  for (const repo of repos) {
    const fetched = git(repo.path, ['fetch', '--quiet', 'origin']);
    if (!fetched.ok) return { ok: false, fetch: true, reason: `fetch ${repo.name}: ${lastLine(fetched.stderr) || 'git failed'}` };
  }
  for (const repo of repos) {
    const path = join(base, repo.name);
    const branch = `manager/curation-${stamp}`;
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
 * The archived programmes whose record names `slug`: `{ programme, dir }`, read from `archived` (the archive's
 * programmes directory) through `list`/`read`. A record that cannot be read is not one.
 */
export function archivedFor({ archived, slug, list, read }) {
  return list(archived).filter((name) => NAME_RE.test(name)).sort().flatMap((programme) => {
    const found = readRecord(join(archived, programme), { read });
    return found.status === 'valid' && found.record.horizon === slug ? [{ programme, dir: join(archived, programme) }] : [];
  });
}

/** What the horizon session is told: the horizon, where its playback and the area pages are, and the three endings. */
export function horizonPrompt({ slug, env, pages, archivedProgrammes, checkouts }) {
  const playback = join(horizonsDir(env), slug, 'playback.md');
  const read = Object.entries(checkouts).map(([repo, path]) => `${repo}: \`${path}\``).join('; ') || '(none)';
  const where = pages.length ? pages.map((page) => `\`${page.path}\` (${page.repo}, area ${page.id})`).join('; ') : '(none declared)';
  const was = archivedProgrammes.length ? archivedProgrammes.map((entry) => `${entry.programme} (\`${entry.dir}\`)`).join('; ') : 'none';
  return `You are the headless manager: the horizon ${slug} is open and no open programme serves it, and nobody is present. Read its playback \`${playback}\` first (\`mc martin horizon show ${slug}\`), then the area pages: ${where}. Programmes already archived whose record names this horizon: ${was}. `
    + `Read checkouts of every repository that declares areas, detached at origin/main, are ${read}; read code there and change nothing in them. See the app as it is with \`mc shot\`. `
    + `Decide what stands between the app as it is and the playback, and end in exactly one of three ways: `
    + `(1) \`mc programs create <name> --end "<when the programme is done>" --horizon ${slug} --purpose "<what part of the horizon it delivers>"\`; `
    + `(2) \`mc martin horizon reached ${slug}\` when the playback is already true of the app; `
    + `(3) an open text item \`horizon:${slug}\` made with \`mc martin propose --text horizon:${slug} --file <brief>\` when the playback itself must change. `
    + `Do not make a horizon or a goal, and do not perform a reserved act. Your manager role's headless sections say the rest.`;
}

/** The proposals folders the curation prompt lists, each file with its age: `~/mc/proposals/` and every programme's `proposals/`. */
export function proposalBacklog({ root, home, list, modified }) {
  const folders = [join(root, 'proposals'), ...list(home).filter((name) => NAME_RE.test(name)).sort().map((name) => join(home, name, 'proposals'))];
  return folders.flatMap((folder) => list(folder).filter((name) => !name.startsWith('.')).map((name) => ({ path: join(folder, name), at: modified(join(folder, name)) })))
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || (a.path < b.path ? -1 : 1));
}

/** What the curation session is told: the worktrees it works in, what it may write and where, and the backlog. */
export function curationPrompt({ paths, branches, pages, backlog, moved = [] }) {
  const trees = Object.entries(paths).map(([repo, path]) => `${repo}: \`${path}\` on branch ${branches[repo]}`).join('; ');
  const where = pages.length ? pages.map((page) => `${page.repo} ${page.id}: \`${page.path}\``).join('; ') : '(none)';
  const list = backlog.length ? backlog.map((entry) => `- ${entry.path}`).join('\n') : '(no proposals)';
  const since = moved.length ? ` Main has moved since the last curation in: ${moved.join(', ')}.` : '';
  return `You are the headless manager, curating the area texts with nobody present.${since} Your worktrees, made from origin/main, are ${trees}. The area pages are ${where}. `
    + `Bring each page's Closer, Store and Standards into line with what the code and \`docs/technical/\` now say. Change nothing under ## Aim or ## Decisions of a page, nothing outside \`docs/technical/\`, and no line holding a dated decision of Martin's; \`mc publish\` refuses it. `
    + `Publish each worktree you changed with \`mc publish --no-merge\`; a worktree you did not change needs nothing, and a turn that finds nothing to change is a success. What waits on Martin goes to the desk with \`mc martin propose\`; do not make a horizon or a goal. `
    + `Proposals, oldest first — turn a proposal into a programme only through \`mc programs create --area <repo>/<id> --purpose "…" --from-proposal <path>\`, which refuses while an open programme already repairs that area:\n${list}`;
}
