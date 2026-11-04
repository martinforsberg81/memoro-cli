/**
 * Who holds a dev server: the session that took it, written when it is taken.
 *
 * The page's DEV section (goal mc/dev-section) names the session behind every
 * server — `BUILD mc/no-work`, `REVIEW email-compose`, `plan mc`, `brief`, or
 * `shot` for a short `mc shot` that no session ran. Guessing that from the
 * worktree path would name the worktree's goal, not whoever is using it: a
 * review session and a build session on the same goal share a worktree, and
 * the shared checkout's main server is used by everyone. So the verb that takes
 * the server — `mc shot dev`, `mc test dev`, `mc dev open`, through
 * `ensureDevServer` — writes the holder into mc's copy of the registration, and
 * the page reads it back.
 *
 * A holder is `{ kind, owner, name, pid }`:
 *
 * - `kind` is the session's kind — `build`, `review`, `plan`, a desk (`brief`,
 *   `helper`, `intake`), `gate` for a gate round — or, with no session at all,
 *   the verb itself (`shot`, `test`, `open`).
 * - `owner` is the programme the session works for, or the desk's name.
 * - `name` is what the session works on: the goal (`mc/no-work`) for a build
 *   or a review, the programme for a plan, null for a desk or a bare verb.
 * - `pid` is the session's own process — the coding agent's, found by walking
 *   up from the verb — so a holder whose session has ended can be told from
 *   one that is still at work. The verb's own pid would be dead a second after
 *   it answered. A bare verb has no session, and its pid is its own.
 */
import { execFileSync } from 'node:child_process';

import { PLAN_ROLE, REVIEW_ROLE } from './goals.js';
import { BUILD_ROLES } from './run-plan.js';

/** The session kinds whose ending a page should say: a holder of these whose pid is gone is `holder gone`. */
export const SESSION_HOLDERS = Object.freeze(['build', 'review', 'plan', 'brief', 'helper', 'intake', 'gate', 'session']);

/** The command names a coding agent's process has. */
const AGENT = /(?:^|\/)(?:claude|codex)(?:$|[\s.-])/u;

/** `ps -o ppid=,comm= -p <pid>` as `{ ppid, command }`, or null. */
function psOne(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const match = /^(\d+)\s+(.*)$/u.exec(out);
    return match ? { ppid: Number(match[1]), command: match[2] } : null;
  } catch {
    return null;
  }
}

/**
 * The coding agent this process runs under: the nearest ancestor whose command
 * is `claude` or `codex`, or null when there is none (a person's shell, a
 * launchd job). `ps` is `(pid) => { ppid, command } | null`, injected by tests.
 */
export function agentPid({ start = process.ppid, ps = psOne } = {}) {
  let pid = start;
  for (let depth = 0; depth < 24 && Number.isInteger(pid) && pid > 1; depth += 1) {
    const row = ps(pid);
    if (!row) return null;
    if (AGENT.test(row.command)) return pid;
    pid = row.ppid;
  }
  return null;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The holder for a verb run with `env`: the session's kind, owner, name and
 * pid, or the verb itself when no session ran it. `verb` is `shot`, `test` or
 * `open`; `pid` is the verb's own process, used only when there is no session.
 */
export function leaseHolder({ env = process.env, verb = 'mc', pid = process.pid, ps } = {}) {
  const role = text(env.MC_ROLE);
  const goal = text(env.MC_GOAL);
  const programme = text(env.MC_PROGRAMME) || (goal ? goal.split('/')[0] : null);
  const session = () => {
    const given = Number(env.MC_SESSION_PID);
    if (Number.isInteger(given) && given > 0) return given;
    return agentPid(ps ? { ps } : {});
  };
  let kind = null;
  let owner = programme;
  let name = null;
  if (env.MC_GATE_ROUND) {
    kind = 'gate';
    owner = text(env.MC_REPO) || programme;
    name = text(env.MC_GATE_ROUND);
  } else if (role === REVIEW_ROLE || role?.startsWith('review-session')) {
    kind = 'review';
    name = goal;
  } else if (role === PLAN_ROLE) {
    kind = 'plan';
    name = programme;
  } else if (role && ['brief', 'helper', 'intake'].includes(role)) {
    kind = role;
    owner = role;
  } else if (role === BUILD_ROLES.goal || role?.startsWith('build-session') || (!role && goal)) {
    kind = 'build';
    name = goal;
  } else if (role || env.CLAUDE_CODE_SESSION_ID || env.CODEX_THREAD_ID || env.CLAUDECODE) {
    // A coding session mc did not start in one of its roles: still a session.
    kind = 'session';
    name = role && role !== 'work' ? role : null;
  }
  if (!kind) return { kind: verb, owner: null, name: null, pid };
  return { kind, owner, name, pid: session() };
}

/** Is this holder a session — one whose end the page says — rather than a bare verb? */
export function isSessionHolder(holder) {
  return Boolean(holder) && SESSION_HOLDERS.includes(holder.kind);
}

/**
 * The holder as a row names it: `BUILD mc/no-work`, `REVIEW email-compose`,
 * `plan mc`, `brief`, `shot`. The runner's two working kinds are in capitals,
 * as SESSIONS writes them; everything else is a word.
 */
export function holderLabel(holder) {
  if (!holder?.kind) return '—';
  const kind = ['build', 'review'].includes(holder.kind) ? holder.kind.toUpperCase() : holder.kind;
  return holder.name ? `${kind} ${holder.name}` : kind;
}
