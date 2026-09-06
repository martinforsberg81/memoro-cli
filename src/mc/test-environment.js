/**
 * A running memoro to measure, and the suites that measure it.
 *
 * `mc test <repo> <pr>` reads a tree. Everything under it — the gate, the
 * nightly, the whole selection apparatus — answers questions about source
 * code, and there are questions source code cannot answer. Whether a module
 * graph links, whether a surface settles, whether a route still renders at 390
 * pixels: those need a server, and until now reaching one meant knowing
 * twenty scripts and eight environment variables, so in practice nobody asked
 * them outside their own laptop and nobody asked them of production at all.
 *
 * This module is the two halves of making that one command. **Which server** —
 * ensured for `dev`, declared for `prod` — and **which suites**, read from the
 * repository rather than remembered here. mc holds no list of memoro's script
 * names: `.mc/test.json` is memoro's to write and this is only its reader. The
 * same division `docs/dev-server-protocol.md` already draws for dev servers,
 * for the same reason — a list in the wrong repository is a list that goes
 * stale in silence.
 *
 * Nothing here runs by itself. Not at session launch, not in a round, not on a
 * timer: no runner step calls it and no page starts it. It costs minutes and a
 * browser, and it exists for the moments a person or a session is planning,
 * debugging or verifying and needs to see the running thing (Martin,
 * 2026-09-05). That is also why `dev` shares one server by default rather than
 * standing one up per worktree — ten lanes with ten wranglers is a machine
 * nobody can work on.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { getSecret, setSecret, deleteSecret } from '../lib/keychain.js';
import { defaultRepos } from './brief-collect.js';
import { listServers } from './dev-servers.js';

/** Where a repository says what it may be measured with. */
export const DECLARATION_FILE = join('.mc', 'test.json');

/** Where it says how its dev server starts. */
export const DEV_DEFINITION_FILE = join('.mc', 'dev.json');

/**
 * Two windows, because a start has two stages and only one of them is a guess.
 *
 * Until the wrapper registers, mc knows nothing: the process may be building,
 * or it may have died on a bad `.dev.vars`. That window is short.
 *
 * Once it has registered, mc has been told the wrapper is alive and where it
 * intends to serve, and the only thing left is waiting. That window is long,
 * and it has to be: measured on 2026-09-05, a cold start in a worktree with
 * two other dev servers already running took **181 seconds** from spawn to
 * `Ready on http://127.0.0.1:8900` — CSS build, 283 migrations, then wrangler.
 * A 120-second ceiling reported that as a failure while the wrapper was
 * working perfectly, and the server answered a minute later.
 *
 * The long wait is not blind. Each turn checks the registered pid is still
 * alive, so a wrapper that dies fails in a second rather than in ten minutes.
 */
export const REGISTER_TIMEOUT_MS = 120_000;
export const READY_TIMEOUT_MS = 600_000;

/**
 * Read what the repository offers.
 *
 * Refused rather than repaired, and refused with the field: a declaration mc
 * half-understands is worse than none, because the half it dropped is the
 * suite nobody notices is missing. The shape is small on purpose — every
 * command is argv, so no line of this file is ever handed to a shell.
 */
export function readDeclaration(worktree) {
  const path = join(worktree, DECLARATION_FILE);
  if (!existsSync(path)) {
    return { ok: false, error: `${worktree} does not declare ${DECLARATION_FILE} — nothing here says what may be measured` };
  }
  let declaration = null;
  try {
    declaration = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { ok: false, error: `${path}: ${error.message}` };
  }
  if (declaration?.schema_version !== 1) {
    return { ok: false, error: `${path}: schema_version 1, not ${JSON.stringify(declaration?.schema_version)}` };
  }
  const suites = Array.isArray(declaration.suites) ? declaration.suites : [];
  if (!suites.length) return { ok: false, error: `${path}: no suites` };
  for (const suite of suites) {
    if (!suite?.name || !Array.isArray(suite.argv) || !suite.argv.length) {
      return { ok: false, error: `${path}: every suite needs a name and an argv` };
    }
    if (suite.argv.some((part) => typeof part !== 'string' || !part.trim())) {
      return { ok: false, error: `${path}: ${suite.name}'s argv is a list of arguments, never a shell string` };
    }
  }
  // What the repository says does not work against a local server — a
  // weather key nobody has on a laptop, media served from production and
  // blocked by the local origin's policy. Not a list of reds to explain
  // away: `mc test dev` is not production and is not asked to be (Martin,
  // 2026-09-06). It is told, once, at the top of a dev round.
  const gaps = declaration.environments?.dev?.not_in_dev;
  if (gaps !== undefined) {
    if (!Array.isArray(gaps) || gaps.some((gap) => !gap?.name || !gap?.why
      || typeof gap.name !== 'string' || typeof gap.why !== 'string')) {
      return { ok: false, error: `${path}: environments.dev.not_in_dev is a list of { name, why }` };
    }
  }
  return { ok: true, declaration };
}

/** The dev gaps a declaration names, as lines a person reads once. */
export function notInDev(declaration) {
  return (declaration?.environments?.dev?.not_in_dev || []).map((gap) => `${gap.name} — ${gap.why}`);
}

/** The worktree `mc test dev` shares by default: the installation, on main. */
export function sharedWorktree(env = process.env) {
  return defaultRepos(env).find((repo) => repo.name === 'memoro')?.path || null;
}

/**
 * The worktree the caller is standing in, or null.
 *
 * `--here` is for the session that wants to see its own unmerged change in the
 * app, which the shared server cannot show it — the shared server serves main.
 * A worktree is what git says it is, not what the path looks like.
 */
export function callerWorktree(cwd = process.cwd(), deps = {}) {
  const git = deps.git || ((args) => spawnSync('git', args, { cwd, encoding: 'utf8' }));
  const asked = git(['rev-parse', '--show-toplevel']);
  if (asked.status !== 0) return null;
  const path = String(asked.stdout || '').trim();
  return path ? resolve(path) : null;
}

/**
 * A live server already serving this worktree, or null.
 *
 * Since the static tier, a worktree can have two: the Worker and the file
 * server the harness suites measure against. They register through the same
 * protocol and differ in `service`, so a caller that means one of them says
 * which. A caller that says nothing gets whichever is live — the reading
 * `mc test dev --stop` and the page had before, kept for them.
 */
export function servingWorktree(worktree, { root, service = null } = {}) {
  const { servers } = listServers(root ? { root } : {});
  return servers.find((server) => server.live
    && resolve(server.worktree_path) === resolve(worktree)
    && (!service || server.service === service)) || null;
}

/** Every live server for this worktree, whatever it serves. */
export function serversFor(worktree, { root } = {}) {
  const { servers } = listServers(root ? { root } : {});
  return servers.filter((server) => server.live && resolve(server.worktree_path) === resolve(worktree));
}

/**
 * Which tier a suite is measured against.
 *
 * `server: "static"` is the repository saying this suite never talks to the
 * app — it stubs its own document and imports the module graph — and may be
 * served files by something that is not the Worker. Anything else is the app.
 * Read here and nowhere else, so that "what does static mean" has one answer.
 */
export function tierOf(suite) {
  return suite?.server === 'static' ? 'static' : 'app';
}

/** The service the declaration names for a tier, or null when it names none. */
export function serviceFor(declaration, tier) {
  const dev = declaration?.environments?.dev || {};
  if (tier === 'static') return dev.static_service || null;
  return dev.service || null;
}

/**
 * The argv a worktree's dev definition says starts its server.
 *
 * Read from `.mc/dev.json`, which is argv-only by design so that mc never
 * evaluates a shell command while planning one. The profile is the
 * declaration's, and `agent` in practice — the light one, without containers,
 * because this is a measurement and not the whole product.
 */
export function startArgvFor(worktree, declaration, { service: wanted = null } = {}) {
  const path = join(worktree, DEV_DEFINITION_FILE);
  if (!existsSync(path)) return { ok: false, error: `${worktree} does not declare ${DEV_DEFINITION_FILE}` };
  let definition = null;
  try {
    definition = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { ok: false, error: `${path}: ${error.message}` };
  }
  const serviceName = wanted || declaration?.environments?.dev?.service || definition.default_service;
  const service = definition.services?.[serviceName];
  if (!service) return { ok: false, error: `${path}: no service ${serviceName}` };
  // The declaration's profile is about the app service; another service —
  // the static tier — runs its own default.
  const declared = !wanted || wanted === declaration?.environments?.dev?.service;
  const profileName = (declared && declaration?.environments?.dev?.profile) || service.default_profile;
  const profile = service.profiles?.[profileName];
  if (!profile) return { ok: false, error: `${path}: ${serviceName} has no profile ${profileName}` };
  const argv = profile.start?.argv;
  if (!Array.isArray(argv) || !argv.length || argv.some((part) => typeof part !== 'string')) {
    return { ok: false, error: `${path}: ${serviceName}/${profileName} has no start argv` };
  }
  // The protocol has always let a profile say how long registering may take.
  // The Worker never declared one and gets the long window below; the static
  // tier says fifteen seconds, and fifteen seconds is what it gets.
  const declaredMs = Number(profile.readiness?.timeout_ms);
  return {
    ok: true,
    argv,
    service: serviceName,
    profile: profileName,
    registerTimeoutMs: Number.isFinite(declaredMs) && declaredMs > 0 ? declaredMs : null,
  };
}

/**
 * Has the worktree moved on from the tree a running service was built from?
 *
 * The measurement fixture serves a startup snapshot: workerd reads `public/`
 * once, and a module that arrives on disk afterwards answers 404 until the
 * fixture is started again. On 2026-09-06 a shared checkout was fast-forwarded
 * under a fixture that had been up since 07:43; two modules landed with it,
 * and `msr-core` reported the app's module graph as broken for an hour. A
 * service that says what it was built from (`built_from.commit` in its
 * manifest) is compared with the worktree's HEAD, and a mismatch is a reason
 * to start over. A service that says nothing is trusted as before.
 */
export function builtFromMoved(server, worktree, deps = {}) {
  const was = String(server?.built_from?.commit || '').trim();
  if (!was) return null;
  const git = deps.git || ((args) => spawnSync('git', args, { cwd: worktree, encoding: 'utf8' }));
  const asked = git(['rev-parse', 'HEAD']);
  if (asked.status !== 0) return null;
  const now = String(asked.stdout || '').trim();
  if (!now || now === was) return null;
  return { was: was.slice(0, 10), now: now.slice(0, 10) };
}

/**
 * A dev server for this worktree — the one already there, or a new one.
 *
 * Or a new one in place of the one there, when the checkout has moved on from
 * what that one was built from — see `builtFromMoved`.
 *
 * Reuse is decided by the inventory, not by a port answering: a URL that
 * responds says something is serving, never that it is serving *this*
 * worktree, and on a machine running four lanes those are different servers
 * with the same shape. `mc dev`'s registry is the only thing that knows which
 * is which, and this is the reader it was brought back for.
 *
 * Starting one is the project's own command, run with `shell: false`, detached
 * so it outlives this process the way a dev server should. mc then waits for
 * the wrapper to register itself and for its health endpoint to answer — both,
 * because a registration is a claim and a 200 is the evidence, and each gets
 * its own window: see REGISTER_TIMEOUT_MS and READY_TIMEOUT_MS.
 */
export async function ensureDevServer(worktree, declaration, deps = {}) {
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((done) => { setTimeout(done, ms); }));
  const fetchImpl = deps.fetch || fetch;
  const readyMs = deps.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const root = deps.root;
  // Which of the worktree's services. Unnamed means the app, as it always did.
  const service = deps.service || serviceFor(declaration, 'app');

  const running = servingWorktree(worktree, { root, service });
  let restartedFrom = null;
  if (running) {
    const stale = builtFromMoved(running, worktree, deps);
    if (!stale) return { ok: true, server: running, started: false };
    // The server is alive and it is this worktree's, and it is serving a tree
    // that is no longer here. Stopped through its own stop command, like
    // `--stop` would, and started again below.
    const stopped = (deps.stopServer || stopServer)(running);
    if (!stopped.ok) return { ok: false, error: `${running.instance_id} serves ${stale.was}, the worktree is at ${stale.now}, and it could not be stopped: ${stopped.error}` };
    restartedFrom = stale;
    deps.onRestart?.(running, stale);
  }

  const start = startArgvFor(worktree, declaration, { service });
  if (!start.ok) return start;
  const registerMs = deps.registerTimeoutMs ?? start.registerTimeoutMs ?? REGISTER_TIMEOUT_MS;

  const [command, ...args] = start.argv;
  const child = (deps.spawn || spawn)(command, args, {
    cwd: worktree, detached: true, shell: false, stdio: 'ignore',
  });
  child.unref?.();

  // Stage one: has it said where it will serve?
  const registerBy = now() + registerMs;
  let server = null;
  while (!server && now() < registerBy) {
    await sleep(1000);
    server = servingWorktree(worktree, { root, service });
  }
  if (!server) {
    return {
      ok: false,
      error: `no ${start.service} registered for ${worktree} within ${seconds(registerMs)}`
        + ' — its log is under .wrangler/dev-server/logs/',
    };
  }
  deps.onRegistered?.(server);

  // Stage two: has it started answering? One attempt a turn — the loop is the
  // retry, and a server that is not up yet should not cost six seconds each
  // time round.
  const readyBy = now() + readyMs;
  while (now() < readyBy) {
    if (await answers(server, { fetch: fetchImpl, attempts: 1 })) {
      return {
        ok: true, server, started: true, service: start.service, profile: start.profile, restartedFrom,
      };
    }
    // A wrapper that has died is not going to answer, and waiting ten minutes
    // to find that out is the wrong kind of patience.
    const still = servingWorktree(worktree, { root, service });
    if (!still) {
      return {
        ok: false,
        error: `${worktree}'s ${start.service} (${server.instance_id}) stopped before it answered`
          + ' — its log is under .wrangler/dev-server/logs/',
      };
    }
    server = still;
    await sleep(2000);
  }
  return {
    ok: false,
    error: `${worktree}'s ${start.service} registered as ${server.instance_id} but had not answered`
      + ` ${server.health_url || server.url} after ${seconds(readyMs)}`,
  };
}

function seconds(ms) {
  const value = Math.round(ms / 1000);
  return value >= 120 ? `${Math.round(value / 60)} minutes` : `${value}s`;
}

/**
 * Is it still there?
 *
 * Asked before a measurement and again after one, because a dev server can
 * leave in the middle of a long run — memoro's own guidance says so, and it
 * happened on the first full round this verb ever ran: the worker exited at
 * 17:24:41 with `worker exited unexpectedly`, and the six suites after it all
 * reported red on `ERR_CONNECTION_REFUSED`. Six red suites and a broken
 * measurement look identical in a log, and the broken one is worse, because
 * somebody acts on it.
 *
 * Three attempts, not one, and the second reason is the mirror of the first.
 * A single probe wrote the opposite lie on the very next round: the server was
 * up the whole time — 200 on the port, its log still filling — and one request
 * that did not come back while a browser matrix hammered it condemned nine
 * suites as never-run. A check that decides a server is dead has to be at
 * least as reliable as the server it is judging, and it gets a timeout,
 * because a probe that hangs reports nothing rather than something wrong.
 */
export async function answers(server, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const sleep = deps.sleep || ((ms) => new Promise((done) => { setTimeout(done, ms); }));
  const attempts = deps.attempts ?? 3;
  const delayMs = deps.delayMs ?? 2000;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const url = server.health_url || `${String(server.url).replace(/\/+$/u, '')}/api/version`;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) return true;
    } catch {
      // Fall through to the next attempt.
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  return false;
}

/**
 * The environment the suites are handed.
 *
 * One variable points every suite at the server, because memoro's suites now
 * read one — `MEMORO_BASE_URL`, the name thirty-five of its scripts already
 * used. The per-suite variables still win where they are set, and mc does not
 * unset them: a person who has pointed one matrix somewhere on purpose has
 * said something, and a tool that silently overrides it is a tool they cannot
 * use.
 *
 * The account link is built only when the repository says a suite needs one
 * and the token is in the environment. mc never stores it, never reads it out
 * of a file and never prints it: it is a production login, it belongs to the
 * shell that has it, and the whole of mc's part is passing it through.
 *
 * And it is built only for a server that can honour it. The token is a login
 * to production; a loopback server has a different door — memoro's is
 * `/dev/login?account=seeded`, which its write smoke takes when no link is
 * set. The first full round on the two tiers (2026-09-06) handed the
 * production link to the local fixture, and the smoke reported 404 with a
 * question about `TEST_ACCOUNT_ENABLED` — a red about a token that had no
 * business being there. Against loopback mc sets no link and the suite finds
 * its own way in. A link a person exported themselves is still theirs.
 */
export function suiteEnv({
  declaration, baseUrl, env = process.env, needsAccount = false,
}) {
  const next = { ...env, [declaration.base_url_env || 'MEMORO_BASE_URL']: baseUrl };
  const account = declaration.account;
  if (!needsAccount || !account?.token_env || !account?.url_env) return next;
  if (next[account.url_env]) return next;
  if (isLoopback(baseUrl)) return next;
  const token = String(env[account.token_env] || '').trim();
  if (token) next[account.url_env] = `${baseUrl}${account.route || '/demo/'}${token}`;
  return next;
}

/** A server on this machine: the production token means nothing to it. */
export function isLoopback(baseUrl) {
  try {
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * The exit code a suite uses to say "this did not run".
 *
 * Declared by the repository, because inventing one here would make mc's idea
 * of a skip and memoro's two separate facts. Both wrong readings of a skip
 * happened within an hour of this verb existing, in both directions: the write
 * smoke exited 0 against production having skipped every step and was reported
 * **green**; the fix — mc deciding from `needs_account` whether a suite could
 * have signed in — then reported a local run that *did* sign in and *did*
 * write as **never signed in**. A caller cannot know, and should not guess.
 * The suite is the only thing that knows, so the suite says, in the one
 * channel that needs no parsing.
 */
export function skipExitCode(declaration) {
  const declared = Number(declaration?.skip_exit_code);
  return Number.isInteger(declared) && declared > 0 ? declared : null;
}

/** Whether an account link can be built at all, and what to say when it cannot. */
export function accountAvailable(declaration, env = process.env) {
  const name = declaration.account?.token_env;
  if (!name) return { available: false, why: 'this repository declares no test account' };
  if (!String(env[name] || '').trim()) {
    // Says what is missing, not what will happen: a suite may have a door of
    // its own — the write smoke signs in through `/dev/login` against a
    // loopback server and needs no token at all there.
    return { available: false, why: `no ${name}: mc test token --set, or export it` };
  }
  return { available: true, why: null };
}

/**
 * Run the declared suites against one base URL, and say what each one did.
 *
 * Every suite runs even after one goes red. A run that stops at the first
 * failure answers "is anything wrong" when the question a person actually has
 * at this point is "what is wrong" — and these are minutes each, so a second
 * pass to find out is a second coffee. The exit code is the round's, not any
 * one suite's.
 *
 * The one thing that does stop it is a server leaving. `stillThere(suite)` is
 * asked before each suite and again after any suite that went red, and a tier
 * that loses its server reports what it measured, which suite was unmeasured,
 * and which never ran — never six red suites, which is what the first full
 * round of this verb actually produced when memoro's worker exited under it.
 * The other tier goes on: since 2026-09-06 the harness suites have a file
 * server of their own, and the Worker leaving is not their news.
 */
export async function runSuites({
  declaration, worktree, baseUrl, staticBaseUrl = null, only = null, env = process.env,
  stillThere = null, onStart = null, onEnd = null,
}, deps = {}) {
  const runOne = deps.spawnSync || spawnSync;
  const now = deps.now || (() => Date.now());
  const chosen = only
    ? declaration.suites.filter((suite) => suite.name === only)
    : declaration.suites;
  const results = [];
  // Two tiers, two servers, and a server that leaves takes only its own
  // suites with it: the file server going has nothing to say about the app,
  // and the Worker going — which is the one that does go — has nothing to say
  // about six suites that never asked it for anything.
  const gone = new Set();
  const neverRan = [];
  // A tier the declaration gives no server of its own runs against the app,
  // which is where every suite ran before there were tiers.
  const urlFor = (suite) => (tierOf(suite) === 'static' && staticBaseUrl ? staticBaseUrl : baseUrl);
  const there = async (suite) => (stillThere ? stillThere(suite) : true);

  for (const suite of chosen) {
    const tier = tierOf(suite);
    if (gone.has(tier)) { neverRan.push(suite.name); continue; }
    // Before, so a round that cannot measure anything says that instead of
    // spending six minutes proving it one suite at a time.
    if (!await there(suite)) { gone.add(tier); neverRan.push(suite.name); continue; }

    onStart?.(suite);
    const startedAt = now();
    const [command, ...args] = suite.argv;
    const finished = runOne(command, args, {
      cwd: worktree,
      env: suiteEnv({
        declaration, baseUrl: urlFor(suite), env, needsAccount: Boolean(suite.needs_account),
      }),
      encoding: 'utf8',
      shell: false,
      maxBuffer: 32 * 1024 * 1024,
    });
    const skip = skipExitCode(declaration);
    const skipped = skip !== null && finished.status === skip;
    const ok = finished.status === 0;

    // And after, because the suite that was running when the server left is
    // the one whose red is a lie. It is reported as unmeasured, not as a
    // failure of the thing it was pointed at. A suite that skipped itself is
    // not evidence about the server either way.
    if (!ok && !skipped && !await there(suite)) {
      results.push({
        name: suite.name,
        server: tier,
        ok: false,
        unmeasured: true,
        skipped: false,
        status: finished.status,
        seconds: Math.round((now() - startedAt) / 100) / 10,
        tail: tailOf(finished),
      });
      onEnd?.(results.at(-1));
      gone.add(tier);
      continue;
    }

    const result = {
      name: suite.name,
      server: tier,
      ok,
      unmeasured: false,
      // Not red — the app did not fail — and not a pass either. The round
      // counts it on its own line so nobody reads it as green.
      skipped,
      status: finished.status,
      seconds: Math.round((now() - startedAt) / 100) / 10,
      // The tail is what a person reads first, and the whole of a browser
      // matrix's output is megabytes nobody scrolls.
      tail: tailOf(finished),
    };
    results.push(result);
    onEnd?.(result);
  }

  return { results, gone: [...gone], skipped: neverRan };
}

function tailOf(finished, lines = 12) {
  const text = `${finished.stdout || ''}${finished.stderr || ''}`.trimEnd();
  if (!text) return finished.error ? String(finished.error.message || finished.error) : '';
  return text.split('\n').slice(-lines).join('\n');
}

/**
 * The production test-account token, held by mc rather than by a shell.
 *
 * Cloudflare cannot give it back. Workers secrets are write-only by design —
 * `wrangler secret list` returns names and types, never values, and neither
 * does the API — so "read it from Cloudflare when needed" is not a thing that
 * exists, however reasonable it sounds. `mc vault` cannot carry it either:
 * `mc vault get` refuses plaintext export on purpose, and weakening that to
 * serve a test would be a bad trade.
 *
 * What is left, and what Martin asked for — the token stored in mc, never in
 * a session's environment — is the platform keychain `src/lib/keychain.js`
 * already speaks: macOS `security`, libsecret on Linux, Credential Manager on
 * Windows. mc reads it at the moment `mc test prod` runs, hands it to the
 * suite's environment and to nothing else. It is never printed, never in
 * `--json`, and never passed to a suite that did not declare it needs one.
 *
 * The environment still wins where it is set. A person with the token already
 * exported has said something, and a tool that overrides that is a tool they
 * cannot use.
 */
export async function tokenFor(declaration, env = process.env) {
  const name = declaration?.account?.token_env;
  if (!name) return { name: null, token: null, from: null };
  const fromEnv = String(env[name] || '').trim();
  if (fromEnv) return { name, token: fromEnv, from: 'environment' };
  const stored = String(await getSecret(name).catch(() => '') || '').trim();
  return stored
    ? { name, token: stored, from: 'keychain' }
    : { name, token: null, from: null };
}

/** Put one there. The value never comes from argv, so it never reaches a history file. */
export async function storeToken(name, value) {
  const token = String(value || '').trim();
  if (!token) return { ok: false, error: 'nothing was given to store' };
  await setSecret(name, token);
  return { ok: true, name };
}

/** Take it out again. */
export async function forgetToken(name) {
  await deleteSecret(name);
  return { ok: true, name };
}

/**
 * Stop the server serving this worktree — by asking the project, never by
 * signalling anything.
 *
 * The manifest carries `control.stop.argv`, which is the wrapper's own stop
 * command (`node scripts/dev.mjs --stop` in memoro's case). mc runs that and
 * nothing else: it holds an index and it does not own the process. A pid or an
 * occupied port has never been authority to signal anything here, and the
 * unregister is the wrapper's to do on the way out — which is how mc learns
 * the server is gone without being told.
 *
 * A refusal rather than a guess when the manifest has no stop command: a
 * server mc cannot stop politely is one a person stops themselves, and the
 * message says where.
 */
export function stopServer(server, deps = {}) {
  const runOne = deps.spawnSync || spawnSync;
  const argv = server?.control?.stop?.argv;
  if (!Array.isArray(argv) || !argv.length) {
    return {
      ok: false,
      error: `${server?.instance_id || 'that server'} declares no stop command — stop it where it was started`,
    };
  }
  const [command, ...args] = argv;
  const finished = runOne(command, args, {
    cwd: server.worktree_path,
    encoding: 'utf8',
    shell: false,
    timeout: Number(server.control.stop.timeout_ms) || 30_000,
  });
  return finished.status === 0
    ? { ok: true, instance_id: server.instance_id }
    : {
      ok: false,
      error: `${argv.join(' ')} exited ${finished.status}${finished.stderr ? `: ${String(finished.stderr).trim().split('\n').at(-1)}` : ''}`,
    };
}
