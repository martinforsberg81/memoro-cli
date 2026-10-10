/**
 * `mc language` — the one door through which language data reaches
 * production, the way `mc deploy` is for code (ruling 31).
 *
 * mc owns the door and memoro owns the content. What is read and what is
 * written is memoro's: its cutover manifests (`language-manifest.js`) and the
 * `--json` scripts they and the reads below name. mc runs those argument
 * arrays as they are, in the memoro worktree `mc deploy` uses
 * (`deploySource`), and adds what is around them — the reading, the cache,
 * the key.
 *
 * This file, so far:
 *
 *   mc language                  every language from the cache — offline, instant
 *   mc language status <lang>    the language's four reads, run now and cached
 *   mc language key              whether the Cloudflare key is held
 *   mc language key set          the key from stdin, the account from --account
 *   mc language run <manifest>   a cutover's acts, a question before every write
 *   mc language resume           the stopped run, from the act it stopped at
 *   mc language promote          the grammar waiting, as a one-act run built here
 *
 * The key is never an argument. `mc.log` keeps a command's positionals that
 * look like identifiers (`invocationShape`, logger.js), and a shell keeps its
 * history, so the token is read from stdin and only from there. Reads need no
 * key: they run on wrangler's login, and every `CLOUDFLARE_*` in mc's own
 * environment is taken out of theirs.
 *
 * Every process boundary is on `deps` — git, the reads' spawn, the keychain,
 * stdin — so the verb runs in a test with nothing real behind it. The cache is
 * the exception, as the deploy record is in `deploy.js`: it is what the verb
 * leaves behind, and `env` already points it at a throwaway directory.
 *
 * A run is the manifest's acts in order: each act's `check` read and compared
 * with its expectations, and — for an act that writes — one question, then
 * its `execute`. No flag skips the question and without a terminal `run` and
 * `resume` exit 2 before reading anything, as `mc deploy` does. An `exact`
 * expectation that does not hold stops the run before the next write, with
 * the act's `if_not`; `advisory` ones are printed and never enforced. The key
 * goes into the environment of a child whose act names `cloudflare-d1-edit`,
 * and nowhere else. Every run is a record (`language-runs.js`), and a run and
 * a deploy never write at the same time: each reads the other's record under
 * the register's lock before it writes its own.
 *
 * Exit codes: 0 for a reading with every read answered, the cache shown, a
 * key kept or a run whose every act held; 1 for a reading with a failed read,
 * a refusal (a deploy or a run going on, a dirty or diverged `main`, no
 * wrangler, no key), a deviation, a `no`, or a keychain that would not write;
 * 2 for a bad argument, a token not piped in, no terminal to ask at, or a
 * subcommand not built yet; 130 for a run stopped by ^C.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { getSecret as realGetSecret, setSecret as realSetSecret } from '../../lib/keychain.js';
import { writeJsonAtomic } from '../atomic-write.js';
import { defaultRepos } from '../brief-collect.js';
import { runningDeploy } from '../deploys.js';
import { tryGit } from '../git.js';
import { processAlive } from '../lease-owner.js';
import { closingManifests, readManifests } from '../language-manifest.js';
import {
  actEnd, actStart, cachedReadings, closeAbandoned, DONE, doneExecutes, endRun, FAILED, liveRun, readRuns, REFUSED, runStem,
  startRun, STOPPED,
} from '../language-runs.js';
import { workRoot } from '../paths.js';
import { ask as realAsk, interactive as realInteractive } from '../prompt.js';
import { realLock } from '../register.js';
import { currentHolder } from '../repo-lease.js';
import { scrubRuntimeSecretsFromEnv } from '../runtime-secrets.js';
import {
  deploySource, isOwnWorktree, leftoverStamps, REPO, strayPaths, worktreeState,
} from './deploy.js';
import { scanArgs } from './flags.js';

/** The keychain entries the key is kept under. */
export const TOKEN_SECRET = 'cloudflare-d1-edit-token';
export const ACCOUNT_SECRET = 'cloudflare-account-id';

const LANG = /^[a-z]{2,3}$/u;
const ACCOUNT = /^[A-Za-z0-9_-]{1,64}$/u;
const short = (sha) => (sha ? String(sha).slice(0, 7) : null);

export function usage() {
  return [
    'usage — mc language [--json]                    each language\'s last reading and last run, from the cache\n',
    '        mc language status <lang>               the language\'s reads, run now in memoro\'s main, and cached\n',
    '        mc language key [--json]                whether the Cloudflare key is held, and its account\n',
    '        printf %s "<token>" | mc language key set --account <id>\n',
    '                                                keep the key in this machine\'s keychain — never an argument\n',
    '        mc language run <manifest> [--dry-run]  a cutover\'s acts in order, asking before every write\n',
    '        mc language resume [--manifest <name>] [--from-head]\n',
    '                                                the stopped run again, from the act it stopped at\n',
    '        mc language promote [--langs <list>]    the curated grammar waiting, to production after one question\n',
  ].join('');
}

/** `~/mc/runner/log/language` — the readings and, from step 2, the runs. */
export function languageDir(env = process.env) {
  return join(workRoot(env), 'runner', 'log', 'language');
}

export function readingPath(lang, env = process.env) {
  return join(languageDir(env), `status-${lang}.json`);
}

/** `env` without `CLOUDFLARE_*`, and the names that were taken out. */
export function withoutCloudflare(env) {
  const clean = {};
  const removed = [];
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith('CLOUDFLARE_')) removed.push(name);
    else clean[name] = value;
  }
  return { env: clean, removed };
}

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const env = deps.env || process.env;
  const io = { stdout, stderr, env, deps };
  const [sub, ...rest] = argv;
  if (sub === undefined || sub.startsWith('--')) return overview(argv, io);
  if (sub === 'status') return status(rest, io);
  if (sub === 'key') return key(rest, io);
  if (sub === 'run') return runVerb(rest, io);
  if (sub === 'resume') return resumeVerb(rest, io);
  if (sub === 'promote') return promoteVerb(rest, io);
  stderr.write(`mc: unknown subcommand: ${sub}\n${usage()}`);
  return 2;
}

/* ------------------------------------------------------------------- key */

async function key(argv, { stdout, stderr, deps }) {
  const scanned = scanArgs(argv, { booleans: ['--json'], strictValues: ['--account'] });
  const [what, ...extra] = scanned.positional;
  if (scanned.error || extra.length || (what !== undefined && what !== 'set')) {
    stderr.write(`mc: ${scanned.error || `mc language key takes set or nothing (${scanned.positional.join(' ')})`}\n${usage()}`);
    return 2;
  }
  const getSecret = deps.getSecret || realGetSecret;
  const setSecret = deps.setSecret || realSetSecret;

  if (what === 'set') {
    const account = scanned.flags.account;
    const stdin = deps.stdin || process.stdin;
    const hint = 'printf %s "<token>" | mc language key set --account <id>';
    if (stdin.isTTY) {
      stderr.write(`mc: the token is read from stdin, never typed or passed as an argument — ${hint}\n`);
      return 2;
    }
    if (!account || !ACCOUNT.test(account)) {
      stderr.write(`mc: --account <id> is the Cloudflare account id — ${hint}\n`);
      return 2;
    }
    const token = await readStdin(stdin);
    if (!token) {
      stderr.write(`mc: nothing came in on stdin — ${hint}\n`);
      return 2;
    }
    let where;
    try {
      where = await setSecret(TOKEN_SECRET, token);
      await setSecret(ACCOUNT_SECRET, account);
    } catch (error) {
      // The keychain's own message: it never carries the value.
      stderr.write(`mc: the keychain did not keep it — ${error?.message || error}\n`);
      return 1;
    }
    stdout.write(where === 'file'
      ? 'mc: kept the Cloudflare key in ~/.memoro/secrets.json (mode 0600) — this machine has no keychain mc can use\n'
      : 'mc: kept the Cloudflare key and its account in this machine\'s keychain\n');
    return 0;
  }

  const [token, account] = [await getSecret(TOKEN_SECRET), await getSecret(ACCOUNT_SECRET)];
  if (scanned.flags.json) {
    stdout.write(`${JSON.stringify({ token: Boolean(token), account: account || null }, null, 2)}\n`);
    return 0;
  }
  stdout.write(`token    ${token ? 'held' : 'not held'}\n`);
  stdout.write(`account  ${account || 'not held'}\n`);
  if (!token || !account) stdout.write('mc: printf %s "<token>" | mc language key set --account <id>\n');
  return 0;
}

/** All of stdin, trimmed. */
function readStdin(stream) {
  return new Promise((done) => {
    let text = '';
    stream.setEncoding?.('utf8');
    stream.on('data', (chunk) => { text += chunk; });
    stream.on('end', () => done(text.trim()));
    stream.on('error', () => done(''));
  });
}

/* ---------------------------------------------------------------- reads */

/**
 * The four reads of `mc language status`, each `node <script> … --json` in
 * the memoro worktree, and what is kept of each JSON report. Paths read from
 * memoro's scripts on 2026-10-10.
 */
export const READS = [
  {
    id: 'selectors',
    args: (lang) => ['scripts/language-library/grammar-selector-readiness-report.mjs', '--env', 'production', '--langs', lang, '--json'],
    pick(json, lang) {
      const entry = json.languages?.[lang];
      const uses = {};
      for (const selector of entry?.unresolved_selectors || []) {
        const use = String(selector?.uses || '?');
        uses[use] = (uses[use] || 0) + 1;
      }
      return {
        unresolved: entry?.selectors?.unresolved ?? null,
        without_usable: entry?.rows?.without_usable_resolved ?? null,
        uses,
      };
    },
  },
  {
    id: 'forms',
    args: (lang) => ['scripts/language-library/readiness-report.mjs', '--env', 'production', '--langs', lang, '--json'],
    pick: (json, lang) => ({ forms: json.languages?.[lang]?.d1?.totals?.forms ?? null }),
  },
  {
    id: 'grammar',
    args: (lang) => ['scripts/admin/language-grammar-promote.mjs', '--check', '--json', '--langs', lang],
    pick(json, lang) {
      const plan = json.plans?.[lang];
      return {
        status: json.languages?.[lang]?.status ?? null,
        waiting: plan ? (plan.upsert || 0) + (plan.delete_stale || 0) : null,
      };
    },
  },
  {
    id: 'anchors',
    args: (lang) => ['scripts/language-library/apply-curated-lemma-anchors.mjs', '--env', 'production', '--langs', lang, '--json'],
    pick(json, lang) {
      const entry = json.languages?.[lang];
      const missing = entry?.missing;
      return {
        would_update: entry?.would_update ?? null,
        missing: Array.isArray(missing) ? missing.length : (missing ?? null),
      };
    },
  },
];

export function spawnReadDefault({ cmd, args, cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => resolve({ code: 127, stdout: out, stderr: `${err}${error?.message || error}` }));
    child.on('close', (code, signal) => resolve({ code: signal ? 1 : (code ?? 1), stdout: out, stderr: err }));
  });
}

/** The one JSON object a `--json` script prints, or null. */
function parseReport(text) {
  const trimmed = String(text || '').trim();
  try {
    const value = JSON.parse(trimmed);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const tail = (text, n = 5) => String(text || '').split('\n').map((line) => line.trimEnd()).filter(Boolean).slice(-n);

/**
 * One read. A child that exits non-zero but printed its report is a reading,
 * not a failure: the lemma script exits 1 whenever anchors are missing, read
 * or not.
 */
async function runRead(read, { lang, cwd, env, spawnRead }) {
  const args = read.args(lang);
  const result = await spawnRead({ cmd: 'node', args, cwd, env });
  const json = parseReport(result.stdout);
  if (!json) {
    return { ok: false, exit: result.code, command: ['node', ...args].join(' '), error: tail(result.stderr) };
  }
  return { ok: true, exit: result.code, ...read.pick(json, lang) };
}

/**
 * Make the deploy worktree a reading of `origin/main`: fetched, then
 * fast-forwarded as `ship` does — or a refusal that touched nothing.
 * Returns `{ worktree }` or `{ refused: '<line>' }`.
 */
export function prepareWorktree({ path, git, env, alive }) {
  const deploy = runningDeploy(env, { alive });
  if (deploy) {
    const when = String(deploy.started).slice(0, 16).replace('T', ' ');
    return { refused: `a deploy of ${short(deploy.sha)} has been running since ${when} (pid ${deploy.pid}) — the reads wait for it; nothing was read` };
  }
  const source = deploySource({ path, git, env, create: true });
  if (source.failed) return { refused: `git worktree add ${source.worktree} main failed in ${path} — the reads need a checkout of main` };
  const { worktree } = source;
  if (git(path, ['fetch', 'origin', 'main', '--quiet']) === null) {
    return { refused: `git fetch origin main failed in ${path} — nothing was read` };
  }
  const state = worktreeState({ worktree, git });
  const own = isOwnWorktree(worktree, env);
  if (state.dirty.length && !leftoverStamps({ worktree, dirty: state.dirty, git }) && !(own && strayPaths(state.dirty))) {
    return { refused: `main in ${worktree} has ${state.dirty.length} uncommitted file${state.dirty.length === 1 ? '' : 's'} — commit or clean it there; nothing was read` };
  }
  if (state.ahead) {
    return { refused: `main in ${worktree} has ${state.ahead} commit${state.ahead === 1 ? '' : 's'} that origin/main does not — push them or reset that checkout yourself; nothing was read` };
  }
  if (state.behind && git(worktree, ['merge', '--ff-only', 'origin/main']) === null) {
    return { refused: `git merge --ff-only origin/main failed in ${worktree} — nothing was read` };
  }
  return { worktree };
}

async function status(argv, { stdout, stderr, env, deps }) {
  const scanned = scanArgs(argv, {});
  const [lang, ...extra] = scanned.positional;
  if (scanned.error || !lang || extra.length || !LANG.test(lang)) {
    stderr.write(`mc: ${scanned.error || 'mc language status takes one language code, e.g. sv'}\n${usage()}`);
    return 2;
  }
  const path = (deps.repos || defaultRepos(env)).find((repo) => repo.name === REPO)?.path;
  if (!path) {
    stderr.write(`mc: no checkout of ${REPO} on this machine — the reads run in its main\n`);
    return 1;
  }
  const git = deps.git || tryGit;
  const prepared = prepareWorktree({ path, git, env, alive: deps.alive || processAlive });
  if (prepared.refused) {
    stderr.write(`mc: ${prepared.refused}\n`);
    return 1;
  }
  const { worktree } = prepared;
  const exists = deps.exists || existsSync;
  if (!exists(join(worktree, 'node_modules', '.bin', 'wrangler'))) {
    stderr.write(`mc: no wrangler in ${worktree} — run npm ci there; nothing was read\n`);
    return 1;
  }

  const { env: childEnv, removed } = withoutCloudflare(env);
  if (removed.length) stdout.write(`mc: ${removed.join(', ')} set here — not passed to the reads, which use wrangler's login\n`);
  const spawnRead = deps.spawnRead || spawnReadDefault;
  const reads = {};
  for (const read of READS) {
    reads[read.id] = await runRead(read, { lang, cwd: worktree, env: childEnv, spawnRead });
  }

  const { manifests, unreadable } = readManifests(worktree);
  const closing = {};
  for (const use of Object.keys(reads.selectors.uses || {})) closing[use] = closingManifests(manifests, lang, use);
  const reading = {
    lang,
    at: (deps.now || (() => new Date()))().toISOString(),
    sha: git(worktree, ['rev-parse', 'HEAD']),
    worktree,
    reads,
    closing,
    manifests: manifests.filter((manifest) => manifest.lang === lang).map((manifest) => manifest.name),
    unreadable,
  };
  writeJsonAtomic(readingPath(lang, env), reading);

  for (const line of readingLines(reading)) stdout.write(`${line}\n`);
  return Object.values(reads).every((read) => read.ok) ? 0 : 1;
}

/* ---------------------------------------------------------------- render */

const number = (value) => (typeof value === 'number' ? value.toLocaleString('en-US') : value ?? '?');
const stamp = (iso) => String(iso || '').slice(0, 16).replace('T', ' ');

export function age(iso, now = Date.now()) {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'at an unknown time';
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function readLines(label, read, describe) {
  const head = `  ${label.padEnd(12)} `;
  if (!read) return [`${head}not read`];
  if (!read.ok) {
    return [
      `${head}read failed — exit ${read.exit}${read.command ? ` · ${read.command}` : ''}`,
      ...(read.error || []).map((line) => `  ${''.padEnd(12)}   ${line}`),
    ];
  }
  return [`${head}${describe(read)}`];
}

/** One language's block: the reading, and under it what the caller adds. */
export function readingLines(reading, { now } = {}) {
  const when = now === undefined ? `read ${stamp(reading.at)}` : `read ${age(reading.at, now)} (${stamp(reading.at)})`;
  const lines = [`${reading.lang} · ${when} · ${REPO} main ${short(reading.sha) || '?'}`];
  const { reads = {} } = reading;
  lines.push(...readLines('selectors', reads.selectors, (read) => `${number(read.unresolved)} unresolved · ${number(read.without_usable)} rows without a usable selector`));
  for (const [use, count] of Object.entries(reads.selectors?.uses || {})) {
    const names = reading.closing?.[use] || [];
    lines.push(`  ${''.padEnd(12)}   ${use.padEnd(16)} ${String(count).padStart(4)}  ${names.length ? `closed by ${names.join(', ')}` : 'no manifest closes it'}`);
  }
  lines.push(...readLines('forms', reads.forms, (read) => number(read.forms)));
  lines.push(...readLines('grammar', reads.grammar, (read) => `${read.status ?? '?'} · ${number(read.waiting)} rows waiting`));
  lines.push(...readLines('lemma bands', reads.anchors, (read) => `${number(read.would_update)} would update · ${number(read.missing)} missing`));
  if (reading.manifests?.length) lines.push(`  ${'manifests'.padEnd(12)} ${reading.manifests.join(', ')}`);
  for (const bad of reading.unreadable || []) lines.push(`  ${'unreadable'.padEnd(12)} ${bad.name} — ${bad.problems[0]}`);
  return lines;
}

/* -------------------------------------------------------------- overview */

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

// Every cached reading, by language — read where the page reads it too.
export { cachedReadings };

/** The newest run record per language (`language-runs.js`); none yet is none. */
export function lastRuns(env = process.env) {
  const dir = join(languageDir(env), 'runs');
  let files = [];
  try { files = readdirSync(dir).filter((file) => file.endsWith('.json')); } catch { return {}; }
  const out = {};
  for (const file of files) {
    const record = readJson(join(dir, file));
    if (!record?.lang || !record.started) continue;
    if (!out[record.lang] || String(record.started) > String(out[record.lang].started)) out[record.lang] = record;
  }
  return out;
}

async function overview(argv, { stdout, stderr, env, deps }) {
  const scanned = scanArgs(argv, { booleans: ['--json'] });
  if (scanned.error || scanned.positional.length) {
    stderr.write(`mc: ${scanned.error || `unknown subcommand: ${scanned.positional[0]}`}\n${usage()}`);
    return 2;
  }
  const readings = cachedReadings(env);
  const runs = lastRuns(env);
  // The manifests as they are on disk: no fetch, nothing moved.
  let manifests = [];
  let unreadable = [];
  const path = (deps.repos || defaultRepos(env)).find((repo) => repo.name === REPO)?.path;
  if (path) {
    const source = deploySource({ path, git: deps.git || tryGit, env, create: false });
    if (!source.absent) ({ manifests, unreadable } = readManifests(source.worktree));
  }
  const langs = [...new Set([...Object.keys(readings), ...manifests.map((manifest) => manifest.lang)])].sort();
  const now = (deps.now || (() => new Date()))().getTime();

  const languages = Object.fromEntries(langs.map((lang) => [lang, {
    reading: readings[lang] || null,
    manifests: manifests.filter((manifest) => manifest.lang === lang).map((manifest) => manifest.name),
    last_run: runs[lang] || null,
  }]));
  if (scanned.flags.json) {
    stdout.write(`${JSON.stringify({ languages, unreadable }, null, 2)}\n`);
    return 0;
  }
  if (!langs.length) {
    stdout.write('mc: no language read yet and no manifest found — mc language status <lang>\n');
    return 0;
  }
  langs.forEach((lang, index) => {
    const entry = languages[lang];
    if (index) stdout.write('\n');
    const lines = entry.reading
      ? readingLines({ ...entry.reading, manifests: entry.manifests, unreadable: [] }, { now })
      : [`${lang} · never read`, ...(entry.manifests.length ? [`  ${'manifests'.padEnd(12)} ${entry.manifests.join(', ')}`] : [])];
    const last = entry.last_run;
    lines.push(`  ${'last run'.padEnd(12)} ${last ? `${last.manifest} · ${last.outcome} · ${stamp(last.started)}` : 'none recorded'}`);
    for (const line of lines) stdout.write(`${line}\n`);
  });
  for (const bad of unreadable) stdout.write(`unreadable manifest ${bad.name} — ${bad.problems[0]}\n`);
  stdout.write('mc: mc language status <lang> reads one again\n');
  return 0;
}

/* ------------------------------------------------------------------- run */

/** The one credential a manifest may name, and the keychain entries behind it. */
export const CREDENTIAL = 'cloudflare-d1-edit';

const YES = /^y(es)?$/iu;
const said = (answer) => YES.test(String(answer || '').trim());

/** The value at a dotted path — `languages.sv.forms`, `rows.0.n` — or undefined. */
export function valueAt(json, path) {
  let at = json;
  for (const key of String(path).split('.')) {
    if (at === null || typeof at !== 'object' || !Object.hasOwn(at, key)) return undefined;
    at = at[key];
  }
  return at;
}

/**
 * Each expectation against a report: `{ path, kind, want, observed, held,
 * ok }`. A path the report does not have is a deviation. `relax` reads every
 * exact expectation as advisory — `held` still says, `ok` does not stop — for
 * the one act a resume picks up mid-write.
 */
export function compare(expectations, json, { relax = false } = {}) {
  return (expectations || []).map((item) => {
    const observed = json ? valueAt(json, item.path) : undefined;
    if (Object.hasOwn(item, 'exact')) {
      const held = observed !== undefined && isDeepStrictEqual(observed, item.exact);
      return { path: item.path, kind: relax ? 'relaxed' : 'exact', want: item.exact, observed, held, ok: relax || held };
    }
    return { path: item.path, kind: 'advisory', want: item.advisory, observed, held: null, ok: true };
  });
}

/** The report a child printed: the whole stdout as one object, or the last
 * `{…}` block in it when logs leaked onto stdout. */
export function parseLastJson(text) {
  const whole = parseReport(text);
  if (whole) return whole;
  const lines = String(text || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    const found = parseReport(lines.slice(i).join('\n'));
    if (found) return found;
  }
  return null;
}

/** Every secret in `text` replaced, as `mc shot` does with what a script echoed. */
export function scrubber(secrets) {
  const live = secrets.filter(Boolean);
  return (text) => live.reduce((out, secret) => out.split(secret).join('<redacted>'), String(text));
}

const show = (value) => (value === undefined ? 'missing' : JSON.stringify(value));

function comparisonLine(row, { dim }) {
  if (row.kind === 'exact') {
    return row.ok
      ? `    ✓ ${row.path} = ${show(row.observed)}`
      : `    ✗ ${row.path} = ${show(row.observed)}, expected ${show(row.want)}`;
  }
  if (row.kind === 'relaxed') {
    if (row.held) return `    ✓ ${row.path} = ${show(row.observed)}`;
    return dim(`    · ${row.path} = ${show(row.observed)}, expected ${show(row.want)} — not enforced: resuming an interrupted write`);
  }
  return dim(`    · ${row.path} = ${show(row.observed)} — advisory: ${row.want}`);
}

/**
 * One act's child: the manifest's argument array as it is, no shell, in the
 * memoro worktree. stdout is the report; stderr goes to `onStderr` as it
 * comes. ^C, a closed terminal or a kill is passed on as SIGTERM and the child
 * is waited for, as `spawnDeployDefault` does — a write half-done is the
 * script's to stop, and the record is completed after it.
 */
export function spawnActDefault({ argv, cwd, env, onStderr, signals = process }) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => onStderr?.(chunk));
    let interrupted = null;
    const onStop = (signal) => {
      interrupted = interrupted || signal;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    };
    for (const signal of STOP_SIGNALS) signals.on(signal, onStop);
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      for (const signal of STOP_SIGNALS) signals.off(signal, onStop);
      resolve({ ...result, stdout: out, interrupted });
    };
    child.on('error', (error) => settle({ code: 127, error: error?.message || String(error) }));
    child.on('close', (code, signal) => settle({ code: signal ? 1 : (code ?? 1) }));
  });
}

const STOP_SIGNALS = ['SIGINT', 'SIGHUP', 'SIGTERM'];

async function runVerb(argv, io) {
  const scanned = scanArgs(argv, { booleans: ['--dry-run'] });
  const [name, ...extra] = scanned.positional;
  if (scanned.error || !name || extra.length) {
    io.stderr.write(`mc: ${scanned.error || 'mc language run takes one manifest, e.g. sv-forms-cutover'}\n${usage()}`);
    return 2;
  }
  const dryRun = scanned.flags['dry-run'];
  if (!dryRun && !(io.deps.interactive || realInteractive)(io.env)) {
    io.stderr.write('mc: mc language run asks before every write, and there is no terminal here to ask — run it in one; nothing was read\n');
    return 2;
  }
  return conduct({ name, dryRun }, io);
}

async function resumeVerb(argv, io) {
  const scanned = scanArgs(argv, { booleans: ['--from-head'], strictValues: ['--manifest'] });
  if (scanned.error || scanned.positional.length) {
    io.stderr.write(`mc: ${scanned.error || `mc language resume takes no argument (${scanned.positional[0]}) — --manifest <name> picks one`}\n${usage()}`);
    return 2;
  }
  if (!(io.deps.interactive || realInteractive)(io.env)) {
    io.stderr.write('mc: mc language resume asks before every write, and there is no terminal here to ask — run it in one; nothing was read\n');
    return 2;
  }
  const wanted = scanned.flags.manifest;
  const prior = readRuns(io.env).filter((each) => !each.dry_run
    && [STOPPED, FAILED].includes(each.outcome)
    && (!wanted || each.manifest === wanted)).at(-1);
  if (!prior) {
    io.stderr.write(`mc: no stopped language run${wanted ? ` of ${wanted}` : ''} to resume\n`);
    return 1;
  }
  const built = prior.manifest === PROMOTE ? promoteManifest(prior.lang === ALL ? null : prior.lang) : null;
  return conduct({ name: prior.manifest, manifest: built, prior, fromHead: scanned.flags['from-head'] }, io);
}

/**
 * A run, start to end: the worktree, the manifest, the record under the lock,
 * the preflight, then the acts. Shared by `run`, `run --dry-run`, `resume`
 * and `promote`, which hands in the manifest it built (`built`) instead of
 * naming one on disk.
 */
async function conduct({
  name, manifest: built = null, dryRun = false, prior = null, fromHead = false,
}, { stdout, stderr, env, deps }) {
  const path = (deps.repos || defaultRepos(env)).find((repo) => repo.name === REPO)?.path;
  if (!path) {
    stderr.write(`mc: no checkout of ${REPO} on this machine — the acts run in its main\n`);
    return 1;
  }
  const git = deps.git || tryGit;
  const alive = deps.alive || processAlive;
  const prepared = prepareWorktree({ path, git, env, alive });
  if (prepared.refused) {
    stderr.write(`mc: ${prepared.refused}\n`);
    return 1;
  }
  const { worktree } = prepared;
  if (!(deps.exists || existsSync)(join(worktree, 'node_modules', '.bin', 'wrangler'))) {
    stderr.write(`mc: no wrangler in ${worktree} — run npm ci there; nothing was read\n`);
    return 1;
  }
  const { manifests, unreadable } = built ? { manifests: [built], unreadable: [] } : readManifests(worktree);
  const manifest = manifests.find((each) => each.name === name);
  if (!manifest) {
    const bad = unreadable.find((each) => each.name === name);
    stderr.write(bad
      ? `mc: the manifest ${name} is unreadable — ${bad.problems.join('; ')}\n`
      : `mc: no manifest ${name} in ${join(worktree, 'scripts/language-library/cutovers')} — ${manifests.map((each) => each.name).join(', ') || 'none there'}\n`);
    return 1;
  }
  const sha = git(worktree, ['rev-parse', 'HEAD']) || '';
  if (prior && prior.sha !== sha && !fromHead) {
    stderr.write(`mc: the run of ${name} stopped at ${short(prior.sha)}, and memoro's main is ${short(sha)} now — the manifest may have changed; mc language resume --from-head resumes it there\n`);
    return 1;
  }
  if (manifest.ran) stdout.write(`mc: ${name} ran on ${manifest.ran.on} — ${manifest.ran.note}\n`);

  // One writer to production at a time, decided under the register's lock as
  // `mc deploy` decides it: the other's record read, abandoned runs closed,
  // this run's record written — before any child is started.
  const holder = (deps.holder || currentHolder()).name || '';
  const lock = deps.lock || realLock;
  const locked = lock(deps.root || workRoot(env), () => {
    const deploy = runningDeploy(env, { alive });
    if (deploy) {
      return { refused: `a deploy of ${short(deploy.sha)} has been running since ${stamp(deploy.started)} (pid ${deploy.pid}) — nothing was written` };
    }
    const other = liveRun(env, { alive });
    if (other) {
      return { refused: `a language run of ${other.manifest} has been running since ${stamp(other.started)} (pid ${other.pid}) — one at a time; nothing was written` };
    }
    const closed = closeAbandoned({ alive }, env);
    const run = startRun({
      manifest: name, lang: manifest.lang, sha, holder, pid: deps.pid ?? process.pid, dryRun, resumes: prior?.started || null,
    }, env);
    return { run, closed };
  });
  if (locked.refused) {
    stderr.write(`mc: ${locked.refused}\n`);
    return 1;
  }
  const { run } = locked;
  for (const old of locked.closed) stdout.write(`mc: the run of ${old.manifest} started ${stamp(old.started)} never came back — its record now says failed\n`);
  if (prior) stdout.write(`mc: resuming the run of ${name} started ${stamp(prior.started)}${prior.sha !== sha ? ` — at ${short(sha)}, not ${short(prior.sha)}` : ''}\n`);

  const ctx = {
    stdout, stderr, env, deps, manifest, worktree, run, dryRun,
    spawnAct: deps.spawnAct || spawnActDefault,
    ask: deps.ask || realAsk,
    dim: stdout.isTTY ? (text) => `\x1b[2m${text}\x1b[0m` : (text) => text,
    scrub: (text) => text,
    logFile: join(languageDir(env), `${runStem(run)}.log`),
  };
  const stop = (outcome, note, code) => {
    endRun(run, { outcome, note }, env);
    return code;
  };

  // The environment every child gets: mc's own, without the runtime secrets
  // and without any CLOUDFLARE_* — the key is added to one child at a time.
  const { env: bare, removed } = withoutCloudflare(scrubRuntimeSecretsFromEnv(env));
  if (removed.length || Object.keys(env).some((key) => key.startsWith('CLOUDFLARE_'))) {
    stdout.write('mc: CLOUDFLARE_* set in this shell are ignored — the key comes from the keychain\n');
  }
  ctx.bare = bare;

  // Preflight: everything before the first write, production untouched by any of it.
  const needed = [...new Set(manifest.acts.flatMap((act) => act.credentials))];
  const unknown = needed.filter((credential) => credential !== CREDENTIAL);
  if (unknown.length) {
    stderr.write(`mc: ${name} names a credential mc does not hold — ${unknown.join(', ')}; nothing was run\n`);
    return stop(REFUSED, `unknown credential ${unknown.join(', ')}`, 1);
  }
  if (needed.length) {
    const getSecret = deps.getSecret || realGetSecret;
    const [token, account] = [await getSecret(TOKEN_SECRET), await getSecret(ACCOUNT_SECRET)];
    if (!token || !account) {
      stderr.write('mc: the Cloudflare key is not in the keychain — printf %s "<token>" | mc language key set --account <id>; nothing was run\n');
      return stop(REFUSED, 'no key in the keychain', 1);
    }
    ctx.key = { token, account };
    ctx.scrub = scrubber([token]);
    const first = manifest.acts.find((act) => act.credentials.includes(CREDENTIAL));
    // A check that runs without the key (`check_without_key`, the promotion's)
    // cannot show that the key reads: its execute is the first to use it.
    if (!first.check_without_key) {
      stdout.write(`mc: preflight — the key reads: ${first.id} check\n`);
      const result = await child(ctx, first, first.check);
      if (result.interrupted) return stop(STOPPED, `interrupted by ${result.interrupted} in preflight`, 130);
      if (result.code !== 0) {
        stderr.write(`mc: the key did not read — ${first.id}'s check exited ${result.code}; nothing was written\n`);
        return stop(REFUSED, `the key did not read: ${first.id} check exit ${result.code}`, 1);
      }
    }
  }
  const done = prior ? doneExecutes(prior, readRuns(env)) : new Set();
  const resumed = prior
    ? prior.acts.filter((act) => act.phase === 'execute' && [FAILED, 'running'].includes(act.outcome)).at(-1)?.id || null
    : null;
  if (!dryRun) {
    for (const act of manifest.acts.filter((each) => each.target === 'local' && !done.has(each.id))) {
      stdout.write(`mc: preflight — ${act.id} (local)\n`);
      const read = await checkAct(ctx, act, { relax: act.id === resumed, record: false });
      if (read.interrupted) return stop(STOPPED, `interrupted by ${read.interrupted} in preflight`, 130);
    }
    const firstWrite = manifest.acts.find((act) => act.execute !== null && !done.has(act.id));
    if (firstWrite) {
      const runnable = await requiresRunnable(ctx, firstWrite);
      if (runnable.interrupted) return stop(STOPPED, `interrupted by ${runnable.interrupted} in preflight`, 130);
      if (!runnable.ok) return stop(REFUSED, `${firstWrite.id} is not runnable: ${runnable.failed} did not hold`, 1);
    }
  }

  // The acts, in order.
  const total = manifest.acts.length;
  for (const [index, act] of manifest.acts.entries()) {
    stdout.write(`act ${index + 1}/${total} ${act.id} — ${act.title}\n`);
    if (done.has(act.id)) {
      stdout.write('    written in the run this resumes — skipped\n');
      continue;
    }
    const relax = act.id === resumed;
    const read = await checkAct(ctx, act, { relax });
    if (read.interrupted) return stop(STOPPED, `interrupted by ${read.interrupted} at ${act.id} check`, 130);
    if (read.end) return stop(read.end.outcome, read.end.note, read.end.code);
    if (!read.ok) return deviated(ctx, act, stop);
    if (act.execute === null) continue;

    if (dryRun) {
      if (act.target !== 'production') {
        stdout.write(`    --dry-run — would write to ${act.target}: ${act.execute.join(' ')}\n`);
        continue;
      }
      const runnable = await requiresRunnable(ctx, act);
      if (runnable.interrupted) return stop(STOPPED, `interrupted by ${runnable.interrupted}`, 130);
      if (!runnable.ok) return stop(STOPPED, `${act.id} is not runnable: ${runnable.failed} did not hold`, 1);
      stdout.write(`    --dry-run — would write to production: ${act.execute.join(' ')}\n`);
      for (const later of manifest.acts.slice(index + 1)) {
        stdout.write(`act ${manifest.acts.indexOf(later) + 1}/${total} ${later.id} — not checkable until ${act.id} has written\n`);
        stdout.write(`    check    ${later.check.join(' ')}\n`);
        if (later.execute) stdout.write(`    execute  ${later.execute.join(' ')}\n`);
      }
      break;
    }

    // The question. What it writes already holding is said, and running it
    // anyway is a question of its own, default no.
    stdout.write(`    would run ${act.execute.join(' ')}\n`);
    const already = compare(act.expect.execute, read.json).filter((row) => row.kind === 'exact');
    if (already.length && already.every((row) => row.ok)) {
      stdout.write(`    what ${act.id} writes already holds\n`);
      if (!said(ctx.ask(`${act.id}: run it anyway? [y/N]`, { stdout }))) {
        stdout.write(`    ${act.id} not run — already true\n`);
        continue;
      }
    } else if (!said(ctx.ask(act.question?.(read.json) || `${act.id}: write to ${act.target}? [y/N]`, { stdout }))) {
      actEnd(run, actStart(run, { id: act.id, phase: 'execute' }, env), { outcome: 'declined', note: 'answered no at the question' }, env);
      stdout.write(`mc: ${act.id} was not run — nothing more was written; mc language resume asks again\n`);
      return stop(STOPPED, `declined at ${act.id}`, 1);
    }
    if (act.requires_runnable.length) {
      const runnable = await requiresRunnable(ctx, act);
      if (runnable.interrupted) return stop(STOPPED, `interrupted by ${runnable.interrupted}`, 130);
      if (!runnable.ok) return stop(STOPPED, `${act.id} is not runnable: ${runnable.failed} did not hold`, 1);
    }

    const row = actStart(run, { id: act.id, phase: 'execute', opens_gap: act.opens_gap || null }, env);
    const result = await child(ctx, act, act.execute);
    if (result.interrupted) {
      actEnd(run, row, { outcome: FAILED, note: `interrupted by ${result.interrupted}` }, env);
      stderr.write(`mc: ${act.id} was interrupted by ${result.interrupted} — mc language resume picks it up\n`);
      return stop(STOPPED, `interrupted by ${result.interrupted} at ${act.id}`, 130);
    }
    if (act.confirm) {
      // An act built in code judges its own write, exit and report together.
      const judged = act.confirm(result);
      for (const line of judged.lines) (judged.ok ? stdout : stderr).write(ctx.scrub(`${line}\n`));
      if (!judged.ok) {
        const outcome = result.code !== 0 ? FAILED : 'deviated';
        actEnd(run, row, { outcome, observed: judged.observed, note: judged.note }, env);
        printIfNot(ctx, act);
        return stop(result.code !== 0 ? FAILED : STOPPED, `${act.id} execute: ${judged.note}`, 1);
      }
      actEnd(run, row, { outcome: DONE, observed: judged.observed }, env);
      act.after?.(result.json, { env, now: deps.now || (() => new Date()) });
      continue;
    }
    const rows = compare(act.expect.execute, result.json);
    for (const line of rows) stdout.write(ctx.scrub(`${comparisonLine(line, ctx)}\n`));
    const observed = Object.fromEntries(rows.map((line) => [line.path, line.observed ?? null]));
    if (result.code !== 0) {
      actEnd(run, row, { outcome: FAILED, observed, note: `exit ${result.code}${result.error ? ` — ${result.error}` : ''}` }, env);
      stderr.write(`mc: ${act.id} exited ${result.code}\n`);
      printIfNot(ctx, act);
      return stop(FAILED, `${act.id} exit ${result.code}`, 1);
    }
    if (!rows.every((line) => line.ok)) {
      actEnd(run, row, { outcome: 'deviated', observed }, env);
      printIfNot(ctx, act);
      return stop(STOPPED, `${act.id} execute deviated`, 1);
    }
    actEnd(run, row, { outcome: DONE, observed }, env);
  }
  stdout.write(dryRun ? 'mc: --dry-run — every exact expectation read held; nothing was written\n' : `mc: ${name} — every act done\n`);
  return stop(DONE, '', 0);
}

/** The child for one argument array of `act`: the key in its environment only
 * when the act names it — and not in its check when the act says
 * `check_without_key` — stderr teed to the terminal and the run's log. */
async function child(ctx, act, argv) {
  const env = { ...ctx.bare };
  if (ctx.key && act.credentials.includes(CREDENTIAL) && !(act.check_without_key && argv === act.check)) {
    env.CLOUDFLARE_API_TOKEN = ctx.key.token;
    env.CLOUDFLARE_ACCOUNT_ID = ctx.key.account;
  }
  mkdirSync(languageDir(ctx.env), { recursive: true });
  const onStderr = (chunk) => {
    const clean = ctx.scrub(chunk);
    try { ctx.stderr.write(clean); } catch { /* the terminal is gone */ }
    try { appendFileSync(ctx.logFile, clean); } catch { /* the log is a copy */ }
  };
  const result = await ctx.spawnAct({ argv, cwd: ctx.worktree, env, onStderr });
  return { ...result, json: parseLastJson(result.stdout) };
}

/**
 * `act`'s check run and compared, its lines printed, and — unless `record` is
 * false — a check row. `{ ok, json, interrupted }`: `ok` false at the first
 * exact deviation or a check that printed no report.
 */
async function checkAct(ctx, act, { relax = false, record = true } = {}) {
  const row = record ? actStart(ctx.run, { id: act.id, phase: 'check' }, ctx.env) : null;
  const result = await child(ctx, act, act.check);
  if (result.interrupted) {
    if (row) actEnd(ctx.run, row, { outcome: FAILED, note: `interrupted by ${result.interrupted}` }, ctx.env);
    return { ok: false, interrupted: result.interrupted };
  }
  if (act.assess) {
    // `{ ok, lines, observed, note, end }` — `end` finishes the run here.
    const judged = act.assess(result);
    const out = judged.ok || judged.end?.code === 0 ? ctx.stdout : ctx.stderr;
    for (const line of judged.lines) out.write(ctx.scrub(`${line}\n`));
    if (row) actEnd(ctx.run, row, { outcome: judged.ok ? 'passed' : FAILED, observed: judged.observed, note: judged.note }, ctx.env);
    return { ok: judged.ok, json: result.json, end: judged.end };
  }
  const rows = compare(act.expect.check, result.json, { relax });
  for (const line of rows) ctx.stdout.write(ctx.scrub(`${comparisonLine(line, ctx)}\n`));
  const observed = Object.fromEntries(rows.map((line) => [line.path, line.observed ?? null]));
  if (!result.json) {
    ctx.stdout.write(`    ✗ the check printed no report — exit ${result.code}\n`);
    if (row) actEnd(ctx.run, row, { outcome: FAILED, observed, note: `no report, exit ${result.code}` }, ctx.env);
    return { ok: false, json: null };
  }
  const ok = rows.every((line) => line.ok);
  if (row) actEnd(ctx.run, row, { outcome: ok ? 'passed' : 'deviated', observed, note: relax ? 'exact read as advisory: resuming' : '' }, ctx.env);
  return { ok, json: result.json };
}

/** The checks of every act `act.requires_runnable` names, each with all its
 * exact expectations holding. `{ ok, failed, interrupted }`. */
async function requiresRunnable(ctx, act) {
  for (const id of act.requires_runnable) {
    const required = ctx.manifest.acts.find((each) => each.id === id);
    ctx.stdout.write(`    requires ${id}\n`);
    if (!required) {
      ctx.stderr.write(`mc: ${act.id} requires ${id}, which ${ctx.manifest.name} has no act of — nothing was written\n`);
      return { ok: false, failed: id };
    }
    const read = await checkAct(ctx, required);
    if (read.interrupted) return { ok: false, interrupted: read.interrupted };
    if (!read.ok) {
      ctx.stderr.write(`mc: ${act.id} requires ${id}, and ${id} does not hold — nothing was written\n`);
      printIfNot(ctx, required);
      return { ok: false, failed: id };
    }
  }
  return { ok: true };
}

function printIfNot(ctx, act) {
  ctx.stderr.write(`mc: ${act.id} — ${act.if_not}\n`);
}

function deviated(ctx, act, stop) {
  printIfNot(ctx, act);
  ctx.stderr.write(ctx.dryRun
    ? `mc: --dry-run stopped at ${act.id} — nothing was written\n`
    : `mc: the run stopped before ${act.id}'s write — mc language resume picks it up\n`);
  return stop(STOPPED, `${act.id} check deviated`, 1);
}

/* --------------------------------------------------------------- promote */

/** The record name of a grammar promotion, and its `lang` when no --langs. */
export const PROMOTE = 'grammar-promote';
const ALL = 'all';
const LANGS = /^[a-z]{2,3}(,[a-z]{2,3})*$/u;

/** What the wrapper printed on stdout, the last lines of it; its stderr is
 * already on the terminal and in the run's log. */
const wrapperLines = (result) => tail(result.stdout, 20).map((line) => `    ${line}`);

/**
 * The grammar promotion `mc deploy` no longer does, as a one-act manifest
 * built here: memoro's `language-grammar-promote.mjs`, whose `--check --json`
 * is `buildPromotionReport` (memoro `promote-curated-grammar.mjs`) — per
 * language `languages.<lang>.status` and `plans.<lang>.{desired, upsert,
 * delete_stale}`. The act judges its own check and write (`assess`,
 * `confirm`) because what must hold depends on which languages were ready.
 */
export function promoteManifest(langs = null) {
  const only = langs ? ['--langs', langs] : [];
  let ready = [];
  return {
    name: PROMOTE,
    lang: langs || ALL,
    closes: [],
    acts: [{
      id: PROMOTE,
      title: 'The curated grammar waiting, to production',
      target: 'production',
      check: ['node', 'scripts/admin/language-grammar-promote.mjs', '--check', '--json', ...only],
      execute: ['node', 'scripts/admin/language-grammar-promote.mjs', '--json', ...only],
      credentials: [CREDENTIAL],
      // The check reads on wrangler's login, as `mc language status` does.
      check_without_key: true,
      requires_runnable: [],
      expect: { check: [], execute: [] },
      if_not: 'the promotion did not finish — mc language status <lang> reads where it stands, then mc language promote again',
      assess(result) {
        if (result.code !== 0) {
          const note = `check exit ${result.code}: the selector or source gate`;
          return {
            ok: false,
            lines: [...wrapperLines(result), `mc: the promotion's check exited ${result.code} — the selector or source gate; nothing was written`],
            note,
            end: { outcome: REFUSED, note, code: 1 },
          };
        }
        const json = result.json;
        if (!json) {
          return {
            ok: false,
            lines: ['    ✗ the check printed no report — exit 0', ...wrapperLines(result)],
            note: 'no report',
            end: { outcome: FAILED, note: 'the check printed no report', code: 1 },
          };
        }
        const statuses = Object.entries(json.languages || {});
        const observed = Object.fromEntries(statuses.map(([lang, entry]) => [`languages.${lang}.status`, entry?.status ?? null]));
        ready = statuses.filter(([lang, entry]) => LANG.test(lang) && entry?.status === 'ready').map(([lang]) => lang);
        if (!ready.length) {
          return {
            ok: true, lines: ['nothing waiting — every language unchanged'], observed, end: { outcome: DONE, note: 'nothing waiting', code: 0 },
          };
        }
        const lines = ready.map((lang) => {
          const plan = json.plans?.[lang] || {};
          return `${lang}: ${number(plan.upsert)} to write, ${number(plan.delete_stale)} stale to remove, ${number(plan.desired)} rows in all`;
        });
        return { ok: true, lines, observed };
      },
      question: () => `promote grammar for ${ready.join(', ')} to production? [y/N]`,
      confirm(result) {
        const observed = Object.fromEntries(ready.map((lang) => [`languages.${lang}.status`, result.json?.languages?.[lang]?.status ?? null]));
        const not = ready.filter((lang) => observed[`languages.${lang}.status`] !== 'promoted');
        if (result.code !== 0 || !result.json || not.length) {
          const note = result.code !== 0 ? `exit ${result.code}` : `not promoted: ${(not.length ? not : ready).join(', ')}`;
          return {
            ok: false,
            lines: [...wrapperLines(result), `mc: the promotion ${result.code !== 0 ? `exited ${result.code}` : `left ${not.join(', ') || ready.join(', ')} not promoted`}`],
            observed,
            note,
          };
        }
        return { ok: true, lines: ready.map((lang) => `    ✓ ${lang}: promoted`), observed };
      },
      after: (json, { env, now }) => markPromoted(ready, { env, now }),
    }],
  };
}

/**
 * The cached reading of every language just promoted, its grammar rewritten
 * to what a check would now say, so `mc language` and the page stop showing
 * rows waiting. A language never read has no reading to rewrite.
 */
export function markPromoted(langs, { env = process.env, now = () => new Date() } = {}) {
  for (const lang of langs) {
    const path = readingPath(lang, env);
    const reading = readJson(path);
    if (!reading) continue;
    reading.reads = {
      ...reading.reads,
      grammar: { ok: true, exit: 0, status: 'unchanged', waiting: 0, promoted: now().toISOString() },
    };
    writeJsonAtomic(path, reading);
  }
}

async function promoteVerb(argv, io) {
  const scanned = scanArgs(argv, { strictValues: ['--langs'] });
  const langs = scanned.flags.langs ?? null;
  if (scanned.error || scanned.positional.length || (langs !== null && !LANGS.test(langs))) {
    io.stderr.write(`mc: ${scanned.error || 'mc language promote takes --langs <list>, e.g. --langs sv,fr, or nothing for every language'}\n${usage()}`);
    return 2;
  }
  if (!(io.deps.interactive || realInteractive)(io.env)) {
    io.stderr.write('mc: mc language promote asks before it writes, and there is no terminal here to ask — run it in one; nothing was read\n');
    return 2;
  }
  return conduct({ name: PROMOTE, manifest: promoteManifest(langs) }, io);
}
