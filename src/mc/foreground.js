/**
 * The foreground register — `~/mc/runner/foreground/<pid>.json`.
 *
 * The runner writes `current-<repo>.json` while a lane's step is in flight,
 * so NOW can name it. A session somebody opens themselves — `mc brief`, `mc plan <name>`,
 * `mc worker <name>`, `mc work <name>` in a plain terminal — leaves no such
 * trace: it is a child of mc holding the terminal, and nothing on disk says it
 * exists. NOW would then say "nothing is running" while the machine is busy,
 * which is the one thing the page must never do.
 *
 * So the verb registers itself: one small file named by the pid of the mc
 * process that is waiting on the tool, written before the call that blocks and
 * removed however that call returns. The pid is the mc process rather than the
 * tool's, for the same reason a lane's current file names the runner: it is
 * the pid whose death means the session is over, and it is the one that can be tested
 * for life from outside.
 *
 * Two things keep the directory honest without any bookkeeping:
 *
 *   - the reader (`page-collect.js`) drops an entry whose pid is not alive, so
 *     a file left behind by a terminal closed with ctrl-c never claims a
 *     session that is gone;
 *   - the writer sweeps those files as it arrives, so the directory does not
 *     grow one file per interrupted session forever.
 *
 * `pidAlive` is imported rather than repeated: two answers to "is this pid
 * alive" is two chances to get it subtly wrong, and this file and the page
 * must agree.
 */
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { workRoot } from './paths.js';
import { pidAlive } from './status-collect.js';

export function foregroundDir(env = process.env) {
  return join(workRoot(env), 'runner', 'foreground');
}

/**
 * Register this process as a foreground session and hand back the way to
 * un-register it. The returned function is idempotent: calling it twice, or
 * calling it after the process exit hook already has, removes nothing twice.
 *
 * Nothing here is allowed to fail the session it describes. A work root that
 * cannot be written to costs the page one line, not the user their tool, so
 * every failure ends in a no-op release.
 */
export function registerForeground({
  verb,
  area = null,
  tool = null,
  model = null,
  // What this session was told it is, and a digest of what it was told —
  // `roleRecord` in roles.js, or null for a session with no role at all. The
  // launcher exits and takes its argv with it; this is the only place the
  // answer survives it (`mc roles check`).
  role = null,
  env = process.env,
  pid = process.pid,
  now = () => new Date(),
  write = (path, value) => writeJsonAtomic(path, value, { mode: 0o644 }),
  remove = (path) => { try { rmSync(path, { force: true }); } catch { /* already gone */ } },
  list = (dir) => { try { return readdirSync(dir); } catch { return []; } },
  alive = pidAlive,
  onExit = (fn) => process.once('exit', fn),
} = {}) {
  const noop = () => {};
  if (!verb) return noop;
  const dir = foregroundDir(env);
  const path = join(dir, `${pid}.json`);

  sweep({ dir, pid, list, remove, alive });

  try {
    write(path, {
      verb, area, tool, model, pid,
      started: now().toISOString().replace(/\.\d{3}Z$/u, 'Z'),
      role,
    });
  } catch {
    return noop;
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    remove(path);
  };
  // The belt to the try/finally's braces: a verb that throws past its own
  // cleanup, or exits mid-flight, still takes its line off the page.
  try { onExit(release); } catch { /* no process to hook */ }
  return release;
}

/** Drop the files of processes that are gone. Ours is left to the writer. */
export function sweep({ dir, pid = process.pid, list, remove, alive = pidAlive }) {
  for (const name of list(dir)) {
    const match = /^(\d+)\.json$/u.exec(name);
    if (!match) continue;
    const other = Number(match[1]);
    if (other === pid || alive(other)) continue;
    remove(join(dir, name));
  }
}
