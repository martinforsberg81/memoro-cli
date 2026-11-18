/**
 * `mc helper` — the eye on production. The verb used to carry a desk as well
 * (a foreground session Martin talked to); the desk is `mc martin` now
 * (reach/helper-goes-into-the-desk), and every call that names neither
 * `--intake` nor `--collect` is refused before it reads a role, makes a
 * directory or opens a session.
 *
 * `--intake` is **the eye**: the script that reads the five sources memoro
 * already records into `~/mc/intake/errors-<repo>-<date>.md`, and then the
 * inbox drained — one headless turn with the `intake` role per file, oldest
 * first, each file archived after its turn. `--collect` stops after the digest
 * — no model; only verified suggestion receipts write to production. `mc run` runs both halves on its own cadence,
 * through the modules, not this verb.
 *
 * The verb keeps the name `helper` for the eye's sake: the intake turn
 * registers its live record with verb `helper`, which the page's intake panel
 * reads, and `~/mc/helper/` holds the retired desk's old conversations.
 *
 * Nothing here writes `queue.md`. Whichever half wrote a proposal, it is read
 * in the area it was written to (`~/mc/areas/<repo>/<area>/proposals/`);
 * that is the whole arrangement, and it is why the intake half can run
 * unattended every day.
 */
import { commandUsage } from '../command-help.js';
import {
  collectHelper, DEFAULT_LIMIT, DEFAULT_THRESHOLD, describeDigest, HELPER_REPOS,
  unreadableSections,
} from '../helper-collect.js';
import { describeTurn, drainIntake } from '../helper-turn.js';
import { areasHome } from '../area-proposals.js';
import { INTAKE_PER_ROUND } from '../run-plan.js';
import { scanArgs } from './flags.js';

const USAGE = commandUsage('helper');

/** What a call that names neither `--intake` nor `--collect` is told: the desk is `mc martin`, and the eye is unchanged. */
export const DESK_GONE = 'mc: mc helper is no longer a way in — the desk is mc martin\n'
  + 'mc: mc helper --collect and mc helper --intake are unchanged\n';

export function usage() {
  return commandUsage('helper');
}

/** Each subcommand and the scan it is read with; '' is the bare verb, '*' a first word that names something. help-routes.test.js walks the help with it. */
/** `check`: what the scanned arguments may not be — null, or what is wrong; the verb runs it, and help-routes.test.js walks the help with it. */
export const ROUTES = {
  '': {
    booleans: ['--intake', '--collect'],
    strictValues: ['--since', '--limit', '--threshold', '--model'],
    toolSugar: true,
    check: ({ positional }) => (positional.length ? `unknown argument ${positional[0]}` : null),
  },
};

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  // The desk is `mc martin`. A call that names neither half of the eye is refused whole, whatever else it says
  // (bare, --new, --resume, --bg, --local, a tool or model alone, a digest flag alone), before anything is read or made.
  if (!argv.includes('--intake') && !argv.includes('--collect')) {
    stderr.write(DESK_GONE);
    return 2;
  }
  const scanned = scanArgs(argv, ROUTES['']);
  const refused = scanned.error || ROUTES[''].check(scanned);
  if (refused) {
    stderr.write(`mc: ${refused}\n`);
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

  // Both repositories, every time. memoro's production is five remote
  // sources; memoro-cli's is this machine. For a week only the first was
  // read, which is why every memoro-cli failure was found by a person
  // noticing it — and why sixteen merge rounds stopping on a lease in one day
  // was a feeling rather than a number.
  //
  // Sequential, not concurrent: the memoro half spends minutes on wrangler
  // and the network, and interleaving the two streams of stderr would make
  // the half that failed impossible to attribute. The cli half costs
  // milliseconds and reads nothing but this disk.
  const results = [];
  let worst = 0;
  for (const repo of HELPER_REPOS) {
    const t0 = Date.now();
    const result = await (deps.collect || collectHelper)({ since, limit, threshold, repo });
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    const { delta, errors, notes = [] } = result.data;
    stdout.write(`mc: ${result.path} (${seconds}s) — ${describeDigest({ delta, errors })}\n`);
    for (const note of notes) stderr.write(`mc: ${repo}: ${note}\n`);
    for (const [section, source] of unreadableSections(result.data)) {
      stderr.write(`mc: ${repo}: ${section} not read — ${source.error}\n`);
    }
    // The repository is carried beside the result, not read back out of it:
    // the collector echoes it, but a caller that trusted the echo printed
    // `undefined:` in front of every line the moment a stub did not.
    results.push({ repo, result });
  }
  if (flags.collect) return 0;

  // The inbox, drained — the same drain the runner does, the same cap and the
  // same archive. Not a turn per digest just written: what stands in front of
  // the turn is an inbox, and the two files collected a second ago are at the
  // back of it behind anything that has been waiting longer. A file with
  // nothing new in it is still read — "nothing new" is a judgement about
  // fingerprints, and a condition failing for three days is exactly what a
  // fresh reader should still propose fixing. Zero proposals is the answer on
  // a quiet day, not a failure.
  //
  // One file per turn, so a turn that fails costs that file's judgement and
  // no other's — losing memoro-cli's proposals because wrangler was
  // unauthenticated is the exact failure shape this file is written against.
  const drained = await (deps.drain || drainIntake)({
    limit: INTAKE_PER_ROUND,
    model: flags.model || null,
    tool: flags.tool || null,
    deps: { turn: deps.turn, files: deps.files, move: deps.move },
  });
  let wrote = 0;
  for (const { file, turn, archived, seconds } of drained.done) {
    for (const note of turn.groundNotes || []) stderr.write(`mc: ${note}\n`);
    if (!turn.ok) {
      stderr.write(`mc: ${file}: the intake turn did not finish — ${turn.note || turn.reason}\n`);
      if (turn.stderr?.trim()) stderr.write(`mc: ${turn.stderr.trim().split('\n').at(-1)}\n`);
      worst = 1;
    } else {
      stdout.write(`mc: ${file}: ${describeTurn(turn)} (${seconds}s, ${turn.tool} ${turn.model})\n`);
      for (const p of turn.wrote) stdout.write(`mc:   ${p.file}\n`);
      wrote += turn.wrote.length;
    }
    // Archiving is what makes the drain terminate, so a file that stayed put
    // is said out loud rather than left to be noticed as a file read twice.
    if (!archived) stderr.write(`mc: ${file}: could not be moved out of the inbox — it will be taken again\n`);
  }
  if (drained.left) stdout.write(`mc: ${drained.left} more in the inbox — run it again to take the next ${INTAKE_PER_ROUND}\n`);
  // Only when there is something to read. A quiet day that still points at
  // the proposals directory is a line that trains people to ignore the line.
  // Each waits in its area; the turn's own line above already named which.
  if (wrote) stdout.write(`mc: proposals wait in their areas — ${areasHome()}/<repo>/<area>/proposals (mc proposals counts them)\n`);
  return worst;
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
