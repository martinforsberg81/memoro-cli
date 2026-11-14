/** Model-free durable store behind the Martin desk. */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';
import { collectMartinQueue, currentQuestion } from './martin-collect.js';
import { mainMendPath, readMainMends } from './main-repair.js';
import { parseGoal, parseLog, GOAL_FILE, LOG_FILE } from './goals.js';
import { mcHome, martinDir, programsHome, workRoot } from './paths.js';
import { ledgerPath } from './jev.js';

export const ITEM_STATES = ['new', 'prepared', 'for-martin', 'closed'];
const open = (item) => item.state !== 'closed';
export function deskItemId(kind, reference, sourceAt) {
  return createHash('sha256').update(`${kind}\n${reference}\n${sourceAt}`).digest('hex').slice(0, 24);
}
export function itemStore(env = process.env) { return join(martinDir(env), 'items'); }

/** Sync is idempotent; its only writes are atomic files below ~/mc/martin/items. */
export function syncDeskItems({ env = process.env, home = programsHome(env), root = workRoot(env), mc = mcHome(env), now = () => new Date(), collect = collectMartinQueue, read = readText, list = listDirs, readLedger = readText, readMends = readMainMends, write = writeJsonAtomic, reportIssue = issue => process.stderr.write(`mc: source issue ${issue.path}: ${issue.error}\n`) } = {}) {
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
      sourceAt = entries.find((x) => x.id === entryId)?.created || entryId;
    }
    if (!reference || !sourceAt) continue;
    opens.push({ kind, reference, source_at: sourceAt, question: firstLine(source.question?.question || source.question?.reason || source.reason || 'No source reason recorded.') });
  }
  for (const row of ledgerRows(readLedger(ledgerPath(mc)))) {
    const chosen = row.answers?.answer?.choice;
    const product = row.answers?.product;
    const flagged = row.outcome === 'decided' && ((typeof chosen === 'string' && chosen !== row.recommend) || (typeof product === 'number' && product >= 0.70));
    if (!flagged || Date.parse(row.at) < Date.parse(store.first_sync_at)) continue;
    opens.push({ kind: 'decision', reference: `decision:${row.at}`, source_at: row.at, question: firstLine(row.question || row.reason || 'Decision record') });
  }
  for (const source of opens) {
    const id = deskItemId(source.kind, source.reference, source.source_at);
    if (existing.has(id)) continue;
    const item = { schema: 'mc-desk-item', version: 1, id, kind: source.kind, reference: source.reference,
      source_at: source.source_at, opened_at: now().toISOString(), state: 'new', sort: null, reversible: null, due_at: null, outcome: null };
    write(join(dir, id, 'item.json'), item); existing.set(id, item);
  }
  for (const item of existing.values()) {
    if (!open(item) || !['goal', 'main-red'].includes(item.kind)) continue;
    let summary = null;
    if (item.kind === 'goal') {
      const [programme, goal] = item.reference.split('/'); const gd = join(home, programme, 'goals', goal);
      const path = join(gd, GOAL_FILE);
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
    } else {
      const [, repoAndId] = item.reference.split(':'); const slash = repoAndId.indexOf('/'); const repo = repoAndId.slice(0, slash); const id = repoAndId.slice(slash + 1);
      const entries = sourceMends(repo);
      if (!entries) continue;
      const entry = entries.find((x) => x.id === id);
      if (!entry || entry.state !== 'Martin') summary = entry ? `The main-red source now reads ${entry.state}.` : 'The main-red source no longer exists.';
    }
    if (summary) { item.state = 'closed'; item.outcome = { by: 'source', at: now().toISOString(), summary }; write(join(dir, item.id, 'item.json'), item); }
  }
  for (const issue of issues.values()) reportIssue(issue);
  return [...existing.values()];
}

/** Recover the original label from source history, without extending item.json. */
export function deskItemQuestion(item, { env = process.env, home = programsHome(env), root = workRoot(env), read = readText } = {}) {
  if (item.kind === 'goal') {
    const [programme, goal] = item.reference.split('/');
    const log = parseLog(read(join(home, programme, 'goals', goal, LOG_FILE)) || '');
    const index = log.findIndex(entry => entry.at === item.source_at);
    if (index < 0) return 'Source question unavailable.';
    const question = currentQuestion(log.slice(0, index + 1), 'Martin');
    return firstLine(question?.question || question?.reason || 'Source question unavailable.');
  }
  if (item.kind === 'decision') {
    const row = ledgerRows(read(ledgerPath(mcHome(env)))).find(row => row.at === item.source_at);
    return firstLine(row?.question || row?.reason || 'Source decision unavailable.');
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
export function writeDeskItem(item, { env = process.env, write = writeJsonAtomic } = {}) { write(join(itemStore(env), item.id, 'item.json'), item); }
export function itemDirectory(item, env = process.env) { return join(itemStore(env), item.id); }
export function listDeskItems({ env = process.env, state = null } = {}) {
  const dir = itemStore(env); const items = [];
  for (const name of listDirs(dir)) try { const item = JSON.parse(readText(join(dir, name, 'item.json'))); if (!state || item.state === state) items.push(item); } catch { /* unreadable entry omitted */ }
  return items.sort((a,b) => Number(!open(a))-Number(!open(b)) || String(a.source_at).localeCompare(String(b.source_at)) || a.id.localeCompare(b.id));
}
function ledgerRows(text) { return String(text || '').split(/\n/u).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); }
function firstLine(value) { return String(value).split(/\r?\n/u)[0].trim(); }
function readText(path) { try { return readFileSync(path, 'utf8'); } catch { return null; } }
function listDirs(path) { try { return readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } }
