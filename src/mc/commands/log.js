/**
 * `mc log` — what mc did, and what happened to it.
 *
 *   mc log [--limit <n>]            the last invocations, newest last
 *   mc log --failures               only the ones that did not end well
 *   mc log <run>                    one invocation, whole: its narration,
 *                                   its rounds, the leases it touched
 *   mc log --open                   rounds that started and never ended
 *   mc log --repo <repo>            narrowed to one repository
 *   mc log --since <iso>            narrowed to a window
 *   mc log --where                  the files this reads, and their sizes
 *
 * This exists because of one morning. On 2026-08-30 two merge rounds were
 * killed from outside, the first after #11082 had already landed and before
 * #11085 was reached. Every fact needed to understand that was on disk, in
 * three files that nothing joined, and reading them took a hand-written
 * script. `mc log <run>` is that script, kept.
 *
 * It only reads. It does not release a lease, repair a round or clean
 * anything up. An abandoned lease is a judgement about the world — whether a
 * person walked away or a machine died — and `--open` lays out the evidence
 * for somebody to make it, which is the same division `mc repo who` has
 * always kept.
 */
import { statSync } from 'node:fs';

import { painter } from '../status-render.js';
import { logPath, runId } from '../logger.js';
import {
  abandoned, filterRuns, readEvents, readLeaseLog, runsFrom, storyOf,
} from '../log-read.js';
import { mcHome } from '../paths.js';
import { leaseLogPath } from '../repo-lease.js';
import { roundLogPath } from '../repo-round-log.js';
import { scanArgs } from './flags.js';

const DEFAULT_LIMIT = 25;

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write(usage());
    return 2;
  }
  const root = deps.root || mcHome();
  const c = painter(Boolean(stdout.isTTY) && process.env.NO_COLOR === undefined);
  const alive = deps.alive || undefined;

  if (opts.where) {
    const lines = [logPath(), roundLogPath(root), leaseLogPath(root)].map((path) => {
      let size = null;
      try { size = statSync(path).size; } catch { /* absent is an answer */ }
      return `${size === null ? '  —      ' : `${String(kb(size)).padStart(6)} KB`}  ${path}`;
    });
    stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }

  if (opts.run) {
    const story = storyOf(opts.run, { root, alive });
    if (opts.json) { stdout.write(`${JSON.stringify(story, null, 2)}\n`); return 0; }
    if (!story.invocation && !story.rounds.length) {
      stderr.write(`mc: nothing recorded for ${opts.run} — mc log lists the runs that are\n`);
      return 1;
    }
    stdout.write(`${storyLines(c, story).join('\n')}\n`);
    return 0;
  }

  if (opts.open) {
    const open = abandoned({ root, alive });
    if (opts.json) { stdout.write(`${JSON.stringify(open, null, 2)}\n`); return 0; }
    if (!open.length) {
      stdout.write('mc: every round that started has ended\n');
      return 0;
    }
    stdout.write(`${openLines(c, open).join('\n')}\n`);
    // A round that died is not this command's failure — it is its finding.
    // Exit 0, because a nonzero here would make `mc log --open` unusable in
    // anything that chains commands with &&.
    return 0;
  }

  const { events, skipped } = readEvents({ root });
  const runs = filterRuns(runsFrom(events, { alive }), {
    since: opts.since, repo: opts.repo, verb: opts.verb, failures: opts.failures,
    // This invocation is in the log it is reading, and it has not ended yet,
    // so it would head every listing as the one thing that is still running.
    // A tool that reports itself as the anomaly teaches people to ignore the
    // anomaly column.
    exclude: deps.self === undefined ? runId() : deps.self,
  }).slice(-opts.limit);
  if (opts.json) { stdout.write(`${JSON.stringify(runs, null, 2)}\n`); return 0; }
  if (!runs.length) {
    stdout.write(`mc: nothing recorded${opts.failures ? ' that failed' : ''}${opts.since ? ` since ${opts.since}` : ''}\n`);
    return 0;
  }
  stdout.write(`${runs.map((one) => runLine(c, one)).join('\n')}\n`);
  if (skipped) stdout.write(`${dim(c, `${skipped} line${skipped === 1 ? '' : 's'} in the log would not parse and were skipped`)}\n`);
  return 0;
}

/* ------------------------------------------------------------- rendering */

function runLine(c, run) {
  const words = [run.verb, run.sub, ...(run.args || [])].filter(Boolean).join(' ');
  return [
    dim(c, clock(run.at)),
    paint(c, run.outcome),
    words.padEnd(34).slice(0, 34),
    dim(c, (run.holder || '').padEnd(16).slice(0, 16)),
    dim(c, run.duration_ms == null ? '' : took(run.duration_ms)),
    run.threw && run.error ? dim(c, `— ${run.error}`) : '',
  ].join(' ').trimEnd();
}

function storyLines(c, story) {
  const out = [];
  const run = story.invocation;
  if (run) {
    out.push(`${bold(c, story.run)}  ${[run.verb, run.sub, ...(run.args || [])].filter(Boolean).join(' ')}`);
    out.push(`  ${dim(c, 'started')}  ${run.at}  ${dim(c, `pid ${run.pid}`)}  ${dim(c, run.holder || '')}`);
    if (run.flags?.length) out.push(`  ${dim(c, 'flags')}    ${run.flags.join(' ')}`);
    out.push(`  ${dim(c, 'outcome')}  ${paint(c, run.outcome)}${run.exit_code == null ? '' : ` exit ${run.exit_code}`}${run.duration_ms == null ? '' : ` after ${took(run.duration_ms)}`}`);
    if (run.killed) out.push(`  ${dim(c, 'signal')}   ${run.killed}`);
    if (run.error) out.push(`  ${dim(c, 'error')}    ${run.error}`);
  }
  for (const round of story.rounds) {
    out.push(`  ${dim(c, 'round')}    ${round.phase}  ${round.repo}  ${(round.prs || []).map((n) => `#${n}`).join(' ')}`
      + `${round.stopped_at ? `  stopped at ${round.stopped_at}` : ''}`);
    if (round.reason) out.push(`           ${dim(c, round.reason)}`);
  }
  for (const lease of story.leases) {
    out.push(`  ${dim(c, 'lease')}    ${lease.verb.padEnd(8)}${lease.repo}${lease.errand ? `  “${lease.errand}”` : ''}${lease.gone ? red(c, '  pid was gone') : ''}`);
  }
  if (run?.said?.length) {
    out.push(`  ${dim(c, 'said')}`);
    // The narration is the point of keeping it: on a round that died this is
    // the only account of how far it got.
    for (const line of run.said) out.push(`    ${dim(c, clock(line.at))}  ${line.text}`);
  }
  return out;
}

function openLines(c, open) {
  const out = [];
  for (const round of open) {
    const verdict = round.verdict === 'died' ? red(c, 'DIED') : dim(c, 'running');
    out.push(`${verdict}  ${round.repo}  ${(round.prs || []).map((n) => `#${n}`).join(' ')}`
      + `  ${dim(c, `started ${round.at}`)}  ${dim(c, `pid ${round.pid}`)}  ${dim(c, round.run || '')}`);
    if (round.verdict === 'died') {
      out.push(round.reaped
        ? `      ${dim(c, 'its lease has since been reaped — nothing is held')}`
        : `      ${dim(c, 'no reap recorded for that pid: check mc repo who before assuming the lease is free')}`);
    }
    for (const lease of round.lease) out.push(`      ${dim(c, `${lease.at}  ${lease.verb}  ${lease.errand || ''}`)}`);
  }
  out.push('');
  out.push(dim(c, 'mc log <run> for one of these in full. Releasing a lease stays a decision somebody makes.'));
  return out;
}

// `painter` returns `(text, ...styleNames)` and the identity function when the
// output is not a terminal, so these four are the whole colour vocabulary here.
const dim = (c, text) => c(text, 'dim');
const red = (c, text) => c(text, 'red');
const green = (c, text) => c(text, 'green');
const bold = (c, text) => c(text, 'bold');

function paint(c, outcome) {
  const word = outcome.padEnd(7);
  if (outcome === 'ok') return green(c, word);
  if (outcome === 'running') return dim(c, word);
  return red(c, word);
}

function clock(at) {
  return String(at || '').slice(5, 16).replace('T', ' ');
}

function took(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function kb(bytes) {
  return Math.max(1, Math.round(bytes / 1024));
}

/* ---------------------------------------------------------------- parsing */

export function parseArgs(argv) {
  const scanned = scanArgs(argv, {
    booleans: ['--json', '--failures', '--open', '--where'],
    strictValues: ['--limit', '--since', '--repo', '--verb'],
  });
  if (scanned.error) return { error: scanned.error };
  if (scanned.positional.length > 1) return { error: `unexpected argument ${scanned.positional[1]}` };
  const limit = scanned.flags.limit == null ? DEFAULT_LIMIT : Number(scanned.flags.limit);
  if (!Number.isInteger(limit) || limit <= 0) return { error: '--limit needs a whole number above zero' };
  return {
    run: scanned.positional[0] || null,
    json: Boolean(scanned.flags.json),
    failures: Boolean(scanned.flags.failures),
    open: Boolean(scanned.flags.open),
    where: Boolean(scanned.flags.where),
    limit,
    since: scanned.flags.since || null,
    repo: scanned.flags.repo || null,
    verb: scanned.flags.verb || null,
  };
}

function usage() {
  return 'usage — mc log [<run>] [--failures] [--open] [--repo <repo>] [--since <iso>]\n'
    + '              [--verb <verb>] [--limit <n>] [--where] [--json]\n';
}

// Re-exported so the reading rules have one door for anything that wants them
// without going through the command.
export { abandoned, filterRuns, readEvents, readLeaseLog, runsFrom, storyOf };
