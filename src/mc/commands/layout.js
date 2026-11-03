/**
 * `mc layout` — which structure the work root has (ruling 51), and where its
 * planning sessions, step areas and deps areas are.
 *
 *   mc layout          `layout <1|2>` and the three roots
 *   mc layout --json   the same, as one object
 *
 * `mc layout migrate`, the one-time move to layout 2, ran on 2026-10-20 and
 * went with projects on 2026-11-03 (goal mc/projects-to-goals): most of what
 * it moved was project registers, and there are none now. The word is still
 * understood, so that somebody who types it is told so.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { RUNNER_DEPS, STEP_HOME, layoutVersion, planAreaRoot, stepAreaRoot, workRoot } from '../paths.js';
import { scanArgs } from './flags.js';
import { commandUsage } from '../command-help.js';

export function usage() {
  return commandUsage('layout');
}

/** `path` with the home directory folded to `~`. */
export function tildePath(path, home = homedir()) {
  if (typeof path !== 'string') return path;
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

/** Each subcommand and the scan it is read with; '' is the bare verb. help-routes.test.js walks the help with it. */
/** `check`: what the scanned arguments may not be — null, or what is wrong; the verb runs it, and help-routes.test.js walks the help with it. */
export const ROUTES = { '': { booleans: ['--json'], check: ({ positional }) => refusal(positional) } };

function refusal([sub]) {
  if (sub === 'migrate') return 'mc layout migrate is gone — the move to layout 2 ran on 2026-10-20, and projects went with it';
  if (sub !== undefined) return `mc layout takes no name, not ${sub}`;
  return null;
}

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const root = deps.root || workRoot(env);
  const home = deps.home ?? homedir();
  const scanned = scanArgs(argv, ROUTES['']);
  const error = scanned.error || ROUTES[''].check(scanned);
  if (error) {
    stderr.write(`mc: ${error}\n`);
    stderr.write(usage());
    return 2;
  }
  return showLayout({ root, home, json: Boolean(scanned.flags.json), stdout });
}

/** `layout <n>` and the three roots. */
function showLayout({ root, home, json, stdout }) {
  const layout = layoutVersion({ root });
  const roots = {
    planAreaRoot: planAreaRoot({ root }),
    stepAreaRoot: stepAreaRoot({ root }),
    depsRoot: layout === 2 ? join(root, RUNNER_DEPS) : join(root, STEP_HOME),
  };
  if (json) {
    stdout.write(`${JSON.stringify({ layout, ...roots }, null, 2)}\n`);
    return 0;
  }
  stdout.write(`layout ${layout}\n`);
  stdout.write(`  planning sessions  ${tildePath(roots.planAreaRoot, home)}\n`);
  stdout.write(`  step areas         ${tildePath(roots.stepAreaRoot, home)}\n`);
  stdout.write(`  deps areas         ${tildePath(roots.depsRoot, home)}\n`);
  return 0;
}
