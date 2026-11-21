/**
 * The programme archive turn, model-free (mc-run.md, "Programme archive turn").
 *
 * A programme with a record (PROGRAMME.json) whose goals are all finished, at
 * least one of them done, is archived by the runner without a person present
 * and without a model session: every goal merged means everything is built
 * (Martin, 2026-11-21). Each goal writes what it made true into
 * `docs/technical/` as it lands, so nothing is read again here. What the
 * runner decides here: whether a programme is due, the state that counts what
 * failed, the desk item a second failure opens, a legacy programme's proposals
 * moved to an area, and the archive itself, fenced, with the record's state
 * set to done once the directory has moved. The runner (`run.js`) supplies
 * its own file reads, lock and git, so a fixture drives all of it in memory.
 *
 * A programme without a record is never archived here: for it
 * `mc programs archive <programme>` stays a person's act.
 */
import { basename, join } from 'node:path';
import { deskItemId } from './desk-items.js';
import { archiveDirIn, parseGoal, GOAL_FILE, GOAL_LOG_FILE } from './goals.js';
import { NAME_RE } from './plan-schema.js';
import { changeProgrammeRecord, readRecord, setRecordState } from './programme-record.js';
import { repairGoalAdmission } from './repair-reconcile.js';

export const ARCHIVE_SCHEMA = 'mc-archive-turn';
export const ARCHIVE_VERSION = 1;
export const ARCHIVE_ITEM_KIND = 'archive';
/** The failures since the last item that open one: the first lets the next pass try again, the second is the item. */
export const FAILURES_TO_ITEM = 2;

/** `archive:<programme>`: what the turn is called in a claim, a current record and a runs.tsv row, and an item's reference. */
export const archiveName = (programme) => `archive:${programme}`;
export const archiveReference = archiveName;

/** `runner/archive-turn/<programme>.json` under the work root. */
export const archiveStatePath = (root, programme) => join(root, 'runner', 'archive-turn', `${programme}.json`);
/** The directory of the state files: a programme whose directory has moved is still named here while its state is unwritten. */
export const archiveStateDir = (root) => join(root, 'runner', 'archive-turn');

const emptyState = (programme) => ({ schema: ARCHIVE_SCHEMA, version: ARCHIVE_VERSION, programme, failures: [], items: [], reading: null, destination: null });

/**
 * The state file: `{ status: 'none' }` when it is not there, `{ status: 'valid', state }`, or `{ status: 'unreadable',
 * problem }`. A file that is there and is not the schema is unreadable, never "nothing recorded"; one of an older version is nothing recorded.
 */
export function readArchiveState({ root, programme, read }) {
  let text;
  try { text = read(archiveStatePath(root, programme)); } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { status: 'none' };
    return { status: 'unreadable', problem: `cannot be read: ${error.message}` };
  }
  if (text === null || text === undefined) return { status: 'none' };
  let state;
  try { state = JSON.parse(text); } catch (error) { return { status: 'unreadable', problem: `not JSON: ${error.message}` }; }
  // A file from an older version of the turn is read as nothing recorded: no failures (mixed versions, mc-run.md).
  if (state && typeof state === 'object' && state.schema === ARCHIVE_SCHEMA && Number.isInteger(state.version) && state.version < ARCHIVE_VERSION) return { status: 'none' };
  const problems = [];
  if (!state || typeof state !== 'object' || Array.isArray(state)) problems.push('not an object');
  else {
    if (state.schema !== ARCHIVE_SCHEMA) problems.push(`schema is not ${ARCHIVE_SCHEMA}`);
    if (state.version !== ARCHIVE_VERSION) problems.push(`version is not ${ARCHIVE_VERSION}`);
    if (state.programme !== programme) problems.push(`programme is not ${programme}`);
    if (!Array.isArray(state.failures) || !state.failures.every((f) => f && typeof f.at === 'string' && typeof f.reason === 'string')) problems.push('failures is not a list of { at, reason, log }');
    if (!Array.isArray(state.items) || !state.items.every((item) => item && typeof item.id === 'string' && typeof item.opened_at === 'string')) problems.push('items is not a list of { id, opened_at }');
    if (state.reading !== null && !(state.reading && typeof state.reading.at === 'string' && Array.isArray(state.reading.goals))) problems.push('reading is not null or { at, goals }');
    if (state.destination !== null && typeof state.destination !== 'string') problems.push('destination is not null or a path');
  }
  return problems.length ? { status: 'unreadable', problem: problems.join('; ') } : { status: 'valid', state };
}

/** The failures since the last item opened: the count the second-failure rule reads. */
export function failuresSinceItem(state) {
  const since = state.items.map((item) => item.opened_at).sort().at(-1) ?? null;
  return state.failures.filter((failure) => since === null || failure.at > since);
}

/** The names of the state files: the programmes the turn has recorded something for. */
export const statedProgrammes = ({ root, list }) => list(archiveStateDir(root)).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length)).filter((name) => NAME_RE.test(name)).sort();

/**
 * The goals a programme has archived, as `{ done: [name], dropped: [name], problems: [string] }`: each directory of
 * `goals/.archive/` read as a goal file. A directory whose goal file does not parse, or is neither done nor dropped, is a
 * problem and keeps the programme from being read: nothing is judged on a goal that cannot be read.
 */
export function archivedGoals({ home, programme, list, read }) {
  const archive = archiveDirIn(home, programme);
  const done = []; const dropped = []; const problems = []; const repos = new Set();
  for (const name of list(archive).filter((entry) => !entry.startsWith('.')).sort()) {
    const parsed = parseGoal(read(join(archive, name, GOAL_FILE)) || '');
    if (parsed.problems) problems.push(`${name}: its goal file does not parse`);
    else if (parsed.stage === 'done') { done.push(name); for (const repo of parsed.repos) repos.add(repo); } else if (parsed.stage === 'dropped') dropped.push(name);
    else problems.push(`${name}: archived with the stage ${parsed.stage}`);
  }
  return { done, dropped, problems, repos: [...repos].sort() };
}

// A decline authorizes archiving what actually landed, not delivery of the
// discarded order. Its distinct disposition revision cannot be consumed by
// planning, build or merge.
function archiveAdmission(dir, { read, record, revision } = {}) {
  if (record === undefined) {
    const found = readRecord(dir, { read });
    if (found.status === 'invalid') return { problems: [`${basename(dir)} has no valid programme record`] };
    record = found.record;
  }
  const disposition = record?.repair?.disposition;
  if (record?.state === 'ready' && disposition?.action === 'decline' && !record.repair.stop_item) {
    return revision !== undefined && revision !== disposition.revision
      ? { problems: ['the archive belongs to a different repair disposition'] }
      : { release: { revision: disposition.revision } };
  }
  return repairGoalAdmission(dir, null, { record, revision, read });
}

const archiveRevision = record => record?.repair?.disposition?.action === 'decline'
  ? record.repair.disposition.revision : record?.repair?.release?.revision;

/** Ignore archive metadata while keeping the fence closed for other entries. */
export const liveGoals = ({ home, programme, list }) => list(join(home, programme, 'goals')).filter((name) => !name.startsWith('.') && name !== GOAL_LOG_FILE);

/** Whether a desk item of kind archive is open for `programme`. */
const openArchiveItem = (items, programme) => items.some((item) => item.kind === ARCHIVE_ITEM_KIND && item.reference === archiveReference(programme) && item.state !== 'closed');


/**
 * A destination named in the state whose record does not yet read done: the programme's directory has moved and the write
 * that sets its record done has not finished. Null when there is none, or it reads done. The desk sync keeps the programme's
 * archive item open while this holds, though the directory is gone from the programmes home.
 */
export function pendingDestination(state, { read }) {
  const destination = state.status === 'valid' ? state.state.destination : null;
  if (!destination) return null;
  const found = readRecord(destination, { read });
  return found.status === 'valid' && found.record.state === 'done' ? null : destination;
}

/**
 * Whether `programme` is due now, model-free: `{ due: true, mode: 'archive', record, goals }` (the archive), `{ due: true,
 * mode: 'state', destination }` (the programme's directory has moved and its record still reads open: that write alone,
 * held while an archive item of the programme is open), or `{ due: false, reason, notice }` where `notice` is the line the
 * runner says once while it lasts. `items` are the desk items, `state` is `readArchiveState`'s answer. A state file's
 * `reading`, written by the retired archive reading, is read and ignored.
 */
export function archiveDue({ programme, home, root, list, read, items = [], state }) {
  if (state.status === 'unreadable') {
    return { due: false, reason: 'its turn state is unreadable', notice: `${programme}: ${archiveStatePath(root, programme)} is unreadable (${state.problem}) — nothing is read or archived until it is repaired or removed` };
  }
  const pending = state.status === 'valid' ? state.state.destination : null;
  if (pending) {
    // The directory moved and the write that sets the record done did not finish: that write alone. A record
    // that already reads done is only cleared from the state.
    const found = readRecord(pending, { read });
    if (found.status === 'valid') {
      if (found.record.repair && found.record.state !== 'done') {
        const current = archiveAdmission(pending, { read, record: found.record });
        if (!current?.release) return { due: false, reason: current?.problems?.[0] ?? 'it belongs to a different repair release', notice: null };
      }
      // A write that has failed opens an item at the second failure; while it is open no write is tried, so a write that keeps
      // failing opens no further item. A record already done is only cleared from the state, item or not.
      if (found.record.state !== 'done' && openArchiveItem(items, programme)) return { due: false, reason: 'an archive desk item is open', notice: null };
      return { due: true, mode: 'state', destination: pending };
    }
    return { due: false, reason: 'its destination record cannot be read', notice: `${programme}: the record at ${pending} cannot be read (${found.status}) — it is not set to done until it is repaired` };
  }
  const dir = join(home, programme);
  const record = readRecord(dir, { read });
  if (record.status === 'none') return { due: false, reason: 'no record', notice: null };
  if (record.status === 'invalid') return { due: false, reason: 'its record is invalid', notice: null };
  if (record.record.state !== 'ready') return { due: false, reason: `its record reads ${record.record.state}`, notice: null };
  const repair = archiveAdmission(dir, { read, record: record.record });
  if (repair?.problems) return { due: false, reason: repair.problems[0], notice: null };
  if (liveGoals({ home, programme, list }).length) return { due: false, reason: 'it holds a live goal', notice: null };
  if (openArchiveItem(items, programme)) {
    return { due: false, reason: 'an archive desk item is open', notice: null };
  }
  const goals = archivedGoals({ home, programme, list, read });
  if (goals.problems.length) return { due: false, reason: 'an archived goal cannot be read', notice: `${programme}: ${goals.problems.join('; ')} — it is not archived until that is repaired` };
  const partiallyLanded = record.record.repair?.disposition?.landed ?? [];
  for (const name of partiallyLanded) {
    if (goals.done.includes(name)) continue;
    if (!goals.dropped.includes(name)) return { due: false, reason: `landed goal ${name} is missing`, notice: null };
    const parsed = parseGoal(read(join(archiveDirIn(home, programme), name, GOAL_FILE)) || '');
    goals.repos = [...new Set([...goals.repos, ...parsed.repos])].sort();
    goals.dropped = goals.dropped.filter(goal => goal !== name);
    goals.done.push(name);
  }
  goals.done.sort();
  // A programme whose goals were all dropped is no programme that made anything true: it is not archived here.
  if (!goals.done.length) return { due: false, reason: 'no goal reached done', notice: null };
  const revision = repair?.release?.revision;
  return { due: true, mode: 'archive', record: record.record, goals: goals.done, dropped: goals.dropped, repos: goals.repos,
    ...(partiallyLanded.length ? { partiallyLanded } : {}),
    ...(revision ? { revision } : {}) };
}

/* ------------------------------------------------------------ state changes */

/**
 * Change the state under the strict lock, on the state read inside it: `change(state)` returns what the caller wants back.
 * An unreadable state file throws, and nothing is written.
 */
function withState({ root, programme, read, writeJson, lock }, change) {
  return lock(root, () => {
    const found = readArchiveState({ root, programme, read });
    if (found.status === 'unreadable') throw new Error(`${archiveStatePath(root, programme)} is unreadable (${found.problem})`);
    const state = found.status === 'valid' ? found.state : emptyState(programme);
    const result = change(state);
    writeJson(archiveStatePath(root, programme), state);
    return result;
  }, { strict: true, name: 'archive-turn' });
}

/** Where the programme's directory moved to: recorded before anything else can fail, so the record's state is set later. */
export function noteDestination({ destination, ...seams }) {
  return withState(seams, (state) => { state.destination = destination; });
}

/** The archive done and the record read done: the destination is cleared. */
export function clearDestination(seams) {
  return withState(seams, (state) => { state.destination = null; state.reading = null; });
}

const failureLines = (failures) => failures.map((failure) => `- ${failure.at}: ${failure.reason}${failure.log ? ` (session log: ${failure.log})` : ''}`).join('\n');

/**
 * An archive that did not end in an archived programme, counted. The second failure since the last item opens one
 * (`for-martin`, sort mechanical, with a Swedish `brief.md`). Returns `{ count, item }`; an unreadable state throws and
 * nothing is written.
 */
export function recordArchiveFailure({ reason, log = null, at, env, write, itemDirectory, ...seams }) {
  return withState(seams, (state) => {
    const { programme } = seams;
    state.failures.push({ at, reason, log });
    const recent = failuresSinceItem(state);
    if (recent.length < FAILURES_TO_ITEM) return { count: recent.length, item: null };
    const reference = archiveReference(programme);
    const id = deskItemId(ARCHIVE_ITEM_KIND, reference, at);
    const item = { schema: 'mc-desk-item', version: 1, id, kind: ARCHIVE_ITEM_KIND, reference, source_at: at, opened_at: at,
      state: 'for-martin', sort: 'mechanical', reversible: false, due_at: null, outcome: null };
    const dir = itemDirectory(item, env);
    // The text is written before the item names it: a pass that finds the item finds what it reads.
    write(join(dir, 'brief.md'), briefText({ programme, failures: recent }));
    seams.writeJson(join(dir, 'item.json'), item);
    state.items.push({ id, opened_at: at });
    return { count: recent.length, item };
  });
}

/**
 * The programme holds restricted data (`~/mc/restricted/<programme>/`): deleting it stays a person's act, so the item is
 * opened at once, `for-martin`, sort reserved, with a Swedish brief naming `mc programs archive <programme>`.
 */
export function openRestrictedItem({ entries, at, env, write, itemDirectory, ...seams }) {
  return withState(seams, (state) => {
    const { programme } = seams;
    const reference = archiveReference(programme);
    const id = deskItemId(ARCHIVE_ITEM_KIND, reference, at);
    const item = { schema: 'mc-desk-item', version: 1, id, kind: ARCHIVE_ITEM_KIND, reference, source_at: at, opened_at: at,
      state: 'for-martin', sort: 'reserved', reversible: false, due_at: null, outcome: null };
    write(join(itemDirectory(item, env), 'brief.md'), restrictedBrief({ programme, entries }));
    seams.writeJson(join(itemDirectory(item, env), 'item.json'), item);
    state.items.push({ id, opened_at: at });
    return { item };
  });
}

/** The brief a mechanical item carries. Swedish, as the desk reads it. */
function briefText({ programme, failures }) {
  return `## Vad det gäller\nArkiveringen av programmet ${programme} misslyckades igen; programmet kan inte arkiveras automatiskt.\n\n`
    + `## Alternativ och konsekvenser\n- Undersök underlaget: arkiveringen körs igen när felet är löst.\n- Låt programmet vänta: det förblir öppet och syns här.\n\n`
    + `## Rekommendation och skäl\nUndersök underlaget; arkiveringen har misslyckats två gånger.\n\n`
    + `## Vad som står still\nProgrammet ${programme} väntar på Martin. Felunderlag:\n${failureLines(failures)}\n\n`
    + `## Kan valet ändras efteråt?\nIngen automatisk tillämpning; detta är ett mekaniskt fel som kräver undersökning.\n`;
}

/** The brief of the restricted-data item. Swedish. */
function restrictedBrief({ programme, entries }) {
  return `## Vad det gäller\nProgrammet ${programme} är färdigt, men ~/mc/restricted/${programme}/ innehåller uppgifter (${entries.join(', ')}). Att radera dem är ditt beslut, så systemet arkiverar inte programmet.\n\n`
    + `## Alternativ och konsekvenser\n- Arkivera själv med \`mc programs archive ${programme}\`: uppgifterna tas bort och varje README.md sparas i programmets evidence/.\n- Låt programmet vänta: det förblir öppet och uppgifterna ligger kvar.\n\n`
    + `## Rekommendation och skäl\nKör \`mc programs archive ${programme}\` när uppgifterna inte behövs längre; programmet är i övrigt klart.\n\n`
    + `## Vad som står still\nProgrammet ${programme} väntar på att du arkiverar det.\n\n`
    + `## Kan valet ändras efteråt?\nNej: raderade uppgifter kan inte återskapas.\n`;
}

/* ----------------------------------------------------------- the archiving */

/**
 * A legacy programme's top-level `proposals/*.md` moved to `target`, an area's `proposals/` (the area the record's
 * `area` names when it names a page-area, else `memoro-cli/system`: `archiveOnOk`'s `proposalsTarget`). No programme
 * gets a `proposals/` folder any more; this empties one made before. Each moved file gets a first line naming the
 * programme, never over a file already there (a taken name gets the programme's name in front, then a number). Returns the
 * names moved. `read`/`write`/`remove`/`exists` are the runner's seams; a file that cannot be moved is an error thrown,
 * after the ones before it were: the move is safe to run again, a moved file being gone from the programme.
 */
export function moveProposals({ home, programme, target, list, read, write, remove, exists }) {
  const folder = join(home, programme, 'proposals');
  const moved = [];
  const names = list(folder).filter((entry) => entry.endsWith('.md') && !entry.startsWith('.')).sort();
  // The target is asked only when there is something to move: naming the area may read the repositories.
  const into = names.length && typeof target === 'function' ? target() : target;
  for (const name of names) {
    const text = read(join(folder, name));
    if (text === null || text === undefined) continue;
    let to = join(into, name);
    for (let n = 1; exists(to); n += 1) to = join(into, n === 1 ? `${programme}-${name}` : `${programme}-${n}-${name}`);
    write(to, `From programme ${programme}, which was archived with these still open.\n\n${text}`);
    remove(join(folder, name));
    moved.push(name);
  }
  return moved;
}

/**
 * The record set done, a write that throws (EACCES, ENOSPC) answered as a refusal: `{ ok: false, status: 'unwritten',
 * problems: [message] }`. The destination stays in the state and the failure is counted, never a throw out of the pass.
 */
function setDoneSafely(setDone, dir, seams) {
  try { return setDone(dir, 'done', seams); } catch (error) { return { ok: false, status: 'unwritten', problems: [error?.message || String(error)] }; }
}

function finishRepairArchive(dir, { revision, read, root, lock, write }) {
  return changeProgrammeRecord(dir, record => {
    if (record.state === 'done' && archiveRevision(record) === revision) return record;
    const current = archiveAdmission(dir, { read, record, revision });
    if (current?.release?.revision !== revision) return { problems: current?.problems ?? ['the archive belongs to a different repair release'] };
    return { ...record, state: 'done' };
  }, { root, read, lock, write }, 'repair-archive-finish');
}

/**
 * The archive (C3): `{ ok: true, destination }` (the programme is archived and its record reads done),
 * `{ ok: false, restricted: [entries] }` (the programme holds restricted data: nothing is moved), or `{ ok: false, reason }`.
 *
 * Checked first, in the runner's own reads: `goals/` holds no live goal and the record is open. Then
 * `~/mc/restricted/<programme>/` is read; with entries nothing is touched. Then a legacy programme's proposals move to
 * `proposalsTarget(record)` (an area's `proposals/`), and `archive` — the
 * runner's `archiveProgramme` with its git, gh, docsMerge and release — runs with the fence (a live goal or restricted data
 * that appears meanwhile stops it before anything local is released, deleted or moved) and `onShelved`, which records the
 * destination in the turn state before anything else can fail. The record's state is then set done at the destination (or in
 * place, where the directory did not move) and the destination is cleared.
 */
export async function archiveOnOk({ programme, home, restrictedDir, proposalsTarget, list, read, write, remove, exists, archive, setDone = setRecordState, root, writeJson, lock }) {
  const seams = { root, read, writeJson, lock };
  const dir = join(home, programme);
  if (liveGoals({ home, programme, list }).length) return { ok: false, reason: 'the programme holds a live goal' };
  const record = readRecord(dir, { read });
  if (record.status !== 'valid' || record.record.state !== 'ready') return { ok: false, reason: `its record does not read valid and ready (${record.status === 'valid' ? record.record.state : record.status})` };
  const repair = archiveAdmission(dir, { read, record: record.record });
  const revision = repair?.release?.revision;
  const currentRepair = () => {
    if (!record.record.repair) return null;
    const current = archiveAdmission(dir, { read, revision });
    if (!current?.release) return current?.problems?.[0] ?? 'its repair release is no longer current';
    const due = archiveDue({ programme, home, root, list, read, state: readArchiveState({ root, programme, read }) });
    return due.due && due.mode === 'archive' && due.revision === revision ? null : 'this repair release is no longer current';
  };
  const blocked = currentRepair();
  if (blocked) return { ok: false, stale: true, reason: blocked };
  const entries = list(restrictedDir).filter((entry) => !entry.startsWith('.'));
  if (entries.length) return { ok: false, restricted: entries };
  const fence = () => {
    const problem = currentRepair();
    if (problem) return problem;
    if (liveGoals({ home, programme, list }).length) return 'a goal appeared in the programme';
    const held = list(restrictedDir).filter((entry) => !entry.startsWith('.'));
    return held.length ? `restricted data appeared (${held.join(', ')})` : null;
  };
  try { moveProposals({ home, programme, target: () => proposalsTarget(record.record), list, read, write, remove, exists }); } catch (error) { return { ok: false, reason: `its proposals could not be moved: ${error.message || String(error)}` }; }
  let destination = null; let noted = null;
  const rc = await archive({ fence, onShelved: (moved) => { destination = moved; try { noteDestination({ destination: moved, programme, ...seams }); } catch (error) { noted = error; } } });
  if (rc !== 0) return { ok: false, reason: `archiveProgramme returned ${rc}` };
  if (noted) return { ok: false, reason: `the destination ${destination} was not recorded: ${noted.message || String(noted)}` };
  const where = destination || (exists(dir) ? dir : null);
  if (!where) return { ok: false, reason: 'the programme directory is gone and no destination was recorded' };
  const set = setDoneSafely(revision ? (dir, _state, options) => finishRepairArchive(dir, { revision, ...options }) : setDone,
    where, { root, lock, read, write: (path, text) => write(path, text) });
  if (!set.ok) return { ok: false, reason: `the record at ${where} could not be set to done: ${set.problems?.join('; ') || set.status}`, destination: where };
  try { clearDestination({ programme, ...seams }); } catch (error) { return { ok: false, reason: `the destination was not cleared: ${error.message || String(error)}`, destination: where }; }
  return { ok: true, destination: where };
}

/** What the state write alone does (D: a destination named in the state and its record still open): sets it done, clears it. */
export function finishDestination({ programme, destination, read, write, setDone = setRecordState, root, writeJson, lock }) {
  const record = readRecord(destination, { read });
  const revision = archiveRevision(record.record);
  if (record.record?.repair && !revision) {
    return { ok: false, reason: 'no current repair release for the shelved programme' };
  }
  const set = setDoneSafely(revision ? (dir, _state, options) => finishRepairArchive(dir, { revision, ...options }) : setDone,
    destination, { root, lock, read, write });
  if (!set.ok) return { ok: false, reason: `the record at ${destination} could not be set to done: ${set.problems?.join('; ') || set.status}` };
  try { clearDestination({ programme, root, read, writeJson, lock }); } catch (error) { return { ok: false, reason: `the destination was not cleared: ${error.message || String(error)}` }; }
  return { ok: true, destination };
}
