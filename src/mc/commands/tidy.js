/**
 * `mc tidy` — list first, then remove, per root (tidy.js, ruling 39).
 *
 *   mc tidy                  the dry run: what would go and what stays, by
 *                            rule, and the list file it wrote
 *   mc tidy --apply          the same list written, then removed from —
 *                            each target asked again first
 *   mc tidy --json           the list object
 *   mc tidy --days <n>       how old a loose transcript must be (default 14)
 *   mc tidy --docker         Docker only: images unused for three days;
 *                            with --apply it starts the runtime
 *                            if it is down, which nothing else here does
 *
 * Without `--docker` the Docker half runs too, but only on a runtime that is
 * already up. `mc work tidy` is this command. The runner runs it once a day
 * and after a lane skipped for disk.
 */
import { describeSize } from '../conversations.js';
import { tidyDocker } from '../docker.js';
import { DEFAULT_DAYS, ROUTINE, runTidy, shortPath } from '../tidy.js';
import { scanArgs } from './flags.js';

const SHOWN = 10;

export function usage() {
  return 'usage — mc tidy [--apply] [--json] [--days <n>] [--docker]\n';
}

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write(usage());
    return 2;
  }
  return tidyCommand(opts, { stdout, tidy: deps.tidy, docker: deps.docker });
}

export function parseArgs(argv) {
  const scanned = scanArgs(argv, { booleans: ['--json', '--apply', '--docker'], values: ['--days'] });
  const opts = {
    apply: Boolean(scanned.flags.apply), json: Boolean(scanned.flags.json), docker: Boolean(scanned.flags.docker), days: DEFAULT_DAYS,
  };
  if (scanned.error) return { ...opts, error: scanned.error };
  if (scanned.positional.length) return { ...opts, error: 'mc tidy takes no name — it looks at every root' };
  if (opts.docker && scanned.flags.days != null) return { ...opts, error: '--days is about transcripts, and --docker tidies only Docker' };
  return withDays(opts, scanned.flags.days);
}

/** `--days`, checked: a whole number of days, at least one. */
export function withDays(opts, days) {
  if (days === null || days === undefined) return opts;
  if (!/^\d+$/u.test(String(days)) || Number(days) < 1) return { ...opts, error: '--days wants a whole number of days, at least 1' };
  return { ...opts, days: Number(days) };
}

/**
 * The one entry `mc tidy` and `mc work tidy` share: run, then print. Exit 1
 * when an apply kept something on re-check or a Docker prune failed.
 * `docker` is `tidyDocker`; `--docker` runs nothing else.
 */
export async function tidyCommand(opts, { stdout, tidy = runTidy, docker = tidyDocker } = {}) {
  const prune = docker || tidyDocker;
  if (opts.docker) {
    const answer = await prune({ apply: opts.apply, start: opts.apply ? { pid: process.pid, run: 'mc tidy --docker' } : null });
    if (opts.json) stdout.write(`${JSON.stringify(answer, null, 2)}\n`);
    else {
      stdout.write(`mc tidy --docker${opts.apply ? '' : ' — dry run'}\n`);
      writeDocker(stdout, answer);
    }
    return dockerFailed(answer) ? 1 : 0;
  }
  const { list, listPath, outcome } = (tidy || runTidy)({ apply: opts.apply, days: opts.days });
  const answer = await prune({ apply: opts.apply });
  const code = outcome?.kept || dockerFailed(answer) ? 1 : 0;
  if (opts.json) {
    stdout.write(`${JSON.stringify(answer ? { ...list, docker: answer } : list, null, 2)}\n`);
    return code;
  }
  stdout.write(`mc tidy${opts.apply ? '' : ' — dry run'}\n`);
  const byRule = new Map();
  for (const item of list.targets) {
    if (!byRule.has(item.rule)) byRule.set(item.rule, { count: 0, bytes: 0 });
    const sum = byRule.get(item.rule);
    sum.count += 1;
    sum.bytes += item.bytes || 0;
  }
  if (!byRule.size) stdout.write('\nnothing to remove\n');
  for (const [rule, sum] of byRule) stdout.write(`  ${rule.padEnd(9)} ${String(sum.count).padStart(5)}  ${describeSize(sum.bytes)}\n`);
  if (list.targets.length) {
    stdout.write(`\ntargets${list.targets.length > SHOWN ? ` — the first ${SHOWN} of ${list.targets.length}` : ''}\n`);
    for (const item of list.targets.slice(0, SHOWN)) {
      stdout.write(`  ${item.rule}  ${shortPath(item.path)} — ${describeSize(item.bytes || 0)} — ${item.why}\n`);
    }
  }
  const told = list.kept.filter((item) => !ROUTINE.has(item.rule));
  if (told.length) {
    stdout.write('\nkept\n');
    for (const item of told) stdout.write(`  ${item.rule}  ${shortPath(item.path)} — ${item.why}\n`);
  }
  stdout.write(`\nlist: ${shortPath(listPath)}\n`);
  if (outcome) {
    for (const item of outcome.applied.filter((entry) => !entry.ok)) {
      stdout.write(`  not removed  ${shortPath(String(item.path))} — ${item.why}\n`);
    }
    stdout.write(`freed ${(outcome.freed / 1e9).toFixed(2)} GB in ${outcome.removed} items, kept ${outcome.kept} on re-check\n`);
  }
  if (answer) {
    stdout.write('\n');
    writeDocker(stdout, answer);
  }
  return code;
}

/** Whether Docker was asked and a prune failed. A runtime that is down is not a failure. */
function dockerFailed(answer) {
  return Boolean(answer?.pruned?.some((item) => !item.ok));
}

/** `tidyDocker`'s answer, in lines. */
function writeDocker(stdout, answer) {
  if (!answer.up || (answer.reason && !answer.pruned.length)) {
    const hint = !answer.apply && !answer.up ? ' (mc tidy --docker --apply starts it)' : '';
    stdout.write(`docker: nothing pruned — ${answer.reason}${hint}\n`);
    return;
  }
  if (answer.reclaimable) {
    stdout.write(`docker: would prune images unused for 3 days — at most ${answer.reclaimable.images}\n`);
    return;
  }
  for (const item of answer.pruned) {
    stdout.write(item.ok
      ? `docker: ${item.what} unused for 3 days pruned — ${item.reclaimed || '0B'} reclaimed\n`
      : `docker: the ${item.what} prune failed — ${item.detail}\n`);
  }
}
