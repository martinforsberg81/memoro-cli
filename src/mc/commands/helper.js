/**
 * `mc helper` — the eye on production that is not Martin staring at
 * admin.html.
 *
 * Two halves, one verb. `--collect` is the script: read the five sources
 * memoro already records and write `~/mc/intake/errors-<date>.md`, with the
 * delta against the previous digest. No model, no network writes, no queue.
 * The bare verb does that and then runs the turn — one headless session with
 * the `helper` role that reads the digest and writes zero or more proposals
 * into `~/mc/intake/proposals/`.
 *
 * Nothing here writes `queue.md`. A proposal is read at the next brief and
 * Martin either queues it or drops it; that is the whole arrangement, and it
 * is why the model half can run unattended every day.
 */
import {
  collectHelper, DEFAULT_LIMIT, DEFAULT_THRESHOLD, describeDigest, proposalsDir, unreadableSections,
} from '../helper-collect.js';
import { describeTurn, runHelperTurn } from '../helper-turn.js';
import { scanArgs } from './flags.js';

const USAGE = 'usage — mc helper [--collect] [--since <iso>] [--limit <n>] [--threshold <n>] [--model <model>]\n';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const scanned = scanArgs(argv, {
    booleans: ['--collect'],
    strictValues: ['--since', '--limit', '--threshold', '--model'],
  });
  if (scanned.error || scanned.positional.length) {
    stderr.write(`mc: ${scanned.error || `unknown argument ${scanned.positional[0]}`}\n`);
    stderr.write(USAGE);
    return 2;
  }
  const { flags } = scanned;

  const since = parseSince(flags.since);
  if (flags.since && !since) {
    stderr.write(`mc: --since ${flags.since} is not a date mc can read\n`);
    return 2;
  }
  const limit = parseCount(flags.limit, DEFAULT_LIMIT);
  const threshold = parseCount(flags.threshold, DEFAULT_THRESHOLD);
  if (limit === null || threshold === null) {
    stderr.write('mc: --limit and --threshold want a positive whole number\n');
    return 2;
  }

  const t0 = Date.now();
  const result = await (deps.collect || collectHelper)({ since, limit, threshold });
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  const { delta, errors, notes } = result.data;
  stdout.write(`mc: ${result.path} (${seconds}s) — ${describeDigest({ delta, errors })}\n`);

  for (const note of notes) stderr.write(`mc: ${note}\n`);
  for (const [section, source] of unreadableSections(result.data)) {
    stderr.write(`mc: ${section} not read — ${source.error}\n`);
  }
  if (flags.collect) return 0;

  // The turn. A digest with nothing new in it is still read — "nothing new"
  // is a judgement about fingerprints, and a condition that has been failing
  // for three days is exactly what a fresh reader should still propose
  // fixing. Zero proposals is the answer on a quiet day, not a failure.
  const t1 = Date.now();
  const turn = await (deps.turn || runHelperTurn)({
    digestPath: result.path, digestText: result.text, model: flags.model || null,
  });
  const took = ((Date.now() - t1) / 1000).toFixed(1);
  for (const note of turn.groundNotes || []) stderr.write(`mc: ${note}\n`);
  if (!turn.ok) {
    stderr.write(`mc: the helper turn did not finish — ${turn.note || turn.reason}\n`);
    if (turn.stderr?.trim()) stderr.write(`mc: ${turn.stderr.trim().split('\n').at(-1)}\n`);
    return 1;
  }
  stdout.write(`mc: ${describeTurn(turn)} (${took}s, ${turn.tool} ${turn.model})\n`);
  for (const p of turn.wrote) stdout.write(`mc:   ${p.file} — ${p.title}\n`);
  if (turn.wrote.length) stdout.write(`mc: read them at the next brief — ${proposalsDir()}\n`);
  return 0;
}

function parseSince(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseCount(value, fallback) {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}
