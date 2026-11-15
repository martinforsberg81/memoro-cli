/**
 * The check after a deploy (2026-11-15), as functions with their boundaries
 * passed in: the parts of it, the error comparison and the verdict. The runner
 * starts `deploy-check-run.js` for one due row (`deployCheckTick`, below); that
 * entry loads the row and calls `runCheck` here with the real boundaries.
 *
 * The parts, each `green`, `red` or `could-not-run` with its reason:
 *   version   — production's `/api/version` is the row's commit;
 *   database  — `/ping-d1` answers and says `d1: "healthy"`;
 *   suites    — the gating suites of the row's `.mc/test.json`, as the seeded
 *               account, through `productionRound` (what `mc test prod` runs);
 *   errors    — fingerprints that are new since the deploy.
 *
 * A check that could not run is a verdict of its own. Green is only ever what
 * every part said, so a part that did not run, a skipped suite, a missing
 * answer and a commit that is not the row's can never add up to it
 * (`combine`): phase 3 acts on green.
 *
 * Nothing here is typed and no session runs it. The check holds the production
 * token of the seeded account and the admin token the survey script finds, and
 * only the runner's own child may.
 */
import { spawn } from 'node:child_process';
import {
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeJsonAtomic } from './atomic-write.js';
import { deployWorktreePath, placeWorktree, takeHolder } from './deploy-worktree.js';
import { DEPLOYED, deploysPath, readDeploys, recordCheck, runningDeploy } from './deploys.js';
import { processAlive } from './lease-owner.js';
import { installedScript } from './merger.js';
import { exportAtRev, reasonLine } from './export-at-rev.js';
import { tryGit } from './git.js';
import { workRoot } from './paths.js';
import { sameCommit } from './same-commit.js';
import { isGate, parseDeclaration, productionRound } from './test-environment.js';
import { runBounded } from './take-back.js';

export const GREEN = 'green';
export const RED = 'red';
export const COULD_NOT_RUN = 'could-not-run';

/** The parts a verdict needs; a green verdict has every one of them, green. */
export const PARTS = ['version', 'database', 'suites', 'errors'];

/** How long a request may take, answer and body (D4). */
export const REQUEST_MS = 30_000;
/** The check waits until the row's `ended` plus this before it reads the errors. */
export const SETTLE_MS = 30 * 60_000;
/** The attempt's deadline is `max(its start, ended + SETTLE_MS) + GRACE_MS`. */
export const GRACE_MS = 30 * 60_000;
/** The error survey before the deploy reaches this far back. */
export const BEFORE_WINDOW_MS = 24 * 60 * 60_000;
/** One survey, and the before-reading as a whole, is bounded at this. */
export const SURVEY_MS = 60_000;
export const SURVEY_LIMIT = 200;
/** A reason names at most this many fingerprints, each with this much of its message. */
export const FINGERPRINTS_NAMED = 5;
export const MESSAGE_CHARS = 80;
/** How long the check waits for the deploy worktree before it says it could not. */
export const HOLDER_WAIT_MS = 10 * 60_000;
export const HOLDER_VERB = 'deploy check';
export const SURVEY_SCRIPT = 'scripts/admin/survey-errors.mjs';

const short = (sha) => String(sha || '').slice(0, 7);
const oneLine = (text) => String(text ?? '').replace(/\s+/gu, ' ').trim();
const realSleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

/**
 * The verdict in the words every place says it in (D8): the page's RECORDED line,
 * `mc deploy`'s plan, the helper digest. `checking` is an attempt whose process
 * is alive; an empty cell with none is "not checked" — a row older than the
 * chore, one the runner never reached. Without the leading `· `.
 */
export function checkWords({ check = '', check_why: why = '' } = {}, { checking = false } = {}) {
  if (check === GREEN) return 'checked green';
  if (check === RED) return `check red${why ? `: ${why}` : ''}`;
  if (check === COULD_NOT_RUN) return `check could not run${why ? `: ${why}` : ''}`;
  return checking ? 'checking' : 'not checked';
}

/* ------------------------------------------------------------------ places */

/** Where the check keeps what it writes: the verdicts, the before-readings, the logs. */
export function checkDir(env = process.env) {
  return join(dirname(deploysPath(env)), 'deploy-check');
}
export const verdictPath = (env, started) => join(checkDir(env), `${started}.verdict.json`);
export const beforePath = (env, started) => join(checkDir(env), `${started}.before.json`);
export const logPath = (env, started) => join(checkDir(env), `${started}.log`);
/** The chore's own state: `from`, and the attempt in flight. */
export const statePath = (env = process.env) => join(workRoot(env), 'runner', 'deploy-check.json');

/* ------------------------------------------------------------- stored time */

/**
 * A time as the error store keeps it and compares it: UTC, `YYYY-MM-DD
 * HH:MM:SS`. The store compares text, and an ISO `T`/`Z` string against that
 * form reads every error of the same day as older than the deploy (the `T` sorts
 * after the space), so `since` is never given in ISO.
 */
export function storedTime(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** A time read back — the stored form, or ISO — as milliseconds, NaN when it is neither. */
export function readStored(text) {
  const value = String(text ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/u.test(value)) return Date.parse(`${value.replace(' ', 'T')}Z`);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/u.test(value)) return Date.parse(value);
  return Number.NaN;
}

/* ------------------------------------------------------------------ parts */

const part = (name, verdict, why = '') => ({ part: name, verdict, why: verdict === GREEN ? '' : why });

/**
 * One request, bounded: the answer and its body are both inside `timeoutMs`,
 * and a fetch that ignores its signal is still given up on at the bound.
 */
export async function ask(url, { fetchImpl = globalThis.fetch, timeoutMs = REQUEST_MS } = {}) {
  const controller = new AbortController();
  let timer = null;
  const bound = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ failed: `no answer, with its body, in ${Math.round(timeoutMs / 1000)} s` });
    }, timeoutMs);
  });
  const answer = (async () => {
    try {
      const response = await fetchImpl(url, { cache: 'no-store', signal: controller.signal });
      const text = await response.text();
      return { status: response.status, ok: response.status >= 200 && response.status < 300, text };
    } catch (error) {
      return { failed: error?.message || String(error) };
    }
  })();
  try { return await Promise.race([answer, bound]); } finally { clearTimeout(timer); }
}

const jsonOf = (text) => { try { return JSON.parse(text); } catch { return null; } };

/** What `/api/version` said, as `{ commit, commitFull }`, or the part that says why not. */
export async function readVersion(base, options) {
  const answer = await ask(`${base}/api/version`, options);
  if (answer.failed) return { part: part('version', COULD_NOT_RUN, `/api/version: ${answer.failed}`) };
  if (!answer.ok) return { part: part('version', RED, `/api/version answered ${answer.status}`) };
  const body = jsonOf(answer.text);
  const commit = typeof body?.commit === 'string' ? body.commit.trim() : '';
  const commitFull = typeof body?.commit_full === 'string' ? body.commit_full.trim() : '';
  if (!commit && !commitFull) return { part: part('version', COULD_NOT_RUN, '/api/version named no commit') };
  return { commit, commitFull };
}

/**
 * Is production at the row's commit? `commit_full` when the answer has it,
 * `commit` (seven characters) by the shorter-length rule `sameCommit` compares
 * on otherwise. Another commit is could-not-run — production is not what the
 * row shipped, and a check of something else says nothing about the row.
 */
export function judgeVersion(read, sha, { second = false } = {}) {
  if (read.part) return second ? { ...read.part, why: `second read: ${read.part.why}` } : read.part;
  const seen = read.commitFull || read.commit;
  const same = read.commitFull ? sameCommit(read.commitFull, sha) : sameCommit(read.commit, sha);
  if (same) return part('version', GREEN);
  return part('version', COULD_NOT_RUN, second
    ? `production changed during the check: it is at ${seen.slice(0, 12)}, not ${short(sha)}`
    : `production is at ${seen.slice(0, 12)}, not ${short(sha)}`);
}

/** `/ping-d1`: a non-2xx answer, or a `d1` that is not "healthy", is red. */
export async function checkDatabase(base, options) {
  const answer = await ask(`${base}/ping-d1`, options);
  if (answer.failed) return part('database', COULD_NOT_RUN, `/ping-d1: ${answer.failed}`);
  if (!answer.ok) return part('database', RED, `/ping-d1 answered ${answer.status}`);
  const d1 = jsonOf(answer.text)?.d1;
  return d1 === 'healthy' ? part('database', GREEN) : part('database', RED, `/ping-d1 says d1 is ${d1 === undefined ? 'not given' : JSON.stringify(d1)}`);
}

/**
 * A production round's results as the suites part. Red is a gating suite that
 * failed; skipped (the declared skip exit), unmeasured (production stopped
 * answering under it) and a suite that never ran are could-not-run, with the
 * suite's own words. A round with no gating suite is could-not-run, never green.
 */
export function judgeSuites(round, { names = [] } = {}) {
  const results = round?.results || [];
  const red = results.filter((r) => !r.ok && !r.unmeasured && !r.skipped);
  if (red.length) {
    return part('suites', RED, `${red.map((r) => `${r.name} (exit ${r.status ?? 'none'})`).join(', ')} red`);
  }
  const others = [];
  for (const r of results.filter((one) => one.unmeasured)) others.push(`${r.name} unmeasured — production stopped answering while it ran`);
  for (const r of results.filter((one) => one.skipped)) others.push(`${r.name} skipped${round.account && !round.account.available ? ` (${round.account.why})` : ''}`);
  if (round?.skipped?.length) others.push(`${round.skipped.join(', ')} never ran — production stopped answering`);
  if (round?.gone?.length && !others.length) others.push('production stopped answering during the round');
  if (others.length) return part('suites', COULD_NOT_RUN, others.join('; '));
  if (!results.length || (names.length && results.length < names.length)) {
    return part('suites', COULD_NOT_RUN, results.length ? `only ${results.length} of ${names.length} gating suites ran` : 'no gating suite ran');
  }
  return part('suites', GREEN);
}

/**
 * The gating suites at the row's sha, run as `mc test prod` runs them. The
 * deploy worktree is taken (its holder, verb `deploy check`), put at the row's
 * sha by `placeWorktree`, and released when the round has ended; one that is
 * held too long, or cannot be put there, is could-not-run. No server is
 * started: production has one address, and the declaration says it.
 */
export async function checkSuites({ sha, declaration, baseUrl, env, say = () => {} }, deps = {}) {
  const names = declaration.suites.filter(isGate).map((suite) => suite.name);
  if (!names.length) return part('suites', COULD_NOT_RUN, 'the declaration has no gating suite');
  const holder = await (deps.takeHolder || takeHolder)({
    env, verb: HOLDER_VERB, say, waitMs: deps.holderWaitMs ?? HOLDER_WAIT_MS, ...(deps.holder || {}),
  });
  if (!holder.ok) return part('suites', COULD_NOT_RUN, holder.reason);
  try {
    const worktree = (deps.worktreePath || deployWorktreePath)(env);
    const placed = (deps.place || placeWorktree)({ worktree, sha });
    if (!placed.ok) return part('suites', COULD_NOT_RUN, `the checkout could not be put at ${short(sha)}: ${placed.reason}`);
    // The declaration of the checkout the suites run in is the one that is read;
    // `declaration` was read from the same commit, so they agree.
    const round = await (deps.round || productionRound)({
      declaration, worktree, baseUrl, gateOnly: true, env, ...(deps.roundOptions || {}),
    }, deps.roundDeps || {});
    return judgeSuites(round, { names });
  } catch (error) {
    return part('suites', COULD_NOT_RUN, `the round could not be run: ${oneLine(error?.message || error)}`);
  } finally {
    try { holder.release(); } catch { /* the holder's record is gone already */ }
  }
}

/* ------------------------------------------------------------------ errors */

/**
 * `survey-errors.mjs` output as `{ total, returned, fingerprints }`, or `{ problem }`.
 * Strict: a survey that does not say how many fingerprints there are cannot be
 * told complete from truncated, and is not read as complete.
 */
export function parseSurvey(text) {
  const json = jsonOf(text);
  if (!json || typeof json !== 'object' || !Array.isArray(json.topFingerprints)) return { problem: 'the survey printed no topFingerprints' };
  const total = Number(json.totalFingerprints);
  const returned = Number(json.returnedFingerprints);
  if (!Number.isFinite(total) || !Number.isFinite(returned)) return { problem: 'the survey did not say how many fingerprints there are' };
  return {
    total,
    returned,
    fingerprints: json.topFingerprints
      .filter((f) => f && typeof f.fingerprint === 'string' && f.fingerprint)
      .map((f) => ({ fingerprint: f.fingerprint, message: oneLine(f.normalizedMessage), firstSeen: f.firstSeen ?? null })),
  };
}

/**
 * The survey of production's errors from the scripts of `sha`, written out with
 * `git archive` into a temporary directory that is the script's cwd — as
 * `takeBackReading` runs its script — and without `--repo`, which this script
 * does not take. The admin token is found by the script itself. `{ ok: true,
 * survey }` or `{ ok: false, why }`; never throws.
 */
export async function readSurvey({
  path, sha, since, run = runBounded, exportTree = exportAtRev, timeoutMs = SURVEY_MS, scratch = tmpdir(),
}) {
  let dir = null;
  try {
    dir = realpathSync(mkdtempSync(join(scratch, 'mc-deploy-check-')));
    const why = exportTree(path, sha, 'scripts', dir);
    if (why) return { ok: false, why: `${SURVEY_SCRIPT} is not on ${short(sha)} (${why})` };
    const script = join(dir, SURVEY_SCRIPT);
    if (!existsSync(script)) return { ok: false, why: `${short(sha)} has no ${SURVEY_SCRIPT}` };
    const result = await run(
      ['node', script, '--env', 'production', '--since', since, '--limit', String(SURVEY_LIMIT)],
      { cwd: dir, timeoutMs },
    );
    if (result.timedOut) return { ok: false, why: `${SURVEY_SCRIPT} did not finish in ${Math.round(timeoutMs / 1000)} s and was stopped` };
    if (result.error) return { ok: false, why: `${SURVEY_SCRIPT} could not be run (${result.error})` };
    if (result.code !== 0) {
      return { ok: false, why: `${SURVEY_SCRIPT} exited ${result.code}${reasonLine(result.stderr) ? `: ${reasonLine(result.stderr)}` : ''}` };
    }
    const parsed = parseSurvey(result.stdout);
    if (parsed.problem) return { ok: false, why: parsed.problem };
    return { ok: true, survey: parsed };
  } catch (error) {
    return { ok: false, why: oneLine(error?.message || error) };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The reading taken right before a deploy is spawned: what production's errors
 * were in the 24 hours before it began. Saved as `<started>.before.json` —
 * `{ ok, taken_at, since, survey | why }` — and returned. A failed, slow or
 * missing script is noted in that file and is nothing else: it never throws,
 * and it is over at `boundMs` whatever the script does.
 */
export async function takeBeforeReading({
  path, sha, started, env = process.env, now = Date.now, boundMs = SURVEY_MS, read = readSurvey, ...options
}) {
  const since = storedTime(Date.parse(started) - BEFORE_WINDOW_MS);
  let timer = null;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, why: `the reading did not finish in ${Math.round(boundMs / 1000)} s` }), boundMs);
  });
  let reading;
  try {
    reading = await Promise.race([read({ path, sha, since, timeoutMs: boundMs, ...options }), late]);
  } catch (error) {
    reading = { ok: false, why: oneLine(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
  const record = { ok: Boolean(reading.ok), taken_at: new Date(now()).toISOString(), since, ...(reading.ok ? { survey: reading.survey } : { why: reading.why || 'no reading' }) };
  try { writeJsonAtomic(beforePath(env, started), record); } catch { /* a reading that cannot be kept is a missing one */ }
  return record;
}

/** The before-reading of a deploy as the check reads it, or the reason there is none. */
export function readBeforeFile(env, started) {
  let text;
  try { text = readFileSync(beforePath(env, started), 'utf8'); } catch { return { ok: false, why: 'no reading was taken before the deploy' }; }
  const record = jsonOf(text);
  if (!record || typeof record !== 'object') return { ok: false, why: 'the reading taken before the deploy is not readable' };
  if (!record.ok) return { ok: false, why: `the reading before the deploy failed: ${oneLine(record.why) || 'no reason given'}` };
  return { ok: true, survey: record.survey };
}

const complete = (survey) => survey.total <= survey.returned;

/**
 * Fingerprints new since the deploy. Red when one of the after-reading has its
 * `firstSeen` at or after the row's `started` — read in the stored form, to the
 * second, so an error first seen in the same second the deploy began counts —
 * or is absent from a complete before-reading: an error that returned. One of
 * any status is enough. Could-not-run, when nothing is red already, when a
 * reading is missing or truncated, the after-reading failed or a `firstSeen`
 * cannot be read. The reason names at most five fingerprints, each with the
 * first 80 characters of its message.
 */
export function judgeErrors({ before, after, started }) {
  if (!after?.ok) return part('errors', COULD_NOT_RUN, `the reading after the deploy failed: ${oneLine(after?.why) || 'no reason given'}`);
  const floor = Math.floor(Date.parse(started) / 1000) * 1000;
  const known = before?.ok && complete(before.survey) ? new Set(before.survey.fingerprints.map((f) => f.fingerprint)) : null;
  const red = [];
  let unreadable = 0;
  for (const f of after.survey.fingerprints) {
    const at = readStored(f.firstSeen);
    if (Number.isFinite(at) && at >= floor) red.push({ f, kind: 'new' });
    else if (known && !known.has(f.fingerprint)) red.push({ f, kind: 'returned' });
    else if (!Number.isFinite(at)) unreadable += 1;
  }
  if (red.length) {
    const named = red.slice(0, FINGERPRINTS_NAMED).map(({ f, kind }) => `${f.fingerprint}${kind === 'returned' ? ' (returned)' : ''} "${f.message.slice(0, MESSAGE_CHARS)}"`);
    const more = red.length > FINGERPRINTS_NAMED ? `, and ${red.length - FINGERPRINTS_NAMED} more` : '';
    return part('errors', RED, `${red.length} fingerprint${red.length === 1 ? '' : 's'} new since the deploy: ${named.join(', ')}${more}`);
  }
  const why = [];
  if (!before?.ok) why.push(before?.why || 'no reading before the deploy');
  else if (!complete(before.survey)) why.push(`the reading before the deploy was truncated (${before.survey.returned} of ${before.survey.total} fingerprints)`);
  if (!complete(after.survey)) why.push(`the reading after the deploy was truncated (${after.survey.returned} of ${after.survey.total} fingerprints)`);
  if (unreadable) why.push(`${unreadable} fingerprint${unreadable === 1 ? '' : 's'} had a firstSeen that could not be read`);
  return why.length ? part('errors', COULD_NOT_RUN, why.join('; ')) : part('errors', GREEN);
}

/* ----------------------------------------------------------------- verdict */

/**
 * The parts as one verdict. Red beats could-not-run, which beats green, and
 * green is only every required part present and green: a part that is missing,
 * or says anything but `green`, keeps the verdict from being green. `check_why`
 * is each non-green part as `<part>: <reason>`, joined by `; `, empty when green.
 */
export function combine(parts, { at = new Date(), required = PARTS } = {}) {
  const list = parts.filter(Boolean);
  const missing = required.filter((name) => !list.some((p) => p.part === name));
  const rest = list.filter((p) => p.verdict !== GREEN);
  const check = list.some((p) => p.verdict === RED)
    ? RED
    : (rest.length || missing.length ? COULD_NOT_RUN : GREEN);
  const why = [
    ...rest.map((p) => `${p.part}: ${p.why || p.verdict}`),
    ...(check === GREEN ? [] : missing.map((name) => `${name}: not run`)),
  ].join('; ');
  return {
    check,
    check_at: new Date(at).toISOString(),
    check_why: check === GREEN ? '' : why,
    parts: list,
  };
}

/* ------------------------------------------------------------ orchestration */

/** The declaration of the commit, `git show <sha>:.mc/test.json`, validated as a worktree's is. */
export function declarationAt(worktree, sha, { git = tryGit } = {}) {
  const text = git(worktree, ['show', `${sha}:.mc/test.json`]);
  if (text === null || text === undefined) return { ok: false, error: `${short(sha)} does not declare .mc/test.json` };
  return parseDeclaration(text, `${short(sha)}:.mc/test.json`);
}

/**
 * The check of one deployed row: `{ check, check_at, check_why, parts }`.
 *
 * Version, database and — only while both are green, because a round against
 * something that is not the row's release says nothing about it — the suites.
 * A red among them ends the check at once. Otherwise it waits until `ended`
 * plus thirty minutes, reads the version again by the same rule (another
 * commit is could-not-run: production changed during the check) and only then
 * the errors. Every part is caught: one that throws is could-not-run.
 */
export async function runCheck({ row, env = process.env, deps = {} }) {
  const now = deps.now || Date.now;
  const sleep = deps.sleep || realSleep;
  const say = deps.say || (() => {});
  const requests = { fetchImpl: deps.fetch || globalThis.fetch, timeoutMs: deps.requestMs ?? REQUEST_MS };
  const sha = row.sha;
  const finish = (parts) => combine(parts, { at: new Date(now()) });
  const guarded = async (name, fn) => {
    try { return await fn(); } catch (error) { return part(name, COULD_NOT_RUN, `could not be checked: ${oneLine(error?.message || error)}`); }
  };

  const worktree = (deps.worktreePath || deployWorktreePath)(env);
  const declared = (deps.declare || ((at) => declarationAt(worktree, at)))(sha);
  if (!declared.ok) return finish([part('suites', COULD_NOT_RUN, `the declaration could not be read: ${oneLine(declared.error)}`)]);
  const declaration = declared.declaration;
  const baseUrl = String(declaration.environments?.prod?.base_url || '').replace(/\/+$/u, '');
  if (!baseUrl) return finish([part('suites', COULD_NOT_RUN, `${short(sha)} declares no production base_url`)]);

  const parts = [];
  const version = await guarded('version', async () => judgeVersion(await readVersion(baseUrl, requests), sha));
  parts.push(version);
  const database = await guarded('database', () => checkDatabase(baseUrl, requests));
  parts.push(database);
  if (version.verdict === GREEN && database.verdict === GREEN) {
    parts.push(await guarded('suites', () => checkSuites({ sha, declaration, baseUrl, env, say }, deps.suites || {})));
  }
  if (parts.some((p) => p.verdict === RED)) return finish(parts);

  const ended = Date.parse(row.ended);
  const wait = (Number.isFinite(ended) ? ended : now()) + SETTLE_MS - now();
  if (wait > 0) await sleep(wait);

  const again = await guarded('version', async () => judgeVersion(await readVersion(baseUrl, requests), sha, { second: true }));
  if (again.verdict !== GREEN) {
    parts.push(again);
    return finish(parts);
  }

  parts.push(await guarded('errors', async () => {
    const before = (deps.readBefore || readBeforeFile)(env, row.started);
    const after = await (deps.readAfter || ((since) => readSurvey({ path: worktree, sha, since, ...(deps.survey || {}) })))(storedTime(Date.parse(row.started)));
    return judgeErrors({ before, after, started: row.started });
  }));
  return finish(parts);
}

/* ------------------------------------------------------------------ files */

/** The verdict, written to its own file: the source the chore restores a row's cells from. */
export function writeVerdictFile(env, row, verdict, extra = {}) {
  const record = {
    started: row.started, sha: row.sha, check: verdict.check, check_at: verdict.check_at, check_why: verdict.check_why,
    parts: verdict.parts || [], ...extra,
  };
  mkdirSync(checkDir(env), { recursive: true });
  writeJsonAtomic(verdictPath(env, row.started), record);
  return record;
}

export function readVerdictFile(env, started) {
  try {
    const record = JSON.parse(readFileSync(verdictPath(env, started), 'utf8'));
    return record && [GREEN, RED, COULD_NOT_RUN].includes(record.check) ? record : null;
  } catch { return null; }
}

/** The three cells of a verdict, in the names of the columns. */
export const checkCells = (verdict) => ({ check: verdict.check, check_at: verdict.check_at, check_why: verdict.check_why || '' });

/** The attempt's deadline: `max(its start, ended + 30 min) + 30 min`. */
export function attemptDeadline({ startedAt, ended }) {
  const settled = Number.isFinite(Date.parse(ended)) ? Date.parse(ended) + SETTLE_MS : 0;
  return Math.max(startedAt, settled) + GRACE_MS;
}

/* -------------------------------------------------------- the detached entry */

/**
 * What `deploy-check-run.js` does for its job `{ started, sha }`: loads the row,
 * runs the check, keeps the verdict in its own file and then in the row. The
 * file is written first and is the source: a row that could not be written —
 * the lock was held, the file changed three times — is restored from it by the
 * chore (`deployCheckTick`). `{ code, verdict, written, why }`; never throws.
 */
export async function executeCheck({ job, env = process.env, deps = {}, say = () => {} }) {
  const row = readDeploys(env).findLast((one) => one.started === job?.started && one.sha === job?.sha);
  if (!row) return { code: 1, why: `no row ${job?.started} / ${short(job?.sha)} in deploys.tsv` };
  if (row.outcome !== DEPLOYED) return { code: 1, why: `the row is ${row.outcome}, not ${DEPLOYED}` };
  if (row.check) return { code: 0, why: `the row already carries a verdict (${row.check})` };
  let verdict;
  try {
    verdict = await runCheck({ row, env, deps });
  } catch (error) {
    verdict = combine([part('suites', COULD_NOT_RUN, `the check failed: ${oneLine(error?.message || error)}`)], { at: new Date((deps.now || Date.now)()) });
  }
  say(`the check of ${short(row.sha)} is ${verdict.check}${verdict.check_why ? ` — ${verdict.check_why}` : ''}`);
  try {
    writeVerdictFile(env, row, verdict);
  } catch (error) {
    say(`the verdict could not be written to its file: ${oneLine(error?.message || error)}`);
  }
  let written = { written: false, why: 'not tried' };
  try {
    written = (deps.record || recordCheck)({ started: row.started, sha: row.sha }, checkCells(verdict), env);
  } catch (error) {
    written = { written: false, why: oneLine(error?.message || error) };
  }
  if (!written.written) say(`the row was not written (${written.why}); the verdict file stays for the runner to copy`);
  return { code: 0, verdict, written: written.written, why: written.why };
}

/** The entry's script: `deploy-check-run.js`, started by the runner and nobody else. */
export const CHECK_RUN = fileURLToPath(new URL('./deploy-check-run.js', import.meta.url));

/**
 * The check, started detached in its own process group (so a kill reaches what
 * the suites started), stdin closed, its output in `<started>.log`. The script
 * is the installed mc's, like the deployer's. `{ pid, log }` or `{ pid: null, log, error }`.
 */
export function startCheckDefault(job, { env = process.env, spawnProcess = spawn } = {}) {
  const log = logPath(env, job.started);
  let fd = null;
  try {
    mkdirSync(dirname(log), { recursive: true });
    fd = openSync(log, 'w', 0o644);
    const run = installedScript(join('src', 'mc', 'deploy-check-run.js'), CHECK_RUN, env);
    const child = spawnProcess(process.execPath, [run.path, JSON.stringify(job)], {
      cwd: dirname(run.path), detached: true, stdio: ['ignore', fd, fd], env,
    });
    child.unref();
    return { pid: child.pid ?? null, log };
  } catch (error) {
    return { pid: null, log, error: error?.message || String(error) };
  } finally {
    if (fd != null) try { closeSync(fd); } catch { /* closed */ }
  }
}

/** The process group of `pid` killed, the process alone when there is no group. */
export function killGroup(pid, signal = 'SIGKILL') {
  try { process.kill(-pid, signal); return true; } catch { /* no group */ }
  try { process.kill(pid, signal); return true; } catch { return false; }
}

/* -------------------------------------------------------------- the chore */

export function readState(env = process.env) {
  try {
    const state = JSON.parse(readFileSync(statePath(env), 'utf8'));
    return state && typeof state === 'object' ? state : {};
  } catch { return {}; }
}

const writeState = (env, state) => writeJsonAtomic(statePath(env), state);

/** The attempt in flight, as the page asks it: its row key, when its process is alive. */
export function attemptInFlight(env = process.env, { alive = processAlive } = {}) {
  const attempt = readState(env).attempt;
  const pid = Number(attempt?.pid);
  if (!attempt?.key?.started || !Number.isInteger(pid) || pid <= 0) return null;
  return alive(pid) === true ? { ...attempt.key, pid } : null;
}

/**
 * One pass of the chore (D3). Returns what it did, as notes: `{ notes, started }`.
 *
 *  - The verdict files are copied into rows whose check cell is empty.
 *  - An attempt in flight whose process died without a verdict is written
 *    could-not-run and not retried; one past its deadline has its process group
 *    killed and is written could-not-run, which frees the slot.
 *  - A due row — deployed, ended at or after `from`, empty check, oldest first —
 *    that a later deployed row has superseded is written could-not-run without
 *    a start; the next is started, one at a time, and nothing starts while a
 *    deploy runs, STOP or UPDATE is asked, or an attempt is alive.
 *  - `from` is written the first pass and never moved: rows that ended before
 *    it stay empty and read "not checked".
 */
export function deployCheckTick({
  env = process.env, now = Date.now, alive = processAlive, kill = killGroup, start = startCheckDefault,
  stopRequested = () => false, updateRequested = () => false, say = () => {}, record = recordCheck, running = runningDeploy,
} = {}) {
  const notes = [];
  const write = (row, verdict, why) => {
    const cells = { check: verdict, check_at: new Date(now()).toISOString(), check_why: why };
    try {
      const result = record({ started: row.started, sha: row.sha }, cells, env);
      if (!result.written) { notes.push(`${row.started}: not written (${result.why})`); return false; }
      return true;
    } catch (error) {
      notes.push(`${row.started}: not written (${oneLine(error?.message || error)})`);
      return false;
    }
  };

  let state = readState(env);
  if (!Number.isFinite(Date.parse(state.from))) {
    state = { ...state, from: new Date(now()).toISOString() };
    writeState(env, state);
  }
  const from = Date.parse(state.from);

  // The verdict files first: a verdict the chore did not write itself.
  let rows = readDeploys(env);
  for (const row of rows) {
    if (row.outcome !== DEPLOYED || row.check) continue;
    const file = readVerdictFile(env, row.started);
    if (!file || file.sha !== row.sha) continue;
    try {
      const result = record({ started: row.started, sha: row.sha }, checkCells(file), env);
      if (result.written) notes.push(`${row.started}: verdict restored from its file`);
    } catch { /* the lock is held; the next pass */ }
  }
  rows = readDeploys(env);

  // The attempt in flight.
  const attempt = state.attempt;
  if (attempt?.key) {
    const row = rows.find((one) => one.started === attempt.key.started && one.sha === attempt.key.sha);
    const pid = Number(attempt.pid);
    const live = Number.isInteger(pid) && pid > 0 && alive(pid) === true;
    if (!row || row.check) {
      state = { ...state, attempt: null };
      writeState(env, state);
    } else if (live && now() <= Number(attempt.deadline)) {
      return { notes, started: null, waiting: attempt.key.started };
    } else {
      const why = live
        ? `the check passed its deadline (pid ${pid})`
        : `the check ended without a verdict (pid ${pid})`;
      if (live) kill(pid);
      if (write(row, COULD_NOT_RUN, why)) {
        say(`deploy check: ${short(row.sha)} — ${why}`);
        state = { ...state, attempt: null };
        writeState(env, state);
        // The slot is free; the next due row starts on a later pass.
        return { notes, started: null };
      } else return { notes, started: null };
    }
    rows = readDeploys(env);
  }

  if (stopRequested() || updateRequested()) return { notes, started: null };
  if (running(env, { alive })) return { notes, started: null };

  const deployed = rows.filter((row) => row.outcome === DEPLOYED && row.sha);
  const due = deployed
    .filter((row) => !row.check && Date.parse(row.ended) >= from)
    .sort((a, b) => Date.parse(a.ended) - Date.parse(b.ended));
  for (const row of due) {
    const later = deployed.find((one) => one !== row && Date.parse(one.ended) > Date.parse(row.ended));
    if (later) {
      const why = `superseded by ${short(later.sha)} before it was checked`;
      if (write(row, COULD_NOT_RUN, why)) say(`deploy check: ${short(row.sha)} — ${why}`);
      continue;
    }
    const job = { started: row.started, sha: row.sha };
    const result = start(job, { env });
    if (!result.pid) {
      const why = `the check could not be started: ${result.error || 'no process'}`;
      if (write(row, COULD_NOT_RUN, why)) say(`deploy check: ${short(row.sha)} — ${why}`);
      continue;
    }
    state = {
      ...state,
      attempt: { key: job, pid: result.pid, started_at: new Date(now()).toISOString(), deadline: attemptDeadline({ startedAt: now(), ended: row.ended }) },
    };
    writeState(env, state);
    say(`deploy check: ${short(row.sha)} — started (pid ${result.pid})`);
    return { notes, started: job };
  }
  return { notes, started: null };
}
