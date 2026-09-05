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

import { defaultRepos } from './brief-collect.js';
import { listServers } from './dev-servers.js';

/** Where a repository says what it may be measured with. */
export const DECLARATION_FILE = join('.mc', 'test.json');

/** Where it says how its dev server starts. */
export const DEV_DEFINITION_FILE = join('.mc', 'dev.json');

/** How long to wait for a dev server that was not already running. */
export const START_TIMEOUT_MS = 120_000;

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
  return { ok: true, declaration };
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

/** A live server already serving this worktree, or null. */
export function servingWorktree(worktree, { root } = {}) {
  const { servers } = listServers(root ? { root } : {});
  return servers.find((server) => server.live && resolve(server.worktree_path) === resolve(worktree)) || null;
}

/**
 * The argv a worktree's dev definition says starts its server.
 *
 * Read from `.mc/dev.json`, which is argv-only by design so that mc never
 * evaluates a shell command while planning one. The profile is the
 * declaration's, and `agent` in practice — the light one, without containers,
 * because this is a measurement and not the whole product.
 */
export function startArgvFor(worktree, declaration) {
  const path = join(worktree, DEV_DEFINITION_FILE);
  if (!existsSync(path)) return { ok: false, error: `${worktree} does not declare ${DEV_DEFINITION_FILE}` };
  let definition = null;
  try {
    definition = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { ok: false, error: `${path}: ${error.message}` };
  }
  const serviceName = declaration?.environments?.dev?.service || definition.default_service;
  const service = definition.services?.[serviceName];
  if (!service) return { ok: false, error: `${path}: no service ${serviceName}` };
  const profileName = declaration?.environments?.dev?.profile || service.default_profile;
  const profile = service.profiles?.[profileName];
  if (!profile) return { ok: false, error: `${path}: ${serviceName} has no profile ${profileName}` };
  const argv = profile.start?.argv;
  if (!Array.isArray(argv) || !argv.length || argv.some((part) => typeof part !== 'string')) {
    return { ok: false, error: `${path}: ${serviceName}/${profileName} has no start argv` };
  }
  return {
    ok: true, argv, service: serviceName, profile: profileName,
  };
}

/**
 * A dev server for this worktree — the one already there, or a new one.
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
 * because a registration is a claim and a 200 is the evidence.
 */
export async function ensureDevServer(worktree, declaration, deps = {}) {
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((done) => { setTimeout(done, ms); }));
  const fetchImpl = deps.fetch || fetch;
  const timeoutMs = deps.timeoutMs ?? START_TIMEOUT_MS;
  const root = deps.root;

  const running = servingWorktree(worktree, { root });
  if (running) return { ok: true, server: running, started: false };

  const start = startArgvFor(worktree, declaration);
  if (!start.ok) return start;

  const [command, ...args] = start.argv;
  const child = (deps.spawn || spawn)(command, args, {
    cwd: worktree, detached: true, shell: false, stdio: 'ignore',
  });
  child.unref?.();

  const deadline = now() + timeoutMs;
  let server = null;
  while (now() < deadline) {
    await sleep(1000);
    server = servingWorktree(worktree, { root });
    // One attempt while starting: the loop around this is the retry, and a
    // server that is not up yet should not cost six seconds a turn.
    if (server && await answers(server, { fetch: fetchImpl, attempts: 1 })) {
      return {
        ok: true, server, started: true, service: start.service, profile: start.profile,
      };
    }
  }
  return {
    ok: false,
    error: server
      ? `${worktree}'s dev server registered as ${server.instance_id} but never answered ${server.health_url || server.url}`
      : `no dev server registered for ${worktree} within ${Math.round(timeoutMs / 1000)}s — its log is under .wrangler/dev-server/logs/`,
  };
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
 */
export function suiteEnv({
  declaration, baseUrl, env = process.env, needsAccount = false,
}) {
  const next = { ...env, [declaration.base_url_env || 'MEMORO_BASE_URL']: baseUrl };
  const account = declaration.account;
  if (!needsAccount || !account?.token_env || !account?.url_env) return next;
  const token = String(env[account.token_env] || '').trim();
  if (!token) return next;
  if (!next[account.url_env]) {
    next[account.url_env] = `${baseUrl}${account.route || '/demo/'}${token}`;
  }
  return next;
}

/** Whether an account link can be built at all, and what to say when it cannot. */
export function accountAvailable(declaration, env = process.env) {
  const name = declaration.account?.token_env;
  if (!name) return { available: false, why: 'this repository declares no test account' };
  if (!String(env[name] || '').trim()) {
    return { available: false, why: `${name} is not set in this shell — the suites that sign in will report skipped` };
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
 * The one thing that does stop it is the server leaving. `stillThere` is asked
 * before each suite and again after any suite that went red, and a round that
 * loses its server reports what it measured, which suite was unmeasured, and
 * which never ran — never six red suites, which is what the first full round
 * of this verb actually produced when memoro's worker exited under it.
 */
export async function runSuites({
  declaration, worktree, baseUrl, only = null, env = process.env,
  stillThere = null, onStart = null, onEnd = null,
}, deps = {}) {
  const runOne = deps.spawnSync || spawnSync;
  const now = deps.now || (() => Date.now());
  const chosen = only
    ? declaration.suites.filter((suite) => suite.name === only)
    : declaration.suites;
  const results = [];
  let gone = false;

  for (const suite of chosen) {
    // Before, so a round that cannot measure anything says that instead of
    // spending six minutes proving it one suite at a time.
    if (stillThere && !await stillThere()) { gone = true; break; }

    onStart?.(suite);
    const startedAt = now();
    const [command, ...args] = suite.argv;
    const finished = runOne(command, args, {
      cwd: worktree,
      env: suiteEnv({
        declaration, baseUrl, env, needsAccount: Boolean(suite.needs_account),
      }),
      encoding: 'utf8',
      shell: false,
      maxBuffer: 32 * 1024 * 1024,
    });
    const ok = finished.status === 0;

    // And after, because the suite that was running when the server left is
    // the one whose red is a lie. It is reported as unmeasured, not as a
    // failure of the thing it was pointed at.
    if (!ok && stillThere && !await stillThere()) {
      results.push({
        name: suite.name,
        ok: false,
        unmeasured: true,
        status: finished.status,
        seconds: Math.round((now() - startedAt) / 100) / 10,
        tail: tailOf(finished),
      });
      onEnd?.(results.at(-1));
      gone = true;
      break;
    }

    const result = {
      name: suite.name,
      ok,
      unmeasured: false,
      status: finished.status,
      seconds: Math.round((now() - startedAt) / 100) / 10,
      // The tail is what a person reads first, and the whole of a browser
      // matrix's output is megabytes nobody scrolls.
      tail: tailOf(finished),
    };
    results.push(result);
    onEnd?.(result);
  }

  return { results, gone, skipped: chosen.slice(results.length).map((suite) => suite.name) };
}

function tailOf(finished, lines = 12) {
  const text = `${finished.stdout || ''}${finished.stderr || ''}`.trimEnd();
  if (!text) return finished.error ? String(finished.error.message || finished.error) : '';
  return text.split('\n').slice(-lines).join('\n');
}
