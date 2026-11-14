/** A person's one-item entrance into the same decision lane as the runner. */
import { commandUsage } from '../command-help.js';
import { listDeskItems, readDeskItem } from '../desk-items.js';
import { createRunner, realDeps } from '../run.js';
import { planSessionRefusal } from '../session-role.js';

const ROUTE = { check: ({ positional }) => positional.length > 1 ? 'decision takes at most one item id' : null };
export const ROUTES = { '': ROUTE, '*': ROUTE };
export function usage() { return commandUsage('decision'); }
export async function run(argv, deps = {}) {
  const env = deps.env || process.env, stdout = deps.stdout || process.stdout, stderr = deps.stderr || process.stderr;
  if (env.MC_HEADLESS === '1' || planSessionRefusal({ env, cwd: deps.cwd || process.cwd() })) {
    stderr.write('mc: decision is for a person; do not start it inside a session\n'); return 2;
  }
  if (argv.length > 1 || argv.some(x => x.startsWith('-'))) { stderr.write(usage()); return 2; }
  const id = argv[0] || (deps.items || (() => listDeskItems({ env, state: 'prepared' })))()[0]?.id;
  if (!id) { stdout.write('mc: no prepared desk item\n'); return 0; }
  const runner = (deps.runner || createRunner)({ merge: false, deps: deps.runnerDeps || realDeps(env) });
  const outcome = await runner.decisionOne(id);
  const item = (deps.readItem || (id => readDeskItem(id, { env })))(id);
  stdout.write(`mc: decision ${id}: ${outcome.ran ? item?.outcome?.by || (item?.state === 'for-martin' ? 'briefed' : 'retry pending') : outcome.reason || 'not started'}; state ${item?.state || 'missing'}\n`);
  return outcome.ran ? 0 : 1;
}
