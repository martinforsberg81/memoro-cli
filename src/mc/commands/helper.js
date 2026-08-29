/**
 * `mc helper` — the eye on production that is not Martin staring at
 * admin.html.
 *
 * `--collect` is the script half, and all of it that exists today: read the
 * five sources memoro already records and write
 * `~/mc/intake/errors-<date>.md`, with the delta against the previous
 * digest. No model, no network writes, no queue.
 *
 * The bare verb is the proposal turn — a `helper` role reading the digest
 * and writing `~/mc/intake/proposals/` — and is step 2 of the plan. It
 * refuses rather than pretending, so the runner never records a helper run
 * that produced nothing.
 */
import { collectHelper, DEFAULT_LIMIT, DEFAULT_THRESHOLD } from '../helper-collect.js';
import { scanArgs } from './flags.js';

const USAGE = 'usage — mc helper --collect [--since <iso>] [--limit <n>] [--threshold <n>]\n';

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const scanned = scanArgs(argv, {
    booleans: ['--collect'],
    strictValues: ['--since', '--limit', '--threshold'],
  });
  if (scanned.error || scanned.positional.length) {
    stderr.write(`mc: ${scanned.error || `unknown argument ${scanned.positional[0]}`}\n`);
    stderr.write(USAGE);
    return 2;
  }
  const { flags } = scanned;

  if (!flags.collect) {
    stderr.write('mc: the proposal turn is not built yet — mc helper --collect writes the digest\n');
    stderr.write(USAGE);
    return 2;
  }

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
  stdout.write(`mc: ${result.path} (${seconds}s) — ${describe({ delta, errors })}\n`);

  for (const note of notes) stderr.write(`mc: ${note}\n`);
  for (const [section, source] of unreadable(result.data)) {
    stderr.write(`mc: ${section} not read — ${source.error}\n`);
  }
  return 0;
}

/** The one line a runner log will carry: what is new, and how loud. */
export function describe({ delta, errors }) {
  if (delta.first) return `first digest, ${errors.rows.length} fingerprints — no baseline yet`;
  const loud = delta.fingerprints.filter((f) => f.loud).length;
  const parts = [`${delta.fingerprints.length} new fingerprint${delta.fingerprints.length === 1 ? '' : 's'}`];
  if (loud) parts.push(`${loud} above the threshold`);
  if (delta.failing.length) {
    parts.push(`${delta.failing.length} newly failing condition${delta.failing.length === 1 ? '' : 's'}`);
  }
  return parts.join(', ');
}

/** Every section that could not be read, so a partial digest still complains. */
export function unreadable({ errors, analysis, provider, health, deploy }) {
  return [
    ['error fingerprints', errors],
    ['analysis items', analysis],
    ['AI-provider errors', provider],
    ['D1 health', health],
    ['deploy logs', deploy],
  ].filter(([, source]) => source?.error);
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
