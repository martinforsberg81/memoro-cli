/**
 * `mc helper --collect` — the daily digest of what production is telling us,
 * gathered by a script and written to one file. No model is involved here;
 * the model is the turn that reads the file afterwards (step 2).
 *
 * memoro already records everything this reads. Nothing read it unless a
 * person did. The sources do not share one failure domain, which is why each
 * section says what it could not read rather than the run failing as a unit:
 *
 *   - error fingerprints — `scripts/admin/survey-errors.mjs`, which resolves
 *     the admin token itself and prints JSON on stdout;
 *   - the analysis items behind `/improve` — `GET /admin/analysis`, the
 *     server's own LLM pass over errors and feedback, read here rather than
 *     synced into docs/TODO.md (decision mc-2);
 *   - AI-provider errors — `inspect-ai-provider-errors.mjs`, which does not
 *     use the admin token at all but shells out to `wrangler d1 execute
 *     --remote`, so it fails alone and differently;
 *   - deploys — `GET /admin/deploy/logs`, the same `deploy:index` KV key the
 *     nightly `checkDeployAge` reads, so the helper computes the age itself;
 *   - D1 health — `GET /ping-d1`, which needs no credential at all.
 *
 * Which surface, and why it matters: `/admin/*` is the admin-token surface,
 * `/api/admin/*` is session-admin. Measured against production 2026-08-29,
 * `/api/admin/health`, `/api/admin/operations/status` and
 * `/api/admin/analysis` all answer 401 to a bearer token — "Not logged in or
 * session has expired." Only a browser session reaches them. So the
 * operations projection is not in this digest; it is the first thing the
 * helper will propose exposing.
 *
 * The delta is the point of the file. Neither the scripts nor the routes know
 * what a previous run saw, so the previous digest is the only baseline there
 * is — which makes this file's own format the state, and is why it carries a
 * machine-readable block at the end.
 *
 * The helper reads production and never writes to it. That is the Contract,
 * and it is why `/ping-kv` is not called even though it would report KV
 * health: it writes a probe key and deletes it again.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { cliFailing, cliRows as cliCollect, renderCliSections } from './helper-cli-collect.js';
import { workRoot } from './paths.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Fingerprints asked of `/api/admin/errors`, whose own limit caps at 200. */
export const DEFAULT_LIMIT = 50;

/** Hits in the window above which a *new* fingerprint is marked `!`. */
export const DEFAULT_THRESHOLD = 20;

/** `checkDeployAge`'s own threshold, so the digest agrees with the task. */
export const DEPLOY_STALE_HOURS = 36;

/** The name of the secret the admin surface wants. */
const TOKEN_KEY = 'ADMIN_TOKEN';
const TOKEN_FILE = '.dev.vars';

/** The checkout the admin scripts and the local secrets file live in. */
export function memoroRoot(env = process.env) {
  return env.MC_MEMORO_ROOT || join(env.MC_REPOS_HOME || homedir(), 'memoro');
}

export function intakeDir(env = process.env) {
  return join(workRoot(env), 'intake');
}

/**
 * Where the bare `mc helper` session stands — its own room beside
 * `~/mc/brief/`, and not `~/mc/intake/`: the intake turn's material is not
 * that session's business, and standing in the directory it must not read
 * would be an odd way to say so.
 */
export function helperDir(env = process.env) {
  return join(workRoot(env), 'helper');
}

export function proposalsDir(env = process.env) {
  return join(intakeDir(env), 'proposals');
}

export function baseUrl(env = process.env) {
  return env.MEMORO_BASE_URL || 'https://meetmemoro.app';
}

/**
 * The admin token, from the same places `sync-todo.mjs` looks: the
 * environment first, then the local secrets file in the memoro checkout. It
 * is never rendered, logged or returned — only handed to `fetch` as a bearer.
 */
export function readAdminToken(root, env = process.env) {
  if (env[TOKEN_KEY]) return env[TOKEN_KEY];
  try {
    const line = new RegExp(`^${TOKEN_KEY}\\s*=\\s*(.+)$`, 'mu');
    const match = readFileSync(join(root, TOKEN_FILE), 'utf8').match(line);
    if (match) return match[1].trim().replace(/^"|"$/gu, '');
  } catch { /* no checkout, no file, no token */ }
  return null;
}

/** What to say when there is no token, without naming a value. */
export const NO_TOKEN = `no ${TOKEN_KEY} in the environment or in the memoro checkout`;

/**
 * Why the operations projection is absent, in the digest's own words. It is a
 * standing fact about the routes, not a transient failure, so the collect
 * step does not spend a request on it every day to rediscover the 401.
 */
export const OPERATIONS_UNREACHABLE = 'The nightly and morning task outcomes are not in this digest. '
  + '`/api/admin/operations/status` and `/api/admin/health` are session-admin routes: measured against '
  + 'production on 2026-08-29 both answer 401 — "Not logged in or session has expired." — to a bearer '
  + 'admin token, and there is no token-surface equivalent under `/admin/`. Exposing them to the token '
  + 'is the helper\'s first candidate proposal.';

/* -------------------------------------------------------------------- state */

const STATE_OPEN = '<!-- mc-helper:state v1';
const STATE_CLOSE = '-->';

/**
 * What a digest hands the next one: the fingerprints it saw with their
 * counts, and the operational conditions that were failing when it was
 * written. Two lists, one line each, because a delta needs a baseline and
 * nothing in memoro keeps one.
 */
export function renderState({ fingerprints = [], failing = [] }) {
  const lines = [STATE_OPEN];
  for (const f of fingerprints) lines.push(`fingerprint ${f.fingerprint} ${f.count}`);
  for (const name of failing) lines.push(`failing ${name}`);
  lines.push(STATE_CLOSE);
  return lines.join('\n');
}

export function parseState(text) {
  const body = String(text || '');
  const from = body.indexOf(STATE_OPEN);
  const state = { fingerprints: new Map(), failing: new Set() };
  if (from < 0) return state;
  const to = body.indexOf(STATE_CLOSE, from);
  const block = body.slice(from + STATE_OPEN.length, to < 0 ? body.length : to);
  for (const line of block.split('\n')) {
    const fingerprint = line.match(/^fingerprint\s+(\S+)\s+(\d+)\s*$/u);
    if (fingerprint) { state.fingerprints.set(fingerprint[1], Number(fingerprint[2])); continue; }
    const failing = line.match(/^failing\s+(\S+)\s*$/u);
    if (failing) state.failing.add(failing[1]);
  }
  return state;
}

/** The repositories the helper collects for, and the order it names them in. */
export const HELPER_REPOS = Object.freeze(['memoro', 'memoro-cli']);

/**
 * One digest per repository, named for it.
 *
 * `errors-<date>.md` was the name while memoro was the only thing with a
 * production to read. memoro-cli has one too — this machine — so the name
 * carries the repository, and the two deltas cannot end up measured against
 * each other's baseline.
 */
export function digestName(now, repo = 'memoro') {
  return `errors-${repo}-${now.toISOString().slice(0, 10)}.md`;
}

/**
 * The newest digest that is not the one about to be written. Two runs on the
 * same day therefore both measure against yesterday, instead of the second
 * comparing today's file with itself and reporting nothing new.
 *
 * memoro also accepts the old unprefixed `errors-<date>.md`. Renaming a file
 * whose entire purpose is to be *the previous one* would otherwise throw away
 * a day of delta: the first run after the rename would find no baseline and
 * report an ordinary Tuesday's fingerprints as all new. The fallback costs
 * four lines and stops mattering once no unprefixed digest is left.
 */
export function previousDigest(dir, exclude, repo = 'memoro') {
  const own = new RegExp(`^errors-${repo}-\\d{4}-\\d{2}-\\d{2}\\.md$`, 'u');
  const legacy = /^errors-\d{4}-\d{2}-\d{2}\.md$/u;
  let names = [];
  try {
    names = readdirSync(dir)
      .filter((name) => name !== exclude && (own.test(name) || (repo === 'memoro' && legacy.test(name))))
      // By date, not by name: `errors-memoro-2026-08-29.md` and
      // `errors-2026-08-30.md` sort wrongly against each other as strings.
      .sort((a, b) => dateIn(a).localeCompare(dateIn(b)));
  } catch { return null; }
  const name = names.at(-1);
  if (!name) return null;
  try { return { name, text: readFileSync(join(dir, name), 'utf8') }; } catch { return null; }
}

function dateIn(name) {
  return /(\d{4}-\d{2}-\d{2})\.md$/u.exec(name)?.[1] || '';
}

/* -------------------------------------------------------------------- delta */

/**
 * What this digest knows that the previous one did not: fingerprints absent
 * from the baseline, and conditions failing now that were not failing then. A
 * first run has no baseline and says so rather than calling everything new.
 */
export function computeDelta({ fingerprints = [], failing = [], previous, threshold = DEFAULT_THRESHOLD }) {
  if (!previous) return { first: true, fingerprints: [], failing: [] };
  const state = parseState(previous.text);
  const fresh = fingerprints
    .filter((f) => !state.fingerprints.has(f.fingerprint))
    .map((f) => ({ ...f, loud: (f.count || 0) >= threshold }));
  fresh.sort((a, b) => (b.count || 0) - (a.count || 0));
  return {
    first: false,
    fingerprints: fresh,
    failing: failing.filter((name) => !state.failing.has(name)),
  };
}

/* ------------------------------------------------------------ source shapes */

/** `survey-errors.mjs` output → the fingerprint rows the digest renders. */
export function errorRows(survey) {
  const top = Array.isArray(survey?.topFingerprints) ? survey.topFingerprints : [];
  return top.map((e) => ({
    fingerprint: String(e.fingerprint || ''),
    message: String(e.normalizedMessage || ''),
    count: Number(e.count) || 0,
    status: e.status || 'unknown',
    firstSeen: e.firstSeen || null,
    lastSeen: e.lastSeen || null,
  })).filter((e) => e.fingerprint);
}

/** `/admin/analysis` → the items the server's own LLM pass produced. */
export function analysisRows(analysis) {
  const items = Array.isArray(analysis?.items) ? analysis.items : [];
  return items.map((item) => ({
    priority: item.priority || 'unknown',
    title: String(item.title || '').trim(),
    category: item.category || null,
    sourceType: item.source_type || null,
    occurrences: Number(item.occurrence_count) || 0,
    files: Array.isArray(item.affected_files) ? item.affected_files : [],
    refs: Array.isArray(item.source_refs) ? item.source_refs : [],
    suggestedFix: item.suggested_fix || null,
  }));
}

/**
 * `/admin/deploy/logs` → the same verdict `checkDeployAge` reaches, computed
 * here because the task keeps its numbers to itself.
 *
 * `silent` is the case worth a proposal on its own: an empty index does not
 * mean no deploys, it means the GitHub deploy webhook is writing nothing, and
 * the nightly task has been calling that stale to an empty room ever since.
 */
export function deployState(payload, { now = new Date(), staleAfterHours = DEPLOY_STALE_HOURS } = {}) {
  const logs = Array.isArray(payload?.logs) ? payload.logs : [];
  const production = logs.filter((entry) => (entry.environment || 'production') === 'production');
  const lastSuccess = production.find((entry) => entry.status === 'success') || null;
  const consecutiveFailures = lastSuccess ? production.indexOf(lastSuccess) : production.length;
  const ageHours = lastSuccess
    ? Math.round((now.getTime() - new Date(lastSuccess.timestamp).getTime()) / 3_600_000)
    : null;
  return {
    silent: logs.length === 0,
    entries: logs.length,
    lastSuccess,
    ageHours,
    stale: !lastSuccess || ageHours > staleAfterHours,
    consecutiveFailures,
    staleAfterHours,
  };
}

/** `/ping-d1` → D1's own verdict, and the calls it timed. */
export function healthState(ping) {
  const timings = ping?.timings || {};
  const slow = Array.isArray(ping?.slow) ? ping.slow : [];
  return { d1: ping?.d1 || (ping?.ok ? 'healthy' : 'unknown'), totalMs: timings.total ?? null, slow };
}

/**
 * The named conditions the delta watches — the operational half of "what is
 * new". Fingerprints are the other half and carry their own identity.
 */
export function failingConditions({ deploy, health }) {
  const failing = [];
  if (deploy && !deploy.error) {
    if (deploy.silent) failing.push('deploy-webhook-silent');
    else if (deploy.stale) failing.push('deploy-stale');
    if (deploy.consecutiveFailures > 0) failing.push('deploy-failures');
  }
  if (health?.error) failing.push('d1-unreachable');
  else if (health && health.d1 !== 'healthy') failing.push('d1-unhealthy');
  return failing;
}

/* ------------------------------------------------------------------- render */

const clip = (text, max = 110) => {
  const one = String(text || '').replace(/\s+/gu, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};
const stamp = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/u, 'Z');
const short = (iso) => (iso ? String(iso).slice(0, 16).replace('T', ' ') : '—');

export function renderDigest({
  now, since, previous, threshold, delta, errors, analysis, provider, health, deploy, mainCommit, notes = [],
}) {
  const out = [];
  out.push(`# Errors and maintenance — ${stamp(now)}`, '');
  out.push(previous
    ? `Baseline: \`${previous.name}\`. Window: since ${stamp(since)}.`
    : `First digest — no baseline, so nothing is called new. Window: since ${stamp(since)}.`);
  for (const note of notes) out.push(`> ${note}`);
  out.push('');

  out.push('## New since the last digest', '');
  if (delta.first) out.push('_first digest — no baseline_');
  else if (!delta.fingerprints.length && !delta.failing.length) out.push('_nothing new_');
  else {
    for (const f of delta.fingerprints) {
      out.push(`- ${f.loud ? '!' : '·'} \`${f.fingerprint}\` — ${f.count}× ${f.status} — ${clip(f.message)}`);
    }
    for (const name of delta.failing) out.push(`- ! \`${name}\` — failing now, and not in the last digest`);
    out.push('', `\`!\` = a new fingerprint at or above ${threshold} hits in the window, or a condition that has just started failing.`);
  }
  out.push('');

  out.push('## Error fingerprints', '');
  if (errors.error) out.push(`_could not read: ${errors.error}_`);
  else if (!errors.rows.length) out.push('_no fingerprints in the window_');
  else {
    const summary = Object.entries(errors.byStatus || {})
      .map(([status, g]) => `${status}: ${g.fingerprints} fingerprints / ${g.occurrences} occurrences`)
      .join(' · ');
    if (summary) out.push(summary, '');
    out.push('| fingerprint | hits | status | last seen | message |', '|---|---|---|---|---|');
    for (const e of errors.rows) {
      out.push(`| \`${e.fingerprint}\` | ${e.count} | ${e.status} | ${short(e.lastSeen)} | ${clip(e.message, 90)} |`);
    }
  }
  out.push('');

  out.push('## Analysis items', '');
  if (analysis.error) out.push(`_could not read: ${analysis.error}_`);
  else if (!analysis.rows.length) out.push(`_no items${analysis.message ? ` — ${clip(analysis.message)}` : ''}_`);
  else {
    if (analysis.analyzedAt) out.push(`Analysed ${short(analysis.analyzedAt)} over ${analysis.errorsAnalyzed ?? '?'} errors.`, '');
    out.push('| priority | title | occurrences | files |', '|---|---|---|---|');
    for (const item of analysis.rows) {
      out.push(`| ${item.priority} | ${clip(item.title, 80)} | ${item.occurrences} | ${clip(item.files.join(', '), 60)} |`);
    }
  }
  out.push('');

  out.push('## AI-provider errors', '');
  if (provider.error) out.push(`_could not read: ${provider.error}_`);
  else if (!provider.reasons.length) out.push('_no provider refusals in the window_');
  else {
    out.push('| provider | model | reason | calls | last seen |', '|---|---|---|---|---|');
    for (const r of provider.reasons) {
      out.push(`| ${r.provider} | ${clip(r.model, 30)} | ${clip(r.providerErrorType || r.errorCode || '—', 50)} | ${r.calls} | ${short(r.lastSeen)} |`);
    }
  }
  out.push('');

  out.push('## Health', '');
  if (health.error) out.push(`_could not read: ${health.error}_`);
  else {
    out.push(`D1: **${health.d1}**${health.totalMs != null ? ` (${health.totalMs} ms)` : ''}${health.slow.length ? ` — slow: ${health.slow.join(', ')}` : ''}`);
  }
  out.push('', 'D1 is the only service in this section. KV health is behind `/ping-kv`, which writes a probe '
    + 'key and deletes it — a write, so the Contract keeps the helper out of it. R2, Vectorize, queues and '
    + 'the secrets check are only in `/api/admin/health`, which a bearer token cannot reach.', '');

  out.push('## Deploy', '');
  if (deploy.error) out.push(`_could not read: ${deploy.error}_`);
  else if (deploy.silent) {
    out.push('- **The deploy log is empty.** `deploy:index` holds nothing, so the GitHub deploy webhook is '
      + 'writing nothing — and the nightly `checkDeployAge` has been returning `stale: true` to no reader '
      + 'the whole time. Nothing here says whether the site is actually behind.');
  } else {
    out.push(`- Last successful production deploy: ${deploy.lastSuccess ? `${short(deploy.lastSuccess.timestamp)} (${deploy.lastSuccess.branch}, run ${deploy.lastSuccess.run_id})` : 'none in the last 20 entries'}`);
    out.push(`- Age: ${deploy.ageHours == null ? 'unknown' : `${deploy.ageHours} h`}${deploy.stale ? ` — **stale**, over ${deploy.staleAfterHours} h` : ''}`);
    if (deploy.consecutiveFailures > 0) out.push(`- ${deploy.consecutiveFailures} production deploy(s) failed since that success`);
  }
  out.push(mainCommit
    ? `- origin/main in the local checkout: ${mainCommit}`
    : '- origin/main: not read from a local checkout');
  out.push('');

  out.push('## Not readable', '');
  out.push(OPERATIONS_UNREACHABLE);
  out.push('');

  out.push(renderState({ fingerprints: errors.rows, failing: failingConditions({ deploy, health }) }), '');
  return out.join('\n');
}

/* ------------------------------------------------------------------ words */

/**
 * The one line a runner log and a person share: what the digest found that
 * the previous one had not. `mc helper --intake` prints it and `mc run` writes it into
 * the round's log, so the two can never describe the same digest differently.
 */
export function describeDigest({ delta, errors }) {
  if (delta.first) return `first digest, ${errors.rows.length} fingerprints — no baseline yet`;
  const loud = delta.fingerprints.filter((f) => f.loud).length;
  const parts = [`${delta.fingerprints.length} new fingerprint${delta.fingerprints.length === 1 ? '' : 's'}`];
  if (loud) parts.push(`${loud} above the threshold`);
  if (delta.failing.length) {
    parts.push(`${delta.failing.length} newly failing condition${delta.failing.length === 1 ? '' : 's'}`);
  }
  return parts.join(', ');
}

/** Every section that could not be read, so a partial digest still complains. */
export function unreadableSections({ errors, analysis, provider, health, deploy }) {
  return [
    ['error fingerprints', errors],
    ['analysis items', analysis],
    ['AI-provider errors', provider],
    ['D1 health', health],
    ['deploy logs', deploy],
  ].filter(([, source]) => source?.error);
}

/* ------------------------------------------------------------------ collect */

/** A memoro admin script, run in the memoro checkout, its JSON stdout parsed. */
function runScriptDefault(cwd, args, timeout) {
  return new Promise((resolve) => {
    execFile('node', args, { cwd, encoding: 'utf8', timeout, maxBuffer: 16 << 20 }, (error, stdout, stderr) => {
      if (error) {
        const why = (stderr || '').trim().split('\n').at(-1) || error.message;
        resolve({ ok: false, error: clip(why, 160) });
        return;
      }
      try { resolve({ ok: true, json: JSON.parse(stdout) }); } catch { resolve({ ok: false, error: 'output was not JSON' }); }
    });
  });
}

/**
 * A GET against a memoro route. `token` is null for the public probes; a
 * route that wants one and does not get one is reported, not attempted.
 * Every call here is a GET — the helper has no write path at all.
 */
async function getJsonDefault(url, token) {
  if (token === null) return { ok: false, error: NO_TOKEN };
  try {
    const response = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}`, 'X-Operator-Purpose': 'maintenance' } : {},
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, error: `${new URL(url).pathname} returned ${response.status}` };
    try { return { ok: true, json: JSON.parse(text) }; } catch { return { ok: false, error: 'response was not JSON' }; }
  } catch (error) {
    return { ok: false, error: clip(error?.message || String(error), 120) };
  }
}

function runGitDefault(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 20_000 }, (error, stdout) => {
      resolve(error ? null : stdout.trim());
    });
  });
}

/**
 * Gather the sources and write `<work root>/intake/errors-<date>.md`.
 * Returns the path, the rendered text, and the data behind it.
 *
 * Nothing here is fatal on its own. A section that could not be read says so
 * in the digest and the run still succeeds — wrangler being unauthenticated
 * must not cost us the others.
 */
export async function collectHelper({
  env = process.env,
  now = new Date(),
  since = null,
  limit = DEFAULT_LIMIT,
  threshold = DEFAULT_THRESHOLD,
  memoro = memoroRoot(env),
  script = runScriptDefault,
  getJson = getJsonDefault,
  git = runGitDefault,
  // Which repository's production to read. memoro's is five remote sources;
  // memoro-cli's is this machine (helper-cli-collect.js). Same delta, same
  // state block, same threshold — one notion of "new since yesterday".
  repo = 'memoro',
  cli = cliCollect,
} = {}) {
  if (repo === 'memoro-cli') {
    return collectCli({ env, now, since, threshold, cli });
  }
  const dir = intakeDir(env);
  const name = digestName(now, repo);
  const windowStart = since ? new Date(since) : new Date(now.getTime() - DAY_MS);
  const notes = [];

  const haveCheckout = existsSync(join(memoro, 'scripts', 'admin', 'survey-errors.mjs'));
  if (!haveCheckout) notes.push(`no memoro checkout at ${memoro} — the two admin scripts cannot run`);
  const token = readAdminToken(memoro, env);
  const base = baseUrl(env);
  const missing = { ok: false, error: `no memoro checkout at ${memoro}` };

  const [survey, providerRaw, analysisRaw, deployRaw, pingRaw, mainCommit] = await Promise.all([
    haveCheckout
      ? script(memoro, ['scripts/admin/survey-errors.mjs', '--env', 'production',
        '--limit', String(limit), '--since', windowStart.toISOString()], 60_000)
      : missing,
    haveCheckout
      ? script(memoro, ['scripts/admin/inspect-ai-provider-errors.mjs', '--env', 'production', '--days', '1'], 180_000)
      : missing,
    getJson(`${base}/admin/analysis`, token),
    getJson(`${base}/admin/deploy/logs?limit=20`, token),
    getJson(`${base}/ping-d1`, ''),
    haveCheckout ? git(memoro, ['log', '-1', '--format=%h %cI', 'origin/main']) : null,
  ]);

  const errors = survey.ok
    ? { rows: errorRows(survey.json), byStatus: survey.json?.byStatus || {} }
    : { rows: [], byStatus: {}, error: survey.error };
  const provider = providerRaw.ok
    ? { reasons: Array.isArray(providerRaw.json?.reasons) ? providerRaw.json.reasons : [] }
    : { reasons: [], error: providerRaw.error };
  const analysis = analysisRaw.ok
    ? {
      rows: analysisRows(analysisRaw.json),
      message: analysisRaw.json?.message || null,
      analyzedAt: analysisRaw.json?.analyzedAt || null,
      errorsAnalyzed: analysisRaw.json?.errorsAnalyzed ?? null,
    }
    : { rows: [], error: analysisRaw.error };
  const deploy = deployRaw.ok
    ? deployState(deployRaw.json, { now })
    : { error: deployRaw.error };
  const health = pingRaw.ok ? healthState(pingRaw.json) : { error: pingRaw.error };

  const previous = previousDigest(dir, name, repo);
  const delta = computeDelta({
    fingerprints: errors.rows, failing: failingConditions({ deploy, health }), previous, threshold,
  });

  const text = renderDigest({
    now, since: windowStart, previous, threshold, delta,
    errors, analysis, provider, health, deploy, mainCommit, notes, repo,
  });
  mkdirSync(dir, { recursive: true });
  mkdirSync(proposalsDir(env), { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, text);
  return {
    path,
    text,
    repo,
    data: { since: windowStart, previous, delta, errors, analysis, provider, health, deploy, mainCommit, notes },
  };
}

/**
 * The memoro-cli digest: same delta, same state block, same file shape.
 *
 * It reads no network and holds no credential — everything it needs is
 * already on this disk, written by mc about itself. That is why it is the
 * cheap half and why it can run every day without asking anybody for a token.
 */
async function collectCli({ env, now, since, threshold, cli = cliCollect }) {
  const dir = intakeDir(env);
  const repo = 'memoro-cli';
  const name = digestName(now, repo);
  const windowStart = since ? new Date(since) : new Date(now.getTime() - DAY_MS);
  const measured = cli({ since: windowStart, now });
  const failing = cliFailing({ open: measured.open, lastRun: measured.lastRun, now });
  const previous = previousDigest(dir, name, repo);
  const delta = computeDelta({ fingerprints: measured.rows, failing, previous, threshold });

  const out = [];
  out.push(`# mc itself — ${stamp(now)}`, '');
  out.push(previous
    ? `Baseline: \`${previous.name}\`. Window: since ${stamp(windowStart)}.`
    : `First digest for ${repo} — no baseline, so nothing is called new. Window: since ${stamp(windowStart)}.`);
  out.push('', 'memoro-cli has no server to ask. Its production is this machine, and it records',
    'what happens in `logs/mc.log`, `gate-rounds.jsonl`, `repo-leases/leases.log` and',
    '`runner/log/runs.tsv`. This is those four, counted.', '');

  out.push('## New since the last digest', '');
  if (delta.first) out.push('_first digest — no baseline_');
  else if (!delta.fingerprints.length && !delta.failing.length) out.push('_nothing new_');
  else {
    for (const f of delta.fingerprints) out.push(`- ${f.loud ? '!' : '·'} \`${f.fingerprint}\` — ${f.count}× ${f.status} — ${clip(f.message)}`);
    for (const one of delta.failing) out.push(`- ! \`${one}\` — failing now, and not in the last digest`);
    out.push('', `\`!\` = a new fingerprint at or above ${threshold} hits in the window, or a condition that has just started failing.`);
  }
  out.push('');
  out.push(...renderCliSections({ cli: measured, threshold }));
  out.push('## Failing now', '');
  if (!failing.length) out.push('_nothing_');
  else for (const one of failing) out.push(`- \`${one}\``);
  out.push('');
  out.push(renderState({ fingerprints: measured.rows, failing }));

  const text = `${out.join('\n')}\n`;
  mkdirSync(dir, { recursive: true });
  mkdirSync(proposalsDir(env), { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, text);
  return {
    path,
    text,
    repo,
    data: {
      since: windowStart, previous, delta, notes: measured.notes,
      errors: { rows: measured.rows, byStatus: measured.byStatus },
      open: measured.open, failing, lastRun: measured.lastRun,
    },
  };
}
