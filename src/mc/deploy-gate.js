/**
 * What `mc deploy` asks of a commit before it asks the question (Martin,
 * 2026-11-14: tests and gates move from the merge to the deploy).
 *
 * A commit of memoro's main is put in production only when that exact commit
 * has been measured whole and the app has been used. Two measurements, both of
 * the commit that would ship and of no other:
 *
 * 1. **The whole suite.** A completed full run of exactly that commit, read
 *    from the history the daily run writes (`readNightlyHistory`). Green is
 *    said with its time and counts. None starts one — `fullRun`, the daily
 *    run's own round, so it writes the same history and queues the same
 *    main-red mends — and follows it. Red or stalled refuses, naming the red
 *    and the mend that holds it. A green run of an older commit is no run of
 *    this one: the question is about the tree that ships, never about one
 *    near it.
 * 2. **The app, used.** The suites memoro's `.mc/test.json` declares, against a
 *    local server started the way `mc test dev` starts one, built from the
 *    commit that would ship. A failed suite or one that cannot run refuses; a
 *    suite exiting with the declared skip code is named as skipped, with its
 *    reason, and does not.
 *
 * `--accept-red "<reason>"` is the only way past a red, and the reason is
 * written into the record. Nothing here deploys, asks or refuses by itself:
 * `commands/deploy.js` owns the question and the refusals, and this file only
 * measures and words what it found. Every boundary — history, the full run,
 * the mends, the servers, the suites — is on `deps`, so the whole gate runs in
 * a test with nothing real behind it.
 */
import { run as runGit } from './git.js';
import { readMainMends } from './main-repair.js';
import { fullRun, RETRY_LATER, RETRY_NOW } from './nightly-loop.js';
import { readNightlyHistory } from './nightly-history.js';
import { mcHome, workRoot } from './paths.js';
import {
  answers, ensureAppServer, ensureDevServer, NO_SHARED_WORKTREE, readDeclaration,
  runSuites, serviceFor, sharedWorktree, tierOf, tokenFor,
} from './test-environment.js';

const REPO = 'memoro';

/** A stop that is the machine's or the runner's: it measured nothing about the tree. */
const MACHINE_STOPS = [...RETRY_LATER, ...RETRY_NOW];

const short = (sha) => (sha ? String(sha).slice(0, 7) : 'unknown');
const when = (at) => String(at || '').slice(0, 16).replace('T', ' ');
const minutes = (ms) => (Number.isFinite(ms) ? `${Math.max(1, Math.round(ms / 60_000))} min` : null);

/** The last lines of what a suite said, for a refusal to name. */
export function lastLines(text, count = 8) {
  return String(text || '').trimEnd().split('\n').slice(-count).join('\n');
}

/** A run as the gate reads it, whether the history stored it or `fullRun` just returned it. */
function normalized(run) {
  const measured = Array.isArray(run?.red);
  return {
    at: run?.at || run?.started_at || null,
    duration_ms: run?.duration_ms ?? null,
    commit: run?.commit || null,
    stopped_at: run?.stopped_at || null,
    reason: run?.reason || null,
    tests: run?.tests ?? null,
    red: measured ? [...run.red] : null,
    measured,
  };
}

/**
 * What the history says of one exact commit: `{ state, run }` where state is
 * `green`, `red`, `stalled` (a run that began and never finished its suite),
 * `unmeasured` (it stopped for a reason that is not the tree's, past what a
 * start would help — never green) or `none`.
 *
 * A run that stopped because of the machine (`fetch`, `lease`, `busy` …)
 * measured nothing and is no answer: it is passed over, and the next start is
 * the answer to that. `red === null` is never green.
 */
export function fullRunVerdict(runs, sha) {
  const mine = (runs || [])
    .map(normalized)
    .filter((run) => run.commit && run.commit === sha)
    .filter((run) => run.measured || !MACHINE_STOPS.includes(run.stopped_at));
  const run = mine.at(-1);
  if (!run) return { state: 'none', run: null };
  return { state: classify(run), run };
}

/** The state of one run of the commit. */
function classify(run) {
  if (run.measured) return run.red.length ? 'red' : 'green';
  return run.stopped_at === 'stalled' ? 'stalled' : 'unmeasured';
}

/**
 * The main-red mends that hold a commit's red: the entries the full run wrote
 * for that base, with the files and commands they name. `landed` is a mend
 * whose repair is already in main, which a newer run no longer sees, and
 * `dropped` one a person gave up on; neither is counted as holding the red.
 */
export function mendsFor(commit, { root = workRoot(), read = readMainMends } = {}) {
  let entries = [];
  try { entries = read({ root, repo: REPO }); } catch { entries = []; }
  return entries.filter((entry) => entry.base === commit);
}

function mendWords(entries) {
  const holding = entries.filter((entry) => entry.state !== 'landed' && entry.state !== 'dropped');
  if (!holding.length) return null;
  const parts = holding.map((entry) => `${entry.file} (${entry.state}${entry.pr ? ` #${entry.pr}` : ''})`);
  return `main-red mend: ${parts.join(', ')}`;
}

/**
 * The full-run half of the gate for the commit that would ship.
 *
 * `dryRun` starts nothing: when no run measured the commit it says one is
 * needed. Otherwise the run is started — `fullRun` is the daily run's own round
 * and writes the same history — and followed, and its answer is read as a
 * history run is. The commit it measured is compared with the one that would
 * ship: `fullRun` fetches origin/main for itself, and a main that moved
 * meanwhile is a run of another tree.
 *
 * Returns `{ state, run, commit, mends, started, lines }` — `lines` is what the
 * reading says, and `state` one of `green`, `red`, `stalled`, `unmeasured`,
 * `moved` or `needed` (a dry run's, never recorded).
 */
export async function measureFull({
  sha, path, env = process.env, dryRun = false, say = () => {}, deps = {}, root = mcHome(env), mendRoot = workRoot(env),
}) {
  const history = deps.history || readNightlyHistory;
  const found = fullRunVerdict(history(path, { root }).runs, sha);
  let { state, run } = found;
  let started = false;

  if (state === 'none') {
    if (dryRun) {
      return {
        state: 'needed', run: null, commit: sha, mends: [], started: false,
        lines: [`mc: full run — none of ${short(sha)}: one is needed, and starts when you deploy (mc test memoro --full runs it by hand)`],
      };
    }
    say(`mc: full run — none of ${short(sha)}; starting one (mc test memoro --full, the round the daily run takes) and following it`);
    const start = () => (deps.fullRun || fullRun)({ name: REPO, path }, {
      root, env, sha, say: (line) => say(`mc:   ${line}`), narrate: (line) => say(`mc:   ${line}`),
    });
    let given = await start();
    // A run this one followed measured what its starter found, which may be a
    // main that has since moved: the tree that would ship is then still
    // unmeasured, and is measured now — the followed run is over, so nothing
    // else is measuring it.
    if (given?.joined && given.commit && given.commit !== sha) {
      say(`mc: full run — the one followed measured ${short(given.commit)}, not ${short(sha)}; starting one of ${short(sha)}`);
      given = await start();
    }
    const ran = normalized(given);
    started = true;
    run = ran;
    state = ran.commit && ran.commit !== sha ? 'moved' : classify(ran);
  }

  const commit = run?.commit || sha;
  const mends = state === 'red' || state === 'stalled'
    ? mendsFor(commit, { root: mendRoot, read: deps.readMends || readMainMends })
    : [];
  return { state, run, commit, mends, started, lines: fullRunLines({ state, run, sha, mends, started }) };
}

/**
 * A full-run reading made earlier — a finished preparation's — with the
 * main-red mends as they stand now: a mend landed or dropped since is not
 * named as holding the red. The measurement itself is not touched.
 */
export function withMendsNow(full, { env = process.env, deps = {} } = {}) {
  if (!full || (full.state !== 'red' && full.state !== 'stalled')) return full;
  const mends = mendsFor(full.commit, { root: deps.mendRoot || workRoot(env), read: deps.readMends || readMainMends });
  return { ...full, mends, lines: fullRunLines({ state: full.state, run: full.run, sha: full.commit, mends, started: full.started }) };
}

/**
 * Both measurements of the commit that would ship — the full run, then the app
 * used — and nothing said about them: `{ full, exercise }`, `exercise` null when
 * the full run already refuses the deploy and nobody accepts that (the suites
 * cost minutes and the answer is known), or when it measured nothing about this
 * tree. A dry run and an accepted red both run the suites, so that the reading
 * shows everything. `stage` is told `full-run`, then `suites`, as each begins.
 * This is what the deploy's preparation runs in its own process
 * (`deploy-prepare.js`); the judging is the asker's (`judgeGate`).
 */
export async function measureGate({
  sha, path, acceptRed = false, dryRun = false, env = process.env, say = () => {}, deps = {}, suites = {}, stage = () => {},
}) {
  stage('full-run');
  const full = await measureFull({
    sha, path, env, dryRun, say, deps, root: deps.root, mendRoot: deps.mendRoot,
  });
  const unmeasured = full.state === 'unmeasured' || full.state === 'moved';
  const redFull = full.state === 'red' || full.state === 'stalled';
  if (unmeasured || (redFull && !dryRun && !acceptRed)) return { full, exercise: null };
  stage('suites');
  say(`mc: suites — starting a local server of ${short(sha)} and running what .mc/test.json declares`);
  const exercise = await exerciseApp({ sha, env, say, deps: suites });
  return { full, exercise };
}

/** What the reading says about the full run. */
export function fullRunLines({ state, run, sha, mends = [], started = false }) {
  const where = `${short(sha)}`;
  const of = run ? `${when(run.at)}${minutes(run.duration_ms) ? `, took ${minutes(run.duration_ms)}` : ''}` : '';
  const tests = run?.tests != null ? `${run.tests} tests, ` : '';
  const mend = mendWords(mends);
  switch (state) {
    case 'green':
      return [`mc: full run — ${where} measured whole${started ? ' just now' : ''}: green, ${tests}${of}`];
    case 'red': {
      const files = mends.map((entry) => entry.file);
      const names = run.red.slice(0, 5).join(', ') + (run.red.length > 5 ? `, … and ${run.red.length - 5} more` : '');
      return [
        `mc: full run — ${where} measured whole: RED, ${run.red.length} red, ${of}`,
        ...(files.length ? [`mc:   red files and commands: ${files.join(', ')}`] : []),
        `mc:   red tests: ${names}`,
        `mc:   ${mend || 'no main-red mend holds it — none names a file for this run; the daily run queues one when it next measures this commit'}`,
      ];
    }
    case 'stalled':
      return [
        `mc: full run — ${where} STALLED: ${run.reason || 'a test never ended'}, ${of}`,
        ...(mends.length ? [`mc:   red files and commands: ${mends.map((entry) => entry.file).join(', ')}`] : []),
        `mc:   ${mend || 'no main-red mend holds it — none names a file for this run'}`,
      ];
    case 'unmeasured':
      return [
        `mc: full run — ${where} stopped at ${run.stopped_at || 'an unknown step'} and measured nothing${run.reason ? `: ${run.reason}` : ''}`,
        // A deploy starts a run only when there is none of the commit, so this run is what every later
        // deploy of it reads: the way out is a new run, which writes the history read here.
        `mc:   nothing to accept — mc test memoro --full measures ${where} again and writes the history this reads; then deploy`,
      ];
    case 'moved':
      return [`mc: full run — measured ${short(run.commit)}, not ${where}: main moved while it ran`];
    default:
      return [`mc: full run — ${where}: ${state}`];
  }
}

// ---------------------------------------------------------------------------
// The app, used
// ---------------------------------------------------------------------------

/**
 * The commit a server serves: the one it says it was built from, or else the
 * checkout's HEAD (a service that says nothing is trusted to serve the tree it
 * stands in, as `builtFromMoved` trusts it).
 */
function servedCommit(server, worktree, head) {
  return String(server?.built_from?.commit || '').trim() || head(worktree);
}

const sameCommit = (a, b) => Boolean(a && b) && (String(a).startsWith(String(b)) || String(b).startsWith(String(a)));

function headOf(worktree) {
  const asked = runGit(worktree, ['rev-parse', 'HEAD']);
  return asked.status === 0 ? String(asked.stdout || '').trim() : null;
}

/** What `git status --porcelain` lists in the checkout: `[]` when clean, null when git could not say. */
function dirtyOf(worktree) {
  const asked = runGit(worktree, ['status', '--porcelain']);
  if (asked.status !== 0) return null;
  return String(asked.stdout || '').split('\n').map((line) => line.trimEnd()).filter(Boolean);
}

/** A few of the dirty paths, for a refusal to name. */
function pathsWords(paths) {
  const shown = paths.slice(0, 5).map((line) => String(line).trim()).join(', ');
  return paths.length > 5 ? `${shown}, … and ${paths.length - 5} more` : shown;
}

/**
 * Run the declared suites against a local server of the commit that would ship.
 *
 * The server is `mc test dev`'s: the shared checkout's own, started through the
 * same door (`ensureDevServer`, which follows main when it can), the static tier
 * first. A server that is not built from `sha` — the checkout is off main, or
 * the server is held as it is — measures another tree and so measures nothing:
 * every suite is then `cannot-run`, named with why. So does a checkout at `sha`
 * that is not clean: its server serves the uncommitted changes, which are not
 * the commit that would ship either. Read twice — the checkout's own
 * `git status --porcelain` before any server is asked for, and the server's
 * `built_from.dirty` (what was dirty when it started). The checkout's
 * `unfollowed` answer (why it was not fast-forwarded) names the cause of a
 * server at another commit.
 *
 * Returns `{ suites, commit, error }`: one `{ name, state, seconds, tail }` per
 * declared suite, `state` one of `ok`, `red`, `skipped` (the declared skip code;
 * `tail` carries its reason) or `cannot-run`.
 */
export async function exerciseApp({ sha, env = process.env, say = () => {}, deps = {} }) {
  const d = {
    sharedWorktree, readDeclaration, ensureAppServer, ensureDevServer, runSuites, tokenFor, head: headOf, dirty: dirtyOf, ...deps,
  };
  const worktree = d.sharedWorktree(env);
  if (!worktree) return cannot(NO_SHARED_WORKTREE);
  const dirtyNow = d.dirty(worktree);
  if (dirtyNow === null) return cannot(`git status failed in ${worktree} — whether it is clean at ${short(sha)} is unknown`);
  if (dirtyNow.length) return cannot(`${worktree} has uncommitted changes (${pathsWords(dirtyNow)}) — a server of it serves them, not ${short(sha)} that would ship; it must be clean and on main`);
  const read = d.readDeclaration(worktree);
  if (!read.ok) return cannot(read.error);
  const { declaration } = read;

  const staticService = serviceFor(declaration, 'static');
  const wantsApp = declaration.suites.some((suite) => tierOf(suite) === 'app' || !staticService);
  const wantsStatic = Boolean(staticService) && declaration.suites.some((suite) => tierOf(suite) === 'static');
  const refuseTree = (what, server, unfollowed = null) => {
    const served = servedCommit(server, worktree, d.head);
    if (!sameCommit(served, sha)) {
      return cannot(`the ${what} server serves ${short(served)}, not ${short(sha)} that would ship — ${worktree} is not at origin/main (${unfollowed || 'off main, or its server was held as it is'}); it must be clean and on main`, served);
    }
    const dirtyAtStart = Array.isArray(server?.built_from?.dirty) ? server.built_from.dirty.filter(Boolean) : [];
    if (dirtyAtStart.length) {
      return cannot(`the ${what} server was started on uncommitted changes in ${worktree} (${pathsWords(dirtyAtStart)}) — it serves them, not ${short(sha)} that would ship; it must be clean and on main`, served);
    }
    return null;
  };

  let server = null;
  let staticServer = null;
  let staticBaseUrl = null;
  let baseUrl = null;
  if (wantsStatic) {
    const ensured = await d.ensureDevServer(worktree, declaration, { holderVerb: 'deploy', ...deps, service: staticService });
    if (!ensured.ok) return cannot(ensured.error);
    staticServer = ensured.server;
    staticBaseUrl = String(staticServer.url).replace(/\/+$/u, '');
    const wrong = refuseTree('static', staticServer, ensured.unfollowed || null);
    if (wrong) return wrong;
    say(`mc: static tier — ${staticBaseUrl} (${staticServer.instance_id})`);
  }
  if (wantsApp) {
    const app = await d.ensureAppServer(worktree, declaration, {
      json: false, stdout: { write: (text) => say(String(text).replace(/\n$/u, '')) }, answer: { write: () => {} }, deps: { holderVerb: 'deploy', ...deps },
    });
    if (!app.ok) return cannot(app.error);
    server = app.server;
    baseUrl = app.baseUrl;
    const wrong = refuseTree('app', server);
    if (wrong) return wrong;
  }
  const commit = servedCommit(server || staticServer, worktree, d.head);

  const held = await d.tokenFor(declaration, env);
  const suiteEnvironment = held.token ? { ...env, [held.name]: held.token } : env;
  const probeFor = (suite) => (tierOf(suite) === 'static' && staticServer ? staticServer : server || { health_url: `${baseUrl}/api/version` });
  const revive = async (tier) => {
    if (tier === 'static' && staticServer) {
      const ensured = await d.ensureDevServer(worktree, declaration, { holderVerb: 'deploy', ...deps, service: staticService });
      if (!ensured.ok) return ensured;
      staticServer = ensured.server;
      staticBaseUrl = String(staticServer.url).replace(/\/+$/u, '');
      return { ok: true, baseUrl: staticBaseUrl };
    }
    const app = await d.ensureAppServer(worktree, declaration, { json: true, stdout: { write: () => {} }, answer: { write: () => {} }, deps: { holderVerb: 'deploy', ...deps } });
    if (!app.ok) return app;
    server = app.server;
    baseUrl = app.baseUrl;
    return { ok: true, baseUrl };
  };
  const { results, gone, skipped: neverRan } = await d.runSuites({
    declaration, worktree, baseUrl, staticBaseUrl, only: null, env: suiteEnvironment,
    stillThere: (suite) => (deps.answers || answers)(probeFor(suite)),
    revive,
    onStart: null,
    onEnd: (result) => say(`mc:   ${result.skipped ? 'skip' : result.ok ? 'ok  ' : 'RED '} ${result.name} ${result.seconds}s`),
  });

  const suites = results.map((result) => ({
    name: result.name,
    state: result.unmeasured ? 'cannot-run' : result.skipped ? 'skipped' : result.ok ? 'ok' : 'red',
    seconds: result.seconds,
    status: result.status,
    tail: result.unmeasured
      ? 'the server left while it was running — it measured nothing'
      : lastLines(result.tail),
  }));
  for (const name of neverRan || []) {
    suites.push({ name, state: 'cannot-run', seconds: 0, status: null, tail: `never ran — ${gone?.length ? 'the server left before it' : 'it was not started'}` });
  }
  return { suites, commit, error: null, base_url: baseUrl, static_base_url: staticBaseUrl };
}

/** An exercise that could not begin: every suite is unmeasured, named with one reason. */
function cannot(error, commit = null) {
  return { suites: [], commit, error };
}

/** What the reading says about the suites. */
export function suiteLines(exercise, { sha }) {
  if (exercise.error) return [`mc: suites — cannot run: ${exercise.error}`];
  const lines = [`mc: suites — ${exercise.suites.length} declared, run against a local server of ${short(exercise.commit || sha)}:`];
  for (const suite of exercise.suites) {
    const mark = { ok: 'ok', red: 'RED', skipped: 'skipped', 'cannot-run': 'CANNOT RUN' }[suite.state];
    lines.push(`mc:   ${mark}  ${suite.name}${suite.seconds ? ` ${suite.seconds}s` : ''}${suite.state === 'skipped' && suite.tail ? ` — ${lastLines(suite.tail, 2).replace(/\n/gu, ' ')}` : ''}`);
  }
  return lines;
}

/** The suites that stop a deploy: failed, or unable to run. A skip is neither. */
export function failedSuites(exercise) {
  return exercise.suites.filter((suite) => suite.state === 'red' || suite.state === 'cannot-run');
}

// ---------------------------------------------------------------------------
// Together
// ---------------------------------------------------------------------------

/**
 * Every red in one list, as a reading and a refusal name them: the full run's
 * (red or stalled) and each failed or unrunnable suite, with its last lines.
 */
export function reds({ full, exercise }) {
  const found = [];
  if (full && (full.state === 'red' || full.state === 'stalled')) found.push(`the full run of ${short(full.commit)} is ${full.state === 'red' ? `red (${full.run.red.length})` : 'stalled'}`);
  if (exercise?.error) found.push(`the suites could not run: ${exercise.error}`);
  for (const suite of exercise?.suites || []) {
    if (suite.state === 'red') found.push(`suite ${suite.name} failed (exit ${suite.status ?? 'unknown'}):\n${suite.tail}`);
    if (suite.state === 'cannot-run') found.push(`suite ${suite.name} could not run:\n${suite.tail}`);
  }
  return found;
}

/**
 * The cells the record keeps (`deploys.js`, `GATE_COLUMNS`): the commit of the
 * full run and its verdict, each suite's result, and the reason a red was
 * accepted. An exercise that never began, or a full run never asked, leaves the
 * cell empty — which says it was not measured, not that it passed.
 */
export function gateRecord({ full = null, exercise = null, accepted = '' }) {
  return {
    full_commit: full?.run?.commit || full?.commit || '',
    full_verdict: full && full.state !== 'needed' ? full.state : '',
    suites: exercise?.error ? `cannot-run:${exercise.error}` : (exercise?.suites || []).map((suite) => `${suite.name}:${suite.state}`).join(','),
    accepted_red: accepted || '',
  };
}
