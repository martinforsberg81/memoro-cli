/**
 * `mc layout` — which structure the work root has, and the move to layout 2
 * (ruling 51, `layout-migrate.js`).
 *
 *   mc layout                    `layout <1|2>` and where its areas and
 *                                registers are
 *   mc layout migrate            the dry run: every move in order, every
 *                                refusal, a count; writes nothing at all.
 *                                Exit 0 with no refusal, 1 otherwise
 *   mc layout migrate --json     `{ layout, moves, refusals }`
 *
 * A person runs the move, from a terminal outside every area, with the runner
 * stopped. Nothing in mc calls it.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { dryRunLines, gatherLayoutFacts, planLayoutMove, tildePath } from '../layout-migrate.js';
import {
  PROGRAMS_HOME, RUNNER_DEPS, RUNNER_HOME, STEP_HOME, layoutVersion, planAreaRoot, stepAreaRoot, workRoot,
} from '../paths.js';
import { REGISTER_DIR, STATE_FILE } from '../register.js';
import { scanArgs } from './flags.js';

export function usage() {
  return 'usage — mc layout [--json] · mc layout migrate [--json]\n';
}

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const root = deps.root || workRoot(env);
  const home = deps.home ?? homedir();
  const scanned = scanArgs(argv, { booleans: ['--json', '--apply'] });
  const [sub, ...rest] = scanned.positional;
  let error = scanned.error;
  if (!error && sub !== undefined && sub !== 'migrate') error = `mc layout knows migrate, not ${sub}`;
  if (!error && rest.length) error = `mc layout ${sub} takes no name`;
  if (!error && scanned.flags.apply && sub !== 'migrate') error = '--apply belongs to mc layout migrate';
  if (error) {
    stderr.write(`mc: ${error}\n`);
    stderr.write(usage());
    return 2;
  }
  const json = Boolean(scanned.flags.json);
  if (sub === undefined) return showLayout({ root, home, json, stdout });
  if (scanned.flags.apply) {
    stderr.write('mc: mc layout migrate --apply is not built yet — the dry run is all there is\n');
    return 2;
  }
  return migrate({ root, env, home, json, stdout, facts: deps.facts });
}

/** `layout <n>` and the four roots. */
function showLayout({ root, home, json, stdout }) {
  const layout = layoutVersion({ root });
  const roots = {
    planAreaRoot: planAreaRoot({ root }),
    stepAreaRoot: stepAreaRoot({ root }),
    depsRoot: layout === 2 ? join(root, RUNNER_DEPS) : join(root, STEP_HOME),
    registers: layout === 2
      ? join(root, PROGRAMS_HOME, '<programme>', '<project>', STATE_FILE)
      : join(root, RUNNER_HOME, REGISTER_DIR),
  };
  if (json) {
    stdout.write(`${JSON.stringify({ layout, ...roots }, null, 2)}\n`);
    return 0;
  }
  stdout.write(`layout ${layout}\n`);
  stdout.write(`  planning sessions  ${tildePath(roots.planAreaRoot, home)}\n`);
  stdout.write(`  step areas         ${tildePath(roots.stepAreaRoot, home)}\n`);
  stdout.write(`  deps areas         ${tildePath(roots.depsRoot, home)}\n`);
  stdout.write(`  registers          ${tildePath(roots.registers, home)}\n`);
  return 0;
}

/** The dry run: exit 0 with nothing refused, 1 otherwise. */
function migrate({ root, env, home, json, stdout, facts: factDeps }) {
  const facts = gatherLayoutFacts({ root, env, deps: factDeps });
  if (facts.layout === 2) {
    if (json) stdout.write(`${JSON.stringify({ layout: 2, moves: [], refusals: [] }, null, 2)}\n`);
    else stdout.write('layout 2 — nothing to move\n');
    return 0;
  }
  const plan = planLayoutMove(facts);
  if (json) stdout.write(`${JSON.stringify({ layout: facts.layout, ...plan }, null, 2)}\n`);
  else stdout.write(`${dryRunLines(plan, home).join('\n')}\n`);
  return plan.refusals.length ? 1 : 0;
}
