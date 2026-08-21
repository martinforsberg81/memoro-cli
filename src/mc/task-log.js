/**
 * Tasks (designnote §6, D-0113): one order, tracked, read by four readers —
 * PM, the succeeding PM, Martin, and the guard.
 *
 * A task is created by the dispatcher, never inferred: `mc work send <name>
 * "…" --task` is the one door in. There is no command that reads prose and
 * decides it looks like an order, because a tracker that guesses is worse
 * than none.
 *
 * Storage is `${MC_HOME}/tasks/<session>.jsonl`, one file per recipient,
 * append-only — the same law as the repository lease's log and the notices
 * ledger: mc adds to the user's data, never edits or removes a line. Current
 * state is the replay of the lines, which is what makes "has this moved in
 * twelve hours" a timestamp subtraction over the last line for an id rather
 * than something that has to be maintained in sync with a second copy.
 *
 * Three states and no more: `open` (the line an order writes), `done`, and
 * `blocked` with one line of reason. `done` is where the arrow ends — nothing
 * here moves a task any further once it has arrived, and blocking a finished
 * task is refused rather than silently rewriting history.
 */
import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { mcHome } from './paths.js';
import { currentHolder } from './work-identity.js';

export const TASK_SCHEMA = 'mc-task';
export const TASK_VERSION = 1;

const SUFFIX = '.jsonl';

export function tasksRoot(root = mcHome()) {
  return join(root, 'tasks');
}

export function taskLogPath(session, root = mcHome()) {
  return join(tasksRoot(root), `${session}${SUFFIX}`);
}

/**
 * Every session with a task log at all — the universe `mc task list` and a
 * bare id walk when nobody named one directory.
 */
function listSessions(root) {
  const dir = tasksRoot(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(SUFFIX))
    .map((name) => name.slice(0, -SUFFIX.length));
}

/**
 * One session's tasks, current state only — the replay of every line for
 * each id. A line this reader does not recognise (wrong schema, wrong
 * version, an event that is none of the three) is skipped rather than
 * thrown on: a file four readers share must stay legible to the ones that
 * do not yet know about whatever wrote the line it cannot place.
 */
export function readTasks(session, { root = mcHome() } = {}) {
  const path = taskLogPath(session, root);
  if (!existsSync(path)) return [];
  const byId = new Map();
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    let line;
    try { line = JSON.parse(raw); } catch { continue; }
    if (line?.schema !== TASK_SCHEMA || line?.version !== TASK_VERSION || typeof line.id !== 'string') continue;

    const task = byId.get(line.id) || {
      id: line.id,
      session,
      state: 'open',
      text: null,
      sender: null,
      reason: null,
      opened_at: null,
      updated_at: null,
    };
    if (line.event === 'open') {
      task.text = typeof line.text === 'string' ? line.text : task.text;
      task.sender = typeof line.sender === 'string' ? line.sender : task.sender;
      task.opened_at = task.opened_at || line.at;
    } else if (line.event === 'done') {
      task.state = 'done';
    } else if (line.event === 'blocked') {
      task.state = 'blocked';
      task.reason = typeof line.reason === 'string' ? line.reason : task.reason;
    } else {
      continue;
    }
    task.updated_at = line.at;
    byId.set(line.id, task);
  }
  return [...byId.values()];
}

export function openTasks(session, opts = {}) {
  return readTasks(session, opts).filter((task) => task.state !== 'done');
}

/** Cheap on the common case: most sessions have never had a task at all. */
export function openTaskCount(session, { root = mcHome() } = {}) {
  if (!existsSync(taskLogPath(session, root))) return 0;
  return openTasks(session, { root }).length;
}

export function listOpenTasks({ root = mcHome() } = {}) {
  return listSessions(root).flatMap((session) => openTasks(session, { root }));
}

/**
 * An id, or a prefix of one — the same rule `mc work <name> --resume <id>`
 * already uses for a conversation. Every match across every session's log,
 * so the caller can tell "not found" from "not specific enough" apart.
 */
export function findTask(idOrPrefix, { root = mcHome() } = {}) {
  const needle = String(idOrPrefix || '');
  const matches = [];
  for (const session of listSessions(root)) {
    for (const task of readTasks(session, { root })) {
      if (task.id === needle || task.id.startsWith(needle)) matches.push(task);
    }
  }
  return matches;
}

function append(session, line, root) {
  mkdirSync(tasksRoot(root), { recursive: true, mode: 0o700 });
  appendFileSync(taskLogPath(session, root), `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

/**
 * The one door in. Called from `mc work send <name> "…" --task`, in the
 * same action as the order itself — after the message is already in the
 * recipient's inbox, so a task never exists without the order that opened it
 * being delivered too.
 */
export function openTask({
  session, text, sender = currentHolder(), root = mcHome(), now = new Date(), id = randomUUID(),
} = {}) {
  const at = now.toISOString();
  const body = String(text ?? '');
  append(session, {
    schema: TASK_SCHEMA, version: TASK_VERSION, id, session, event: 'open', at, text: body, sender: sender.name,
  }, root);
  return {
    id, session, state: 'open', text: body, sender: sender.name, reason: null, opened_at: at, updated_at: at,
  };
}

/**
 * `mc task done <id>`. Marking an already-done task done again is not an
 * error — it is the same fact restated — so it is reported as such rather
 * than refused.
 */
export function markTaskDone(idOrPrefix, { root = mcHome(), now = new Date() } = {}) {
  const found = findTask(idOrPrefix, { root });
  if (found.length === 0) return { ok: false, reason: 'not-found' };
  if (found.length > 1) return { ok: false, reason: 'ambiguous', matches: found };
  const [task] = found;
  if (task.state === 'done') return { ok: true, already: true, task };
  const at = now.toISOString();
  append(task.session, {
    schema: TASK_SCHEMA, version: TASK_VERSION, id: task.id, session: task.session, event: 'done', at,
  }, root);
  return { ok: true, already: false, task: { ...task, state: 'done', updated_at: at } };
}

/**
 * `mc task block <id> "<reason>"`. Refused on a task already done — nothing
 * moves a finished task, and pretending it is blocked instead would make
 * `done` a state you can leave.
 */
export function blockTask(idOrPrefix, reason, { root = mcHome(), now = new Date() } = {}) {
  const found = findTask(idOrPrefix, { root });
  if (found.length === 0) return { ok: false, reason: 'not-found' };
  if (found.length > 1) return { ok: false, reason: 'ambiguous', matches: found };
  const [task] = found;
  if (task.state === 'done') return { ok: false, reason: 'already-done', task };
  const at = now.toISOString();
  const line = String(reason || '');
  append(task.session, {
    schema: TASK_SCHEMA, version: TASK_VERSION, id: task.id, session: task.session, event: 'blocked', at, reason: line,
  }, root);
  return { ok: true, task: { ...task, state: 'blocked', reason: line, updated_at: at } };
}
