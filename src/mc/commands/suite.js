/**
 * `mc suite` — the suite right, as a lease.
 *
 *   mc suite run "<command>"        take it, run, give it back — one step
 *   mc suite claim "<what for>"     hold the right to run a full suite
 *   mc suite release [--force]      give it back; --force takes it, logged
 *   mc suite who [--json]           who holds it, and which suites run now
 *
 * Advisory, like the repository lease: a claim on a right somebody else holds
 * is refused, and that refusal stops exactly one thing — this command. No
 * process is blocked. What it adds is the fact, visible here and on the
 * status board, where a suite nobody claimed is a row rather than a guess.
 *
 * `run` exists because `claim` + a separate command is two steps with a
 * human decision between them, and the decision was measured being skipped
 * (D-0176, 2026-08-23): a track chained `mc suite claim; npm test` with `;`
 * and never read the claim's refusal — the refusal was printed, exit 1, on
 * stderr, and the mechanism could not help because nothing looked. The same
 * day, twice more: an interrupt between the steps left the lease standing
 * (one cost PM 2h25m, D-0167; a command timeout mid-suite did it again). So
 * the guarded form is one step: refused means NOTHING runs and the exit is
 * the refusal's; and the lease goes back when the command ends — on
 * success, on failure, and on SIGINT/SIGTERM, where the command's process
 * group is ended first. A vakt that only holds when called correctly is a
 * vakt that holds until somebody is in a hurry.
 */
import { spawn } from 'node:child_process';

import { painter } from '../status-render.js';
import { orphanLine } from '../lease-owner.js';
import { tellHolder } from '../lease-refusal.js';
import { claimSuiteLease, readSuiteLease, releaseSuiteLease } from '../suite-lease.js';
import { currentHolder } from '../work-identity.js';
import { dependencyTree } from '../dependency-tree.js';
import { suiteRuns } from '../work-status.js';
import { scanArgs } from './flags.js';

const VERBS = ['run', 'claim', 'release', 'who'];

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write('usage — mc suite run "<command>" | claim "<what for>" | release [--force] | who [--json]\n');
    return 2;
  }
  const c = painter(Boolean(stdout.isTTY) && process.env.NO_COLOR === undefined);
  const holder = deps.holder || currentHolder();
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

  if (opts.verb === 'run') {
    // Refuse a shrunk suite before anything runs (D-0152, ordered
    // 2026-08-24). A suite in a worktree without node_modules does not
    // fail — it runs fewer files and reports fewer failures, greener than
    // the truth, and green is the one direction nobody reviews. Four of
    // twenty-seven worktrees stood like that for nine days; the session
    // that found it called its own escape luck, not a guardrail. The gate
    // already refuses this (its `dependencies` stop); this is the same
    // rule at the door everyone was told to use. The refusal must not be
    // readable as a red run: exit 2 (never a test's exit), first word
    // REFUSED, and "the suite never ran" on the first line.
    const where = deps.cwd || process.cwd();
    const tree = (deps.tree || dependencyTree)(where);
    if (tree.missing) {
      stderr.write(`mc: REFUSED — the suite never ran: ${where} declares ${tree.declares} dependencies and has no node_modules\n`);
      stderr.write('mc: a suite there shrinks silently — fewer files run, fewer failures reported, greener than the truth (D-0152)\n');
      stderr.write('mc: npm ci, or link node_modules from a sibling worktree with the same lockfile, then run again\n');
      return 2;
    }
    const outcome = claimSuiteLease({ errand: opts.errand, holder, ownerPid: process.pid });
    if (!outcome.ok) {
      // The whole point: refused means NOTHING runs, and the exit says so.
      // The same words as a refused claim, so the two forms cannot drift.
      const running = await runs();
      stderr.write(`mc: the suite right is held by ${outcome.lease.holder} — ${suiteRow(c, outcome.lease, running)}\n`);
      stderr.write('mc: NOTHING was run — one full suite at a time on this machine (D-0141)\n');
      const told = (deps.tell || tellHolder)({ lease: outcome.lease, asker: holder, what: 'the suite right', errand: opts.errand, running });
      stderr.write(told.told
        ? `mc: told ${outcome.lease.holder}${told.woke ? ' and woke it' : ` (delivered, not woken: ${told.reason || 'nobody to wake'})`}\n`
        : `mc: could not tell ${outcome.lease.holder}: ${told.reason}\n`);
      stderr.write('mc: wait, or run only what is affected; if that run is over, mc suite release --force ends it\n');
      return 1;
    }
    if (outcome.reaped) {
      stdout.write(`mc: took the suite right from ${outcome.reaped.holder} — its process (pid ${outcome.reaped.owner_pid}) was gone after ${minutes(outcome.reaped.age_ms)}; logged as a reap\n`);
    }
    // A right already held by hand stays held afterwards: that was their
    // claim, and `run` gives back only what it took (the gate's own rule).
    const ownRight = !outcome.already;
    stdout.write(`mc: ${holder.name} holds the suite right — running: ${opts.errand}\n`);
    let released = false;
    const giveBack = (why) => {
      if (released || !ownRight) return;
      released = true;
      releaseSuiteLease({ holder });
      if (why) stderr.write(`mc: ${why} — the suite right is released, not left standing\n`);
    };
    // A closed pane or a shell timeout sends SIGTERM/SIGINT and runs no
    // `finally`: the lease went with the process once (D-0167, 2h25m) and
    // again the same day under a command timeout. The child's whole process
    // group is ended, the lease goes back, and the exit is the signal's.
    let child = null;
    const onSignal = (signal) => {
      try {
        try { if (child?.pid) process.kill(-child.pid, signal); } catch { /* already gone */ }
        giveBack(`cut short by ${signal}`);
      } finally {
        process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
      }
    };
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, onSignal);
    try {
      const started = (deps.spawn || defaultSpawn)(opts.errand);
      child = started.child || null;
      const ended = await started.done;
      if (ended.signal) {
        giveBack(`the command was killed by ${ended.signal}`);
        return 128 + (ended.signal === 'SIGINT' ? 2 : 15);
      }
      if (ended.code !== 0) {
        giveBack(`the command exited ${ended.code}`);
        return ended.code ?? 1;
      }
      giveBack(null);
      if (ownRight) stdout.write('mc: done — suite right released\n');
      else stdout.write('mc: done — you claimed the right by hand, so you still hold it\n');
      return 0;
    } finally {
      for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, onSignal);
      giveBack('the run ended unexpectedly');
    }
  }

  if (opts.verb === 'claim') {
    const outcome = claimSuiteLease({ errand: opts.errand, holder });
    if (!outcome.ok) {
      const running = await runs();
      stderr.write(`mc: the suite right is held by ${outcome.lease.holder} — ${suiteRow(c, outcome.lease, running)}\n`);
      stderr.write('mc: nothing is blocked; this is mc being strict with itself — one full suite at a time on this machine (D-0141)\n');
      // The holder is told (lease-refusal.js): the one who can end the wait
      // should not have to be written to by the one waiting.
      const told = (deps.tell || tellHolder)({ lease: outcome.lease, asker: holder, what: 'the suite right', errand: opts.errand, running });
      stderr.write(told.told
        ? `mc: told ${outcome.lease.holder}${told.woke ? ' and woke it' : ` (delivered, not woken: ${told.reason || 'nobody to wake'})`}\n`
        : `mc: could not tell ${outcome.lease.holder}: ${told.reason}\n`);
      stderr.write('mc: if that run is over, mc suite release --force ends it — and says so in the log\n');
      return 1;
    }
    if (outcome.already) {
      stdout.write(`mc: you already hold the suite right — ${suiteRow(c, outcome.lease, [])}\n`);
      return 0;
    }
    if (outcome.reaped) {
      stdout.write(`mc: took the suite right from ${outcome.reaped.holder} — its process (pid ${outcome.reaped.owner_pid}) was gone after ${minutes(outcome.reaped.age_ms)}; logged as a reap\n`);
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
    : outcome.reaped
      ? `mc: cleared the suite right ${outcome.lease.holder} held — its process (pid ${outcome.lease.owner_pid}) was gone; logged as a reap\n`
      : 'mc: suite right released\n');
  return 0;
}

/**
 * The command, through a shell, in its own process group.
 *
 * Its own group so a signal to mc can end the whole tree — an `npm test`
 * killed alone leaves node workers running a suite nobody owns. Output goes
 * straight to the terminal: this is a wrapper, not a reporter.
 */
function defaultSpawn(command) {
  const child = spawn('sh', ['-c', command], { stdio: 'inherit', detached: true });
  const done = new Promise((resolve) => {
    child.on('error', () => resolve({ code: 127, signal: null }));
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, done };
}

/** One line: the lease, then what is actually running. */
export function suiteRow(c, lease, running, now = Date.now()) {
  const parts = [];
  if (lease?.held) {
    const age = Number.isFinite(lease.age_ms) ? lease.age_ms : Math.max(0, now - Date.parse(lease.since));
    parts.push(`${c(lease.holder, 'bold')}${lease.errand ? ` “${lease.errand}”` : ''} ${c(`held for ${minutes(age)}`, 'grey')}`);
    // A lease whose process is gone is said as that, not as a long hold.
    const orphan = orphanLine(lease);
    if (orphan) parts.push(c(orphan, 'yellow'));
  } else {
    parts.push(c('free', 'grey'));
  }
  if (running?.length) {
    parts.push(...running.map((run) => c(`running: ${run.command} in ${run.area || run.directory} (pid ${run.pid}, ${run.elapsed})`, 'yellow')));
  } else if (lease?.held && lease.owner_alive === true) {
    // "Nothing running" beside a living holder read as "release it" and
    // nearly cost a mid-round release (2026-08-24): this row can only name
    // suites, and a gate spends most of its round in steps that are not
    // one (extra gates, prepare). The living pid is the holder's answer.
    parts.push(c(`no suite visible, but the holder's process (pid ${lease.owner_pid}) is alive — likely an extra gate or preparation`, 'yellow'));
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
  if (!verb) return { ...opts, error: 'say which: run, claim, release or who' };
  if (!VERBS.includes(verb)) return { ...opts, error: `mc suite does not know "${verb}"` };
  if (verb === 'claim' && rest.length === 0) return { ...opts, error: 'claim needs to say what for — mc suite claim "<what for>"' };
  if (verb === 'run' && rest.length === 0) return { ...opts, error: 'run needs the command — mc suite run "<command>"' };
  if (verb !== 'claim' && verb !== 'run' && rest.length > 0) return { ...opts, error: `${verb} takes no further words` };
  return { ...opts, verb, errand: rest.join(' ') };
}
