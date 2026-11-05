/**
 * The dev-server pool as the page reads it: `mc --json`'s `dev`, and the DEV
 * section drawn from it (goal mc/dev-section).
 *
 * `readPool` reads live-pid registry records (`reap: false`), queue tickets
 * whose pids pass the supplied liveness check, and the shared checkout record
 * used to identify the main slot (`mainCheckout`). It does not make an HTTP
 * request or sweep/rewrite the registry or queue. Dead server records and
 * dead waiters are left for a writer and are not counted here.
 *
 * `devSection` is pure: what each server is and who holds it, from the records
 * alone. Who holds a server is what the verb that took it wrote
 * (`touchServer`'s `holder`, dev-holder.js); nothing here guesses it from the
 * worktree.
 */
import { basename, resolve, sep } from 'node:path';

import { holderLabel, isSessionHolder } from './dev-holder.js';
import { devQueuePath, peekQueue, queueOrder } from './dev-queue.js';
import { DEFAULT_HOLDER_STALE_MINUTES, isMainServer, lastUsedAt, listServers } from './dev-servers.js';
import { duration } from './page-grid.js';
import { devServersRoot, mcHome } from './paths.js';
import { REPO_NAMES, pidAlive } from './status-collect.js';
import { mainCheckout } from './test-environment.js';

/** A server registered this recently that mc has never used is still `starting`. */
export const STARTING_SECONDS = 10 * 60;

/** The registry, the queue and the main slot, as they stand. */
export function readPool({ env = process.env, alive = pidAlive, main } = {}) {
  const root = devServersRoot(mcHome(env));
  const servers = listServers({ root, reap: false }).servers.filter((server) => alive(Number(server.pid)));
  return {
    servers,
    queue: peekQueue({ file: devQueuePath(root), alive }),
    main: main !== undefined ? main : safeMain(env),
  };
}

function safeMain(env) {
  try { return mainCheckout(env); } catch { return null; }
}

/** The repository a worktree is a checkout of: the nearest path segment that is one, else its directory's name. */
export function repoOf(worktree) {
  if (!worktree) return null;
  const parts = resolve(worktree).split(sep).filter(Boolean);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (REPO_NAMES.includes(parts[index])) return parts[index];
  }
  return basename(resolve(worktree)) || null;
}

function portOf(url) {
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    return Number.isInteger(port) ? port : null;
  } catch {
    return null;
  }
}

/** The holder's pid, asked of the kernel: true, false, or null for no pid. */
function holderAlive(holder, alive) {
  const pid = Number(holder?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return Boolean(alive(pid));
}

/**
 * One server as `mc --json` carries it. `state`:
 *
 * - `starting` — no recorded use or holder, with a parseable registration
 *   time less than `STARTING_SECONDS` ago. This recent-registration heuristic
 *   is not an HTTP result.
 * - `leased` — a holder is recorded, its last use is within the configured
 *   stale window, and it is not a dead session holder. Bare-verb holders are
 *   not classified as gone, so their lease lasts until that window expires.
 * - `idle` — none of those conditions applies; a dead session holder is also
 *   reported separately as `holder_gone`.
 *
 * This projection has no `cold` state. `running` below is a registry-derived
 * count of rows not classified as `starting`, not a server health probe.
 */
export function serverRow(server, { main = null, now = Date.now(), alive = pidAlive, staleSeconds, branchOf = () => null } = {}) {
  const used = lastUsedAt(server);
  const registered = Date.parse(server.registered_at ?? server.started_at ?? '');
  const idle = used === null ? null : Math.max(0, Math.round((now - used) / 1000));
  const holder = server.holder?.kind ? {
    kind: server.holder.kind, owner: server.holder.owner ?? null, name: server.holder.name ?? null, pid: server.holder.pid ?? null,
  } : null;
  const living = holderAlive(holder, alive);
  // Only a session ends; a bare `mc shot` was over the moment it answered.
  const gone = Boolean(holder) && isSessionHolder(holder) && living === false;
  let state = 'idle';
  if (!server.last_used_at && !holder && Number.isFinite(registered) && now - registered < STARTING_SECONDS * 1000) state = 'starting';
  else if (holder && !gone && idle !== null && idle < staleSeconds) state = 'leased';
  return {
    kind: isMainServer(server, main) ? 'main' : 'slot',
    instance_id: server.instance_id ?? null,
    pid: server.pid ?? null,
    service: server.service ?? null,
    holder,
    holder_alive: living,
    holder_gone: gone,
    // What the row's name column says: the holder, as the page names a session.
    name: holder ? holderLabel(holder) : null,
    repo: server.repo || repoOf(server.worktree_path),
    state,
    idle_seconds: idle,
    // The grid's progress column: how long since mc last used it.
    progress: idle === null ? null : duration(idle),
    port: portOf(server.url),
    url: server.url ?? null,
    worktree: server.worktree_path ?? null,
    branch: server.branch || branchOf(server.worktree_path) || null,
  };
}

/** A queue ticket as `mc --json` carries it: who waits, for what, and for how long. */
export function queueRow(ticket, now) {
  const session = ticket.session?.kind ? ticket.session : null;
  return {
    holder: session ? { kind: session.kind, owner: session.owner ?? null, name: session.name ?? null, pid: session.pid ?? null } : null,
    name: session ? holderLabel(session) : 'a request',
    worktree: ticket.worktree_path ?? null,
    service: ticket.service ?? null,
    gate: Boolean(ticket.gate),
    waited_seconds: Math.max(0, Math.round((now - Date.parse(ticket.joined_at)) / 1000)),
  };
}

/**
 * `mc --json`'s `dev`: the counts, one entry per live server — the main slot
 * first, then the slots by port — and the queue in the order it is served.
 * `running` counts every projected row except `starting`; it is not a health result.
 */
export function devSection({
  servers = [], queue = [], main = null, now = new Date(), alive = pidAlive, env = {}, branchOf,
} = {}) {
  const at = now instanceof Date ? now.getTime() : Number(now);
  const staleSeconds = (Number(env.MC_DEV_HOLDER_STALE_MINUTES) || DEFAULT_HOLDER_STALE_MINUTES) * 60;
  const rows = servers
    .map((server) => serverRow(server, { main, now: at, alive, staleSeconds, branchOf }))
    .sort((a, b) => (a.kind === b.kind ? (a.port ?? 0) - (b.port ?? 0) : a.kind === 'main' ? -1 : 1));
  const waiting = queueOrder(queue, at).map((ticket) => queueRow(ticket, at));
  return {
    running: rows.filter((row) => row.state !== 'starting').length,
    starting: rows.filter((row) => row.state === 'starting').length,
    leased: rows.filter((row) => row.state === 'leased').length,
    queued: waiting.length,
    servers: rows,
    queue: waiting,
  };
}
