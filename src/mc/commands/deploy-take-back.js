/**
 * `mc deploy take-back` — the take-back as a verb (docs/technical/mc-deploy.md,
 * *The take-back*). It calls the function the runner's reaction calls
 * (`takeBack` in `release-take-back.js`) and takes the last deployed release
 * back to the version recorded as live before it, red or not; whoever types it
 * is the decision. A release read as one that cannot be taken back is refused
 * unless `--despite "<reason>"` says it is known. `--dry-run` runs only the
 * script's own `--dry-run` and writes nothing. `--end <started> --reason "…"`
 * ends a desk entry of the red ledger.
 *
 * Exit codes: 0 every Worker was taken back (or the dry run is clean), 2 a
 * refusal — nothing was written, nothing was called — and 1 a take-back that ran
 * and did not take every Worker back (its row is `failed`).
 */
import { LedgerError } from '../check-red-ledger.js';
import { takeBack } from '../release-take-back.js';
import { endDesk } from '../take-back-run.js';
import { scanArgs } from './flags.js';

const oneLine = (text) => String(text ?? '').replace(/\s+/gu, ' ').trim();

/** `{ dryRun, json, despite, end, reason }` or `{ error }`. */
export function parseTakeBackArgs(argv) {
  const scanned = scanArgs(argv, { booleans: ['--dry-run', '--json'], strictValues: ['--despite', '--end', '--reason'] });
  if (scanned.error) return { error: scanned.error };
  if (scanned.positional.length) {
    return { error: `mc deploy take-back takes no arguments (${scanned.positional[0]}) — it takes back the last release, and nothing else` };
  }
  const { flags } = scanned;
  const despite = flags.despite === null ? null : oneLine(flags.despite);
  const end = flags.end === null ? null : oneLine(flags.end);
  const reason = flags.reason === null ? null : oneLine(flags.reason);
  if (despite === '') return { error: '--despite needs a reason — say why the reading is set aside, in words; it is on the record' };
  if (end !== null) {
    if (!end) return { error: '--end needs the started of the desk entry (mc martin get names it)' };
    if (!reason) return { error: '--end needs --reason "…" — why the entry ends; it is on the record' };
    if (despite !== null || flags['dry-run']) return { error: '--end ends a desk entry and takes nothing back: it takes no --despite or --dry-run' };
  } else if (reason !== null) {
    return { error: '--reason belongs to --end; a take-back says its reason with --despite "<reason>"' };
  }
  return { dryRun: flags['dry-run'], json: flags.json, despite, end, reason };
}

function workerLine(one) {
  return `${one.worker}: ${one.from || '?'} → ${one.to || '?'}${one.state ? ` (${one.state}${one.serving ? `, serving ${one.serving}` : ''}${one.why ? ` — ${one.why}` : ''})` : ''}`;
}

/**
 * Run the verb. `deps`: `stdout`, `stderr`, `env`, `repoPath`, `takeBack`,
 * `endDesk`, and the `takeBack` function's own `deps` as `takeBackDeps`.
 */
export async function runTakeBack(opts, { stdout, stderr, env, repoPath, deps = {} }) {
  const emit = (value) => stdout.write(`${JSON.stringify(value)}\n`);
  const refuse = (message, extra = {}) => {
    if (opts.json) emit({ status: 'refused', why: message, ...extra });
    else stderr.write(`mc: ${message}\n`);
    return 2;
  };

  if (opts.end) {
    let done;
    try {
      done = (deps.endDesk || endDesk)({ env, started: opts.end, reason: opts.reason });
    } catch (error) {
      if (error instanceof LedgerError) return refuse(error.message);
      throw error;
    }
    if (!done.length) return refuse(`no open desk entry ${opts.end} in the red ledger — mc martin get lists the open ones`);
    if (opts.json) emit({ status: 'ended', started: opts.end, reason: opts.reason });
    else stdout.write(`mc: the desk entry ${opts.end} is ended — ${opts.reason}\n`);
    return 0;
  }

  if (!repoPath) return refuse('no checkout of memoro on this machine — mc deploy take-back takes memoro\'s last release back and no other');

  const say = (line) => { if (!opts.json) stdout.write(`${line}\n`); };
  const result = await (deps.takeBack || takeBack)({
    by: 'verb',
    reason: opts.despite || '',
    despite: Boolean(opts.despite),
    dryRun: opts.dryRun,
    holder: 'mc deploy take-back',
    repoPath,
    env,
    deps: deps.takeBackDeps || {},
    say,
  });

  if (result.status === 'refused' || result.status === 'not-made') {
    const code = result.code;
    if (opts.json) {
      emit({ status: result.status, code, why: result.why });
    } else {
      stderr.write(`mc: nothing was taken back — ${result.why}\n`);
      if (result.status === 'refused' && code !== 'reading-no') {
        stderr.write('mc: by hand, in the deploy worktree: memoro\'s docs/runbooks/deploy.md (The manual take-back); or ship the repair — mc deploy once a later commit is green. mc martin get names the open desk entry.\n');
      }
    }
    return 2;
  }

  if (result.status === 'dry-run') {
    if (opts.json) {
      emit({
        status: 'dry-run', ok: result.ok, release: result.release, returns_to: result.returnsTo, workers: result.workers, why: result.why || '',
      });
    } else {
      const { release, returnsTo } = result;
      stdout.write(`mc: take-back (dry run) — ${String(release.sha).slice(0, 7)} (started ${release.started}) back to ${String(returnsTo.sha).slice(0, 7)}\n`);
      stdout.write(`mc:   reading: take_back ${release.take_back || 'none'}${release.take_back_why ? ` — ${release.take_back_why}` : ''}${release.check ? `; check ${release.check}` : ''}\n`);
      for (const one of result.workers) stdout.write(`mc:   ${workerLine(one)}\n`);
      if (!result.ok) stdout.write(`mc:   the script's dry run is not clean${result.why ? ` — ${result.why}` : ''}\n`);
      stdout.write('mc: nothing was taken back and no row was written\n');
    }
    return result.ok ? 0 : 2;
  }

  const taken = result.status === 'taken-back';
  if (opts.json) {
    emit({
      status: result.status, release: result.release, returns_to: result.returnsTo, workers: result.workers,
      row: { started: result.row?.started, outcome: result.row?.outcome, note: result.row?.note }, why: result.why || '',
    });
  } else if (taken) {
    stdout.write(`mc: taken back — ${result.row.note}\n`);
    for (const one of result.workers) stdout.write(`mc:   ${workerLine(one)}\n`);
    stdout.write('mc: the check runs again on the take-back row\n');
  } else {
    stderr.write(`mc: ${result.why}\n`);
    for (const one of result.workers) stderr.write(`mc:   ${workerLine(one)}\n`);
    stderr.write('mc: mc deploy take-back again takes back what is still on the release\n');
  }
  return taken ? 0 : 1;
}
