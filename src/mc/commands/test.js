/**
 * `mc test <repo> <pr>` — measure a pull request against the branch it is
 * aimed at, and stop there.
 *
 * This is the gate round without the landing. It was reachable before as
 * `mc merge <repo> <pr> --check`, which is a flag on the verb for merging: a
 * name nobody looks under when the question is "is this change red?". Ruled
 * 2026-08-29 that the measurement gets its own verb and that `mc merge` runs
 * the same one — not a second implementation that could drift from it.
 *
 * One measurement, two doors. `mc test` runs `runGate` and reports; `mc merge`
 * runs `runGate` and, if it came back clean, lands the change. There is no
 * path here that merges anything, which `repo-gate.js` asserts against its own
 * source and this file inherits by having no merge code to assert about.
 *
 * What it measures depends on what the repository declares. With a `select`
 * command it is the test files the change reaches and the command gates the
 * same selection named beside them; without one it is the whole suite. One
 * tree either way, and the verdict is that tree's own red: whether main was
 * already red is not this round's question (ruled 2026-08-31).
 *
 * `mc test <repo> --full` is the other reading, and the only one here that is
 * about the code rather than about a change: the repository's whole suite on
 * the default branch as fetched. Asked for here, and — since 2026-09-03 — also
 * taken on an interval by the nightly, which runs this same round rather than a
 * copy of it, so the scheduled reading and the asked-for one cannot disagree
 * about what a repository's whole suite is.
 *
 * And since 2026-09-04 the nightly is started, stopped and asked here too:
 * `mc test nightly start | stop | status` is the scheduled form of the round
 * above, under the verb whose round it runs (`mc repo nightly` was the old
 * spelling and answers with this one).
 */
import { join } from 'node:path';

import { nightlyReading } from '../nightly-history.js';
import {
  accountAvailable, answers, callerWorktree, ensureDevServer, forgetToken, readDeclaration,
  runSuites, sharedWorktree, storeToken, tokenFor,
} from '../test-environment.js';
import { knownRepos } from '../nightly-loop.js';
import {
  DEFAULT_INTERVAL_MS as NIGHTLY_INTERVAL_MS, nightlyState, startNightly, stopNightly,
} from '../nightly.js';
import { renderNightlyLines } from '../repo-render.js';
import { scanArgs } from './flags.js';
import { gate, parseMergeArgs } from './repo.js';

/** The scheduler's three words, the watcher's three words. One grammar. */
const METER_VERBS = ['start', 'stop', 'status'];

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  // Before the line is read as a repository and a pull request: no repository
  // is called `nightly`, and none will be.
  if (argv[0] === 'nightly') return nightly(argv.slice(1), { stdout, stderr });
  // Nor is any repository called `dev` or `prod`. These are the two places a
  // running memoro can be, and the round they take is the one no tree can
  // answer: not "does this code parse" but "does this app work".
  if (argv[0] === 'dev' || argv[0] === 'prod') {
    return environment(argv[0], argv.slice(1), { stdout, stderr, deps });
  }
  // Where the production test-account token lives, so it does not have to
  // live in a shell.
  if (argv[0] === 'token') return token(argv.slice(1), { stdout, stderr, deps });
  const opts = parseMergeArgs(argv, { full: true });
  if (opts.error) {
    stderr.write(`mc: ${opts.error.replace(/mc merge <repo> <pr>[^\n]*/u, 'mc test <repo> <pr> | --full')}\n`);
    stderr.write(usage());
    return 2;
  }
  // The round never lands anything from here, whatever else was typed.
  return gate({ ...opts, check: true, verb: 'test' }, { stdout, stderr });
}

/**
 * `mc test dev` and `mc test prod` — the round a tree cannot answer.
 *
 * Everything else under this verb reads source. Whether a module graph links,
 * whether a surface reaches a terminal state, whether a route still renders at
 * 390 pixels: those need the app running, and reaching it used to mean knowing
 * twenty scripts and eight environment variables. Now it is two words.
 *
 * `dev` shares one server, started from the installation on `main`, because
 * ten lanes with ten wranglers is a machine nobody can work on. A session that
 * needs to see its *own* unmerged change says `--here` and gets a server for
 * its own worktree — the shared one serves main and cannot show it. `--here`
 * works for `prod` too, where it changes only which copy of the suites runs:
 * production has one address, but the instrument pointed at it can be the one
 * you are in the middle of changing.
 *
 * `prod` is the same suites against `meetmemoro.app`, and it exists because
 * some of these answers are only true there: a Worker's real bindings, real
 * assets, real latency. The repository declares that URL; mc does not carry it.
 *
 * Neither runs by itself. No round calls this, no page starts it, nothing
 * schedules it (Martin, 2026-09-05) — it costs minutes and a browser, and it
 * is for planning, debugging and verifying, when a person or a session asks.
 */
async function environment(where, argv, { stdout, stderr, deps = {} }) {
  const opts = parseEnvironmentArgs(where, argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write(usage());
    return 2;
  }

  // `--here` says which worktree's suites to run, and for `dev` it also says
  // which server to measure. Those are two different things and only the
  // second is about production: the suite is the instrument, and running an
  // instrument you have just changed against the live app is exactly what a
  // person verifying a change to a suite needs.
  const env = deps.env || process.env;
  const worktree = opts.here
    ? callerWorktree(deps.cwd || process.cwd())
    : sharedWorktree(env);
  if (!worktree) {
    stderr.write(opts.here
      ? 'mc: --here needs a git worktree, and this is not one\n'
      : 'mc: no memoro checkout to read a declaration from\n');
    return 1;
  }

  const read = readDeclaration(worktree);
  if (!read.ok) {
    stderr.write(`mc: ${read.error}\n`);
    return 1;
  }
  const { declaration } = read;

  if (opts.suite && !declaration.suites.some((suite) => suite.name === opts.suite)) {
    stderr.write(`mc: ${worktree} declares no suite called ${opts.suite}\n`);
    stderr.write(`mc: it has ${declaration.suites.map((suite) => suite.name).join(', ')}\n`);
    return 2;
  }

  // Where to point them.
  let baseUrl = null;
  let server = null;
  if (where === 'prod') {
    baseUrl = declaration.environments?.prod?.base_url || null;
    if (!baseUrl) {
      stderr.write(`mc: ${worktree} declares no production base_url\n`);
      return 1;
    }
  } else {
    if (!opts.json) stdout.write(`mc: a dev server for ${worktree}…\n`);
    const ensured = await ensureDevServer(worktree, declaration, deps);
    if (!ensured.ok) {
      stderr.write(`mc: ${ensured.error}\n`);
      return 1;
    }
    server = ensured.server;
    baseUrl = String(server.url).replace(/\/+$/u, '');
    if (!opts.json) {
      stdout.write(ensured.started
        ? `mc: started one — ${baseUrl} (${server.instance_id})\n`
        : `mc: ${baseUrl} was already serving it (${server.instance_id})\n`);
    }
  }

  // `--url` is the whole answer for a caller that wants to run something mc
  // does not know about. It is why this is not only a test runner.
  if (opts.url) {
    stdout.write(`${baseUrl}\n`);
    return 0;
  }

  // The token may be in this shell, or in mc's keychain, or nowhere. Only the
  // suites that declared they need one ever see it, and it is never printed.
  const held = await tokenFor(declaration, env);
  const suiteEnvironment = held.token ? { ...env, [held.name]: held.token } : env;
  const account = accountAvailable(declaration, suiteEnvironment);
  if (!opts.json) {
    if (account.available) {
      stdout.write(`mc: signing in with the test account (${held.name} from the ${held.from})\n`);
    } else {
      stdout.write(`mc: ${account.why}\n`);
    }
  }

  const { results, gone, skipped: neverRan } = await runSuites({
    declaration,
    worktree,
    baseUrl,
    only: opts.suite,
    env: suiteEnvironment,
    // A dev server can leave in the middle of a six-minute round, and the
    // suites after it then all report red on a refused connection. Production
    // is asked too: a deploy mid-round is the same shape of lie.
    stillThere: () => answers(server || { health_url: `${baseUrl}/api/version` }),
    // A suite is minutes long, so a terminal says which one is running and
    // then overwrites that line with its verdict. A pipe gets the verdict
    // only: a carriage return in a log file is a line nobody can read.
    onStart: opts.json || !stdout.isTTY ? null : (suite) => stdout.write(`  …  ${suite.name}`),
    onEnd: opts.json ? null : (result) => stdout.write(
      `${stdout.isTTY ? '\r\u001b[2K' : ''}  ${verdict(result)}  ${result.name} ${result.seconds}s\n`,
    ),
  });

  const red = results.filter((result) => !result.ok && !result.unmeasured && !result.skipped);
  const unmeasured = results.filter((result) => result.unmeasured);
  const skipped = results.filter((result) => result.skipped);
  if (opts.json) {
    stdout.write(`${JSON.stringify({
      where,
      base_url: baseUrl,
      worktree,
      instance_id: server?.instance_id || null,
      server_gone: gone,
      results,
      never_ran: neverRan,
    }, null, 2)}\n`);
    return gone || red.length ? 1 : 0;
  }

  for (const result of red) {
    stdout.write(`\n${result.name} — exit ${result.status}\n${result.tail}\n`);
  }

  // A round that lost its server reports that, and never a count of red. Six
  // suites failing on a refused connection is not a verdict about the app.
  if (gone) {
    stdout.write(`\nmc: ${baseUrl} stopped answering — this round measured nothing after that\n`);
    if (unmeasured.length) stdout.write(`mc: ${unmeasured[0].name} was running when it went and is unmeasured\n`);
    if (neverRan.length) stdout.write(`mc: never ran — ${neverRan.join(', ')}\n`);
    if (where === 'dev') {
      stdout.write(`mc: the server's own log says why, under ${join(worktree, '.wrangler', 'dev-server', 'logs')}\n`);
    }
    stdout.write(`mc: of what did run, ${red.length} red and ${results.length - red.length - unmeasured.length} green\n`);
    return 1;
  }

  const green = results.length - red.length - skipped.length;
  stdout.write(red.length
    ? `\nmc: ${red.length} of ${results.length} red against ${baseUrl}\n`
    : `\nmc: ${green} green against ${baseUrl}\n`);
  // A suite that said it did not run is not a pass, and counting it as one is
  // the quiet failure this whole verb exists to stop.
  if (skipped.length) {
    stdout.write(`mc: did not run — ${skipped.map((result) => result.name).join(', ')}`
      + `${account.available ? '' : ` (${account.why})`}\n`);
  }
  return red.length ? 1 : 0;
}

/** How one suite's result reads in a line. */
function verdict(result) {
  if (result.unmeasured) return 'GONE';
  if (result.skipped) return '·· ';
  return result.ok ? 'ok ' : 'RED';
}

export function parseEnvironmentArgs(where, argv) {
  const scanned = scanArgs(argv, { booleans: ['--json', '--here', '--url'], strictValues: ['--suite'] });
  const opts = {
    where, json: scanned.flags.json, here: scanned.flags.here, url: scanned.flags.url, suite: scanned.flags.suite,
  };
  if (scanned.error) return { ...opts, error: scanned.error };
  if (scanned.positional.length) {
    return { ...opts, error: `mc test ${where} takes no repository (${scanned.positional[0]})` };
  }
  return opts;
}

/**
 * `mc test token` — the production test account's key, kept by mc.
 *
 *   mc test token             is one held, and where it came from
 *   mc test token --set       read one from stdin and keep it
 *   mc test token --rm        forget it
 *
 * It reads from stdin rather than taking an argument, because an argument is
 * a line in a shell history file and this is a production login. Nothing here
 * ever prints the value — not on `--set`, not on `--json`, not in an error.
 *
 * Why mc holds it at all: Cloudflare will not give it back. Workers secrets
 * are write-only by design, so "read it from Cloudflare when the verb runs"
 * does not exist however sensible it sounds, and `mc vault` refuses plaintext
 * export on purpose. The platform keychain is what is left, and it is what
 * `src/lib/keychain.js` has spoken since long before this verb.
 */
async function token(argv, { stdout, stderr, deps = {} }) {
  const scanned = scanArgs(argv, { booleans: ['--set', '--rm', '--json'] });
  if (scanned.error || scanned.positional.length) {
    stderr.write(`mc: ${scanned.error || `mc test token takes no argument (${scanned.positional[0]})`}\n`);
    stderr.write('usage — mc test token [--set | --rm] [--json]\n');
    return 2;
  }

  const env = deps.env || process.env;
  const worktree = sharedWorktree(env);
  const read = worktree ? readDeclaration(worktree) : { ok: false, error: 'no memoro checkout' };
  if (!read.ok) {
    stderr.write(`mc: ${read.error}\n`);
    return 1;
  }
  const name = read.declaration.account?.token_env;
  if (!name) {
    stderr.write('mc: this repository declares no test account\n');
    return 1;
  }

  if (scanned.flags.rm) {
    await forgetToken(name);
    stdout.write(`mc: forgot ${name}\n`);
    return 0;
  }

  if (scanned.flags.set) {
    const value = await readStdin(deps.stdin || process.stdin);
    const stored = await storeToken(name, value);
    if (!stored.ok) {
      stderr.write(`mc: ${stored.error} — pipe it in: printf %s "<token>" | mc test token --set\n`);
      return 2;
    }
    stdout.write(`mc: kept ${name} in this machine's keychain\n`);
    return 0;
  }

  const held = await tokenFor(read.declaration, env);
  if (scanned.flags.json) {
    stdout.write(`${JSON.stringify({ name, held: Boolean(held.token), from: held.from }, null, 2)}\n`);
    return 0;
  }
  stdout.write(held.token
    ? `mc: ${name} is held, from the ${held.from}\n`
    : `mc: no ${name} — printf %s "<token>" | mc test token --set\n`);
  return 0;
}

/** One line, and never an argument: an argument is a shell history entry. */
function readStdin(stream) {
  return new Promise((done) => {
    let text = '';
    stream.setEncoding?.('utf8');
    stream.on('data', (chunk) => { text += chunk; });
    stream.on('end', () => done(text.trim()));
    stream.on('error', () => done(''));
  });
}

/**
 * The full run nobody asks for: start it, stop it, or ask after it.
 *
 * Explicit on purpose — no page starts a background process — and this one
 * runs whole suites, which pin the machine for minutes at a time. A process
 * that appears because somebody read a page is bad enough when it costs a
 * fetch.
 *
 * It is a meter and nothing else. Whatever it finds refuses no merge, delays
 * no round and changes no verdict (ruled by Martin, 2026-09-02), so stopping
 * it costs a reading and never a decision.
 */
async function nightly(argv, { stdout, stderr }) {
  const opts = parseNightlyArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write(usage());
    return 2;
  }

  if (opts.verb === 'start') {
    const started = startNightly({ intervalMs: opts.intervalMs });
    if (!started.ok && started.reason === 'already-running') {
      stdout.write(`mc: the nightly is already running (pid ${started.pid}, every ${every(started.interval_ms)})\n`);
      return 0;
    }
    if (!started.ok) {
      stderr.write(`mc: could not start the nightly (${started.reason})\n`);
      return 1;
    }
    stdout.write(`mc: a full run of every repository every ${every(started.interval_ms)} (pid ${started.pid})\n`);
    stdout.write(`mc: it writes ${started.log} and nothing else — it merges nothing and blocks nothing\n`);
    stdout.write('mc: a tick that finds a gate round running skips and says so; it never queues behind one\n');
    return 0;
  }

  if (opts.verb === 'stop') {
    const stopped = await stopNightly();
    if (!stopped.stopped) {
      stdout.write(stopped.abandoned
        ? 'mc: no nightly was running — cleared the pid file it left behind\n'
        : 'mc: no nightly is running\n');
      return 0;
    }
    stdout.write(`mc: stopped the nightly (pid ${stopped.pid})${stopped.forced ? ' — it had to be killed' : ''}\n`);
    return 0;
  }

  return status(opts, { stdout });
}

/**
 * Whether it is running — and what it found.
 *
 * The reading is here because it is the question the nightly exists for: red,
 * and since when. It was printed only under `mc repo status`'s *full run*
 * section, which is a page somebody has to know to go to; a person who started
 * this thing should be able to read it where they started it. The rows are
 * `repo-render.js`'s own, so the two pages cannot drift.
 *
 * Every repository the loop would measure gets a block, whether or not it has
 * ever been measured: a meter that is silent about a repository it runs on is
 * one nobody can tell from a meter that has not run.
 */
async function status(opts, { stdout }) {
  const state = nightlyState();
  const repos = (await knownRepos()).map((repo) => ({ ...repo, nightly: nightlyReading(repo.path) }));
  if (opts.json) {
    stdout.write(`${JSON.stringify({
      ...state,
      repos: Object.fromEntries(repos.map((repo) => [repo.name, repo.nightly])),
    }, null, 2)}\n`);
    return 0;
  }
  stdout.write(`${renderNightlyLines(state, {
    columns: stdout.columns || 100,
    colour: Boolean(stdout.isTTY) && process.env.NO_COLOR === undefined,
    repos,
  }).join('\n')}\n`);
  return 0;
}

export function parseNightlyArgs(argv) {
  const scanned = scanArgs(argv, { booleans: ['--json'], strictValues: ['--interval'] });
  const opts = { verb: 'status', json: scanned.flags.json, intervalMs: NIGHTLY_INTERVAL_MS };
  if (scanned.error) return { ...opts, error: scanned.error };
  const positional = [...scanned.positional];
  // Bare `mc test nightly` is the question about the nightly, the way bare
  // `mc repo watch` is the question about the watcher.
  const word = positional.shift() || 'status';
  if (!METER_VERBS.includes(word)) return { ...opts, error: `mc test nightly ${word}? — start, stop or status` };
  opts.verb = word;
  // It measures every repository mc knows; naming one would be a different
  // command, and that command is `mc test <repo> --full`.
  if (positional.length) return { ...opts, error: `mc test nightly takes no repository (${positional[0]}) — mc test ${positional[0]} --full is the one-off` };
  if (scanned.flags.interval !== null) {
    const value = Number(scanned.flags.interval);
    if (!Number.isFinite(value) || value < 1) return { ...opts, error: '--interval needs a number of seconds' };
    opts.intervalMs = Math.round(value * 1000);
  }
  return opts;
}

/**
 * The same number, said the way a day-long cadence reads.
 *
 * `--interval` is seconds here and on `mc repo watch start`, because one flag
 * with two units across sibling verbs is a trap — but "every 86400s" is not a
 * sentence anybody checks, so the nightly prints hours.
 */
function every(ms) {
  const value = Number(ms) || 0;
  if (value < 3_600_000) return `${Math.round(value / 1000)}s`;
  return `${Math.round((value / 3_600_000) * 10) / 10}h`;
}

export function usage() {
  return [
    'usage — mc test dev [--here] [--suite <name>] [--url] [--json]   the app, running locally\n',
    '        mc test prod [--here] [--suite <name>] [--json]          the app, in production\n',
    '        mc test token [--set | --rm]             the production test account, kept by mc\n',
    '        mc test <repo> <pr> [<pr>...] [--json]   measure the change; merge nothing\n',
    '        mc test <repo> --full [--json]           the repository\'s whole suite, on the default branch\n',
    '        mc test nightly start [--interval <seconds>]\n',
    '        mc test nightly stop\n',
    '        mc test nightly status [--json]          whether it runs, and what it found\n',
  ].join('');
}
