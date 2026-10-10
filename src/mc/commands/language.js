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
 * Exit codes: 0 for a reading with every read answered, the cache shown or a
 * key kept; 1 for a reading with a failed read, a refusal (a deploy running, a
 * dirty or diverged `main`, no wrangler) or a keychain that would not write;
 * 2 for a bad argument, a token not piped in, or a subcommand not built yet.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getSecret as realGetSecret, setSecret as realSetSecret } from '../../lib/keychain.js';
import { writeJsonAtomic } from '../atomic-write.js';
import { defaultRepos } from '../brief-collect.js';
import { runningDeploy } from '../deploys.js';
import { tryGit } from '../git.js';
import { processAlive } from '../lease-owner.js';
import { closingManifests, readManifests } from '../language-manifest.js';
import { workRoot } from '../paths.js';
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
  if (['run', 'resume', 'promote'].includes(sub)) {
    stderr.write(`mc: mc language ${sub} — not yet\n`);
    return 2;
  }
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

/** Every cached reading, by language. */
export function cachedReadings(env = process.env) {
  const dir = languageDir(env);
  let files = [];
  try { files = readdirSync(dir); } catch { return {}; }
  const out = {};
  for (const file of files) {
    const match = /^status-([a-z]{2,3})\.json$/u.exec(file);
    if (!match) continue;
    const reading = readJson(join(dir, file));
    if (reading) out[match[1]] = reading;
  }
  return out;
}

/** The newest run record per language — step 2 writes them to `runs/`; none yet is none. */
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
