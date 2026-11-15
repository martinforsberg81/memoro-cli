/**
 * The take-back of a release (docs/technical/mc-deploy.md, *The take-back*): the
 * one function the runner's red reaction (`take-back-run.js`) and the verb
 * `mc deploy take-back` both call.
 *
 * It takes the last deployed row back to the versions each Worker served before
 * it, by memoro's `scripts/release/take-back.mjs` — mc runs that script from
 * the release's own `scripts/` (written out as the commit has them, as the
 * reading is, `take-back.js`) with mc's deploy worktree as its cwd, and calls
 * no Wrangler itself. A script, a worktree or a Wrangler that is not there is a
 * take-back not made, said in words.
 *
 * Three steps, in this order:
 *  1. the gate (`takeBackGate`): can this release be taken back at all — the
 *     conditions D5 names, each refused in its own words, nothing written;
 *  2. the admission: the deploy worktree's holder first (`take back`), then
 *     one hold of the deploys lock inside which the record is read again, the
 *     gate is asked again, nothing is running, and the `running` take-back row
 *     is written — so two processes that read the same release cannot both
 *     take it back, and the script is never run without its row;
 *  3. the script, its row completed with what it said, and one read of what
 *     production says it is now.
 *
 * Never throws for a refusal; a refusal writes no row.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { takeBeforeReading } from './deploy-check.js';
import { deployWorktreePath, takeHolder } from './deploy-worktree.js';
import {
  DEPLOYED, FAILED, closeAbandoned, isTakeBackRow, readDeploys, recordEnd, recordStart, runningDeploy, withDeploysLock,
} from './deploys.js';
import { exportAtRev, reasonLine } from './export-at-rev.js';
import { baseUrl } from './helper-collect.js';
import { processAlive } from './lease-owner.js';
import { runBounded } from './take-back.js';

/** The script in the repository: what is written out of the release's commit and run. */
export const TAKE_BACK_SCRIPT = 'scripts/release/take-back.mjs';
/** Wrangler in the deploy worktree: its absence is a take-back not made. */
export const WRANGLER_BIN = join('node_modules', '.bin', 'wrangler');
/** How long the script may take: two Workers, three attempts each, and the reads between. */
export const SCRIPT_TIMEOUT_MS = 15 * 60_000;
/** The verb the deploy worktree's holder record carries. */
export const HOLDER_VERB = 'take back';
/** How long a take-back waits for the deploy worktree's holder (a check, a deploy's script). */
export const HOLDER_WAIT_MS = 10 * 60_000;
/** The Workers in the order they are taken back: `memoro` before `memoro-tail`. */
export const WORKER_ORDER = ['memoro', 'memoro-tail'];
/** What the take-back row says about its own reading: it is never taken back by itself. */
export const ROW_TAKE_BACK_WHY = 'a take-back is not taken back by itself';

const short = (sha) => String(sha || '').slice(0, 7);
const oneLine = (text) => String(text ?? '').replace(/\s+/gu, ' ').trim();
const realSleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

/** `memoro:<id>,memoro-tail:missing` as `[{ worker, id }]`; an id of `missing` is `null`. */
export function parseVersions(cell) {
  return String(cell || '').split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const at = part.lastIndexOf(':');
    if (at <= 0) return { worker: part, id: null };
    const id = part.slice(at + 1).trim();
    return { worker: part.slice(0, at).trim(), id: id && id !== 'missing' ? id : null };
  });
}

function orderedWorkers(entries) {
  const rank = (worker) => { const at = WORKER_ORDER.indexOf(worker); return at === -1 ? WORKER_ORDER.length : at; };
  return [...entries].sort((a, b) => rank(a.worker) - rank(b.worker));
}

const stop = (code, why) => ({ ok: false, code, why });

/**
 * Whether the last deployed row of `rows` can be taken back, by the conditions
 * of the take-back gate that the record decides (the script and Wrangler are
 * the files' to say, `takeBack`). `{ ok: true, release, earlier, returnsTo,
 * workers }` — `workers` is `[{ worker, from, to }]`, `from` the version the
 * release made and `to` the one before it — or `{ ok: false, code, why }`.
 *
 * `by` is who asks. A take-back row for the release that failed does not block
 * the verb, which tries again, but it blocks the runner, which tries once.
 */
export function takeBackGate({ rows, by = 'verb' }) {
  const deployed = (rows || []).filter((row) => row.sha && row.outcome === DEPLOYED);
  const release = deployed.at(-1);
  if (!release) return stop('no-release', 'no release has been deployed, so there is nothing to take back');
  const name = `${short(release.sha)} (deployed ${String(release.started).slice(0, 16).replace('T', ' ')})`;
  if (isTakeBackRow(release)) {
    return stop('is-take-back', `the last release, ${name}, is itself a take-back — a take-back is not taken back; ship a later commit`);
  }
  const named = (rows || []).filter((row) => isTakeBackRow(row) && row.takes_back === release.started);
  const done = named.find((row) => row.outcome === DEPLOYED);
  if (done) return stop('already-taken-back', `${name} was already taken back, by the take-back of ${String(done.started).slice(0, 16).replace('T', ' ')}`);
  if (by === 'runner' && named.length) {
    return stop('already-tried', `${name} was already tried by a take-back (${named.at(-1).outcome}); the runner takes a release back once — mc deploy take-back tries again`);
  }
  const made = parseVersions(release.versions_made);
  if (!made.length) {
    return stop('no-versions-made', `the deploy of ${name} names no Worker version it made (versions_made is empty) — there is nothing to roll back from`);
  }
  const before = parseVersions(release.versions_before);
  for (const { worker, id } of made) {
    if (!id) return stop('version-missing', `the deploy of ${name} did not record the version it made for ${worker} — it cannot be rolled back from an unknown version`);
    const was = before.find((entry) => entry.worker === worker);
    if (!was?.id) return stop('version-missing', `the deploy of ${name} did not record the version ${worker} served before it — there is no version to return to`);
  }
  if (release.versions_why) {
    return stop('versions-why', `the deploy of ${name} says a version could not be read (${release.versions_why}) — its versions are not to be trusted`);
  }
  const at = deployed.indexOf(release);
  const earlier = at > 0 ? deployed[at - 1] : null;
  if (!earlier) return stop('no-earlier', `no release was deployed before ${name}, so there is no commit to return to`);
  for (const { worker, id } of parseVersions(earlier.versions_made)) {
    const was = before.find((entry) => entry.worker === worker);
    if (was && id !== was.id) {
      return stop('earlier-differs', `${worker} served ${was.id} before ${name}, but the release before it, ${short(earlier.sha)}, made ${id || 'a version that was not recorded'} — production was changed between them, and a rollback would not return to that release`);
    }
  }
  const workers = orderedWorkers(made).map(({ worker, id }) => ({ worker, from: id, to: before.find((entry) => entry.worker === worker).id }));
  return {
    ok: true,
    release,
    earlier,
    returnsTo: { sha: earlier.live_commit || earlier.sha, build: earlier.live_build || earlier.build || '' },
    workers,
  };
}

/**
 * The gate and what each asker adds: the runner takes back a release whose
 * check is red and whose reading says it can be taken back, the one `started`
 * names; the verb takes back the last release, red or not, and refuses a reading
 * of `no` or none unless `despite` says it is known.
 */
export function judge({ rows, by, started = null, despite = false }) {
  if (by === 'runner' && started) {
    const last = (rows || []).filter((row) => row.sha && row.outcome === DEPLOYED).at(-1);
    if (last && last.started !== started) {
      return stop('not-last', `the release started ${started} is not the last one deployed — ${short(last.sha)} is; nothing is taken back by itself`);
    }
  }
  const gate = takeBackGate({ rows, by });
  if (!gate.ok) return gate;
  const { release } = gate;
  if (by === 'runner') {
    if (release.check !== 'red') return stop('not-red', `the check of ${short(release.sha)} is ${release.check || 'not made'}, not red`);
    if (release.take_back !== 'yes') {
      return stop('reading-no', `${short(release.sha)} is read as one that cannot be taken back${release.take_back_why ? ` — ${release.take_back_why}` : ''}; the runner does not take it back by itself`);
    }
    return gate;
  }
  if (release.take_back !== 'yes' && !despite) {
    const why = release.take_back_why ? ` — ${release.take_back_why}` : '';
    return stop('reading-no', release.take_back === 'no'
      ? `${short(release.sha)} is read as one that cannot be taken back${why}; mc deploy take-back --despite "<reason>" takes it back anyway, knowing what the rollback would not undo`
      : `${short(release.sha)} has no reading of whether it can be taken back; mc deploy take-back --despite "<reason>" takes it back anyway`);
  }
  return gate;
}

/** `GET /api/version` once: what production says it is, or null when it does not answer. */
export async function fetchVersionDefault(env = process.env) {
  try {
    const response = await fetch(`${baseUrl(env)}/api/version`, {
      cache: 'no-store', headers: { 'Cache-Control': 'no-store' }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
}

class StoppedWait extends Error {}

/** What the script printed, strictly read: `{ ok, workers }` or `{ problem }`. */
export function parseScriptOutput(text) {
  let json;
  try { json = JSON.parse(String(text || '').trim().split('\n').filter(Boolean).at(-1) || ''); } catch { return { problem: 'the script printed no JSON' }; }
  if (!json || typeof json !== 'object' || json.schema_version !== 1) return { problem: 'the script printed no schema_version 1 result' };
  if (typeof json.ok !== 'boolean' || !Array.isArray(json.workers)) return { problem: 'the script printed no ok and workers[]' };
  const workers = json.workers.map((one) => ({
    worker: String(one?.worker ?? ''), from: String(one?.from ?? ''), to: String(one?.to ?? ''),
    state: String(one?.state ?? ''), serving: String(one?.serving ?? ''), why: oneLine(one?.why),
  }));
  return { ok: json.ok, workers };
}

/**
 * The cells a take-back row ends with, from what the script said about each
 * Worker it was asked for: `versions_before` the version each served before the
 * take-back, `versions_made` the one it serves now (`missing` for a Worker not
 * taken back), `versions_why` the reason for each that is not.
 */
export function takeBackVersionCells(asked, said) {
  const by = new Map((said?.workers || []).map((one) => [one.worker, one]));
  const before = []; const made = []; const why = [];
  for (const want of asked) {
    const got = by.get(want.worker);
    before.push(`${want.worker}:${want.from}`);
    if (got?.state === 'taken-back') made.push(`${want.worker}:${got.serving || want.to}`);
    else {
      made.push(`${want.worker}:missing`);
      why.push(`${want.worker} made: ${got ? `${got.state}${got.why ? ` — ${got.why}` : ''}` : (said?.problem || 'the script did not report it')}`);
    }
  }
  return { versions_before: before.join(','), versions_made: made.join(','), versions_why: why.join('; ') };
}

/** The command that takes `workers` back by hand, in the deploy worktree: the same order the script uses. */
export function manualLines(workers) {
  return workers.map(({ worker, to }) => `npx wrangler rollback ${to} --name ${worker} --message "taken back by hand"`);
}

/**
 * Take the last release back.
 *
 * `by` is `'runner'` (with `started`, the release the red check belongs to) or
 * `'verb'` (with `despite`); `reason` is what the verb's person typed;
 * `holder` names who is taking it back on the row. `repoPath` is the
 * repository the release's `scripts/` is written out of. `dryRun` runs the
 * script's own `--dry-run` and writes no row.
 *
 * Returns one of
 *  - `{ status: 'refused', code, why }` — the gate or a missing file; nothing
 *    was written, nothing was called;
 *  - `{ status: 'not-made', code, why }` — the admission was lost (the holder
 *    stayed busy, a deploy was running, a take-back or a later deploy came
 *    first); nothing was written;
 *  - `{ status: 'dry-run', ok, workers, release, returnsTo }`;
 *  - `{ status: 'taken-back' | 'failed', row, workers, release }` — the row
 *    written, `taken-back` only when every Worker was taken back.
 *
 * `deps` are the boundaries a test fakes: `readRows`, `exists`, `exportTree`,
 * `runScript`, `fetchVersion`, `beforeReading`, `takeHolder` (and its
 * `holderLock`, `sleep`, `clock`, `alive`), `lock`, `root`, `now`,
 * `stopRequested`, `waitMs`.
 */
export async function takeBack({
  by = 'verb', started = null, reason = '', despite = false, dryRun = false, holder = '', repoPath,
  env = process.env, deps = {}, say = () => {},
}) {
  const readRows = deps.readRows || (() => readDeploys(env));
  const alive = deps.alive || processAlive;
  const first = judge({ rows: readRows(), by, started, despite });
  if (!first.ok) return { status: 'refused', code: first.code, why: first.why };
  const { release } = first;

  const worktree = deployWorktreePath(env);
  const exists = deps.exists || existsSync;
  if (!exists(join(worktree, WRANGLER_BIN))) {
    return { status: 'refused', code: 'no-wrangler', why: `the deploy worktree ${worktree} has no ${WRANGLER_BIN} — a take-back is not made without it` };
  }
  let dir = null;
  let holding = null;
  try {
    dir = realpathSync(mkdtempSync(join(deps.scratch || tmpdir(), 'mc-release-take-back-')));
    const failed = (deps.exportTree || exportAtRev)(repoPath, release.sha, 'scripts', dir);
    const script = join(dir, TAKE_BACK_SCRIPT);
    if (failed || !(deps.exists || existsSync)(script)) {
      return { status: 'refused', code: 'no-script', why: `${short(release.sha)} has no ${TAKE_BACK_SCRIPT}${failed ? ` (${failed})` : ''} — a take-back is not made without it` };
    }

    const message = oneLine(`mc: taken back from ${short(release.sha)} to ${short(first.returnsTo.sha)}${reason ? ` — ${reason}` : ''}`).slice(0, 200);
    const argvFor = (gate, extra = []) => [
      'node', script,
      ...gate.workers.flatMap(({ worker, from, to }) => ['--worker', `${worker}=${from}:${to}`]),
      '--message', message, ...extra,
    ];
    const timeoutMs = deps.scriptTimeoutMs || SCRIPT_TIMEOUT_MS;
    const run = deps.runScript || runBounded;

    // The holder: the tree is nobody else's while the script runs in it. A wait
    // ends at its bound, and at STOP or UPDATE, without a row.
    const sleep = async (ms) => {
      await (deps.sleep || realSleep)(ms);
      if (deps.stopRequested?.()) throw new StoppedWait();
    };
    let taken;
    try {
      if (deps.stopRequested?.()) throw new StoppedWait();
      taken = await (deps.takeHolder || takeHolder)({
        env, verb: HOLDER_VERB, say: (line) => say(line), now: deps.clock, sleep, alive: deps.alive, lock: deps.holderLock,
        waitMs: deps.waitMs ?? HOLDER_WAIT_MS,
      });
    } catch (error) {
      if (error instanceof StoppedWait) return { status: 'not-made', code: 'stopped', why: 'the runner was asked to stop or update while the take-back waited for the deploy worktree' };
      throw error;
    }
    if (!taken.ok) return { status: 'not-made', code: 'held', why: taken.reason };
    holding = taken;

    if (dryRun) {
      const result = await run(argvFor(first, ['--dry-run']), { cwd: worktree, timeoutMs });
      const said = result.error || result.timedOut ? { problem: result.error || 'the script did not finish in time' } : parseScriptOutput(result.stdout);
      return {
        status: 'dry-run', ok: Boolean(said.ok) && result.code === 0, workers: said.workers || [], release, returnsTo: first.returnsTo,
        why: said.problem || (result.code === 0 ? '' : reasonLine(result.stderr) || `the script exited ${result.code}`),
      };
    }

    // The admission, atomic: the record is read again under the deploys lock,
    // the gate asked again, and the `running` row written in the same hold.
    const admitted = withDeploysLock(env, () => {
      const again = judge({ rows: readRows(), by, started, despite });
      if (!again.ok) return { refused: again };
      const other = runningDeploy(env, { alive });
      if (other) return { refused: stop('running', `a deploy of ${short(other.sha)} is running (pid ${other.pid}) — nothing is taken back while one runs`) };
      closeAbandoned({ alive }, env);
      const key = { started: (deps.now ? deps.now() : new Date()).toISOString(), sha: again.returnsTo.sha };
      recordStart({
        sha: again.returnsTo.sha,
        build: again.returnsTo.build,
        holder: holder || (by === 'runner' ? `runner, check red of ${again.release.started}` : 'mc deploy take-back'),
        started: key.started,
        pid: process.pid,
        note: `mc: taking ${short(again.release.sha)} back to ${short(again.returnsTo.sha)}`,
        takeBack: { take_back: 'no', take_back_why: ROW_TAKE_BACK_WHY },
        takesBack: {
          takes_back: again.release.started,
          takes_back_sha: again.release.sha,
          takes_back_why: by === 'runner'
            ? again.release.check_why
            : `typed: ${oneLine(reason) || 'no reason'}${despite ? ' (despite the reading)' : ''}`,
        },
      }, env);
      return { key, again };
    }, {
      name: 'take-back',
      ...(deps.lock ? { lock: deps.lock } : {}),
      ...(deps.root ? { root: deps.root } : {}),
    });
    if (admitted.refused) return { status: 'not-made', code: admitted.refused.code, why: admitted.refused.why };
    const { key, again } = admitted;

    // The error reading before the take-back, taken inside the holder and
    // before the script, as a deploy's is: the check of the take-back row
    // compares with it. A reading that fails is a note, never a stop.
    const beforeReading = deps.beforeReading || (deps.runScript ? null : takeBeforeReading);
    if (beforeReading) {
      try { await beforeReading({ path: worktree, sha: key.sha, started: key.started, env }); } catch { /* a reading not made is a note */ }
    }

    let result;
    let said;
    try {
      result = await run(argvFor(again), { cwd: worktree, timeoutMs });
      said = result.error ? { problem: `the script could not be run (${result.error})` }
        : result.timedOut ? { problem: `the script did not finish in ${Math.round(timeoutMs / 1000)} s and was stopped` }
          : parseScriptOutput(result.stdout);
    } catch (error) {
      result = { code: null, stdout: '', stderr: '' };
      said = { problem: `the script could not be run (${oneLine(error?.message || error)})` };
    }
    const every = !said.problem && result.code === 0 && said.ok === true
      && again.workers.every((want) => said.workers.find((one) => one.worker === want.worker)?.state === 'taken-back');
    const version = await (deps.fetchVersion || fetchVersionDefault)(env).catch(() => null);
    const stderrLine = reasonLine(result.stderr);
    const row = recordEnd(key, {
      outcome: every ? DEPLOYED : FAILED,
      stopped_at: every ? '' : 'take-back',
      live_commit: version?.commit_full || version?.commit || '',
      live_build: version?.build ?? '',
      note: every
        ? `mc: taken back ${short(again.release.sha)} → ${short(again.returnsTo.sha)}`
        : `mc: the take-back of ${short(again.release.sha)} did not take every Worker back — ${said.problem || said.workers.filter((one) => one.state !== 'taken-back').map((one) => `${one.worker} ${one.state}${one.why ? ` (${one.why})` : ''}`).join('; ') || stderrLine || `the script exited ${result.code}`}`,
      ...takeBackVersionCells(again.workers, said),
    }, env);
    return {
      status: every ? 'taken-back' : 'failed', row, workers: said.workers || [], release: again.release, returnsTo: again.returnsTo,
      asked: again.workers, why: every ? '' : row.note,
    };
  } finally {
    holding?.release?.();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
