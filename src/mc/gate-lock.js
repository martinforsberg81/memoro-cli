/**
 * One gate round at a time on this machine.
 *
 * A full suite takes a minute and a half and pins the cores. Two of them at
 * once make both slower and both flakier, and the flakiness lands on whichever
 * pull request happened to be measured — which is the 55 → 57 → 55 the red
 * floor was invented to absorb. So one round runs, and the second is told to
 * wait.
 *
 * ## Why this is a file and a pid and nothing else
 *
 * What was here before was "the suite right": a lease with a holder, an
 * errand, a liveness verdict derived from the work board, a `--force`
 * release, an inbox message to whoever held it, a row on the status page, and
 * four verbs of its own (`mc suite run|claim|release|who`). Four hundred lines
 * of vocabulary for "one at a time", and a name — *the suite right* — that
 * nobody could say out loud without explaining it.
 *
 * Martin, 2026-08-30: *"Svit-rätten är ett mycket märkligt namn/begrepp. Det
 * kastar vi ut. Skapa ingen konstig avancerad kod för det. Vi använder enbart
 * mc test för de stora testerna. En instans kan köra åt gången."*
 *
 * The big suites have exactly one door — the gate round, reached by `mc test`
 * and `mc merge` — so the guard belongs on that door and nowhere else. One
 * file, one pid, two functions:
 *
 *   - taken, and the pid is alive → refused, and told which round it is;
 *   - taken, and the pid is gone → that round was killed; take it;
 *   - not taken → take it.
 *
 * There is no expiry, because there is no clock that can tell a slow round
 * from a dead one — a round is *supposed* to take minutes. Asking the
 * operating system whether the pid exists is the only honest question, and it
 * is one line.
 *
 * It never blocks anything but a gate round. A person running `npm test` in
 * their own worktree is not asking mc's permission and is not refused it.
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { mcHome } from './paths.js';

export function gateLockPath(root = mcHome()) {
  return join(root, 'gate-running.json');
}

/** The round running right now, or null. A file that will not parse is nobody. */
export function runningRound({ root = mcHome(), alive = isAlive } = {}) {
  let raw = null;
  try { raw = JSON.parse(readFileSync(gateLockPath(root), 'utf8')); } catch { return null; }
  if (!Number.isFinite(raw?.pid)) return null;
  // A round that was killed left this behind. It is not a holder; it is
  // litter, and saying so is the whole of the reaping this needs.
  if (!alive(raw.pid)) return null;
  return raw;
}

/**
 * Take it, or say who has it.
 *
 * `{ ok: true, took: true }` when this process now holds it. `{ ok: false,
 * running }` when somebody else does — `running` is what to tell the operator,
 * and it is the other round's own words rather than a guess.
 */
export function takeGateLock({ repo, pr, root = mcHome(), alive = isAlive, now = new Date() } = {}) {
  const running = runningRound({ root, alive });
  if (running) return { ok: false, running };
  const mine = { pid: process.pid, repo: repo || null, pr: pr ?? null, since: now.toISOString() };
  try {
    writeJsonAtomic(gateLockPath(root), mine, { mode: 0o600 });
  } catch {
    // A lock that cannot be written must not stop the round it was meant to
    // protect: the worst case is the contention it was avoiding, and refusing
    // to measure anything is worse than measuring it slowly.
    return { ok: true, took: false, mine };
  }
  return { ok: true, took: true, mine };
}

/**
 * Give it back — but only if it is still ours.
 *
 * A round whose pid was reaped may have had the lock taken over while it was
 * dying. Deleting the file blindly would then release somebody else's round,
 * which is the one way a lock this simple could do real damage.
 */
export function releaseGateLock({ root = mcHome() } = {}) {
  try {
    const raw = JSON.parse(readFileSync(gateLockPath(root), 'utf8'));
    if (raw?.pid !== process.pid) return false;
    rmSync(gateLockPath(root), { force: true });
    return true;
  } catch { return false; }
}

/** How a refusal reads to the operator: whose round, on what, since when. */
export function describeRunning(running) {
  if (!running) return 'another gate round is running on this machine';
  const what = [running.repo, running.pr == null ? null : `#${running.pr}`].filter(Boolean).join(' ');
  return `another gate round is running on this machine (pid ${running.pid}${what ? `, ${what}` : ''}`
    + `${running.since ? `, since ${running.since}` : ''}) — one at a time`;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}
