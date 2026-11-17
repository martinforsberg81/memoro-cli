/**
 * A deploy stopped by a technical fault is repaired by a mend session and shipped once more by the runner
 * (Martin, 2026-11-15: "Ja. Omstart ok."). The record is one file, `runner/deploy-mend.json`, under the
 * runner's lock; this module is the whole of its rules: what a technical stop is (`classifyStop`), the
 * request and its joining (`requestDeployRepair`), the attempts (`failDeployMend`), the handover from
 * `mc publish` and the merger (`publishDeployMend`, `answerDeployMend`), the session's own answer and the
 * desk's (`recordRepaired`, `answerHeldDeployMend`), the one retry's conditions (`retryVerdict`), the
 * prompt and the line `mc deploy` reads out. Design: docs/technical/mc-deploy.md, "A stop that is repaired".
 */
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';
import { readDeploys } from './deploys.js';
import { readTextOrNull } from './goals.js';
import { realLock } from './runner-lock.js';
import { workRoot } from './paths.js';

/** A request still owns its branch, pull requests and worktrees; a later technical stop joins it. */
export const UNFINISHED = ['queued', 'running', 'published', 'repaired', 'retrying', 'Martin'];
/** `deployed`: the retry shipped. `stopped`: it stopped for a reason that is not technical. `not-retried`: repaired, the bounds said no. */
export const FINISHED = ['deployed', 'stopped', 'not-retried', 'dropped'];
/** A request older than this (from its newest row) is never retried, also after waiting for the handover. */
export const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const BRANCH_PREFIX = 'mend/deploy-';
export const REPOS = ['memoro-cli', 'memoro'];

/**
 * The stops that are not technical: nothing in mc's machinery failed, so a mend session has nothing to mend.
 * Every other stop — a `failed` row with any `stopped_at`, a refusal whose code is not listed, a stop nobody
 * has classified — is technical (D2: an unknown stop is technical). `dirty` and `ahead` are sent only for a
 * worktree with main that is not mc's own; mc's own deploy worktree dirty or ahead is `own-dirty`/`own-ahead`,
 * state mc owns, and technical (D4). `usage`, `headless` and `dry-run` write no row today; were one written,
 * it is a decision.
 */
export const NOT_TECHNICAL = Object.freeze([
  'usage', 'headless', 'dry-run', 'running', 'language', 'backwards', 'taken-back', 'unmeasured', 'red', 'dirty', 'ahead', 'replaced',
]);

/**
 * The steps a full run stops at for a reason of mc's own, past what a start would help (`worktree`: its
 * checkout is held; `threw`: its code threw; `lease`, `reservation`, `base`: its own state). `fetch`, `busy`
 * and `pr` are the machine's or the lane's and are tried again by the next start.
 */
export const FULL_RUN_FAULTS = Object.freeze(['worktree', 'threw', 'lease', 'reservation', 'base']);

/** `{ outcome, code }` → true when the stop is a technical fault. `deployed` and `running` are no stop. */
export function classifyStop({ outcome, code = null } = {}) {
  if (outcome === 'deployed' || outcome === 'running') return false;
  if (outcome === 'failed') return true;
  return !NOT_TECHNICAL.includes(code);
}

/**
 * The code of a gate refusal: `red` when any measured thing is red or the commit is not measured whole,
 * `suites` only when the sole fault is that a suite could not run (or the suites could not start).
 */
export function gateStopCode({ full, exercise }) {
  // A full run that could not start or finish for a reason of mc's own is the deploy mend's (`full-run`),
  // never a retry of the deploy: a deploy of that commit measured nothing, and a full run is not a deploy.
  if (full?.state === 'unmeasured' && FULL_RUN_FAULTS.includes(full.run?.stopped_at)) return 'full-run';
  if (full &&['red', 'stalled', 'unmeasured', 'moved'].includes(full.state)) return full.state === 'red' || full.state === 'stalled' ? 'red' : 'unmeasured';
  const suites = exercise?.suites || [];
  if (suites.some((suite) => suite.state === 'red')) return 'red';
  if (exercise?.error || suites.some((suite) => suite.state === 'cannot-run')) return 'suites';
  return 'red';
}

export function deployMendPath(root = workRoot()) {
  return join(root, 'runner', 'deploy-mend.json');
}
export function deployMendCopies(root, id) {
  return join(root, 'runner', 'deploy-mend', id);
}

export function readDeployMends({ root = workRoot(), read = readTextOrNull } = {}) {
  const text = read(deployMendPath(root));
  if (text == null) return [];
  const value = typeof text === 'string' ? JSON.parse(text) : text;
  if (value?.version !== 1 || !Array.isArray(value.entries)) throw new Error('invalid deploy-mend state');
  return value.entries;
}

/** Every read-patch-write holds the runner's lock and writes the whole file atomically. */
export function updateDeployMends({ root = workRoot(), read = readTextOrNull, write = writeJsonAtomic, lock = realLock } = {}, change) {
  return lock(root, () => {
    const entries = readDeployMends({ root, read });
    const result = change(entries);
    write(deployMendPath(root), { version: 1, entries });
    return result;
  }, { name: 'deploy-mend', strict: true });
}

export const openRequest = (entries) => entries.find((entry) => UNFINISHED.includes(entry.state)) || null;
const newest = (entry) => entry.rows.map((row) => row.started).sort().at(-1);

/**
 * Queue (or join) the repair of a technical stop. One request at most is unfinished: a later stop joins it
 * with its own copies of the logs (the logs are one file each, emptied by the next deploy). The joined
 * request carries `--accept-red` if any row did, keeps the first row's holder and counts its age from the
 * newest row. A failed write or copy never changes the deploy: this never throws.
 * `logs`: `[{ name, path }]`, copied to `runner/deploy-mend/<id>/<row.started>/`.
 */
export function requestDeployRepair({ row, holder = '', acceptRed = false, logs = [], origin = 'deploy', repo = '', holders = [], now = () => new Date(), copy = copyFileSync, mkdir = mkdirSync, ...state }) {
  try {
    if (!row?.started) return { skipped: 'no row' };
    const root = state.root || workRoot();
    return updateDeployMends(state, (entries) => {
      const open = openRequest(entries);
      const target = open || { id: randomUUID(), rows: [], state: 'queued', failures: 0, created: now().toISOString() };
      if (target.rows.some((item) => item.started === row.started)) return { id: target.id, joined: true };
      // A checkout held again while the request about it is unfinished is the same fault: no second row, no second copy.
      if (open && origin === 'full-run' && target.rows.some((item) => item.origin === 'full-run' && item.repo === String(repo || ''))) return { id: target.id, joined: true };
      const copies = join(deployMendCopies(root, target.id), row.started);
      const kept = [];
      try {
        mkdir(copies, { recursive: true });
        for (const log of logs) { try { copy(log.path, join(copies, log.name)); kept.push(log.name); } catch { /* a log that is not there */ } }
      } catch { /* the copies are evidence, not the request */ }
      target.rows.push({ started: row.started, sha: row.sha || '', stopped_at: row.stopped_at || '', note: row.note || '',
        holder: holder || row.holder || '', accept_red: Boolean(acceptRed), copies, logs: kept,
        // `full-run`: not a deploy but a full run that could not start; who held it is named for the session.
        ...(origin === 'full-run' ? { origin, repo: String(repo || ''), holders: (holders || []).map(({ pid, command = null, cwd = null }) => ({ pid, command, cwd })) } : {}),
        // A typed deploy refused because its full run could not start stays a deploy (its retry applies, D14);
        // who held the full run's checkout is named for the session all the same.
        ...(origin !== 'full-run' && holders?.length ? { repo: String(repo || ''), holders: holders.map(({ pid, command = null, cwd = null }) => ({ pid, command, cwd })) } : {}) });
      if (!open) entries.push(target);
      return { id: target.id, joined: Boolean(open) };
    });
  } catch (error) { return { skipped: error?.message || String(error) }; }
}

/** Every row of the request is a full run that could not start: there is no deploy in it to retry. */
export const onlyFullRun = (entry) => entry.rows.length > 0 && entry.rows.every((row) => row.origin === 'full-run');

/** What held a full run, in words: the holders it names, or the note of the stop. */
export function fullRunHeld(row) {
  const holders = row.holders || [];
  if (!holders.length) return row.note || `it stopped at ${row.stopped_at || 'a step of its own'}`;
  return holders.map(({ pid, command, cwd }) => `pid ${pid}${command ? ` (${command})` : ''}${cwd ? ` standing in ${cwd}` : ''}`).join('; ');
}

export const requestAcceptsRed =(entry) => entry.rows.some((row) => row.accept_red);
export const requestHolder = (entry) => entry.rows[0]?.holder || '';

/** Two failed repairs put the request on Martin; the first returns it to the queue. A spent retry is `retryFailed`'s. */
export function failDeployMend(entry, reason) {
  entry.failures = (entry.failures || 0) + 1;
  entry.state = entry.failures >= 2 ? 'Martin' : 'queued';
  entry.reason = reason;
  entry.prs = [];
  delete entry.waiting;
}

/** The one retry stopped technically or was interrupted: a failure, and the request waits on Martin. Never retried again. */
export function retryFailed(entry, reason) {
  entry.failures = (entry.failures || 0) + 1;
  entry.state = 'Martin';
  entry.retried = true;
  entry.reason = reason;
  delete entry.waiting;
}

export function deployMendBranch(entry) {
  return entry.branch || `${BRANCH_PREFIX}${createHash('sha256').update(entry.id).digest('hex').slice(0, 12)}`;
}

/** `mc publish` on a `mend/deploy-` branch records the pull request per repository BEFORE queueing it. */
export function publishDeployMend({ repo, branch, pr, ...state }) {
  if (!branch?.startsWith(BRANCH_PREFIX)) return;
  return updateDeployMends(state, (entries) => {
    for (const entry of entries) if (entry.branch === branch && entry.state === 'running') {
      entry.prs = [...(entry.prs || []).filter((item) => !(item.repo === repo && item.number === Number(pr))), { repo, number: Number(pr), state: 'open' }];
    }
  });
}

/** The merger's answer for a pull request: landed, or closed/red without landing (a failed attempt). */
export function answerDeployMend({ repo, pr, landed, reason, ...state }) {
  return updateDeployMends(state, (entries) => {
    const answered = entries.filter((entry) => ['running', 'published'].includes(entry.state)
      && (entry.prs || []).some((item) => item.repo === repo && item.number === Number(pr) && item.state === 'open'));
    for (const entry of answered) {
      if (landed) entry.prs.find((item) => item.repo === repo && item.number === Number(pr)).state = 'landed';
      else failDeployMend(entry, reason);
    }
    return answered;
  });
}

class Refusal extends Error { constructor(message, code) { super(message); this.code = code; } }

/**
 * The session's `repaired` form: only the request its prompt named (MC_DEPLOY_MEND), from a mend session,
 * and only while it recorded no pull request. `{ ok, line }` or `{ ok: false, code, error }`.
 */
export function recordRepaired({ id, reason, role, named, now = () => new Date(), ...state }) {
  try {
    const text = String(reason ?? '').trim();
    if (!text) throw new Refusal('repaired needs --reason "<text>": what was wrong and how it was repaired', 2);
    if (role !== 'mend-session' || !named || named !== id) throw new Refusal(`mc repo mend deploy ${id} repaired is the session's form for the request its prompt named; this session was not given it`, 2);
    let entries;
    try { entries = readDeployMends(state); } catch (error) { throw new Refusal(`the deploy-mend state cannot be read (${error.message})`, 1); }
    const found = entries.find((entry) => entry.id === id);
    if (!found) throw new Refusal(`no deploy-mend request ${id}`, 2);
    if (found.state !== 'running') throw new Refusal(`deploy-mend ${id} reads ${found.state}, not running; nothing was written`, 2);
    if ((found.prs || []).length) throw new Refusal(`deploy-mend ${id} has pull requests recorded; they decide when it is repaired`, 2);
    updateDeployMends(state, (all) => {
      const entry = all.find((item) => item.id === id);
      if (entry?.state !== 'running') throw new Refusal(`deploy-mend ${id} now reads ${entry?.state ?? 'nothing'}; nothing was written`, 1);
      Object.assign(entry, { state: 'repaired', repaired_by: 'session', repaired_at: now().toISOString(), repaired_reason: text });
    });
    return { ok: true, line: `deploy-mend ${id} repaired; the runner retries the deploy once when the bounds hold` };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, code: error.code, error: error.message };
    return { ok: false, code: 1, error: error?.message || String(error) };
  }
}

/**
 * The desk's answer to a request held on Martin: `requeue` (two attempts again) or `drop` (it ends, its
 * copies go). Pull requests it opened are not touched: their own work lands or is closed by whoever owns it.
 */
export function answerHeldDeployMend({ id, verb, reason, role, now = () => new Date(), ...state }) {
  try {
    const text = String(reason ?? '').trim();
    if (!['requeue', 'drop'].includes(verb)) throw new Refusal(`mc repo mend deploy <id> requeue|drop --reason "<text>": ${verb ?? 'no verb'} is not one`, 2);
    if (!text) throw new Refusal(`${verb} needs --reason "<text>": what the desk found`, 2);
    let entries;
    try { entries = readDeployMends(state); } catch (error) { throw new Refusal(`the deploy-mend state cannot be read (${error.message})`, 1); }
    const found = entries.find((entry) => entry.id === id);
    if (!found) throw new Refusal(`no deploy-mend request ${id}`, 2);
    if (found.state !== 'Martin') throw new Refusal(`deploy-mend ${id} reads ${found.state}, not Martin; only a held request is answered`, 2);
    const answered = { verb, by: role, at: now().toISOString(), reason: text };
    updateDeployMends(state, (all) => {
      const entry = all.find((item) => item.id === id);
      if (entry?.state !== 'Martin') throw new Refusal(`deploy-mend ${id} now reads ${entry?.state ?? 'nothing'}, not Martin; nothing was written`, 1);
      if (verb === 'drop') { Object.assign(entry, { state: 'dropped', answered }); return; }
      Object.assign(entry, { state: 'queued', failures: 0, answered });
    });
    if (verb === 'drop') removeCopies({ root: state.root || workRoot(), id });
    return { ok: true, line: verb === 'drop' ? `deploy-mend ${id} dropped` : `deploy-mend ${id} requeued; the runner takes it at its next pick` };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, code: error.code, error: error.message };
    return { ok: false, code: 1, error: error?.message || String(error) };
  }
}

/** The settlement removes a finished request's copies. */
export function removeCopies({ root = workRoot(), id, rm = rmSync }) {
  try { rm(deployMendCopies(root, id), { recursive: true, force: true }); return true; } catch { return false; }
}

/**
 * Whether the one retry may start now. `{ retry: true }`, `{ wait: reason }` (repaired, the runner's own code
 * or the pick does not yet hold the landed repairs), or `{ drop: reason }` (ends "repaired, not retried").
 * `shippedSince(isoTime)` says a deploy shipped after it; `contained()` answers `{ ok, why }` for the landed
 * repairs. The order is the order of the bounds: accept-red, age, a deploy since, then the wait.
 */
export function retryVerdict({ entry, now = new Date(), shippedSince = () => false, contained = () => ({ ok: true }) }) {
  if (entry.retried) return { drop: 'the one retry of this request was spent' };
  if (onlyFullRun(entry)) return { drop: 'a full run is not a deploy: the repair is landed and the next full run measures; no deploy is retried' };
  if (requestAcceptsRed(entry)) return { drop: 'the deploy carried --accept-red; a red accepted by a person is not accepted again by the runner' };
  const last = newest(entry);
  if (now.getTime() - Date.parse(last) > RETRY_WINDOW_MS) return { drop: `the stop is older than 24 hours (${last})` };
  if (shippedSince(last)) return { drop: 'a deploy has shipped since the stop' };
  const held = contained();
  if (!held.ok) return { wait: held.why, waiting: held.kind || 'handover' };
  return { retry: true };
}

/** The holder a retry is written under. */
export const retryHolder = (entry) => `runner for ${requestHolder(entry)}, ${newest(entry)}`;

/** What `mc deploy`'s reading says about an open request, or the reason of one that ended unretried. */
export function deployMendLine(entry, { now = new Date() } = {}) {
  if (!entry) return null;
  const at = String(newest(entry)).slice(0, 16).replace('T', ' ');
  if (onlyFullRun(entry)) {
    // The page's line: what the full run could not do, what held it and where the repair is.
    const row = entry.rows.at(-1);
    const words = { queued: 'queued', running: 'running', published: 'running', repaired: 'landed', retrying: 'landed', Martin: 'waiting on Martin' };
    // A repaired full run is no deploy's story: once it is repaired nothing is retried, and the line ends.
    if (!UNFINISHED.includes(entry.state)) return null;
    return `mc: full run of ${row.repo || 'the repository'} cannot start: ${fullRunHeld(row)}; repair ${words[entry.state] || entry.state}`;
  }
  if (entry.state === 'not-retried') return `mc: the deploy of ${at} was repaired and not retried — ${entry.reason || 'the bounds said no'}`;
  if (!UNFINISHED.includes(entry.state)) return null;
  const waits = { queued: 'queued', running: 'running', published: 'running', retrying: 'repaired, retrying now',
    repaired: `repaired, waiting for ${entry.waiting === 'green' ? 'a green commit with the fix' : 'the handover'}`, Martin: 'waiting on Martin' };
  void now;
  return `mc: a repair of the deploy of ${at} is ${waits[entry.state] || entry.state}`;
}

/**
 * The open request (or the last unretried one, until the next deploy ships after it ended) as a reader shows it;
 * unreadable state is said, never an empty queue. `deploys()` is the deploy record (`deploys.tsv` under `root`).
 */
export function deployMendReading({ root = workRoot(), read = readTextOrNull, deploys = () => readDeploys({ MC_WORK_ROOT: root }) } = {}) {
  try {
    const entries = readDeployMends({ root, read });
    const open = openRequest(entries);
    if (open) return { entry: open, error: null };
    const unretried = [...entries].reverse().find((entry) => entry.state === 'not-retried') || null;
    return { entry: unretried && !shippedAfter(deploys, unretried.ended_at || newest(unretried)) ? unretried : null, error: null };
  } catch (error) { return { entry: null, error: error.message }; }
}

/** Whether a deploy shipped after `at`; a record that cannot be read hides nothing. */
function shippedAfter(deploys, at) {
  try { return deploys().some((row) => row.outcome === 'deployed' && Date.parse(row.ended || row.started) > Date.parse(at)); }
  catch { return false; }
}

export function deployMendPrompt({ entry, branch, worktrees, root }) {
  const rows = entry.rows.map((row) => row.origin === 'full-run'
    ? `- ${row.started} full run of ${row.repo || 'a repository'} ${row.sha ? row.sha.slice(0, 8) : 'no sha'} stopped at ${row.stopped_at || 'a step of its own'}: ${row.note}\n  held by: ${fullRunHeld(row)}`
    : `- ${row.started} ${row.sha ? row.sha.slice(0, 8) : 'no sha'} stopped at ${row.stopped_at || 'a refusal'}: ${row.note}\n  logs: ${row.copies}${row.logs?.length ? ` (${row.logs.join(', ')})` : ''}`
      + `${row.holders?.length ? `\n  the full run of ${row.repo || 'the repository'} was held by: ${fullRunHeld(row)}` : ''}`).join('\n');
  const what = onlyFullRun(entry)
    ? 'A full run cannot start or finish for a reason of mc\'s own (rows marked "full run": nothing is deployed and no deploy is retried); find what holds it, and repair it at its cause'
    : 'A deploy stopped on a technical fault (a row marked "full run" is a full run that could not start, not a deploy); find the cause from these rows and logs and repair it at its cause';
  return `You are a deploy-mend session, headless, with no goal (deploy-mend ${entry.id}). Read the deploy-mend section of your mend role.\n` +
    `${what}.\n${rows}\n` +
    `Work on ${branch} in ${worktrees.map((tree) => `${tree.repo}: ${tree.path}`).join(', ')}. Runner root: ${root}.\n` +
    `Previous outcome: ${entry.reason || 'first attempt'}; session log: ${entry.session_log || 'none'}.\n` +
    `Write a proposal in ~/mc/areas/memoro-cli/system/proposals/ naming the fault of mc deploy's design. End with a published PR (mc publish) or mc repo mend deploy ${entry.id} repaired --reason "<what was repaired>". Never run mc deploy.`;
}
