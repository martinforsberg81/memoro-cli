/** Model-free durable store behind the Martin desk. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';
import { collectMartinQueue, currentQuestion } from './martin-collect.js';
import { mainMendPath, readMainMends } from './main-repair.js';
import { archiveDirIn, listDirsOf, parseGoal, parseLog, GOAL_FILE, LOG_FILE } from './goals.js';
import { NAME_RE } from './plan-schema.js';
import { archivedProgramsHome, mcHome, martinDir, programsHome, workRoot } from './paths.js';
import { ledgerPath, rowAnswer } from './jev.js';
import { realLock } from './runner-lock.js';
import { cuttable, cutProblems, readTurnState, turnStatePath } from './programme-turn.js';
import { readRecord } from './programme-record.js';
import { archiveStatePath, liveGoals, pendingDestination, readArchiveState } from './archive-turn.js';
import { readHorizonState } from './manager-pulse.js';

export const ITEM_STATES = ['new', 'prepared', 'for-martin', 'closed'];
const open = (item) => item.state !== 'closed';
export function deskItemId(kind, reference, sourceAt) {
  return createHash('sha256').update(`${kind}\n${reference}\n${sourceAt}`).digest('hex').slice(0, 24);
}
export function itemStore(env = process.env) { return join(martinDir(env), 'items'); }
export const REPAIR_STOP_KIND = 'repair-stop';
export const repairStopReference = programme => `repair-stop:${programme}`;

/** The programme record is authoritative: either write can be retried by sync. */
function projectRepairStop({ programme, record, env, existing, write = writeJsonAtomic }) {
  const stop = record?.repair?.stop;
  if (!stop) return null;
  const closed = record.repair.stop_item !== stop.id;
  const prior = existing?.get(stop.id) ?? readDeskItem(stop.id, { env });
  const item = {
    schema: 'mc-desk-item', version: 1, id: stop.id, kind: REPAIR_STOP_KIND, reference: repairStopReference(programme),
    source_at: stop.at, opened_at: stop.at, sort: 'scope', reversible: null, due_at: null,
    title: stop.title, summary: stop.summary, landed: [...new Set([...stop.landed, ...(record.repair.disposition?.landed ?? [])])],
    ...(stop.link ? { link: stop.link } : {}),
    state: closed ? 'closed' : 'for-martin',
    outcome: closed ? { by: 'martin', at: record.repair.disposition.at,
      summary: record.repair.disposition.reason, disposition: record.repair.disposition.action } : null,
  };
  if (JSON.stringify(prior) !== JSON.stringify(item)) write(join(itemStore(env), item.id, 'item.json'), item);
  existing?.set(item.id, item);
  return item;
}

/** Caller holds the programme lock. */
export function publishRepairStop(programme, record, env) {
  return projectRepairStop({ programme, record, env });
}

export function repairStopBrief(item) {
  return [item.summary, item.landed?.length ? `Redan landat: ${item.landed.join(', ')}.` : null].filter(Boolean).join('\n\n');
}

/**
 * Sync is idempotent. It runs in one hold of the strict runner lock, from the store marker's
 * reading to the last item write, so every record it decides on was read under the lock
 * (milliseconds: the collect is the bulk). Apart from the lock's own file, its only writes are
 * atomic files below ~/mc/martin/items. A lock that cannot be had throws; nothing is written.
 */
export function syncDeskItems({ env = process.env, lock = realLock, reportIssue = issue => process.stderr.write(`mc: source issue ${issue.path}: ${issue.error}\n`), ...options } = {}) {
  const { items, issues } = lock(workRoot(env), () => syncHeld({ env, ...options }), { strict: true, name: 'desk-items-sync' });
  for (const issue of issues) reportIssue(issue);
  return items;
}

function syncHeld({ env, home = programsHome(env), root = workRoot(env), mc = mcHome(env), now = () => new Date(), collect = collectMartinQueue, read = readText, exists = existsSync, list = listDirs, readLedger = readText, readMends = readMainMends, write = writeJsonAtomic }) {
  const dir = join(martinDir(env), 'items');
  mkdirSync(dir, { recursive: true });
  const marker = join(dir, '.store.json');
  let store;
  try { store = JSON.parse(readText(marker)); } catch { store = null; }
  if (!store?.first_sync_at) { store = { schema: 'mc-desk-item-store', version: 1, first_sync_at: now().toISOString() }; write(marker, store); }
  const existing = new Map();
  for (const name of list(dir)) {
    if (name.startsWith('.')) continue;
    try { const item = JSON.parse(readText(join(dir, name, 'item.json'))); if (item?.id) existing.set(item.id, item); } catch { /* preserve unreadable items */ }
  }
  for (const programme of list(home).filter(name => NAME_RE.test(name))) {
    const found = readRecord(join(home, programme), { read });
    if (found.status === 'valid') projectRepairStop({ programme, record: found.record, env, existing, write });
  }
  // A declined repair can be shelved after the disposition but before its
  // item write. Only the matching archived disposition can close that item.
  for (const item of existing.values()) {
    if (item.kind !== REPAIR_STOP_KIND || !open(item)) continue;
    const programme = item.reference.slice('repair-stop:'.length);
    if (!NAME_RE.test(programme) || exists(join(home, programme))) continue;
    const archive = archivedProgramsHome(env);
    for (const name of list(archive).filter(name => name === programme || (name.startsWith(`${programme}-`) && /^\d+$/u.test(name.slice(programme.length + 1))))) {
      const found = readRecord(join(archive, name), { read });
      if (found.record?.repair?.disposition?.item !== item.id) continue;
      projectRepairStop({ programme, record: found.record, env, existing, write });
      break;
    }
  }
  const live = collect({ home, read });
  const issues = new Map((live.issues || []).map(issue => [issue.path, issue]));
  // A missing or unreadable file is not evidence that a main-red was resolved.
  const mends = new Map();
  const sourceMends = repo => {
    if (!mends.has(repo)) {
      try {
        mends.set(repo, readMends({ root, repo, read: path => {
          const text = read(path);
          if (text == null) throw new Error('missing or unreadable main-mend state');
          return text;
        } }));
      } catch (error) {
        const path = mainMendPath(root, repo);
        issues.set(path, { path, error: error.message });
        mends.set(repo, null);
      }
    }
    return mends.get(repo);
  };
  const opens = [];
  for (const source of live.items || []) {
    const kind = source.kind || 'goal';
    const reference = source.reference;
    let sourceAt = source.question?.at;
    if (kind === 'goal' && issues.has(source.log_path)) continue;
    if (source.kind === 'main-red') {
      const entryId = source.reference.split('/').at(-1);
      const entries = sourceMends(source.repo);
      if (!entries) continue;
      // An answered entry that reaches Martin again is a new question: its source time is the answer's.
      const entry = entries.find((x) => x.id === entryId);
      sourceAt = entry?.answered?.at || entry?.created || entryId;
    }
    if (!reference || !sourceAt) continue;
    opens.push({ kind, reference, source_at: sourceAt, question: firstLine(source.question?.question || source.question?.reason || source.reason || 'No source reason recorded.') });
  }
  for (const row of ledgerRows(readLedger(ledgerPath(mc)))) {
    const chosen = row.answers?.answer?.choice;
    const product = row.answers?.product;
    const answer = rowAnswer(row);
    // A row since the one way to ask: every answer that is not the asker's recommendation, and every unread one. An older row keeps its rule.
    const flagged = answer.old
      ? row.outcome === 'decided' && ((typeof chosen === 'string' && chosen !== row.recommend) || (typeof product === 'number' && product >= 0.70))
      : answer.unread || (typeof answer.chosen === 'string' && answer.chosen !== row.recommend);
    if (!flagged || Date.parse(row.at) < Date.parse(store.first_sync_at)) continue;
    opens.push({ kind: 'decision', reference: `decision:${row.at}`, source_at: row.at, question: firstLine(row.question || row.reason || 'Decision record') });
  }
  for (const source of opens) {
    const id = deskItemId(source.kind, source.reference, source.source_at);
    if (existing.has(id)) continue;
    // A goal's item is its current question: a note that is not one opens nothing beside an item at or after it.
    if (source.kind === 'goal' && [...existing.values()].some(item => item.kind === 'goal' && item.reference === source.reference && open(item) && Date.parse(item.source_at) >= Date.parse(source.source_at))) continue;
    const item = { schema: 'mc-desk-item', version: 1, id, kind: source.kind, reference: source.reference,
      source_at: source.source_at, opened_at: now().toISOString(), state: 'new', sort: null, reversible: null, due_at: null, outcome: null };
    write(join(dir, id, 'item.json'), item); existing.set(id, item);
  }
  for (const item of existing.values()) {
    if (!open(item) || !['goal', 'main-red', 'programme', 'manager', 'archive'].includes(item.kind)) continue;
    let summary = null;
    if (item.kind === 'goal') {
      const [programme, goal] = item.reference.split('/'); const gd = join(home, programme, 'goals', goal);
      const path = join(gd, GOAL_FILE);
      // A goal whose live file is absent may have left goals/ for the archive, which then decides. A live file that
      // exists is judged as it is, whatever the archive holds.
      const archived = exists(path) ? null : archivedFinish({ home, programme, goal, read });
      if (archived) summary = archived;
      else {
        const parsed = parseGoal(read(path) || '');
        if (parsed.problems) {
          issues.set(path, { path, error: parsed.problems.join('; ') });
          continue;
        }
        if (parsed.stage === 'done' || parsed.stage === 'dropped' || parsed.status !== 'Martin') summary = `The goal now reads ${parsed.stage} · ${parsed.status}.`;
        else {
          const logPath = join(gd, LOG_FILE), text = read(logPath);
          const log = parseLog(text || '');
          if (text == null || (text.match(/^## /gmu) || []).length !== log.length) {
            issues.set(logPath, { path: logPath, error: 'missing, unreadable or malformed LOG.md' });
            continue;
          }
          const question = currentQuestion(log, parsed.status);
          if (Date.parse(question?.at) > Date.parse(item.source_at)) summary = `A later question now waits at ${question.at}.`;
        }
      }
    } else if (item.kind === 'programme') {
      // A programme item is the planning turn's: it closes when a goal names every part of the programme document,
      // its record no longer reads valid and ready, or its directory is gone. A state file that cannot be read keeps it open, said.
      const programme = item.reference.slice('programme:'.length);
      const turn = readTurnState({ root, programme, read });
      if (turn.status === 'unreadable') {
        const path = turnStatePath(root, programme);
        issues.set(path, { path, error: turn.problem });
        continue;
      }
      const record = exists(join(home, programme)) ? readRecord(join(home, programme), { read }) : null;
      if (!record) summary = 'The programme directory is gone.';
      else if (record.status !== 'valid' || record.record.state !== 'ready') summary = 'The programme record no longer reads valid and ready.';
      else if (!cutProblems({ home, programme, list, read }).length) summary = 'Goals now name every part of the programme document.';
    } else if (item.kind === 'archive') {
      // An archive item is the archive turn's: it closes by source only when the programme directory is gone from the
      // programmes home or its goals/ holds a live goal. A directory gone while the state still names a destination whose
      // record does not read done is a record write that failed after the move: the item stays open until it is decided,
      // so a write that keeps failing opens no new item. A state file that cannot be read keeps it open, said.
      const programme = item.reference.slice('archive:'.length);
      const turn = readArchiveState({ root, programme, read });
      if (turn.status === 'unreadable') {
        const path = archiveStatePath(root, programme);
        issues.set(path, { path, error: turn.problem });
        continue;
      }
      if (!exists(join(home, programme))) { if (!pendingDestination(turn, { read })) summary = 'The programme directory is gone.'; }
      else if (liveGoals({ home, programme, list }).length) summary = 'The programme now holds a live goal.';
    } else if (item.kind === 'manager') {
      // A manager item was opened by the manager's horizon turn, which is removed: nothing starts that turn again,
      // so the item closes by source.
      summary = "The manager's horizon turn is removed.";
    } else {
      const [, repoAndId] = item.reference.split(':'); const slash = repoAndId.indexOf('/'); const repo = repoAndId.slice(0, slash); const id = repoAndId.slice(slash + 1);
      const entries = sourceMends(repo);
      if (!entries) continue;
      const entry = entries.find((x) => x.id === id);
      if (!entry || entry.state !== 'Martin') summary = entry ? `The main-red source now reads ${entry.state}.` : 'The main-red source no longer exists.';
    }
    if (summary) { item.state = 'closed'; item.outcome = { by: 'source', at: now().toISOString(), summary }; write(join(dir, item.id, 'item.json'), item); }
  }
  return { items: [...existing.values()], issues: [...issues.values()] };
}

/** Recover the original label from source history, without extending item.json. */
export function deskItemQuestion(item, { env = process.env, home = programsHome(env), root = workRoot(env), read = readText } = {}) {
  if (item.kind === REPAIR_STOP_KIND) return firstLine(item.title);
  if (item.kind === 'goal') {
    const [programme, goal] = item.reference.split('/');
    const log = parseLog(read(join(home, programme, 'goals', goal, LOG_FILE)) || '');
    // The entry with status Martin at that minute: another entry may share it (stamps have minute resolution).
    const index = log.findIndex(entry => entry.at === item.source_at && entry.status === 'Martin');
    if (index < 0) return 'Source question unavailable.';
    const question = currentQuestion(log.slice(0, index + 1), 'Martin');
    return firstLine(question?.question || question?.reason || 'Source question unavailable.');
  }
  // A text item has no source to recover a label from: its label is the text it names.
  if (item.kind === 'text') return firstLine(item.text ?? item.reference.replace(/^text:/u, ''));
  if (item.kind === 'decision') {
    const row = ledgerRows(read(ledgerPath(mcHome(env)))).find(row => row.at === item.source_at);
    return firstLine(row?.question || row?.reason || 'Source decision unavailable.');
  }
  if (item.kind === 'programme') {
    const state = readTurnState({ root, programme: item.reference.slice('programme:'.length), read });
    const last = state.status === 'valid' ? state.state.failures.at(-1) : null;
    return firstLine(last?.reason || 'Source reason unavailable.');
  }
  if (item.kind === 'archive') {
    const state = readArchiveState({ root, programme: item.reference.slice('archive:'.length), read });
    const last = state.status === 'valid' ? state.state.failures.at(-1) : null;
    return firstLine(last?.reason || 'The write-back reading found a gap.');
  }
  if (item.kind === 'manager') {
    const state = readHorizonState({ root, slug: item.reference.slice('manager:'.length), read });
    const last = state.status === 'valid' ? state.state.failures.at(-1) : null;
    return firstLine(last?.reason || 'Source reason unavailable.');
  }
  const match = item.reference.match(/^main-red:([^/]+)\/(.+)$/u);
  try {
    const entry = readMainMends({ root, repo: match[1], read }).find(entry => entry.id === match[2]);
    return firstLine(entry?.reason || 'Source reason unavailable.');
  } catch { return 'Source reason unavailable.'; }
}

export function readDeskItem(id, { env = process.env, read = readText } = {}) {
  if (!/^[a-f0-9]{24}$/u.test(id)) return null;
  try { return JSON.parse(read(join(itemStore(env), id, 'item.json'))); } catch { return null; }
}
/** An unlocked write: fixtures only. Every change of an item in the product goes through `updateDeskItem`. */
export function writeDeskItem(item, { env = process.env, write = writeJsonAtomic } = {}) { write(join(itemStore(env), item.id, 'item.json'), item); }

/**
 * The one way an item.json changes: a read-modify-write under the strict runner lock, as
 * `updateMainMends` does. `change` gets the record read inside the lock (null when there is none) and
 * returns the record to write, or null to refuse: then nothing is written. The result is
 * `{ item, written }`, `item` being the record written or, on a refusal, the record read. A lock that
 * cannot be had throws and nothing is written. The lock is not re-entrant: nothing `change` calls may
 * take it. `read` takes the id, `write` the item.json path and the record.
 */
export function updateDeskItem(id, change, { env = process.env, lock = realLock, read = (itemId) => readDeskItem(itemId, { env }), write = writeJsonAtomic } = {}) {
  return lock(workRoot(env), () => {
    const current = read(id);
    const next = change(current);
    if (!next) return { item: current, written: false };
    write(join(itemStore(env), id, 'item.json'), next);
    return { item: next, written: true };
  }, { strict: true, name: 'desk-item' });
}
export function itemDirectory(item, env = process.env) { return join(itemStore(env), item.id); }
export function listDeskItems({ env = process.env, state = null } = {}) {
  const dir = itemStore(env); const items = [];
  for (const name of listDirs(dir)) try { const item = JSON.parse(readText(join(dir, name, 'item.json'))); if (!state || item.state === state) items.push(item); } catch { /* unreadable entry omitted */ }
  return items.sort((a,b) => Number(!open(a))-Number(!open(b)) || String(a.source_at).localeCompare(String(b.source_at)) || a.id.localeCompare(b.id));
}
/**
 * The summary that closes a goal item whose goal has left `goals/`: the last archived directory of exactly that goal's
 * name, or of its name with the stamp `archiveGoal` adds, read as a finished goal. Null when there is none, or when its
 * goal file does not parse or is neither done nor dropped: the item then stays open and the live path is reported.
 */
function archivedFinish({ home, programme, goal, read }) {
  const archive = archiveDirIn(home, programme);
  const name = listDirsOf(archive).filter(n => n === goal || (n.startsWith(`${goal}-`) && /^-\d{8}T\d{4}$/u.test(n.slice(goal.length)))).at(-1);
  if (!name) return null;
  const parsed = parseGoal(read(join(archive, name, GOAL_FILE)) || '');
  if (parsed.problems) return null;
  if (parsed.stage === 'done') return 'The goal is done and archived.';
  if (parsed.stage !== 'dropped') return null;
  const reason = dropReason(parseLog(read(join(archive, name, LOG_FILE)) || ''));
  return `The goal is dropped and archived.${reason ? ` Reason: ${reason}` : ''}`;
}
/** The first line of the comment of the entry at which the goal became dropped: the first of the log's last run of `dropped` entries. */
function dropReason(log) {
  let i = log.length - 1;
  while (i >= 0 && log[i].stage !== 'dropped') i -= 1;
  if (i < 0) return null;
  while (i > 0 && log[i - 1].stage === 'dropped') i -= 1;
  return log[i].comment ? firstLine(log[i].comment) : null;
}
function ledgerRows(text) { return String(text || '').split(/\n/u).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); }
function firstLine(value) { return String(value).split(/\r?\n/u)[0].trim(); }
function readText(path) { try { return readFileSync(path, 'utf8'); } catch { return null; } }
function listDirs(path) { try { return readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } }
