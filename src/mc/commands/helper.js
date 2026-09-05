/**
 * `mc helper` — the desk, and the eye on production behind the same verb.
 *
 * The bare verb is **the desk**: a fresh foreground session standing in
 * `~/mc/helper/`, with Martin in it, whose whole job is to take what he says
 * is broken or should be better and write it down as a proposal in
 * `~/mc/proposals/`. It reads no digest and it does not touch the
 * proposals already waiting — adding is all it does.
 *
 * `--intake` is **the eye**: the script that reads the five sources memoro
 * already records into `~/mc/intake/errors-<repo>-<date>.md`, and then the
 * inbox drained — one headless turn with the `intake` role per file, oldest
 * first, each file archived after its turn. `--collect` stops after the digest
 * — no model, no network writes. `mc run` runs both halves on its own cadence,
 * through the modules, not this verb.
 *
 * Nothing here writes `queue.md`. Whichever half wrote a proposal, it is read
 * at the next `mc brief` and Martin queues it or drops it; that is the whole
 * arrangement, and it is why the intake half can run unattended every day.
 */
import { mkdirSync } from 'node:fs';

import {
  collectHelper, DEFAULT_LIMIT, DEFAULT_THRESHOLD, describeDigest, helperDir, HELPER_REPOS, proposalsDir,
  unreadableSections,
} from '../helper-collect.js';
import { describeTurn, drainIntake } from '../helper-turn.js';
import { readCanonRole } from '../roles.js';
import { INTAKE_PER_ROUND } from '../run-plan.js';
import { openInWorkArea } from '../work-open.js';
import { scanArgs } from './flags.js';

const USAGE = 'usage — mc helper [--codex|--claude] [--model <model>]\n'
  + '        mc helper --intake [--collect] [--since <iso>] [--limit <n>] [--threshold <n>] [--model <model>]\n';

/** The flags that only mean something to the digest, named once for the refusal. */
const DIGEST_FLAGS = ['--since', '--limit', '--threshold'];

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const scanned = scanArgs(argv, {
    booleans: ['--intake', '--collect'],
    strictValues: ['--since', '--limit', '--threshold', '--model'],
    toolSugar: true,
  });
  if (scanned.error || scanned.positional.length) {
    stderr.write(`mc: ${scanned.error || `unknown argument ${scanned.positional[0]}`}\n`);
    stderr.write(USAGE);
    return 2;
  }
  const { flags } = scanned;

  // The desk. `--collect` still reaches the digest on its own, because it
  // always has and a script that says it wants only the file means it.
  if (!flags.intake && !flags.collect) return openDesk({ flags, stdout, stderr, deps });

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
  if (wrote) stdout.write(`mc: read them at the next brief — ${proposalsDir()}\n`);
  return worst;
}

/**
 * The bare verb: a new foreground conversation in `~/mc/helper/` wearing the
 * `helper` role. Same shape as `mc brief` — the terminal's session, never
 * tmux, never `--resume` — and its own directory rather than `~/mc/intake/`,
 * which is the intake turn's material and none of its business.
 *
 * The directories are made here rather than by the session: a session told to
 * write into a path that does not exist has one avoidable way to fail.
 */
async function openDesk({ flags, stdout, stderr, deps }) {
  const stray = DIGEST_FLAGS.filter((name) => flags[name.slice(2)] !== null);
  if (stray.length) {
    stderr.write(`mc: ${stray[0]} is the digest's flag — say mc helper --intake ${stray[0]} …\n`);
    stderr.write(USAGE);
    return 2;
  }

  const role = (deps.role || readCanonRole)('helper');
  if (!role?.overlay) {
    stderr.write('mc: the helper role is missing from this install — expected canon/roles/helper.md with an overlay body\n');
    return 1;
  }

  const dir = helperDir();
  const proposals = proposalsDir();
  const mkdir = deps.mkdir || mkdirSync;
  mkdir(dir, { recursive: true });
  mkdir(proposals, { recursive: true });
  stdout.write(`mc: ${dir} — tell it what is broken; proposals land in ${proposals}\n`);

  const launch = helperLaunch({ proposalsPath: proposals, role });
  const opened = await (deps.open || openInWorkArea)({
    areaRoot: dir,
    worktree: { repo: null, path: dir, is_git: false },
    tool: flags.tool || role.tools?.[0] || 'claude',
    pick: 'new',
    // NOW says "mc helper" while this is up. Its room is nobody's workarea,
    // so there is no area name to give it.
    verb: 'helper',
    model: flags.model,
    overlay: role.overlay,
    prompt: launch.prompt,
    defaultModel: role.model,
    defaultModelTool: role.tools?.[0] || null,
  });
  if (!opened.ok) {
    stderr.write(`mc: ${opened.reason}${opened.hint ? ` — ${opened.hint}` : ''}\n`);
    return 1;
  }
  return opened.code ?? 0;
}

/**
 * What the desk session is told first. There is no file to hand it — the
 * report is in Martin's head — so the opening words are the date its
 * filenames need and the one instruction the role does not already carry:
 * ask first, write after.
 */
export function helperLaunch({ proposalsPath = proposalsDir(), role = null, now = new Date() } = {}) {
  const date = now.toISOString().slice(0, 10);
  const prompt = [
    `Today is ${date}. Martin is here with something that is broken, or something he wants better.`,
    'Take his report. Ask only what you cannot read for yourself, then write it into',
    `\`${proposalsPath}\` as \`${date}-<slug>.md\` in the shape your role gives.`,
    '',
    'Open by asking what he has. Write nothing until you have it.',
  ].join('\n');
  return { prompt, overlay: role?.overlay || null, model: role?.model || null };
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
