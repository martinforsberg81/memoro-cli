#!/usr/bin/env node
/**
 * The runner's reaction to a red check (docs/technical/mc-deploy.md, *The
 * take-back*): `take-back-run.js <started>` — started detached by `executeCheck`
 * the moment it records a red, and by the first step of the chore pass for a red
 * row whose ledger entry is not done. As a script it is the runner's alone and
 * exits 2 under `MC_HEADLESS=1` before anything is read or written; the same
 * file exports what the chore and the desk read.
 *
 * For the red row `<started>` it, in this order:
 *  1. takes the row's entry in the red ledger by its pid (a second process for
 *     the row exits at once while the first is alive);
 *  2. takes the release back when the runner may (`takeBack`, by `runner`): the
 *     release is the last deployed row, read `yes`, D5 holds, no take-back row
 *     names it, no deploy runs, neither STOP nor UPDATE is asked — the decision
 *     itself is made inside the deploys lock, in the take-back function;
 *  3. asks the repair once: a main-red mend with a member for each red part;
 *  4. records the outcome in the ledger, and for a red the runner did not take
 *     back, the steps a person can act on (`desk: Martin`).
 *
 * A reaction that could not try (the deploy worktree stayed busy, STOP or
 * UPDATE was asked, a deploy was running) ends without a decision and its entry
 * stays not done: a later chore pass starts it again.
 */
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  LedgerError, heldBy, newEntry, readLedger, readLedgerSafe, updateLedger,
} from './check-red-ledger.js';
import { readVerdictFile, startReactionDefault, verdictPath } from './deploy-check.js';
import { deployWorktreePath } from './deploy-worktree.js';
import {
  DEPLOYED, FAILED, RUNNING, closeAbandoned, isTakeBackRow, readDeploys, takeBackRowsOf,
} from './deploys.js';
import { processAlive } from './lease-owner.js';
import { checkMemberKey, requestMainRepair } from './main-repair.js';
import { workRoot } from './paths.js';
import { WORKER_ORDER, parseVersions, takeBack } from './release-take-back.js';

export const REPO = 'memoro';
/** The codes of a take-back not made that mean the reaction did not get to decide: it tries again later. */
const UNTRIED = new Set(['held', 'stopped', 'running']);
/** The codes of the take-back gate's conditions D5 names, and the two files it needs. */
const D5_CODES = new Set(['no-versions-made', 'version-missing', 'versions-why', 'no-earlier', 'earlier-differs', 'no-script', 'no-wrangler']);

const short = (sha) => String(sha || '').slice(0, 7);
const oneLine = (text) => String(text ?? '').replace(/\s+/gu, ' ').trim();

/** The red parts of a row's check, as `[{ part, why }]`: the verdict file's, else read from `check_why`. */
export function redParts(row, file = null) {
  const red = (file?.parts || []).filter((part) => part.verdict === 'red').map((part) => ({ part: part.part, why: oneLine(part.why) }));
  if (red.length) return red;
  const read = String(row?.check_why || '').split('; ').filter(Boolean).map((piece) => {
    const at = piece.indexOf(': ');
    return at > 0 ? { part: piece.slice(0, at), why: piece.slice(at + 2) } : { part: 'check', why: piece };
  });
  return read.length ? read : [{ part: 'check', why: 'red' }];
}

/** The desk's steps for a red the runner did not take back: what was red, what serves, the mend, and the one path. */
export function deskSteps({ row, rows = [], kind, why = '', mends = [], repairWhy = '', env = process.env }) {
  const worktree = deployWorktreePath(env);
  const made = parseVersions(row.versions_made);
  const before = parseVersions(row.versions_before);
  const workers = (made.length ? made.map((one) => one.worker) : WORKER_ORDER).sort((a, b) => WORKER_ORDER.indexOf(a) - WORKER_ORDER.indexOf(b));
  const handLines = workers.map((worker) => {
    const id = before.find((one) => one.worker === worker)?.id;
    return id
      ? `npx wrangler rollback ${id} --name ${worker} --message "taken back by hand"`
      : `npx wrangler deployments list --name ${worker}   (find the version before ${short(row.sha)}, then npx wrangler rollback <id> --name ${worker} --message "taken back by hand")`;
  });
  const failedRow = takeBackRowsOf(rows, row.started).findLast((one) => one.outcome === FAILED);
  const steps = [
    `Red: the check of ${short(row.sha)} (deployed ${row.started}) — ${row.check_why || 'red'}.`,
    kind === 'failed'
      ? `Serving now: the take-back stopped part-way — ${failedRow?.note || why}; the Workers may serve different versions.`
      : `Serving now: ${short(row.sha)}${kind === 'take-back-red' ? ' (a take-back, which is not taken back)' : ''} — the runner did not take it back${why ? `: ${why}` : ''}.`,
    mends.length
      ? `Repair: a main-red mend is open (${mends.length} member${mends.length === 1 ? '' : 's'}; mc martin get lists it if it reaches you).`
      : `Repair: none could be asked${repairWhy ? ` (${repairWhy})` : ''}.`,
  ];
  if (kind === 'reading-no') {
    steps.push(`To take it back anyway: mc deploy take-back --despite "<reason>" — the reading says it would not undo: ${row.take_back_why || 'what the reading names'}. Or wait for the repair and ship a later green commit with mc deploy.`);
  } else if (kind === 'failed') {
    steps.push('To finish it: mc deploy take-back (it takes back what is still on the release).');
    steps.push(`By hand, in ${worktree}, the Workers still on the release, memoro before memoro-tail:`);
    steps.push(...handLines.map((line) => `  ${line}`));
  } else if (kind === 'take-back-red') {
    steps.push('A take-back is not taken back and there is nothing before it to roll back to: ship the repair — mc deploy once the main-red mend has landed and a later commit is green.');
  } else {
    steps.push(`mc cannot take this release back${why ? ` (${why})` : ''}. Ship the repair: mc deploy once the main-red mend has landed and a later commit is green.`);
    steps.push(`By hand, in ${worktree}, memoro before memoro-tail:`);
    steps.push(...handLines.map((line) => `  ${line}`));
    steps.push('A rollback by hand leaves deploys.tsv naming the release as live; the next mc deploy reads each Worker\'s versions from the provider.');
  }
  return steps;
}

/** What a red-row's outcome is called in a desk step and in the ledger. */
function classify(code) {
  if (code === 'reading-no') return 'reading-no';
  if (code === 'is-take-back') return 'take-back-red';
  if (D5_CODES.has(code)) return 'd5';
  return 'other';
}

/**
 * The reaction to the red row `started`. Returns `{ status, code, why }`;
 * never throws. `status` is one of `no-red-row`, `ledger-unreadable`, `done`,
 * `held`, `untried`, `taken-back`, `failed`, `not-made`.
 *
 * `deps` are the boundaries a test fakes: `readRows`, `takeBack`,
 * `requestRepair`, `readVerdict`, `alive`, `stopRequested`, `now`, `pid`,
 * `closeAbandoned`, `ledger` (the ledger's read/lock options), `repoPath`.
 */
export async function react({ started, env = process.env, deps = {}, say = () => {} }) {
  const pid = deps.pid ?? process.pid;
  const alive = deps.alive || processAlive;
  const now = deps.now || (() => new Date());
  const readRows = deps.readRows || (() => readDeploys(env));
  const ledgerOptions = { alive, now, ...(deps.ledger || {}) };
  const stopRequested = deps.stopRequested
    || (() => existsSync(join(workRoot(env), 'runner', 'STOP')) || existsSync(join(workRoot(env), 'runner', 'UPDATE')));

  let rows = readRows();
  const row = rows.find((one) => one.started === started && one.outcome === DEPLOYED);
  if (!row || row.check !== 'red') return { status: 'no-red-row', code: 0, why: `no deployed row ${started} with a red check` };
  const file = (deps.readVerdict || readVerdictFile)(env, started);
  const parts = redParts(row, file);

  let claim;
  try {
    claim = updateLedger(env, (entries) => {
      const current = entries[started];
      if (current?.done) return { state: 'done' };
      if (heldBy(current, { alive, pid })) return { state: 'held' };
      entries[started] = { ...(current || newEntry({ sha: row.sha, parts, now: now() })), pid };
      return { state: 'claimed', entry: entries[started] };
    }, ledgerOptions);
  } catch (error) {
    const why = `${error.message} — no take-back is made and no repair is asked until it reads again`;
    say(why);
    return { status: 'ledger-unreadable', code: 1, why };
  }
  if (claim.state !== 'claimed') return { status: claim.state, code: 0, why: claim.state === 'done' ? 'the reaction for this row is done' : 'a reaction for this row is alive' };
  const entry = claim.entry;

  const settle = (patch) => updateLedger(env, (entries) => {
    entries[started] = { ...(entries[started] || entry), ...patch, pid: null };
    return entries[started];
  }, ledgerOptions);
  const leave = (why) => { try { settle({}); } catch { /* the entry stays leased to a dead pid */ } say(why); return { status: 'untried', code: 0, why }; };

  try {
    // 1. The take-back, unless the record already says what became of it.
    let takeBackState = entry.take_back;
    let kind = null; let why = ''; let result = null;
    if (takeBackState === 'none') {
      (deps.closeAbandoned || closeAbandoned)({ alive }, env);
      rows = readRows();
      const named = takeBackRowsOf(rows, started);
      if (isTakeBackRow(row)) {
        takeBackState = 'not-made'; kind = 'take-back-red'; why = 'a take-back is not taken back by itself';
      } else if (named.some((one) => one.outcome === DEPLOYED)) {
        takeBackState = 'taken-back'; why = 'a take-back row already names this release';
      } else if (named.some((one) => one.outcome === RUNNING)) {
        return leave('a take-back of this release is running; nothing is started twice');
      } else if (named.length) {
        takeBackState = 'failed'; kind = 'failed'; why = named.at(-1).note || 'the take-back failed';
      } else if (stopRequested()) {
        return leave('STOP or UPDATE is asked; the reaction ends without a take-back and a later pass tries again');
      } else {
        result = await (deps.takeBack || takeBack)({
          by: 'runner', started, repoPath: deps.repoPath || deployWorktreePath(env), env,
          deps: { ...(deps.takeBackDeps || {}), stopRequested, alive }, say,
        });
        if (result.status === 'taken-back') { takeBackState = 'taken-back'; why = ''; }
        else if (result.status === 'failed') { takeBackState = 'failed'; kind = 'failed'; why = result.why; }
        else if (UNTRIED.has(result.code)) return leave(`not taken back yet: ${result.why}`);
        else if (result.code === 'not-last') { takeBackState = 'not-made'; kind = 'later'; why = result.why; }
        else if (result.code === 'already-taken-back') { takeBackState = 'taken-back'; why = result.why; }
        else { takeBackState = 'not-made'; kind = classify(result.code); why = result.why; }
      }
    }

    // 2. The repair, once.
    let repair = entry.repair || [];
    let repairWhy = entry.repair_skipped || '';
    if (!repair.length && !repairWhy) {
      const asked = (deps.requestRepair || requestMainRepair)({
        repo: REPO, base: row.sha, root: workRoot(env), now,
        checks: parts.map(({ part, why: reason }) => ({
          key: checkMemberKey(part, started), part, why: reason, sha: row.sha, started, verdict: verdictPath(env, started),
          taken_back: takeBackState === 'taken-back', finder: `the check of ${short(row.sha)} deployed ${started}`,
        })),
      });
      repair = [...(asked.created || []), ...(asked.open || []), ...(asked.finished || [])];
      if (!repair.length) repairWhy = asked.skipped || 'the request made no member';
    }

    // 3. The record, and what the desk is asked.
    const deskKinds = new Set(['reading-no', 'take-back-red', 'd5', 'failed', 'other']);
    const toDesk = takeBackState !== 'taken-back' && deskKinds.has(kind);
    const steps = toDesk ? deskSteps({ row, rows: readRows(), kind, why, mends: repair, repairWhy, env }) : [];
    settle({
      sha: row.sha, parts, repair, ...(repairWhy ? { repair_skipped: repairWhy } : {}), take_back: takeBackState,
      desk: toDesk ? 'Martin' : 'none', reason: oneLine(why), steps, done: true,
    });
    const line = takeBackState === 'taken-back' ? `${short(row.sha)} taken back${result?.returnsTo ? ` to ${short(result.returnsTo.sha)}` : ''}`
      : `${short(row.sha)} not taken back (${takeBackState}${why ? `: ${oneLine(why)}` : ''})`;
    say(`${line}; repair ${repair.length ? `asked (${repair.length} member${repair.length === 1 ? '' : 's'})` : `not asked (${repairWhy})`}`);
    return { status: takeBackState, code: takeBackState === 'failed' ? 1 : 0, why: oneLine(why), repair, desk: toDesk };
  } catch (error) {
    return leave(`the reaction stopped: ${oneLine(error?.message || error)}`);
  }
}

/**
 * The red rows the chore pass must start a reaction for: red, recorded at or
 * after the ledger began, no entry that is done and none held by a live
 * reaction. `{ starts, error }`; an unreadable ledger starts nothing.
 */
export function pendingReds({ env = process.env, rows = null, alive = processAlive, pid = process.pid } = {}) {
  let ledger;
  try { ledger = readLedger(env); } catch (error) { return { starts: [], error: error.message }; }
  const from = ledger.from ? Date.parse(ledger.from) : Infinity;
  const starts = (rows || readDeploys(env))
    .filter((row) => row.outcome === DEPLOYED && row.check === 'red' && Date.parse(row.check_at) >= from)
    .filter((row) => {
      const entry = ledger.entries[row.started];
      return !entry?.done && !heldBy(entry, { alive, pid });
    })
    .map((row) => row.started);
  return { starts, error: null, began: Boolean(ledger.from) };
}

/**
 * The entries the desk is asked about: `desk: Martin` and not ended. An entry
 * ends when a later deployed row (a deploy or a take-back) ships after the red
 * row. `{ items, ended, error }` — `ended` are the keys that now read ended,
 * for the chore to write.
 */
export function deskEntries({ env = process.env, rows = null } = {}) {
  const ledger = readLedgerSafe(env);
  if (ledger.error) return { items: [], ended: [], error: ledger.error };
  const all = rows || readDeploys(env);
  const items = []; const ended = [];
  for (const [started, entry] of Object.entries(ledger.entries)) {
    if (entry.desk !== 'Martin') continue;
    const later = all.find((row) => row.outcome === DEPLOYED && row.sha && Date.parse(row.started) > Date.parse(started));
    if (later) { ended.push(started); continue; }
    items.push({ started, ...entry });
  }
  return { items, ended, error: null };
}

/** Write `desk: ended` for entries a later row ended, and for one a person ends (`mc deploy take-back --end`). */
export function endDesk({ env = process.env, started = null, reason = '', ended = [], now = () => new Date() } = {}) {
  return updateLedger(env, (entries) => {
    const keys = started ? [started] : ended;
    const done = [];
    for (const key of keys) {
      const entry = entries[key];
      if (!entry || entry.desk !== 'Martin') continue;
      entries[key] = { ...entry, desk: 'ended', ended_at: now().toISOString(), ...(reason ? { ended_reason: oneLine(reason) } : {}) };
      done.push(key);
    }
    return done;
  }, { now });
}

export { LedgerError };

/**
 * The first step of every chore pass: a reaction started for each red row not
 * done, and the desk entries a later row ended written as ended. Starts nothing
 * while STOP or UPDATE is asked. `{ notes, started }`; the ledger is begun on the
 * first pass (what is red before it is not a reaction's to make). Never throws.
 */
export function takeBackTick({
  env = process.env, alive = processAlive, stopRequested = () => false, updateRequested = () => false,
  start = startReactionDefault, say = () => {}, now = () => new Date(),
} = {}) {
  const notes = []; const started = [];
  try {
    const pending = pendingReds({ env, alive });
    if (pending.error) { notes.push(`${pending.error} — no reaction is started and no take-back is made until it reads again`); return { notes, started }; }
    if (!pending.began) { updateLedger(env, () => null, { alive, now }); notes.push('the red ledger begun'); return { notes, started }; }
    const desk = deskEntries({ env });
    if (desk.ended.length) { endDesk({ env, ended: desk.ended, now }); notes.push(`${desk.ended.length} desk entr${desk.ended.length === 1 ? 'y' : 'ies'} ended by a later row`); }
    if (stopRequested() || updateRequested()) return { notes, started };
    for (const key of pending.starts) {
      const result = start({ started: key }, { env });
      if (result.pid) { started.push(key); notes.push(`${key}: the reaction to a red check started (pid ${result.pid})`); say(`take back: ${key} — reaction started (pid ${result.pid})`); }
      else notes.push(`${key}: the reaction could not be started (${result.error || 'no process'})`);
    }
  } catch (error) {
    notes.push(`the pass failed — ${oneLine(error?.message || error)}`);
  }
  return { notes, started };
}

/* ------------------------------------------------------------------ the entry */

const entryPath = (() => { try { return process.argv[1] ? realpathSync(process.argv[1]) : null; } catch { return null; } })();
if (entryPath && pathToFileURL(entryPath).href === import.meta.url) {
  if (process.env.MC_HEADLESS === '1') {
    process.stderr.write('take-back-run.js is the runner\'s reaction to a red check and is refused to a headless session (MC_HEADLESS=1); nothing was done.\n');
    process.exit(2);
  }
  const started = String(process.argv[2] || '');
  const say = (message) => process.stdout.write(`${new Date().toISOString()} ${message}\n`);
  if (!started) { say('no row given: take-back-run.js <started>'); process.exit(2); }
  const result = await react({ started, env: process.env, say });
  if (result.why && result.status !== 'taken-back') say(`${result.status}: ${result.why}`);
  process.exit(result.code);
}

export const TAKE_BACK_RUN = fileURLToPath(import.meta.url);
