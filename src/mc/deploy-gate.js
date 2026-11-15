/**
 * What `mc deploy` asks of a commit before the deployer starts (Martin,
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
 * `commands/deploy.js` owns the refusals and the start, and this file only
 * measures and words what it found. Every boundary — history, the full run,
 * the mends, the servers, the suites — is on `deps`, so the whole gate runs in
 * a test with nothing real behind it.
 */
import { deployWorktreePath, placeWorktree, strayLines, takeHolder } from './deploy-worktree.js';
import { KEPT_HOLD_SECONDS, mainIdleSecondsOf, stopServer } from './dev-servers.js';
import { run as runGit } from './git.js';
import { readMainMends } from './main-repair.js';
import { fullRun, RETRY_LATER, RETRY_NOW } from './nightly-loop.js';
import { readNightlyHistory } from './nightly-history.js';
import { mcHome, workRoot } from './paths.js';
import {
  answers, ensureAppServer, ensureDevServer, isGate, mainHold, NO_SHARED_WORKTREE, parseDeclaration,
  readDeclaration, runSuites, serversFor, serviceFor, servingWorktree, sharedWorktree, tierOf, tokenFor,
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
 * The commit `mc deploy` ships: the newest first-parent commit of origin/main
 * after the live one whose full run is green, walking back from the tip.
 *
 * `chain` is `git rev-list --first-parent <live>..origin/main`, newest first —
 * with the live commit unknown, the tip alone. A commit that is the live one is
 * no candidate, and neither is a green one that does not descend from it
 * (`descends(sha)`, asked only of a green commit): production never goes
 * backwards. A commit that was taken back, or comes before one (`takenBack(sha)`,
 * the floor), is no candidate either and is passed over with state `taken-back`:
 * a green full run does not bring a commit back that production's check found
 * red. Every commit walked past is returned in `passed` with the verdict
 * that passed it over, so the reading can say why the tip did not ship.
 *
 * Pure: the chain, the history and the ancestry are all handed in. `pick` is
 * null when no commit of the chain is green.
 */
export function pickCommit({ chain = [], live = null, runs = [], descends = () => true, takenBack = () => false }) {
  const tip = chain[0] || null;
  const passed = [];
  for (const sha of chain) {
    if (sha === live) continue;
    if (takenBack(sha)) {
      passed.push({ sha, state: 'taken-back', run: null, descends: null });
      continue;
    }
    const verdict = fullRunVerdict(runs, sha);
    if (verdict.state === 'green' && descends(sha)) return { pick: sha, tip, passed };
    passed.push({ sha, state: verdict.state, run: verdict.run, descends: verdict.state === 'green' ? false : null });
  }
  return { pick: null, tip, passed };
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
  sha, path, acceptRed = false, dryRun = false, env = process.env, say = () => {}, deps = {}, suites = {}, stage = () => {}, own = false,
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
  const exercise = await exerciseApp({ sha, env, say, deps: suites, own });
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
      // Every name: a reading that says "and N more" hides what a person accepts or what passed the tip over.
      const names = run.red.join(', ');
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
 * How long the hold check waits, in all, for the main servers to be free before
 * the exercise gives up. Both holds end by themselves — a busy one when mc has
 * not used the server for the idle window, a kept browser's KEPT_HOLD_SECONDS
 * after its last step — so the deploy waits rather than asking anybody to close
 * anything; only a server somebody keeps using for this long refuses.
 */
export const HOLD_WAIT_MS = 10 * 60_000;
const HOLD_POLL_MS = 5_000;

function gitIn(worktree, args) {
  const asked = runGit(worktree, args);
  return { status: asked.status, stdout: String(asked.stdout || ''), stderr: String(asked.stderr || '') };
}

/**
 * Run the declared suites against a local server of exactly the commit that
 * would ship — the pick, which may be behind main's tip.
 *
 * The server is `mc test dev`'s: the shared checkout's own, through the same
 * door (`ensureDevServer`), the static tier first. What differs is the tree:
 * the checkout is *placed* at `sha` once, and every ensure of the exercise — the
 * static tier, the app tier, each revive — pins instead of following main, which
 * would move it. In this order, and nothing is moved before the last step of it:
 *
 * 1. the checkout must be clean (read twice: its own `git status --porcelain`,
 *    and each server's `built_from.dirty`);
 * 2. the declaration of the commit, `git show <sha>:.mc/test.json`, names the
 *    app service;
 * 3. that service's main server is not held: a hold of either kind — busy (mc
 *    used it within the idle window) or a kept browser's — is waited out and
 *    asked again, within one bound for the whole check (`HOLD_WAIT_MS`); a hold
 *    that outlasts it refuses and names the hold;
 * 4. the checkout is on main or on no branch and its HEAD an ancestor of
 *    origin/main, then `git checkout --detach <sha>`. Otherwise every suite is
 *    cannot-run with the reason and nothing is moved;
 * 5. the declaration is read from that tree, and only the suites that gate
 *    (`gate: false` takes one out, with its reason, named once) are run.
 *
 * The served commit is compared with `sha` after every ensure, each revive
 * included: a server at another commit measures another tree, so the suites that
 * would run against it are `cannot-run`, as is a checkout whose server was
 * started on uncommitted changes.
 *
 * That is the shared-checkout route. With `own` — main held in mc's own deploy
 * worktree, or nowhere — the suites run in that worktree instead (`exerciseOwn`):
 * its holder taken, the tree placed at `sha` by `placeWorktree`, the servers
 * ensured unpinned in it, and the shared checkout not touched at all.
 *
 * Returns `{ suites, commit, error, not_gate }`: one `{ name, state, seconds,
 * tail }` per suite that gates, `state` one of `ok`, `red`, `skipped` (the
 * declared skip code; `tail` carries its reason) or `cannot-run`; `not_gate`
 * the `{ name, why }` of those that do not.
 */
export async function exerciseApp({ sha, env = process.env, say = () => {}, deps = {}, own = false }) {
  const d = {
    sharedWorktree, readDeclaration, ensureAppServer, ensureDevServer, runSuites, tokenFor, head: headOf, dirty: dirtyOf,
    gitIn, servingWorktree, mainHold, now: () => Date.now(), sleep: (ms) => new Promise((done) => { setTimeout(done, ms); }),
    takeHolder, placeWorktree, serversFor, stopServer, deployWorktree: deployWorktreePath,
    ...deps,
  };
  if (own) return exerciseOwn({ sha, env, say, deps, d });
  const worktree = d.sharedWorktree(env);
  if (!worktree) return cannot(NO_SHARED_WORKTREE);
  const dirtyNow = d.dirty(worktree);
  if (dirtyNow === null) return cannot(`git status failed in ${worktree} — whether it is clean at ${short(sha)} is unknown`);
  if (dirtyNow.length) return cannot(`${worktree} has uncommitted changes (${pathsWords(dirtyNow)}) — a server of it serves them, not ${short(sha)} that would ship; it must be clean and on main`);

  // The commit's own declaration names the app service, which is the main server whose hold is read.
  const shown = d.gitIn(worktree, ['show', `${sha}:.mc/test.json`]);
  if (shown.status !== 0) return cannot(`${short(sha)} does not declare .mc/test.json (${lastLines(shown.stderr, 1) || 'git show failed'}) — nothing there says what may be measured`);
  const declared = parseDeclaration(shown.stdout, `${short(sha)}:.mc/test.json`);
  if (!declared.ok) return cannot(declared.error);

  const before = d.head(worktree);
  if (!sameCommit(before, sha)) {
    const held = await awaitHold({ d, worktree, services: [serviceFor(declared.declaration, 'app'), serviceFor(declared.declaration, 'static')], env, say });
    if (held) return cannot(held);
    const placed = placeCheckout({ d, worktree, sha });
    if (placed) return cannot(placed);
    say(`mc: suites — the shared checkout ${worktree} stands at ${short(sha)} now (it was at ${short(before)}), detached`);
  }

  // Every ensure pins: the checkout is where it was placed, and following main would move it.
  return runDeclared({ d, deps, worktree, sha, env, say, pinned: true });
}

/**
 * The exercise where main is held nowhere (D1–D5 of deploy-serves-its-own-checkout): in mc's own
 * deploy worktree, at the pick, and never in the shared checkout — nothing of it is read, moved,
 * waited for or served. In this order:
 *
 * 1. the worktree's holder is taken (`takeHolder`): waited for while another process has the
 *    tree, up to its bound, and then every suite is cannot-run naming the holder;
 * 2. the tree is placed at `sha` (`placeWorktree`, the function `ship` places with), and a tree it
 *    cannot place — modified tracked files, commits origin/main lacks, off its line, a failed
 *    reading — is every suite cannot-run naming what stood;
 * 3. the servers the exercise starts take dev-pool slots, in turn, within the pool's wait — a slot
 *    not had is cannot-run with the pool's reason — and each is checked against `sha`;
 * 4. whatever happened, the servers the exercise started are stopped and the holder is released;
 *    a server that was already there is left.
 */
async function exerciseOwn({ sha, env, say, deps, d }) {
  const worktree = d.deployWorktree(env);
  const taken = await d.takeHolder({
    env, verb: 'deploy suites', say, now: d.now, sleep: d.sleep, alive: d.alive, lock: d.holderLock, root: d.holderRoot,
  });
  if (!taken.ok) return cannot(taken.reason);
  let already = null;
  try {
    const git = d.git || ((cwd, args) => {
      const asked = d.gitIn(cwd, args);
      return asked.status === 0 ? String(asked.stdout || '').trim() : null;
    });
    const placed = d.placeWorktree({ worktree, sha, git });
    if (!placed.ok) return cannot(`mc's own deploy worktree ${worktree} cannot be placed at ${short(sha)}, so no suite ran — ${placed.reason}`);
    if (placed.moved) say(`mc: suites — the deploy worktree ${worktree} stands at ${short(sha)} now (${placed.how === 'reset' ? 'moved back from' : 'fast-forwarded from'} ${short(placed.from)})`);
    for (const line of strayLines(placed.strays)) say(line);
    already = new Set(d.serversFor(worktree, { root: d.root }).map((server) => server.instance_id));
    return await runDeclared({ d, deps, worktree, sha, env, say, pinned: false });
  } finally {
    // Its own servers only: one that was there before the exercise is somebody's, and left.
    if (already) {
      for (const server of d.serversFor(worktree, { root: d.root })) {
        if (already.has(server.instance_id)) continue;
        const stopped = d.stopServer(server);
        if (!stopped?.ok) say(`mc: suites — could not stop ${server.instance_id}, which the exercise started: ${stopped?.error || 'no reason given'}`);
      }
    }
    taken.release();
  }
}

/**
 * The declaration read from the tree at the pick, the servers its suites need and the suites
 * themselves — the same on both routes. `pinned` is the shared checkout's: it is placed once and no
 * ensure may follow main, which would move it.
 */
async function runDeclared({ d, deps, worktree, sha, env, say, pinned }) {
  const read = d.readDeclaration(worktree);
  if (!read.ok) return cannot(read.error);
  const { declaration } = read;
  const gating = declaration.suites.filter(isGate);
  const notGate = declaration.suites.filter((suite) => !isGate(suite)).map((suite) => ({ name: suite.name, why: String(suite.gate_why || '') }));
  const gated = { ...declaration, suites: gating };

  const staticService = serviceFor(declaration, 'static');
  const wantsApp = gating.some((suite) => tierOf(suite) === 'app' || !staticService);
  const wantsStatic = Boolean(staticService) && gating.some((suite) => tierOf(suite) === 'static');
  const refuseTree = (what, server) => {
    const served = servedCommit(server, worktree, d.head);
    if (!sameCommit(served, sha)) {
      return cannot(`the ${what} server serves ${short(served)}, not ${short(sha)} that would ship — ${worktree} was placed at ${short(sha)}, but this server was built from another tree and held as it is`, served, notGate);
    }
    const dirtyAtStart = Array.isArray(server?.built_from?.dirty) ? server.built_from.dirty.filter(Boolean) : [];
    if (dirtyAtStart.length) {
      return cannot(`the ${what} server was started on uncommitted changes in ${worktree} (${pathsWords(dirtyAtStart)}) — it serves them, not ${short(sha)} that would ship; it must be clean and on main`, served, notGate);
    }
    return null;
  };
  const pin = pinned ? { pin: true } : {};
  const staticEnsure = () => d.ensureDevServer(worktree, declaration, { holderVerb: 'deploy', ...deps, service: staticService, ...pin });
  const appEnsure = (json) => d.ensureAppServer(worktree, declaration, {
    json,
    stdout: { write: (text) => { if (!json) say(String(text).replace(/\n$/u, '')); } },
    answer: { write: () => {} },
    deps: { holderVerb: 'deploy', ...deps, ...pin },
  });

  let server = null;
  let staticServer = null;
  let staticBaseUrl = null;
  let baseUrl = null;
  if (wantsStatic) {
    const ensured = await staticEnsure();
    if (!ensured.ok) return cannot(ensured.error, null, notGate);
    staticServer = ensured.server;
    staticBaseUrl = String(staticServer.url).replace(/\/+$/u, '');
    const wrong = refuseTree('static', staticServer);
    if (wrong) return wrong;
    say(`mc: static tier — ${staticBaseUrl} (${staticServer.instance_id})`);
  }
  if (wantsApp) {
    const app = await appEnsure(false);
    if (!app.ok) return cannot(app.error, null, notGate);
    server = app.server;
    baseUrl = app.baseUrl;
    const wrong = refuseTree('app', server);
    if (wrong) return wrong;
  }
  const commit = servedCommit(server || staticServer, worktree, d.head);

  const held = await d.tokenFor(declaration, env);
  const suiteEnvironment = held.token ? { ...env, [held.name]: held.token } : env;
  const probeFor = (suite) => (tierOf(suite) === 'static' && staticServer ? staticServer : server || { health_url: `${baseUrl}/api/version` });
  // A server brought back is checked like the first one: a revive that lands on another tree is no revive.
  const revive = async (tier) => {
    if (tier === 'static' && staticServer) {
      const ensured = await staticEnsure();
      if (!ensured.ok) return ensured;
      const wrong = refuseTree('static', ensured.server);
      if (wrong) return { ok: false, error: wrong.error };
      staticServer = ensured.server;
      staticBaseUrl = String(staticServer.url).replace(/\/+$/u, '');
      return { ok: true, baseUrl: staticBaseUrl };
    }
    const app = await appEnsure(true);
    if (!app.ok) return app;
    const wrong = refuseTree('app', app.server);
    if (wrong) return { ok: false, error: wrong.error };
    server = app.server;
    baseUrl = app.baseUrl;
    return { ok: true, baseUrl };
  };
  const { results, gone, skipped: neverRan } = await d.runSuites({
    declaration: gated, worktree, baseUrl, staticBaseUrl, only: null, env: suiteEnvironment,
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
  return { suites, commit, error: null, base_url: baseUrl, static_base_url: staticBaseUrl, not_gate: notGate };
}

/**
 * Wait out a held main server — busy or a kept browser's, both end by
 * themselves — with the checkout untouched: `null` when none of the declared
 * services' main servers is held (or running), else, once the one bound of the
 * whole check has passed, why the exercise cannot go on. Each new hold waited
 * for is said once; nobody is asked to do anything.
 */
async function awaitHold({ d, worktree, services, env, say }) {
  const idleMs = mainIdleSecondsOf(env) * 1000;
  const until = d.now() + HOLD_WAIT_MS;
  const why = (hold) => (hold === 'kept'
    ? `a kept browser stepped on it within the last ${KEPT_HOLD_SECONDS} s`
    : `mc used it within the last ${Math.round(idleMs / 1000)} s`);
  let saidFor = null;
  for (;;) {
    let held = null;
    for (const service of services.filter(Boolean)) {
      const running = d.servingWorktree(worktree, { root: d.root, service });
      const hold = running ? d.mainHold(running, { now: d.now(), idleMs, dir: d.sessionsDir }) : null;
      if (hold) { held = { running, hold }; break; }
    }
    if (!held) return null;
    if (d.now() >= until) {
      return `the main server ${held.running.instance_id} is still held (${why(held.hold)}) after ${Math.round(HOLD_WAIT_MS / 60_000)} min of waiting — the checkout is not moved under it`;
    }
    const key = `${held.running.instance_id}:${held.hold}`;
    if (key !== saidFor) {
      say(`mc: suites — the main server ${held.running.instance_id} is held (${why(held.hold)}); waiting up to ${Math.round(HOLD_WAIT_MS / 60_000)} min for the hold to end before the checkout is moved`);
      saidFor = key;
    }
    await d.sleep(Math.min(HOLD_POLL_MS, Math.max(1, until - d.now())));
  }
}

/**
 * Put the shared checkout at `sha`, detached — or say why it is not: on another
 * branch, or at a commit origin/main does not contain (local work), nothing is
 * moved. The ancestor check is the point: a detached HEAD is moved only along
 * origin/main's own line, never off a commit somebody made.
 */
function placeCheckout({ d, worktree, sha }) {
  const branch = d.gitIn(worktree, ['branch', '--show-current']);
  if (branch.status !== 0) return `git could not say which branch ${worktree} is on — it is not moved`;
  const on = branch.stdout.trim();
  if (on && on !== 'main') return `${worktree} is on ${on}, not main or a detached commit of it — it is not moved; it must be clean and on main`;
  const contained = d.gitIn(worktree, ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']);
  if (contained.status !== 0) return `${worktree} stands on ${short(d.head(worktree))}, which origin/main does not contain — it is not moved; it must be clean and on main`;
  const moved = d.gitIn(worktree, ['checkout', '--detach', sha]);
  if (moved.status !== 0) return `git checkout --detach ${short(sha)} failed in ${worktree}: ${lastLines(moved.stderr, 2) || 'no message'}`;
  return null;
}

/** An exercise that could not begin: every suite is unmeasured, named with one reason. */
function cannot(error, commit = null, notGate = []) {
  return { suites: [], commit, error, not_gate: notGate };
}

/**
 * What the reading says about the suites: each that gates, then — once, with
 * the reason its declaration gives — each that does not. A suite with
 * `gate: false` is not run by `mc deploy` and is never a refusal.
 */
export function suiteLines(exercise, { sha }) {
  const notGate = exercise.not_gate || [];
  const lines = [];
  if (exercise.error) lines.push(`mc: suites — cannot run: ${exercise.error}`);
  else {
    lines.push(`mc: suites — ${exercise.suites.length} declared, run against a local server of ${short(exercise.commit || sha)}:`);
    for (const suite of exercise.suites) {
      const mark = { ok: 'ok', red: 'RED', skipped: 'skipped', 'cannot-run': 'CANNOT RUN' }[suite.state];
      lines.push(`mc:   ${mark}  ${suite.name}${suite.seconds ? ` ${suite.seconds}s` : ''}${suite.state === 'skipped' && suite.tail ? ` — ${lastLines(suite.tail, 2).replace(/\n/gu, ' ')}` : ''}`);
    }
  }
  if (notGate.length) {
    lines.push(`mc: suites — ${notGate.length} more declared, not run: they do not gate a deploy (gate: false):`);
    for (const suite of notGate) lines.push(`mc:   not a gate  ${suite.name} — ${suite.why}`);
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
