/** Repair scope belongs to the desk once the author records a stop. */
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { deskItemId, publishRepairStop, readDeskItem, REPAIR_STOP_KIND, repairStopReference } from './desk-items.js';
import { FINISHED, GOALS_DIR, listDirsOf, logStamp, readTextOrNull, setGoalState } from './goals.js';
import { mergesPath, queueEntries } from './merge-queue.js';
import { programsHome, workRoot } from './paths.js';
import { changeProgrammeRecord, readRecord } from './programme-record.js';
import { goalParts } from './programme-turn.js';
import { isRepairAuthor } from './repair-authority.js';
import { isDesk } from './repair-release.js';
import { REPAIR_REVIEW_FILE } from './repair-review.js';
import { realLock } from './runner-lock.js';
import { settleRepairSources } from './repair-sources.js';
import { repoNameOf } from './repos.js';
import { knownRepositories } from './work-area.js';

export const REPAIR_DISPOSITIONS = ['decline', 'return', 'takeover'];
const refused = problem => ({ problems: [problem] });
const clearReview = dir => write => write(join(dir, REPAIR_REVIEW_FILE), '{}\n');
const refuseState = programme => `${programme} has no open repair stop — mc programs show ${programme}`;
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && !/[\p{Cc}]/u.test(value);

function readGoals(dir, read, { strict = true } = {}) {
  const rows = goalParts({ home: join(dir, '..'), programme: basename(dir), list: listDirsOf, read });
  if (!strict) return rows;
  const recorded = new Set(rows.map(row => row.dir));
  const goals = join(dir, GOALS_DIR);
  for (const folder of [goals, join(goals, '.archive')]) {
    for (const name of listDirsOf(folder).filter(name => !name.startsWith('.'))) {
      if (!recorded.has(join(folder, name))) throw new Error(`goal ${name} cannot be read`);
    }
  }
  return rows;
}

// Project after the authoritative write. If this write fails, ordinary desk
// sync recovers it, and repeating the command republishes the same item.
function project(result, { dir, env, lock, read }) {
  if (!result.ok) return result;
  lock(workRoot(env), () => {
    const fresh = readRecord(dir, { read });
    if (fresh.status === 'valid') publishRepairStop(basename(dir), fresh.record, env);
  }, { strict: true, name: 'repair-stop-item' });
  return result;
}

export function stopRepair(dir, env, { title, summary, item }, { now = new Date(), read = readTextOrNull, alive, lock = realLock } = {}) {
  const programme = basename(dir);
  if (!text(title, 160) || !text(summary, 1400)) return refused('a scope stop needs a title and a Swedish summary (one paragraph)');
  const options = { root: workRoot(env), lock, read };
  const result = changeProgrammeRecord(dir, record => {
    if (!record.repair || record.repair.desk || record.repair.disposition?.action === 'decline' || !isRepairAuthor(env, programme, alive)) {
      return refused('only the assigned repair session may stop this repair order');
    }
    if (record.state === 'Martin' && record.repair.stop) return record;
    if (!['draft', 'ready'].includes(record.state)) return refused(`${programme} is not a live repair order`);
    let link;
    if (item) {
      const held = readDeskItem(item, { env });
      if (held?.state !== 'for-martin' || !['text', 'reserved'].includes(held.sort)) return refused('link an open text or reserved-act item from the desk');
      link = { id: held.id, kind: held.sort };
    }
    // Persist any previous disposition's projection before replacing the stop.
    publishRepairStop(programme, record, env);
    const at = now.toISOString();
    const id = deskItemId(REPAIR_STOP_KIND, repairStopReference(programme), at + randomBytes(8).toString('hex'));
    const landed = readGoals(dir, read, { strict: false }).filter(row => row.goal.stage === 'done').map(row => row.name);
    const { disposition: _disposed, ...repair } = record.repair;
    return { ...record, state: 'Martin', repair: { ...repair, stop_item: id,
      stop: { id, at, title: title.trim(), summary: summary.trim(), landed, ...(link ? { link } : {}) } } };
  }, options, 'repair-stop', { beforeWrite: clearReview(dir) });
  return project(result, { dir, env, lock, read });
}

function prState(ref, env) {
  const repo = knownRepositories(env).find(path => repoNameOf(path) === ref.repo);
  if (!repo) return null;
  const result = spawnSync('gh', ['pr', 'view', String(ref.pr), '--json', 'state'], { cwd: repo, encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) return null;
  try { return JSON.parse(result.stdout)?.state; } catch { return null; }
}

function unfinishedFacts(rows) {
  return JSON.stringify(rows.filter(row => row.goal.stage !== 'done').map(({ dir, goal }) => [dir, goal.prs]));
}

function mergerInFlight(root, programme, rows, read) {
  const queue = JSON.parse(read(mergesPath(root)) ?? '[]');
  if (!Array.isArray(queue)) throw new Error('the merge queue is unreadable; nothing was retired');
  const prs = rows.flatMap(row => row.goal.prs);
  return queueEntries(queue).some(job => job.state === 'landing' && (job.goal?.programme === programme
    || prs.some(pr => pr.repo === job.repo && pr.pr === job.pr)));
}

/**
 * The decline intent (including any PR that beat the stop) is durable before
 * the first retirement or source move. A partial decline can only be retried.
 * The ordinary dropped-goal path finalizes PRs/worktrees later with its guards.
 */
export function disposeRepair(dir, env, { action, reason }, { lock = realLock, now = new Date(), read = readTextOrNull, readPr = prState } = {}) {
  const programme = basename(dir), root = workRoot(env);
  if (!isDesk(env)) return refused('only interactive Martin may dispose of a repair stop — mc martin opens the desk');
  if (!REPAIR_DISPOSITIONS.includes(action) || !reason?.trim()) return refused('use mc programs disposition <programme> decline|return|takeover --reason "<text>"');
  const options = { root, lock, read };
  const initial = readRecord(dir, { read }).record;
  const matching = disposition => disposition?.action === action && disposition.reason === reason;
  if (!initial?.repair?.stop) return refused(refuseState(programme));
  if (initial.state !== 'Martin') return matching(initial.repair.disposition)
    ? project({ ok: true, record: initial }, { dir, env, lock, read }) : refused(refuseState(programme));
  const id = initial.repair.stop.id;
  const pending = initial.repair.disposition;
  if (pending && !matching(pending)) return refused(`a ${pending.action} is already recorded for item ${id}; retry that disposition with its original reason`);
  const rows = action === 'decline' && !pending ? readGoals(dir, read) : [];
  const inFlight = 'a merger still owns a pull request of this order; retry disposition when it has answered';
  if (action === 'decline' && !pending && mergerInFlight(root, programme, rows, read)) return refused(inFlight);
  const landed = [];
  for (const row of rows.filter(row => row.goal.stage !== 'done')) {
    for (const pr of row.goal.prs) {
      const state = readPr(pr, env);
      if (!['OPEN', 'CLOSED', 'MERGED'].includes(state)) return refused(`could not establish whether ${pr.repo}#${pr.pr} landed; the repair remains stopped`);
      if (state === 'MERGED' && !landed.includes(row.name)) landed.push(row.name);
    }
  }
  const decide = changeProgrammeRecord(dir, record => {
    if (record.state !== 'Martin' || record.repair?.stop_item !== id) return refused(refuseState(programme));
    const prior = record.repair.disposition;
    if (prior) return matching(prior) ? record : refused(`a disposition is already recorded for item ${id}`);
    const { stop_item: _stopped, ...repair } = record.repair;
    const disposition = { item: id, action, reason, at: now.toISOString() };
    if (action !== 'decline') return { ...record, state: 'draft', repair: { ...repair, disposition, ...(action === 'takeover' ? { desk: true } : {}) } };
    if (unfinishedFacts(readGoals(dir, read)) !== unfinishedFacts(rows)) return refused('goals changed while reading landed work; retry disposition');
    if (mergerInFlight(root, programme, rows, read)) return refused(inFlight);
    return { ...record, repair: { ...record.repair, disposition: { ...disposition, revision: randomUUID(), landed } } };
  }, options, 'repair-disposition', { beforeWrite: clearReview(dir) });
  if (!decide.ok || action !== 'decline') return project(decide, { dir, env, lock, read });
  const retired = changeProgrammeRecord(dir, record => {
    if (record.state !== 'Martin' || record.repair?.stop_item !== id || !matching(record.repair.disposition)) return refused(refuseState(programme));
    const { stop_item: _stopped, ...repair } = record.repair;
    const goals = readGoals(dir, read);
    for (const row of goals.filter(row => !FINISHED.includes(row.goal.stage))) {
      const result = setGoalState({ dir: row.dir, stage: 'dropped', read,
        entry: { at: logStamp(now), tool: env.MC_TOOL || 'person', model: null, role: 'martin', done: null,
          comment: `repair declined (item ${id}): ${reason.replace(/\s+/gu, ' ')}`, next: null } });
      if (result.problems) throw new Error(`${row.name}: ${result.problems.join('; ')}`);
    }
    settleRepairSources({ env, programme, action, reason, sources: repair.sources });
    const hasLanded = goals.some(row => row.goal.stage === 'done') || repair.disposition.landed.length;
    return { ...record, state: hasLanded ? 'ready' : 'done', repair };
  }, options, 'repair-decline');
  return project(retired, { dir, env, lock, read });
}
