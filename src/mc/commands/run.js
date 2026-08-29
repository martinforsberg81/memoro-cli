/**
 * `mc run` — take the next step of the next project, all day.
 *
 * `mc run [--rounds N] [--once] [--no-merge] [--idle-sleep S]`; rounds 0
 * (the default) is forever. `--once` runs one step for the first runnable
 * project and exits — the way to watch one step. Stop a running one by
 * touching `~/mc/runner/STOP`: it exits after the step it is in.
 */
import { runLoop } from '../run.js';
import { scanArgs } from './flags.js';

export async function run(argv, deps = {}) {
  const stderr = deps.stderr || process.stderr;
  const opts = parseRunArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write('usage — mc run [--rounds <n>] [--once] [--no-merge] [--idle-sleep <seconds>]\n');
    return 2;
  }
  return (deps.loop || runLoop)({ rounds: opts.rounds, once: opts.once, merge: opts.merge, idleSleepMs: opts.idleSleep * 1000 });
}

export function parseRunArgs(argv) {
  const scanned = scanArgs(argv, { booleans: ['--once', '--no-merge'], strictValues: ['--rounds', '--idle-sleep'] });
  if (scanned.error) return { error: scanned.error };
  if (scanned.positional.length) return { error: `unexpected argument ${scanned.positional[0]}` };
  const num = (flag, value, fallback) => {
    if (value == null) return fallback;
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : NaN;
  };
  const rounds = num('--rounds', scanned.flags.rounds, 0);
  const idleSleep = num('--idle-sleep', scanned.flags.idleSleep ?? scanned.flags['idle-sleep'], 600);
  if (Number.isNaN(rounds)) return { error: '--rounds needs a whole number (0 = forever)' };
  if (Number.isNaN(idleSleep)) return { error: '--idle-sleep needs a whole number of seconds' };
  return { rounds, once: scanned.flags.once, merge: !scanned.flags.noMerge && !scanned.flags['no-merge'], idleSleep };
}
