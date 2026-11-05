/**
 * `~/.memoro/mc/dev-queue.json` — who is waiting for an app server, in order.
 *
 * Until 2026-11-03 every waiter polled the registry every ten seconds and
 * whoever looked first after a holder left took the slot. A request that had
 * started waiting a minute ago could overtake one that had waited fifteen, and
 * a gate round waited behind sessions that only wanted a screenshot. From 31
 * Oct to 3 Nov 72 starts waited (median ~200 s) and 26 were refused after
 * fifteen minutes. This file is the order: a waiter takes a ticket, and only
 * the ticket at the head may be admitted when `admission` says yes.
 *
 * Who goes next is `nextInQueue(tickets, now)`, pure. FIFO by `joined_at`,
 * except that a gate round's ticket that has waited `GATE_PRIORITY_MS` moves
 * ahead of every non-gate ticket — never ahead of an earlier gate ticket,
 * which has waited longer and so moved first. Priority is a place in the
 * queue and nothing else: a gate ticket stops no server to get one.
 *
 * A ticket whose pid is gone is swept on every read, as `listServers` sweeps a
 * dead server: a waiter killed mid-wait must not hold the head for ever.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { withFileLock } from './dev-reservations.js';
import { devServersRoot } from './paths.js';
import { pidAlive } from './status-collect.js';

/** How long a gate round's ticket waits before it goes ahead of the others. */
export const GATE_PRIORITY_MS = 2 * 60_000;

/** The queue beside the registry it orders: `~/.memoro/mc/dev-queue.json` for the default root. */
export function devQueuePath(root = devServersRoot()) {
  return join(dirname(resolve(root)), 'dev-queue.json');
}

/**
 * One writer at a time, through the pool's lock (`withFileLock`): a lock that
 * cannot be taken within five seconds is an error the waiter refuses on. Until
 * 2026-11-05 a writer went ahead of a held lock and the worst case was a lost
 * ticket; a queue nobody can write is now a refusal, never a guess.
 */
function withLock(file, fn, { alive = pidAlive } = {}) {
  return withFileLock(file, fn, { alive });
}

function readTickets(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed?.tickets) ? parsed.tickets.filter((ticket) => ticket && typeof ticket.id === 'string') : [];
  } catch {
    return [];
  }
}

function writeTickets(file, tickets) {
  writeJsonAtomic(file, { schema_version: 1, tickets });
}

/** Read, sweep the dead, apply `change`, write back when anything moved. */
function update(file, change = (tickets) => tickets, { alive = pidAlive } = {}) {
  return withLock(file, () => {
    const before = readTickets(file);
    const live = before.filter((ticket) => alive(ticket.pid));
    const after = change(live);
    if (after.length !== before.length || after !== live) writeTickets(file, after);
    return after;
  }, { alive });
}

/**
 * The queue in the order it is served at `now`: promoted gate tickets first,
 * by when they joined, then every other ticket by when it joined.
 */
export function queueOrder(tickets, now) {
  const byJoin = [...(tickets || [])].sort((a, b) => (Date.parse(a.joined_at) - Date.parse(b.joined_at)) || String(a.id).localeCompare(String(b.id)));
  const promoted = (ticket) => Boolean(ticket.gate) && now - Date.parse(ticket.joined_at) >= GATE_PRIORITY_MS;
  return [...byJoin.filter(promoted), ...byJoin.filter((ticket) => !promoted(ticket))];
}

/** The ticket that goes next at `now`, or null on an empty queue. */
export function nextInQueue(tickets, now) {
  return queueOrder(tickets, now)[0] || null;
}

/** Who a waiter is: the runner's step, the gate round, or the coding session. */
export function holderOf(env = process.env) {
  return env.MC_STEP || env.MC_GATE_ROUND || env.CLAUDE_CODE_SESSION_ID || env.CODEX_THREAD_ID || null;
}

/** The live tickets, swept, in no particular order. */
export function readQueue({ file = devQueuePath(), alive = pidAlive } = {}) {
  return update(file, undefined, { alive });
}

/**
 * The live tickets as they stand, without writing anything: what a reader that
 * must not write — the page — sees. A dead waiter's ticket is left for the next
 * writer to sweep, and not counted here.
 */
export function peekQueue({ file = devQueuePath(), alive = pidAlive } = {}) {
  return readTickets(file).filter((ticket) => alive(ticket.pid));
}

/** Take a ticket; returns it. */
export function joinQueue({
  file = devQueuePath(), pid = process.pid, worktree, service, env = process.env, now = Date.now(), alive = pidAlive, id = randomUUID(),
  session = null,
} = {}) {
  const ticket = {
    id,
    pid,
    worktree_path: worktree,
    service,
    holder: holderOf(env),
    // Who waits, as the page's DEV section names it (`leaseHolder`, dev-holder.js).
    ...(session ? { session } : {}),
    gate: Boolean(env.MC_GATE_ROUND),
    joined_at: new Date(now).toISOString(),
  };
  update(file, (tickets) => [...tickets, ticket], { alive });
  return ticket;
}

/** Give a ticket back: admitted, or given up. */
export function leaveQueue(id, { file = devQueuePath(), alive = pidAlive } = {}) {
  update(file, (tickets) => tickets.filter((ticket) => ticket.id !== id), { alive });
}

/** `{ place, of, order }` for one ticket at `now`; `place` is 1-based, null when it is not there. */
export function placeOf(id, tickets, now) {
  const order = queueOrder(tickets, now);
  const index = order.findIndex((ticket) => ticket.id === id);
  return { place: index < 0 ? null : index + 1, of: order.length, order };
}

/** A ticket as a refusal or `mc dev status` shows it. */
export function ticketView(ticket, now) {
  return {
    holder: ticket.holder ?? null,
    worktree_path: ticket.worktree_path ?? null,
    service: ticket.service ?? null,
    gate: Boolean(ticket.gate),
    pid: ticket.pid ?? null,
    joined_at: ticket.joined_at ?? null,
    waited_s: Math.max(0, Math.round((now - Date.parse(ticket.joined_at)) / 1000)),
  };
}
