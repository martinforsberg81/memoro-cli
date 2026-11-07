/**
 * The batch record a spawn of `files` under `plan` carries, as `runTestBatch`
 * records it at launch: the argv the spawn boundary builds (`nodeTestArgv`), read
 * back the way the boundary reads it (`executedTimeoutOf`). A test substitute for a
 * spawn reports the batch that spawn would have launched, so the receipt it feeds
 * is the one a real spawn would make; the real spawn is covered by the real child test.
 */
import { executedTimeoutOf, nodeTestArgv, resolveTestPlan } from '../../../src/mc/repo-gate.js';

export function spawnedBatch({ plan = resolveTestPlan({}), files, lanes = 1, resource = 'standard' }) {
  const argv = nodeTestArgv({ plan, files, lanes, reporters: [], stdioBlocking: 'stdio.mjs' });
  return { resource, files: [...files], lanes, node: process.execPath, nodeVersion: process.version,
    timeoutSource: plan.timeout.source, timeoutMs: executedTimeoutOf(argv), forceExit: argv.includes('--test-force-exit'), argv };
}

/**
 * A fake `tests` that reports the batch its spawn would launch, under the plan it
 * was handed (or the one its flags resolve to), before it returns or never returns.
 */
export function withSpawnedBatches(tests) {
  return (options) => {
    const files = options.files || [];
    if (files.length) {
      options.onBatch?.(spawnedBatch({ plan: options.plan ?? resolveTestPlan({ flags: options.flags ?? [] }), files, lanes: options.lanes ?? 1 }));
    }
    return tests(options);
  };
}
