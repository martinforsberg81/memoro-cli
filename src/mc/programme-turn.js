/**
 * The programme planning turn, model-free (mc-run.md, "Programme planning turn").
 *
 * A ready programme whose README.md has parts no goal names yet, or whose goals naming a part are
 * still drafts, is planned by one headless plan session with nobody present: it cuts every part into
 * a goal and moves each to build (Martin, 2026-11-21). Everything here is what the runner decides around
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
import { repairReleaseState } from './repair-release.js';

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
export function documentParts(text) {
  return partSections(text).map(([number]) => number);
}

export function partSections(text) {
  return splitProgrammeParts(text).parts;
}

export function splitProgrammeParts(text) {
  const lines = String(text ?? '').split(/\r?\n/u);
  const headings = String(text ?? '').replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*(?:\n|$)/gmu, fence => fence.replace(/[^\n]/gu, ' ')).split(/\r?\n/u);
  const start = headings.indexOf('## Parts');
  if (start < 0) return { parts: [], shared: lines.join('\n'), sharedContract: '' };
  let end = headings.findIndex((line, at) => at > start && /^## /u.test(line));
  if (end < 0) end = lines.length;
  const parts = headings.slice(start + 1, end).flatMap((line, i) => {
    const found = /^### Part ([1-9]\d*)\s+—\s+\S/u.exec(line);
    return found ? [{ number: Number(found[1]), start: start + 1 + i }] : [];
  });
  const cutoff = parts[0]?.start ?? end;
  const shared = [...lines.slice(0, cutoff), '', ...lines.slice(end)].join('\n');
  // Read and Where things are can accumulate review reasoning and provenance
  // without changing a goal contract. Named binding inputs still count.
  let audit = false;
  const sharedContract = lines.filter((_, i) => {
    if (i >= cutoff && i < end) return false;
    if (/^## /u.test(headings[i])) audit = /^## (?:Read|Where things are)\s*$/u.test(headings[i]);
    return !audit;
  }).join('\n').trimEnd();
  return {
    parts: parts.map((part, i) => [part.number, lines.slice(part.start, parts[i + 1]?.start ?? end).join('\n').trimEnd()]),
    shared,
    sharedContract,
  };
}

/** The part numbers one document label names: `Part 1; Part 2`, `Parts 1, 2 and 4`. No range is read. */
export function partsNamed(label) {
  const named = new Set();
  for (const found of String(label ?? '').matchAll(/\bParts?\s+(\d+(?:\s*(?:,|;|&|and)\s*\d+)*)/giu)) {
    for (const number of found[1].match(/\d+/gu)) named.add(Number(number));
  }
  return named;
}

/**
 * Each goal of the programme, live and archived, that reads as a goal: its name and the parts of the programme's
 * `README.md` it names (mc-goals.md, "Part association"): a document whose path is that README.md, labelled with
 * explicit `Part n` references. A goal file that is missing, does not parse or does not validate is left out.
 */
export function goalParts({ home, programme, list, read }) {
  const readme = resolve(join(home, programme, 'README.md'));
  const goals = join(home, programme, GOALS_DIR);
  const dirs = [...list(goals).filter((name) => !name.startsWith('.')).map((name) => [name, join(goals, name), false]),
    ...list(join(goals, ARCHIVE_DIR)).map((name) => [name, join(goals, ARCHIVE_DIR, name), true])];
  const found = [];
  for (const [name, dir, archived] of dirs) {
    let text;
    try { text = read(join(dir, GOAL_FILE)); } catch { continue; }
    if (text == null) continue;
    const parsed = parseGoal(text);
    if (parsed.problems) continue;
    const named = new Set();
    for (const document of parsed.documents ?? []) {
      const docPath = typeof document?.path === 'string' ? resolve(join(home, programme), document.path) : null;
      if (docPath !== readme) continue;
      for (const part of partsNamed(document.label)) named.add(part);
    }
    found.push({ name, named, dir, archived, goal: parsed });
  }
  return found;
}

/** The parts of the programme's `README.md` its goals name, live and archived. */
export function partsCut({ home, programme, list, read }) {
  return new Set(goalParts({ home, programme, list, read }).flatMap(({ named }) => [...named]));
}

/**
 * The goals, live and archived, that name no part of the programme's `README.md`: goals planned by hand or cut
 * before the planning turn read README.md. A programme holding one is planned already and is not due a turn.
 */
export function goalsNamingNoPart({ home, programme, list, read }) {
  return goalParts({ home, programme, list, read }).filter(({ named }) => !named.size).map(({ name }) => name).sort();
}

/**
 * The problems that keep a programme document uncut: none when every one of its parts is named by a goal.
 */
export function cutProblems({ home, programme, list, read }) {
  let text;
  try { text = read(join(home, programme, 'README.md')); } catch { text = null; }
  if (text == null) return ['README.md is missing'];
  const parts = documentParts(text);
  if (!parts.length) return ['README.md names no part'];
  const named = partsCut({ home, programme, list, read });
  const missing = parts.filter((part) => !named.has(part));
  return missing.length ? [`no goal names part${missing.length === 1 ? '' : 's'} ${missing.join(', ')}`] : [];
}

/**
 * The live goals that name a part of the programme's `README.md` and are still in stage `draft`, by name: what the
 * turn has cut and not yet moved to build. An archived goal is over and is not one.
 */
export function partDrafts({ home, programme, list, read }) {
  return goalParts({ home, programme, list, read })
    .filter(({ named, archived, goal }) => named.size && !archived && goal.stage === 'draft')
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The drafts of `partDrafts` that are the turn's to finish: `ready`, and not `unavailable({ name, dir })` (the
 * runner's word that a draft is held or decision-claimed). A draft that is held, claimed, blocked or waiting on
 * Martin is its holder's: it neither calls a turn nor fails one.
 */
export function freeDrafts({ home, programme, list, read, unavailable = () => false }) {
  return partDrafts({ home, programme, list, read })
    .filter((draft) => draft.goal.status === 'ready' && !unavailable({ name: draft.name, dir: draft.dir }));
}

/** A record the turn cuts from: valid and ready. */
export const cuttable = (record, dir) => record?.state === 'ready' && (!record.repair || Boolean(dir && repairReleaseState(dir, record)?.release));

/**
 * Whether `programme` is due a planning turn now: `{ due: true, record }`, or `{ due: false, reason, notice }`.
 * It is due while a part of README.md is named by no goal, and while every part is named but a goal naming one is
 * still `draft · ready` and free: a turn that was interrupted or failed is run again and finishes its own drafts.
 * `unavailable({ name, dir })` is the runner's word that a draft is held or decision-claimed; such a draft, and one
 * that waits on Martin or is blocked, is its holder's and calls no turn.
 */
export function programmeDue({ programme, home, list, read, items = [], horizon = () => null, state, unavailable = () => false }) {
  const dir = join(home, programme);
  const record = readRecord(dir, { read });
  if (record.status === 'none') return { due: false, reason: 'no record', notice: null };
  if (record.status === 'invalid') return { due: false, reason: 'its record is invalid', notice: null };
  const repair = repairReleaseState(dir, record.record);
  const refusal = repair?.problems?.[0];
  if (refusal) return { due: false, reason: refusal, notice: null };
  if (record.record.state !== 'ready') return { due: false, reason: `its record reads ${record.record.state}`, notice: null };
  let readme;
  try { readme = repair ? repair.snapshot.text : read(join(dir, 'README.md')); } catch { readme = null; }
  if (readme == null) return { due: false, reason: 'it has no README.md', notice: null };
  const parts = documentParts(readme);
  if (!parts.length) return { due: false, reason: 'README.md names no part', notice: null };
  if (repair) {
    if (record.record.repair.reconciled?.revision === repair.release.revision) return { due: false, reason: 'its release is reconciled', notice: null };
  } else {
    const problems = cutProblems({ home, programme, list, read });
    const drafts = problems.length ? [] : freeDrafts({ home, programme, list, read, unavailable });
    if (problems.length === 0 && drafts.length === 0) return { due: false, reason: 'its goals are already cut', notice: null };
    const unnamed = goalsNamingNoPart({ home, programme, list, read });
    if (unnamed.length) {
      const named = unnamed.length > 3 ? `${unnamed.slice(0, 3).join(', ')} and ${unnamed.length - 3} more` : unnamed.join(', ');
      return { due: false, reason: `its goal${unnamed.length === 1 ? '' : 's'} ${named} name${unnamed.length === 1 ? 's' : ''} no part of README.md`, notice: null };
    }
  }
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
  return { due: true, record: record.record, ...(repair ? { revision: repair.release.revision, snapshot: repair.snapshot } : {}) };
}

/**
 * How the turn ended: `{ kind: 'cut' }` when a goal names every part and no live goal naming a part is still a
 * free draft (`freeDrafts`), `{ kind: 'incomplete', problems }` when parts or such drafts remain (each draft is named), or
 * `{ kind: 'settled', problems }` when the programme state is no longer ready.
 */
export function finishTurn({ programme, home, list, read, write, lock, root, revision, unavailable = () => false }) {
  try {
    const dir = join(home, programme);
    const record = readRecord(dir, { read });
    if (record.status !== 'valid') return { kind: 'settled', problems: ['record is invalid'] };
    if (!cuttable(record.record, dir)) {
      return { kind: 'settled', problems: [repairReleaseState(dir, record.record)?.problems?.[0] ?? `record reads ${record.record.state}`] };
    }
    if (record.record.repair) {
      if (record.record.repair.release.revision !== revision) return { kind: 'settled', problems: ['repair release changed during planning'] };
      return record.record.repair.reconciled?.revision === revision ? { kind: 'cut' }
        : { kind: 'incomplete', problems: ['the programme planner has not reconciled this release'] };
    }
    const problems = cutProblems({ home, programme, list, read });
    if (problems.length > 0) return { kind: 'incomplete', problems };
    const drafts = freeDrafts({ home, programme, list, read, unavailable }).map(({ name }) => `goal ${name} is still a draft`);
    if (drafts.length > 0) return { kind: 'incomplete', problems: drafts };
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
    + `The runner's planning turn for programme ${programme} ended twice without every part of README.md cut into a goal in build. `
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
  return `## Vad det gäller\nPlaneringspasset för programmet ${programme} slutade igen utan att varje del av programmets README.md blev ett mål i build; arbetet kan inte fortsätta automatiskt.\n\n`
    + `## Alternativ och konsekvenser\n- Undersök underlaget: planeringen kan köras igen när felet är löst.\n- Låt programmet vänta: inga fler mål skärs förrän felet är löst.\n\n`
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
