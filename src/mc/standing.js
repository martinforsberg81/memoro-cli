/**
 * Who stands where — by prefix, not by exact path.
 *
 * Three mechanisms rest on `lsof -d cwd`: occupation (`mc work <name>` refuses
 * a workplace somebody sits in), addressing (a pane is found by where it
 * stands), and the board (which tools and suites run in which area). All
 * three asked lsof for exact directories, and lsof answers exactly: a process
 * whose cwd is `<area>/memoro-cli/src` is not standing in `<area>/memoro-cli`.
 * Measured 2026-08-23 (KP-08 point 7): a tool started one directory down
 * vanished from all three at once, and none of them could say why. `mc work`
 * starts tools at the root, so it bit only hand-started sessions — which is
 * exactly the kind nobody is watching.
 *
 * So lsof is asked once for every cwd this user's processes hold, and the
 * match is done here: a process stands in the longest known path that is its
 * cwd or an ancestor of it. Scoped to the user because that is 77 ms against
 * 320 ms for the whole machine and 28 ms for the old exact ask — and because
 * a process somebody else owns is not one mc could address anyway.
 *
 * The directory reported is the *known* path that matched, so every caller's
 * map keyed on its own paths keeps working; the actual cwd rides along.
 */
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';

/**
 * Every process of this user with its cwd, as lsof reports them. One call.
 * `-F pn`: a pid line, then the name line for its cwd.
 */
export function cwdsOfUser({ run = execFileSync, uid = userInfo().uid } = {}) {
  let output = '';
  try {
    output = run('lsof', ['-a', '-d', 'cwd', '-u', String(uid), '-F', 'pn'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    // lsof exits 1 when some process could not be read; the rest is still here.
    output = error?.stdout?.toString?.() || '';
  }
  const found = [];
  let pid = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) { pid = Number(line.slice(1).trim()); continue; }
    if (line.startsWith('n') && pid) found.push({ pid, cwd: line.slice(1).trim() });
  }
  return found;
}

/**
 * The known path a cwd stands in: itself, or its nearest listed ancestor.
 * `null` when none. Pure, so the rule is testable without lsof.
 */
export function standsIn(cwd, paths) {
  let best = null;
  for (const path of paths) {
    if (cwd === path || cwd.startsWith(path.endsWith('/') ? path : `${path}/`)) {
      if (best === null || path.length > best.length) best = path;
    }
  }
  return best;
}

/**
 * Processes standing in any of these paths: `{ pid, directory, cwd }`, where
 * `directory` is the matched known path. The replacement for
 * `lsof -a -d cwd -- <paths>` everywhere mc asked it.
 */
export function processesStandingIn(paths, { cwds = null, run, uid } = {}) {
  if (paths.length === 0) return [];
  const all = cwds || cwdsOfUser({ ...(run ? { run } : {}), ...(uid ? { uid } : {}) });
  const found = [];
  for (const { pid, cwd } of all) {
    const directory = standsIn(cwd, paths);
    if (directory) found.push({ pid, directory, cwd });
  }
  return found;
}
