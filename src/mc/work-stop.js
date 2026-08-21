/**
 * Stop what is running in a piece of work, without touching the work.
 *
 * `release` and `discard` are about the worktree, the branch and the
 * conversations — what a piece of work *is*. This is about what it is *doing*:
 * the tool process, and nothing else. Afterwards the branch is where it was,
 * the conversation is on disk in full, and `mc work <name>` resumes it.
 *
 * Two kinds of running, one verb. A background worker is a tmux session and is
 * asked to leave; a conversation in someone's terminal is a process and is
 * asked the same way, by signal. Neither is killed outright while there is a
 * gentler way, because a tool interrupted mid-turn loses that turn and, for
 * Claude, skips the hooks that upload what it did.
 */
import { execFileSync, spawnSync } from 'node:child_process';

import { log } from './logger.js';
import { toolProcesses } from './work-status.js';

/**
 * Which processes must never be stopped: this one, and everything it grew out
 * of.
 *
 * A session run inside a work area can be asked to stop that work area. Doing
 * as it is told would kill the tool that asked, mid-sentence, and the person
 * reading would see their terminal die with no explanation. The chain up to
 * the login shell is skipped and reported instead.
 */
export function ownAncestry(startPid = process.pid, { run = null } = {}) {
  const ask = run || ((pid) => {
    try {
      return execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch { return ''; }
  });
  const chain = new Set();
  let pid = startPid;
  for (let depth = 0; depth < 24 && pid > 1; depth += 1) {
    chain.add(pid);
    const parent = Number(ask(pid));
    if (!Number.isInteger(parent) || parent <= 1) break;
    pid = parent;
  }
  return chain;
}

function tmuxSession(target, run) {
  const tmux = run || ((args) => spawnSync('tmux', args, { encoding: 'utf8' }));
  return tmux(['has-session', '-t', target]).status === 0;
}

/**
 * Ask the tool in a pane to leave by its own front door.
 *
 * `/exit` is the tool's own way out: it closes the conversation cleanly and
 * lets Claude's SessionEnd hooks run, so the last turn is saved and uploaded.
 * It says nothing about whether the pane is gone afterwards — that is the
 * caller's question, and the two callers answer it differently: stopping asks
 * tmux whether the session survived, replacing does not care because it is
 * about to respawn the window either way.
 */
export function askToolToLeave(target, { run = null, wait = null } = {}) {
  const tmux = run || ((args) => spawnSync('tmux', args, { encoding: 'utf8' }));
  const pause = wait || ((ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  });
  tmux(['send-keys', '-t', target, '/exit']);
  pause(400);
  tmux(['send-keys', '-t', target, 'Enter']);
  pause(2500);
}

/**
 * Ask a background worker to finish.
 *
 * Only if it is still there after its own front door is the tmux session
 * killed, which is abrupt but never loses more than the turn in flight —
 * every turn before it is already on disk.
 */
function stopBackground(name, { run = null, wait = null } = {}) {
  const target = `mc-${name}`;
  const tmux = run || ((args) => spawnSync('tmux', args, { encoding: 'utf8' }));
  if (!tmuxSession(target, run)) return null;
  askToolToLeave(target, { run, wait });
  const left = tmuxSession(target, run);
  if (left) tmux(['kill-session', '-t', target]);
  log('work.stop-background', { target, graceful: !left });
  return { kind: 'background', target, graceful: !left };
}

export function stopWork(area, { env = process.env, signal = 'SIGTERM', deps = {} } = {}) {
  const stopped = [];
  const kept = [];

  const background = (deps.stopBackground || stopBackground)(area.name);
  if (background) stopped.push(background);

  const paths = [area.path, ...area.worktrees.map((worktree) => worktree.path)];
  const mine = (deps.ownAncestry || ownAncestry)();
  for (const item of (deps.toolProcesses || toolProcesses)(paths)) {
    if (mine.has(item.pid)) {
      kept.push({ ...item, why: 'this is the session asking' });
      continue;
    }
    try {
      process.kill(item.pid, signal);
      stopped.push({ kind: 'process', ...item });
      log('work.stop-process', { area: area.name, pid: item.pid, tool: item.name });
    } catch (error) {
      kept.push({ ...item, why: error?.code === 'ESRCH' ? 'already gone' : String(error?.message || error) });
    }
  }
  return { name: area.name, stopped, kept };
}
