/**
 * `mc suite` — the suite right, as a lease.
 *
 *   mc suite claim "<what for>"     hold the right to run a full suite
 *   mc suite release [--force]      give it back; --force takes it, logged
 *   mc suite who [--json]           who holds it, and which suites run now
 *
 * Advisory, like the repository lease: a claim on a right somebody else holds
 * is refused, and that refusal stops exactly one thing — this command. No
 * process is blocked. What it adds is the fact, visible here and on the
 * status board, where a suite nobody claimed is a row rather than a guess.
 */
import { painter } from '../status-render.js';
import { claimSuiteLease, readSuiteLease, releaseSuiteLease } from '../suite-lease.js';
import { currentHolder } from '../work-identity.js';
import { suiteRuns } from '../work-status.js';
import { scanArgs } from './flags.js';

const VERBS = ['claim', 'release', 'who'];

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write('usage — mc suite claim "<what for>" | release [--force] | who [--json]\n');
    return 2;
  }
  const c = painter(Boolean(stdout.isTTY) && process.env.NO_COLOR === undefined);
  const holder = currentHolder();
  const runs = deps.runs || suiteRuns;

  if (opts.verb === 'who') {
    const lease = readSuiteLease();
    const running = await runs();
    if (opts.json) {
      stdout.write(`${JSON.stringify({ lease, running }, null, 2)}\n`);
      return 0;
    }
    stdout.write(`${suiteRow(c, lease, running)}\n`);
    return 0;
  }

  if (opts.verb === 'claim') {
    const outcome = claimSuiteLease({ errand: opts.errand, holder });
    if (!outcome.ok) {
      stderr.write(`mc: the suite right is held by ${outcome.lease.holder} — ${suiteRow(c, outcome.lease, await runs())}\n`);
      stderr.write('mc: nothing is blocked; this is mc being strict with itself — one full suite at a time on this machine (D-0141)\n');
      stderr.write('mc: if that run is over, mc suite release --force ends it — and says so in the log\n');
      return 1;
    }
    if (outcome.already) {
      stdout.write(`mc: you already hold the suite right — ${suiteRow(c, outcome.lease, [])}\n`);
      return 0;
    }
    stdout.write(`mc: ${holder.name} holds the suite right${opts.errand ? ` for “${opts.errand}”` : ''}\n`);
    stdout.write('mc: release it when the run is done — mc suite release\n');
    return 0;
  }

  const outcome = releaseSuiteLease({ holder, force: opts.force });
  if (!outcome.ok) {
    stderr.write(`mc: the suite right is held by ${outcome.lease.holder}, not by you — mc suite release --force takes it, and is logged\n`);
    return 1;
  }
  if (!outcome.released) { stdout.write('mc: nobody holds the suite right\n'); return 0; }
  stdout.write(outcome.forced
    ? `mc: took the suite right from ${outcome.lease.holder} (held ${Math.round(outcome.lease.age_ms / 60000)}m) — logged\n`
    : 'mc: suite right released\n');
  return 0;
}

/** One line: the lease, then what is actually running. */
export function suiteRow(c, lease, running, now = Date.now()) {
  const parts = [];
  if (lease?.held) {
    const age = Number.isFinite(lease.age_ms) ? lease.age_ms : Math.max(0, now - Date.parse(lease.since));
    parts.push(`${c(lease.holder, 'bold')}${lease.errand ? ` “${lease.errand}”` : ''} ${c(`held for ${minutes(age)}`, 'grey')}`);
  } else {
    parts.push(c('free', 'grey'));
  }
  if (running?.length) {
    parts.push(...running.map((run) => c(`running: ${run.command} in ${run.area || run.directory} (pid ${run.pid}, ${run.elapsed})`, 'yellow')));
  } else {
    parts.push(c('nothing running', 'grey'));
  }
  return parts.join('  ·  ');
}

function minutes(ms) {
  const m = Math.round(ms / 60000);
  return m < 1 ? 'under a minute' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function parseArgs(argv) {
  const scanned = scanArgs(argv, { booleans: ['--json', '--force'] });
  const opts = { verb: null, errand: '', json: scanned.flags.json, force: scanned.flags.force };
  if (scanned.error) return { ...opts, error: scanned.error };
  const [verb, ...rest] = scanned.positional;
  if (!verb) return { ...opts, error: 'say which: claim, release or who' };
  if (!VERBS.includes(verb)) return { ...opts, error: `mc suite does not know "${verb}"` };
  if (verb === 'claim' && rest.length === 0) return { ...opts, error: 'claim needs to say what for — mc suite claim "<what for>"' };
  if (verb !== 'claim' && rest.length > 0) return { ...opts, error: `${verb} takes no further words` };
  return { ...opts, verb, errand: rest.join(' ') };
}
