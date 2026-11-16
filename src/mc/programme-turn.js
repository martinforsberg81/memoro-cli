/**
 * The programme planning turn, model-free (mc-run.md, "Programme planning turn").
 *
 * A programme whose signed document has not yet been cut is planned by one headless plan
 * session with nobody present. Everything here is what the runner decides around
 * that session without a model: whether a programme is due, the state file that
 * counts the turns that failed, the desk item the second failure opens, and the
 * read checkouts the turn stands beside. The runner (`run.js`) supplies its own
 * file reads, lock and git, so a fixture drives all of it in memory.
 */
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { deskItemId } from './desk-items.js';
import { ARCHIVE_DIR, GOAL_FILE, GOALS_DIR, parseGoal } from './goals.js';
import { NAME_RE } from './plan-schema.js';
import { readRecord } from './programme-record.js';

export const TURN_SCHEMA = 'mc-programme-turn';
export const TURN_VERSION = 1;
export const TURN_ITEM_KIND = 'programme';
/** The failures that open a desk item: the first lets the next pick plan again, the second is the item. */
export const FAILURES_TO_ITEM = 2;

/** `programme:<programme>`: what the turn is called in a claim, a current record and a runs.tsv row, and an item's reference. */
export const turnName = (programme) => `programme:${programme}`;
export const turnReference = turnName;

/** `runner/programme-turn/<programme>.json` under the work root. */
export const turnStatePath = (root, programme) => join(root, 'runner', 'programme-turn', `${programme}.json`);

/** `runner/work/programme-turn-<programme>`: the directory holding the turn's read checkouts, one per served repository. */
export const readCheckoutsDir = (root, programme, prefix = 'programme-turn') => join(root, 'runner', 'work', `${prefix}-${programme}`);

const lastLine = (text) => String(text ?? '').trim().split('\n').at(-1) || '';

/**
 * The state file: `{ status: 'none' }` when it is not there (no failures),
 * `{ status: 'valid', state }`, or `{ status: 'unreadable', problem }`. A file
 * that is there and is not the schema is unreadable, never "no failures".
 */
export function readTurnState({ root, programme, read }) {
  let text;
  try { text = read(turnStatePath(root, programme)); } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { status: 'none' };
    return { status: 'unreadable', problem: `cannot be read: ${error.message}` };
  }
  if (text === null || text === undefined) return { status: 'none' };
  let state;
  try { state = JSON.parse(text); } catch (error) { return { status: 'unreadable', problem: `not JSON: ${error.message}` }; }
  const problems = [];
  if (!state || typeof state !== 'object' || Array.isArray(state)) problems.push('not an object');
  else {
    if (state.schema !== TURN_SCHEMA) problems.push(`schema is not ${TURN_SCHEMA}`);
    if (state.version !== TURN_VERSION) problems.push(`version is not ${TURN_VERSION}`);
    if (state.programme !== programme) problems.push(`programme is not ${programme}`);
    if (!Array.isArray(state.failures) || !state.failures.every((f) => f && typeof f.at === 'string' && typeof f.reason === 'string')) problems.push('failures is not a list of { at, reason, log }');
    if (!Array.isArray(state.items) || !state.items.every((item) => item && typeof item.id === 'string' && typeof item.opened_at === 'string')) problems.push('items is not a list of { id, opened_at }');
  }
  return problems.length ? { status: 'unreadable', problem: problems.join('; ') } : { status: 'valid', state };
}

/** The failures since the last item opened: the count the second-failure rule reads. */
export function failuresSinceItem(state) {
  const since = state.items.map((item) => item.opened_at).sort().at(-1) ?? null;
  return state.failures.filter((failure) => since === null || failure.at > since);
}

/** The names of the programme directories under `home`. */
export const programmeDirs = ({ home, list }) => list(home).filter((name) => NAME_RE.test(name)).sort();

/** How many goals the programme holds now: the entries of `goals/` but a dot-entry, and of `goals/.archive/`. */
export function goalCount({ home, programme, list }) {
  const goals = join(home, programme, 'goals');
  return list(goals).filter((name) => !name.startsWith('.')).length + list(join(goals, '.archive')).length;
}

/** The `### Part n —` headings of the programme document's `## Parts` entry (fenced examples do not count), as numbers. */
export function signedParts(text) {
  const lines = String(text ?? '').replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*(?:\n|$)/gmu, '').split(/\r?\n/u);
  const start = lines.indexOf('## Parts');
  if (start < 0) return [];
  let end = lines.findIndex((line, at) => at > start && /^## /u.test(line));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).flatMap((line) => {
    const found = /^### Part ([1-9]\d*)\s+—\s+\S/u.exec(line);
    return found ? [Number(found[1])] : [];
  });
}
export const documentParts = signedParts;

/** The part numbers one document label names: `Part 1; Part 2`, `Parts 1, 2 and 4`. No range is read. */
export function partsNamed(label) {
  const named = new Set();
  for (const found of String(label ?? '').matchAll(/\bParts?\s+(\d+(?:\s*(?:,|;|&|and)\s*\d+)*)/giu)) {
    for (const number of found[1].match(/\d+/gu)) named.add(Number(number));
  }
  return named;
}

/**
 * The parts of the programme document the programme's goals name, live and archived (mc-goals.md, "Part association"): a
 * document of a goal whose path is this programme's `README.md` (or legacy signed document), labelled with explicit `Part n` references.
 */
export function partsCut({ home, programme, list, read }) {
  const readme = resolve(join(home, programme, 'README.md'));
  const legacySigned = resolve(join(home, programme, ['SIGNED', 'md'].join('.')));
  const goals = join(home, programme, GOALS_DIR);
  const dirs = [...list(goals).filter((name) => !name.startsWith('.')).map((name) => join(goals, name)),
    ...list(join(goals, ARCHIVE_DIR)).map((name) => join(goals, ARCHIVE_DIR, name))];
  const named = new Set();
  for (const dir of dirs) {
    let text;
    try { text = read(join(dir, GOAL_FILE)); } catch { continue; }
    if (text == null) continue;
    const parsed = parseGoal(text);
    if (parsed.problems) continue;
    for (const document of parsed.documents ?? []) {
      const docPath = typeof document?.path === 'string' ? resolve(join(home, programme), document.path) : null;
      if (!docPath || (docPath !== readme && docPath !== legacySigned)) continue;
      for (const part of partsNamed(document.label)) named.add(part);
    }
  }
  return named;
}

/**
 * The problems that keep a programme document uncut: none when every one of its parts is named by a goal.
 */
export function cutProblems({ home, programme, list, read }) {
  let text;
  try { text = read(join(home, programme, 'README.md')); } catch { text = null; }
  if (text == null) return ['README.md is missing'];
  const parts = signedParts(text);
  if (!parts.length) return ['README.md names no part'];
  const named = partsCut({ home, programme, list, read });
  const missing = parts.filter((part) => !named.has(part));
  return missing.length ? [`no goal names part${missing.length === 1 ? '' : 's'} ${missing.join(', ')}`] : [];
}

/** A record the turn cuts from: valid and ready. */
export const cuttable = (record) => record?.state === 'ready';

/**
 * Whether `programme` is due a planning turn now: `{ due: true, record }`, or `{ due: false, reason, notice }`.
 */
export function programmeDue({ programme, home, list, read, items = [], horizon = () => null, state }) {
  const dir = join(home, programme);
  const record = readRecord(dir, { read });
  if (record.status === 'none') return { due: false, reason: 'no record', notice: null };
  if (record.status === 'invalid') return { due: false, reason: 'its record is invalid', notice: null };
  if (record.record.state !== 'ready') return { due: false, reason: `its record reads ${record.record.state}`, notice: null };
  let readme;
  try { readme = read(join(dir, 'README.md')); } catch { readme = null; }
  if (readme == null) return { due: false, reason: 'it has no README.md', notice: null };
  const parts = signedParts(readme);
  if (!parts.length) return { due: false, reason: 'README.md names no part', notice: null };
  const problems = cutProblems({ home, programme, list, read });
  if (problems.length === 0) return { due: false, reason: 'its goals are already cut', notice: null };
  if (items.some((item) => item.kind === TURN_ITEM_KIND && item.reference === turnReference(programme) && item.state !== 'closed')) {
    return { due: false, reason: 'a programme desk item is open', notice: null };
  }
  if (state.status === 'unreadable') {
    return { due: false, reason: 'its turn state is unreadable', notice: `${programme}: ${turnStatePath('<work root>', programme).replace('<work root>/', '')} is unreadable (${state.problem}) — no planning turn is started until it is repaired or removed` };
  }
  const slug = record.record.horizon;
  if (slug) {
    const found = horizon(slug);
    if (!found || found.state !== 'open') {
      return { due: false, reason: 'its horizon is not open', notice: `${programme}: its horizon ${slug} ${found ? `reads ${found.state}` : 'is missing or unreadable'} — no planning turn is started while that lasts` };
    }
  }
  return { due: true, record: record.record };
}

/**
 * How the turn ended: `{ kind: 'cut' }` when all parts are cut, `{ kind: 'incomplete', problems }` when parts remain,
 * or `{ kind: 'settled', problems }` when the programme state is no longer ready.
 */
export function finishTurn({ programme, home, list, read, write, lock, root }) {
  try {
    const dir = join(home, programme);
    const record = readRecord(dir, { read });
    if (record.status !== 'valid' || record.record.state !== 'ready') {
      return { kind: 'settled', problems: [record.status === 'valid' ? `record reads ${record.record.state}` : 'record is invalid'] };
    }
    const problems = cutProblems({ home, programme, list, read });
    if (problems.length > 0) return { kind: 'incomplete', problems };
    return { kind: 'cut' };
  } catch (error) {
    return { kind: 'failed', problems: [error.message || String(error)] };
  }
}

/**
 * A turn that ended without its document cut, counted (D6).
 */
export function recordTurnFailure({ root, programme, reason, log = null, at, read, write, writeJson, lock, env, itemDirectory }) {
  return lock(root, () => {
    const found = readTurnState({ root, programme, read });
    if (found.status === 'unreadable') throw new Error(`${turnStatePath(root, programme)} is unreadable (${found.problem})`);
    const state = found.status === 'valid' ? found.state : { schema: TURN_SCHEMA, version: TURN_VERSION, programme, failures: [], items: [] };
    state.failures.push({ at, reason, log });
    const recent = failuresSinceItem(state);
    let item = null;
    if (recent.length >= FAILURES_TO_ITEM) {
      const reference = turnReference(programme);
      const first = state.items.length === 0;
      const id = deskItemId(TURN_ITEM_KIND, reference, at);
      item = { schema: 'mc-desk-item', version: 1, id, kind: TURN_ITEM_KIND, reference, source_at: at, opened_at: at,
        state: first ? 'prepared' : 'for-martin', sort: 'mechanical', reversible: first ? null : false, due_at: null, outcome: null };
      const dir = itemDirectory(item, env);
      if (first) write(join(dir, 'prepared.md'), preparedText({ programme, failures: recent, item }));
      else write(join(dir, 'brief.md'), briefText({ programme, failures: recent }));
      writeJson(join(dir, 'item.json'), item);
      state.items.push({ id, opened_at: at });
    }
    writeJson(turnStatePath(root, programme), state);
    return { count: recent.length, item };
  }, { strict: true, name: 'programme-turn' });
}

const failureLines = (failures) => failures.map((failure) => `- ${failure.at}: ${failure.reason}${failure.log ? ` (session log: ${failure.log})` : ''}`).join('\n');

/** What the decision session reads for the first item: the turns that failed, and where to look. */
function preparedText({ programme, failures, item }) {
  return `# Programme ${programme}: its planning turn failed twice\n\n`
    + `The runner's planning turn for programme ${programme} ended twice without a goal naming every part of README.md. `
    + `Nothing was asked of Martin; this is a mechanical failure to repair within reach.\n\n`
    + `## The failures\n${failureLines(failures)}\n\n`
    + `## Where to look\n- Programme directory: ${programme} under the programmes home, with README.md, PROGRAMME.json and goals/.\n`
    + `- The turn's state: runner/programme-turn/${programme}.json under the work root.\n`
    + `- Item: ${item.id}.\n\n`
    + `## What closes it\nRepair what failed, then close the item (--by decision) so the runner plans the programme again. `
    + `A text of Martin's that would have to change goes to a brief instead.\n`;
}

/** The brief a later item carries: the turn failed again after a decision pass closed the first. Swedish, as the desk reads it. */
function briefText({ programme, failures }) {
  return `## Vad det gäller\nPlaneringspasset för programmet ${programme} slutade igen utan att målen namngav varje del av det signerade dokumentet; arbetet kan inte fortsätta automatiskt.\n\n`
    + `## Alternativ och konsekvenser\n- Undersök underlaget: planeringen kan köras igen när felet är löst.\n- Låt programmet vänta: signaturen skärs inte förrän målen täcker varje del.\n\n`
    + `## Rekommendation och skäl\nUndersök underlaget; planeringspasset har misslyckats igen sedan ett tidigare ärende stängts.\n\n`
    + `## Vad som står still\nProgrammet ${programme} väntar på Martin. Felunderlag:\n${failureLines(failures)}\n\n`
    + `## Kan valet ändras efteråt?\nIngen automatisk tillämpning; detta är ett mekaniskt fel som kräver undersökning.\n`;
}

/**
 * Read checkouts (D8): one detached checkout of origin/main per served
 * repository under `readCheckoutsDir`, made by `git` as the runner's seam
 * (`git(cwd, args) → { ok, stdout, stderr }`). A status-clean leftover whose
 * HEAD origin/main already holds is removed and made again; a dirty one, or
 * one holding a commit origin/main lacks, is never touched and refuses the
 * turn. Returns `{ ok: true, paths }` (`{ repo: path }`), or `{ ok: false,
 * reason, retained? }` — `retained` is the path of a leftover kept. A fetch
 * that fails is `{ ok: false, fetch: true }`: nothing counts against the turn.
 */
export function setUpReadCheckouts({ git, root, programme, repos, exists, prefix }) {
  const base = readCheckoutsDir(root, programme, prefix);
  const paths = {};
  const made = [];
  const undo = () => removeReadCheckouts({ git, root, programme, prefix, repos: repos.filter((repo) => made.includes(repo.name)), exists });
  for (const repo of repos) {
    const fetched = git(repo.path, ['fetch', '--quiet', 'origin']);
    if (!fetched.ok) { undo(); return { ok: false, fetch: true, reason: `fetch ${repo.name}: ${lastLine(fetched.stderr) || 'git failed'}` }; }
  }
  for (const repo of repos) {
    const path = join(base, repo.name);
    if (exists(path)) {
      const state = checkoutState({ git, path });
      if (!state.removable) { undo(); return { ok: false, retained: path, reason: `read checkout retained: ${path}` }; }
      const removed = git(repo.path, ['worktree', 'remove', path]);
      if (!removed.ok) { undo(); return { ok: false, retained: path, reason: `read checkout retained: ${path}` }; }
    }
    const added = git(repo.path, ['worktree', 'add', '-q', '--detach', path, 'origin/main']);
    if (!added.ok) { undo(); return { ok: false, reason: `setup: ${lastLine(added.stderr) || 'git worktree add failed'}` }; }
    made.push(repo.name);
    paths[repo.name] = path;
  }
  return { ok: true, paths };
}

/** A checkout is removable when its status is clean and its HEAD is reachable from origin/main: nothing in it exists nowhere else. */
function checkoutState({ git, path }) {
  const status = git(path, ['status', '--porcelain']);
  if (!status.ok || String(status.stdout ?? '').trim() !== '') return { removable: false, why: 'dirty' };
  const reachable = git(path, ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']);
  return reachable.ok ? { removable: true } : { removable: false, why: 'unreachable' };
}

/** The turn's read checkouts removed after it: each one clean and reachable, the others left. Returns the paths left. */
export function removeReadCheckouts({ git, root, programme, repos, exists, prefix }) {
  const kept = [];
  for (const repo of repos) {
    const path = join(readCheckoutsDir(root, programme, prefix), repo.name);
    if (!exists(path)) continue;
    const state = checkoutState({ git, path });
    if (!state.removable || !git(repo.path, ['worktree', 'remove', path]).ok) kept.push(path);
  }
  return kept;
}
