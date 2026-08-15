/**
 * Who is asking, derived from where they are standing.
 *
 * A work area is the unit that acts in this world: one directory, one branch
 * per repository, one conversation (or a few) working on one thing. So it is
 * also the unit that holds a repository lease and the unit that sends a
 * message — and in both cases the name is read from the working directory
 * rather than declared, so nobody can act under a name they are not working
 * in. There is no flag to spoof and nothing to keep in sync.
 *
 * Outside the work root — Martin's own shell, a script, cron — the actor is
 * the person at the keyboard. That is honest about what it is, and it is
 * exactly who a `--force` release, or a message straight to the PM, comes
 * from.
 *
 * The lease had this first and the channel needed the same rule; one copy,
 * because two would be two answers the day they disagree.
 */
import { realpathSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';

import { workRoot } from './paths.js';

export function currentHolder({ cwd = process.cwd(), env = process.env } = {}) {
  // Both sides resolved: a shell's working directory comes back through the
  // symlinks the temporary and home directories are made of on macOS, and a
  // string comparison against the unresolved work root said "not in a work
  // area" for a directory plainly inside one.
  const root = canonical(workRoot(env));
  const here = canonical(cwd);
  if (here === root || here.startsWith(`${root}/`)) {
    const [area] = here.slice(root.length + 1).split('/').filter(Boolean);
    if (area) return { name: area, kind: 'work-area' };
  }
  let who = 'someone';
  try { who = `${userInfo().username}@${hostname()}`; } catch { /* nameless shell */ }
  return { name: who, kind: 'shell' };
}

function canonical(path) {
  try { return realpathSync(path); } catch { return path; }
}
