/**
 * `mc doctor` — the mechanisms that should be in force, and are not.
 *
 * It once scanned pre-V1 session homes and the V1 dev-server registry for
 * orphans (`session-maintenance-v1`, `dev-servers`); that whole surface is
 * the old portable-session vision, and its one output was twenty-seven
 * identical `dev-server-session-unbound` lines about a dev-server nobody
 * runs — a diagnostic that stood in every heartbeat for a day and was never
 * read (PM, 2026-08-24). With mc for memoro me only, that scan is gone
 * without replacement (memoro's actual dev server belongs on the board, not
 * here). What remains is the live half built the night before: the
 * enforcement list — a mechanism out of force, said by something that
 * already runs.
 *
 * `mc watch pm` runs `diagnose()` every pass (design note §3) and carries
 * `not_in_force` into its knock. It calls the function rather than the
 * command so the two cannot drift.
 */
import { notInForce } from '../enforcement.js';

/**
 * The diagnosis: mechanisms out of force. `ok` and `issues` are kept in the
 * shape (always green / empty now) so every reader — the PM round, the
 * command below — keeps its answer; the enforcement list is the substance.
 */
export function diagnose({ deps = {} } = {}) {
  const enforcement = (deps.enforcement || notInForce)({ deps: deps.enforcementDeps || {} });
  return { ok: true, issues: [], summary: {}, not_in_force: enforcement };
}

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) { stderr.write(`mc: ${opts.error}\n`); return 2; }
  const result = diagnose({ deps });
  if (opts.json) { stdout.write(`${JSON.stringify(result, null, 2)}\n`); return result.not_in_force.length ? 1 : 0; }
  const broken = result.not_in_force || [];
  if (broken.length === 0) {
    stdout.write('mc doctor — every mechanism that should be in force is\n');
    return 0;
  }
  stdout.write(`mc doctor — ${broken.length} mechanism${broken.length === 1 ? '' : 's'} not in force\n`);
  for (const line of broken) stdout.write(`  NOT IN FORCE  ${line}\n`);
  return 1;
}

export function parseArgs(argv) {
  const opts = { json: false };
  for (const arg of argv) {
    if (arg === '--json') { opts.json = true; continue; }
    // `--repair` is gone with the session maintenance it repaired: there is
    // nothing here to repair any more, and a flag that silently does nothing
    // is worse than no flag.
    if (arg === '--repair') return { ...opts, error: 'mc doctor no longer repairs — the session maintenance it fixed is gone; it now only reports mechanisms out of force' };
    return { ...opts, error: `unknown argument: ${arg}` };
  }
  return opts;
}
