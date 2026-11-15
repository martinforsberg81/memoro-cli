/**
 * The programme archive turn, model-free except for one read-only reading
 * (mc-run.md, "Programme archive turn").
 *
 * A programme with a record (PROGRAMME.json) whose goals are all finished is
 * archived by the runner, without a person present, once its write-back reads
 * OK: what the programme made true is written into `docs/technical/` and the
 * area pages (Martin, 2026-11-15, programme horizon). Everything here is what
 * the runner decides around the one reading session: whether a programme is
 * due, the reading's file and its parse, the state that keeps an OK reading
 * and counts what failed, the desk item a NOT OK reading or a second failure
 * opens, the proposals moved out of the programme, and the archive itself,
 * fenced, with the record's state set to done once the directory has moved.
 * The runner (`run.js`) supplies its own file reads, lock and git, so a
 * fixture drives all of it in memory.
 *
 * A programme without a record is never read or archived here: for it
 * `mc plan <programme> --archive` stays a person's act.
 */
import { join } from 'node:path';
import { deskItemId } from './desk-items.js';
import { archiveDirIn, parseGoal, GOAL_FILE } from './goals.js';
import { NAME_RE } from './plan-schema.js';
import { readRecord, setRecordState } from './programme-record.js';
import { sameHead, writeBackFault } from './review-verdict.js';

export const ARCHIVE_SCHEMA = 'mc-archive-turn';
export const ARCHIVE_VERSION = 1;
export const ARCHIVE_ITEM_KIND = 'archive';
/** The failures since the last item that open one: the first lets the next pass read again, the second is the item. */
export const FAILURES_TO_ITEM = 2;
/** The file the reader writes, in the programme's directory. */
export const WRITE_BACK_FILE = 'WRITE-BACK.md';
/** The review file an archived goal holds. */
export const REVIEW_FILE = 'REVIEW.md';

/** `archive:<programme>`: what the turn is called in a claim, a current record and a runs.tsv row, and an item's reference. */
export const archiveName = (programme) => `archive:${programme}`;
export const archiveReference = archiveName;

/** `runner/archive-turn/<programme>.json` under the work root. */
export const archiveStatePath = (root, programme) => join(root, 'runner', 'archive-turn', `${programme}.json`);
/** The directory of the state files: a programme whose directory has moved is still named here while its state is unwritten. */
export const archiveStateDir = (root) => join(root, 'runner', 'archive-turn');
/** The prefix of the reading's read checkouts' directory, `runner/work/archive-turn-<programme>` (`setUpReadCheckouts`' `prefix`). */
export const ARCHIVE_CHECKOUTS_PREFIX = 'archive-turn';

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
  // A file from an older version of the turn is read as nothing recorded: no failures and no kept reading (mixed versions, mc-run.md).
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

/** Whether `goals/` holds a live goal: any entry but a dot-entry. */
export const liveGoals = ({ home, programme, list }) => list(join(home, programme, 'goals')).filter((name) => !name.startsWith('.'));

/**
 * Whether `programme` is due now, model-free: `{ due: true, mode: 'read', record, goals }` (a reading and, on OK, the
 * archive), `{ due: true, mode: 'archive', record, goals }` (an OK reading is kept for exactly the goals archived now:
 * the archive is tried again with no new reading), `{ due: true, mode: 'state', destination }` (the programme's directory
 * has moved and its record still reads open: that write alone), or `{ due: false, reason, notice }` where `notice` is the
 * line the runner says once while it lasts. `items` are the desk items, `state` is `readArchiveState`'s answer.
 */
export function archiveDue({ programme, home, root, list, read, items = [], state }) {
  if (state.status === 'unreadable') {
    return { due: false, reason: 'its turn state is unreadable', notice: `${programme}: ${archiveStatePath(root, programme)} is unreadable (${state.problem}) — nothing is read or archived until it is repaired or removed` };
  }
  const pending = state.status === 'valid' ? state.state.destination : null;
  if (pending) {
    // The directory moved and the write that sets the record done did not finish: that write alone, with no reading. A record
    // that already reads done is only cleared from the state.
    const found = readRecord(pending, { read });
    if (found.status === 'valid') return { due: true, mode: 'state', destination: pending };
    return { due: false, reason: 'its destination record cannot be read', notice: `${programme}: the record at ${pending} cannot be read (${found.status}) — it is not set to done until it is repaired` };
  }
  const dir = join(home, programme);
  const record = readRecord(dir, { read });
  if (record.status === 'none') return { due: false, reason: 'no record', notice: null };
  if (record.status === 'invalid') return { due: false, reason: 'its record is invalid', notice: null };
  if (record.record.state !== 'open') return { due: false, reason: `its record reads ${record.record.state}`, notice: null };
  if (liveGoals({ home, programme, list }).length) return { due: false, reason: 'it holds a live goal', notice: null };
  if (items.some((item) => item.kind === ARCHIVE_ITEM_KIND && item.reference === archiveReference(programme) && item.state !== 'closed')) {
    return { due: false, reason: 'an archive desk item is open', notice: null };
  }
  const goals = archivedGoals({ home, programme, list, read });
  if (goals.problems.length) return { due: false, reason: 'an archived goal cannot be read', notice: `${programme}: ${goals.problems.join('; ')} — no write-back reading is taken until that is repaired` };
  // A programme whose goals were all dropped is no programme that made anything true: nothing is read or archived.
  if (!goals.done.length) return { due: false, reason: 'no goal reached done', notice: null };
  const reading = state.status === 'valid' ? state.state.reading : null;
  const kept = reading && reading.verdict === 'OK' && reading.goals.join('\n') === goals.done.join('\n');
  return { due: true, mode: kept ? 'archive' : 'read', record: record.record, goals: goals.done, dropped: goals.dropped, repos: goals.repos };
}

/* ------------------------------------------------------------- the reading */

/**
 * WRITE-BACK.md, parsed (C2): `{ ok: true, verdict, lines, goals }` or `{ ok: false, problems }`. `goals` are the done
 * goals the file must judge, `checkouts` is `{ <repo>: <sha> }` of what the reader was given. The file is malformed, and
 * the reading failed, when a checkout has no `read: <repo> <sha>` line or one with another sha, a done goal has no line or
 * two, a line names a goal that is not a done one, a line is in no form (`<goal>: OK — <repo>/docs/technical/<page>.md §
 * <section>[, …]`, `<goal>: OK — none — <reason>`, `<goal>: NOT OK — <what is true that no page says>`), the last line
 * is not `verdict: OK` or `verdict: NOT OK`, or the verdict is OK beside a NOT OK line (or NOT OK with none).
 */
export function parseWriteBack(text, { goals, checkouts }) {
  if (text === null || text === undefined) return { ok: false, problems: [`${WRITE_BACK_FILE} is missing`] };
  const problems = [];
  const lines = String(text).split('\n').map((line) => line.trim()).filter(Boolean);
  const reads = []; const judged = new Map(); let verdict = null;
  for (const [index, line] of lines.entries()) {
    const readLine = line.match(/^read: (\S+) ([0-9a-f]{7,64})$/u);
    const verdictLine = line.match(/^verdict: (OK|NOT OK)$/u);
    const goalLine = line.match(/^([^\s:]+): (OK|NOT OK)(?: — (.*))?$/u);
    if (readLine) { reads.push({ repo: readLine[1], sha: readLine[2] }); continue; }
    if (verdictLine) {
      if (index !== lines.length - 1) problems.push('`verdict:` is not the last line');
      verdict = verdictLine[1];
      continue;
    }
    if (goalLine) {
      const [, goal, word, reason = ''] = goalLine;
      const ok = word === 'OK';
      if (!goals.includes(goal)) { problems.push(`a line for "${goal}", which is no done goal of the programme`); continue; }
      if (judged.has(goal)) { problems.push(`two lines for ${goal}`); continue; }
      if (!ok && !reason.trim()) { problems.push(`${goal}: NOT OK needs what is true that no page says`); }
      const fault = writeBackFault({ ok, reason: reason.trim() });
      if (fault) problems.push(`${goal}: ${fault}`);
      judged.set(goal, { ok, reason: reason.trim() });
      continue;
    }
    problems.push(`not in form: "${line}"`);
  }
  for (const [repo, sha] of Object.entries(checkouts)) {
    const found = reads.filter((one) => one.repo === repo);
    if (found.length !== 1) problems.push(`${found.length ? 'more than one' : 'no'} \`read: ${repo} <sha>\` line — the checkout is at ${sha}`);
    else if (!sameHead(found[0].sha, sha)) problems.push(`\`read: ${repo} ${found[0].sha}\` is not the checkout's commit ${sha}`);
  }
  for (const one of reads) if (!(one.repo in checkouts)) problems.push(`\`read: ${one.repo}\` names no checkout given`);
  for (const goal of goals) if (!judged.has(goal)) problems.push(`no line for the done goal ${goal}`);
  if (verdict === null) problems.push('no last line `verdict: OK` or `verdict: NOT OK`');
  else {
    const notOk = [...judged.values()].some((one) => !one.ok);
    if (verdict === 'OK' && notOk) problems.push('`verdict: OK` beside a NOT OK line');
    if (verdict === 'NOT OK' && !notOk) problems.push('`verdict: NOT OK` with no NOT OK line saying what is missing');
  }
  if (problems.length) return { ok: false, problems };
  return { ok: true, verdict, goals: Object.fromEntries(judged), lines: [...judged.entries()].filter(([, one]) => !one.ok).map(([goal, one]) => `${goal}: NOT OK — ${one.reason}`) };
}

/** What the reader is told: the programme, what to read, the file to write and its forms. */
export function archiveReadPrompt({ programme, dir, goals, dropped = [], checkouts, archive }) {
  const read = Object.entries(checkouts).map(([repo, path]) => `${repo}: \`${path}\``).join('; ');
  const goalList = goals.map((goal) => `- ${goal}: \`${join(archive, goal)}\` (GOAL.json, LOG.md, ${REVIEW_FILE})`).join('\n');
  const droppedLine = dropped.length ? ` Dropped goals (${dropped.join(', ')}) made nothing true and are not judged.` : '';
  return `You are the headless archive reader for programme ${programme}, with nobody present. Every goal of the programme is finished; the programme is archived by the system only if what it made true is written into docs/technical/ and the area pages. Its directory is \`${dir}\`; read its README.md first. The done goals, each with its goal file, log and review, are:\n${goalList}${droppedLine}\n`
    + `Read checkouts at origin/main are ${read}; read code and docs there and change nothing in them. For each done goal decide what it made true of the app that a reader of docs/technical/ and the area pages needs, and read the pages to see whether they say it. Write ${dir}/${WRITE_BACK_FILE} and nothing else, with: one line \`read: <repo> <sha>\` per checkout (the sha its HEAD is at); one line per done goal, \`<goal>: OK — <repo>/docs/technical/<page>.md § <section>[, …]\`, \`<goal>: OK — none — <reason>\` or \`<goal>: NOT OK — <what is true that no page says>\`; and a last line \`verdict: OK\` when no goal is NOT OK, else \`verdict: NOT OK\`. Your role page says the rest.`;
}

/** The check-in for the reading: keep to the one task. */
export function archiveCheckInPrompt({ minutes, count }) {
  return `Archive reading check-in after ${minutes} minutes (${count}). Keep to the one task: read each done goal against the pages at origin/main, then write ${WRITE_BACK_FILE} in the programme's directory and end. Change nothing else; write no page yourself.`;
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

/** The OK reading kept, for exactly the goals it judged: the archive is tried again on it without a new reading. */
export function keepReading({ at, goals, lines = [], ...seams }) {
  return withState(seams, (state) => { state.reading = { at, verdict: 'OK', goals: [...goals], lines }; });
}

/** Where the programme's directory moved to: recorded before anything else can fail, so the record's state is set later. */
export function noteDestination({ destination, ...seams }) {
  return withState(seams, (state) => { state.destination = destination; });
}

/** The archive done and the record read done: the destination is cleared, and the reading is no longer needed. */
export function clearDestination(seams) {
  return withState(seams, (state) => { state.destination = null; state.reading = null; });
}

const failureLines = (failures) => failures.map((failure) => `- ${failure.at}: ${failure.reason}${failure.log ? ` (session log: ${failure.log})` : ''}`).join('\n');

/**
 * A reading or an archive that did not end in an archived programme, counted. `kind` is `not-ok` (a reading that found a
 * gap: `lines` are its NOT OK lines) or `failed` (a missing or malformed file, a session that ended without one, an archive
 * that returned 1). A NOT OK reading opens an item at once — `prepared`, for the decision lane, unless an item of the
 * programme was closed by a decision or a failure already stands since the last item, then `for-martin` — and a failure
 * opens one at the second since the last item (`for-martin`, sort mechanical, with a Swedish `brief.md`). `decided` says
 * whether an earlier archive item of the programme was closed by decision. Returns `{ count, item }`; an unreadable state
 * throws and nothing is written.
 */
export function recordArchiveFailure({ kind, reason, log = null, lines = [], at, decided = false, env, write, itemDirectory, ...seams }) {
  return withState(seams, (state) => {
    const { programme } = seams;
    // A NOT OK reading is a finding, not a failure: it opens its item at once and is not counted towards the second failure.
    if (kind !== 'not-ok') state.failures.push({ at, reason, log });
    const recent = failuresSinceItem(state);
    const second = kind !== 'not-ok' && recent.length >= FAILURES_TO_ITEM;
    if (kind !== 'not-ok' && !second) return { count: recent.length, item: null };
    const mechanical = second || decided;
    const reference = archiveReference(programme);
    const id = deskItemId(ARCHIVE_ITEM_KIND, reference, at);
    const item = { schema: 'mc-desk-item', version: 1, id, kind: ARCHIVE_ITEM_KIND, reference, source_at: at, opened_at: at,
      state: mechanical ? 'for-martin' : 'prepared', sort: 'mechanical', reversible: mechanical ? false : null, due_at: null, outcome: null };
    const dir = itemDirectory(item, env);
    // The text is written before the item names it: a decision pass that finds the item finds what it reads.
    if (mechanical) write(join(dir, 'brief.md'), briefText({ programme, kind, failures: recent, lines }));
    else write(join(dir, 'prepared.md'), preparedText({ programme, failures: recent, lines, item }));
    seams.writeJson(join(dir, 'item.json'), item);
    state.items.push({ id, opened_at: at });
    return { count: recent.length, item };
  });
}

/**
 * The programme holds restricted data (`~/mc/restricted/<programme>/`): deleting it stays a person's act, so the item is
 * opened at once, `for-martin`, sort reserved, with a Swedish brief naming `mc plan <programme> --archive`.
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

/** What the decision session reads for a prepared item: the gap the reading found (or the failures), and where to look. */
function preparedText({ programme, failures, lines, item }) {
  const gap = lines.length ? `## What the reading found\n${lines.map((line) => `- ${line}`).join('\n')}\n\n` : '';
  return `# Programme ${programme}: the write-back reading is not OK\n\n`
    + `Every goal of programme ${programme} is finished, and the runner's archive reading found what the programme made true that no page says. `
    + `Nothing was asked of Martin; this is a gap to close within reach.\n\n`
    + gap
    + `## The failures\n${failureLines(failures)}\n\n`
    + `## Where to look\n- Programme directory: ${programme} under the programmes home, with README.md, PROGRAMME.json, WRITE-BACK.md and goals/.archive/.\n`
    + `- The turn's state: runner/archive-turn/${programme}.json under the work root.\n`
    + `- Item: ${item.id}.\n\n`
    + `## What closes it\nWrite the missing pages: make a goal in the programme that writes them into docs/technical/ and the area pages. The item closes by itself when the programme holds a live goal, and the runner reads the write-back again once that goal is archived. `
    + `Or settle that the reading was wrong, and close the item (--by decision) so the runner reads again. A text of Martin's that would have to change goes to a brief instead.\n`;
}

/** The brief a mechanical item carries. Swedish, as the desk reads it. */
function briefText({ programme, kind, failures, lines }) {
  const what = kind === 'not-ok'
    ? `Skrivningen av vad programmet ${programme} gjorde sant saknas fortfarande efter att ett tidigare ärende stängts; programmet kan inte arkiveras automatiskt.`
    : `Arkivläsningen eller arkiveringen av programmet ${programme} misslyckades igen; programmet kan inte arkiveras automatiskt.`;
  const gap = lines.length ? `Läsningen fann:\n${lines.map((line) => `- ${line}`).join('\n')}\n\n` : '';
  return `## Vad det gäller\n${what}\n\n`
    + `## Alternativ och konsekvenser\n- Undersök underlaget: arkiveringen kan köras igen när felet är löst eller sidorna är skrivna.\n- Låt programmet vänta: det förblir öppet och syns här.\n\n`
    + `## Rekommendation och skäl\nUndersök underlaget; läsningen eller arkiveringen har misslyckats igen sedan ett tidigare ärende stängts eller efter två försök.\n\n`
    + `## Vad som står still\nProgrammet ${programme} väntar på Martin. ${gap}Felunderlag:\n${failureLines(failures)}\n\n`
    + `## Kan valet ändras efteråt?\nIngen automatisk tillämpning; detta är ett mekaniskt fel som kräver undersökning.\n`;
}

/** The brief of the restricted-data item. Swedish. */
function restrictedBrief({ programme, entries }) {
  return `## Vad det gäller\nProgrammet ${programme} är färdigt och dess skrivning av vad det gjorde sant är bekräftad, men ~/mc/restricted/${programme}/ innehåller uppgifter (${entries.join(', ')}). Att radera dem är ditt beslut, så systemet arkiverar inte programmet.\n\n`
    + `## Alternativ och konsekvenser\n- Arkivera själv med \`mc plan ${programme} --archive\`: uppgifterna tas bort och varje README.md sparas i programmets evidence/.\n- Låt programmet vänta: det förblir öppet och uppgifterna ligger kvar.\n\n`
    + `## Rekommendation och skäl\nKör \`mc plan ${programme} --archive\` när uppgifterna inte behövs längre; programmet är i övrigt klart.\n\n`
    + `## Vad som står still\nProgrammet ${programme} väntar på att du arkiverar det.\n\n`
    + `## Kan valet ändras efteråt?\nNej: raderade uppgifter kan inte återskapas.\n`;
}

/* ----------------------------------------------------------- the archiving */

/**
 * The programme's top-level `proposals/*.md` moved to `target` (`~/mc/proposals/`), each with a first line naming the
 * programme, never over a file already there (a taken name gets the programme's name in front, then a number). Returns the
 * names moved. `read`/`write`/`remove`/`exists` are the runner's seams; a file that cannot be moved is an error thrown,
 * after the ones before it were: the move is safe to run again, a moved file being gone from the programme.
 */
export function moveProposals({ home, programme, target, list, read, write, remove, exists }) {
  const folder = join(home, programme, 'proposals');
  const moved = [];
  for (const name of list(folder).filter((entry) => entry.endsWith('.md') && !entry.startsWith('.')).sort()) {
    const text = read(join(folder, name));
    if (text === null || text === undefined) continue;
    let to = join(target, name);
    for (let n = 1; exists(to); n += 1) to = join(target, n === 1 ? `${programme}-${name}` : `${programme}-${n}-${name}`);
    write(to, `From programme ${programme}, which was archived with these still open.\n\n${text}`);
    remove(join(folder, name));
    moved.push(name);
  }
  return moved;
}

/**
 * The archive on an OK reading (C3): `{ ok: true, destination }` (the programme is archived and its record reads done),
 * `{ ok: false, restricted: [entries] }` (the programme holds restricted data: nothing is moved), or `{ ok: false, reason }`.
 *
 * Checked first, in the runner's own reads: `goals/` holds no live goal and the record is open. Then
 * `~/mc/restricted/<programme>/` is read; with entries nothing is touched. Then the proposals move, and `archive` — the
 * runner's `archiveProgramme` with its git, gh, docsMerge and release — runs with the fence (a live goal or restricted data
 * that appears meanwhile stops it before anything local is released, deleted or moved) and `onShelved`, which records the
 * destination in the turn state before anything else can fail. The record's state is then set done at the destination (or in
 * place, where the directory did not move) and the destination is cleared.
 */
export async function archiveOnOk({ programme, home, restrictedDir, proposalsHome, list, read, write, remove, exists, archive, setDone = setRecordState, root, writeJson, lock }) {
  const seams = { root, read, writeJson, lock };
  const dir = join(home, programme);
  if (liveGoals({ home, programme, list }).length) return { ok: false, reason: 'the programme holds a live goal' };
  const record = readRecord(dir, { read });
  if (record.status !== 'valid' || record.record.state !== 'open') return { ok: false, reason: `its record does not read valid and open (${record.status === 'valid' ? record.record.state : record.status})` };
  const entries = list(restrictedDir).filter((entry) => !entry.startsWith('.'));
  if (entries.length) return { ok: false, restricted: entries };
  const fence = () => {
    if (liveGoals({ home, programme, list }).length) return 'a goal appeared in the programme';
    const held = list(restrictedDir).filter((entry) => !entry.startsWith('.'));
    return held.length ? `restricted data appeared (${held.join(', ')})` : null;
  };
  try { moveProposals({ home, programme, target: proposalsHome, list, read, write, remove, exists }); } catch (error) { return { ok: false, reason: `its proposals could not be moved: ${error.message || String(error)}` }; }
  let destination = null; let noted = null;
  const rc = await archive({ fence, onShelved: (moved) => { destination = moved; try { noteDestination({ destination: moved, programme, ...seams }); } catch (error) { noted = error; } } });
  if (rc !== 0) return { ok: false, reason: `archiveProgramme returned ${rc}` };
  if (noted) return { ok: false, reason: `the destination ${destination} was not recorded: ${noted.message || String(noted)}` };
  const where = destination || (exists(dir) ? dir : null);
  if (!where) return { ok: false, reason: 'the programme directory is gone and no destination was recorded' };
  const set = setDone(where, 'done', { read, write: (path, text) => write(path, text) });
  if (!set.ok) return { ok: false, reason: `the record at ${where} could not be set to done: ${set.problems?.join('; ') || set.status}`, destination: where };
  try { clearDestination({ programme, ...seams }); } catch (error) { return { ok: false, reason: `the destination was not cleared: ${error.message || String(error)}`, destination: where }; }
  return { ok: true, destination: where };
}

/** What the state write alone does (D: a destination named in the state and its record still open): sets it done, clears it. */
export function finishDestination({ programme, destination, read, write, setDone = setRecordState, root, writeJson, lock }) {
  const set = setDone(destination, 'done', { read, write });
  if (!set.ok) return { ok: false, reason: `the record at ${destination} could not be set to done: ${set.problems?.join('; ') || set.status}` };
  try { clearDestination({ programme, root, read, writeJson, lock }); } catch (error) { return { ok: false, reason: `the destination was not cleared: ${error.message || String(error)}` }; }
  return { ok: true, destination };
}
