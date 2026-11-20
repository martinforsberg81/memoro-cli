import { commandUsage } from '../command-help.js';
import { REPAIR_ROUTE, runRepairDraft } from '../repair-draft.js';
import { finishRepair } from '../repair-order.js';

export const ROUTES = { '': REPAIR_ROUTE };

export function usage() { return commandUsage('repair'); }

export async function run(argv, deps = {}) {
  const { env = process.env, stderr = process.stderr } = deps;
  if (env.MC_HEADLESS === '1' || env.MC_GOAL || (env.MC_ROLE && env.MC_ROLE !== 'martin')) {
    stderr.write('mc: only a person at the terminal starts mc repair\n');
    return 2;
  }
  return runRepairDraft(argv, { ...deps, finish: result => finishRepair(result, deps) });
}
