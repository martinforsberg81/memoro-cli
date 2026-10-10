/**
 * `mc merge watch <repo> <pr>` — follow one queued pull request until the
 * merger has answered (ruling 36).
 *
 * Since ruling 30 `mc merge` queues and returns. A step session wants exactly
 * that; a hand session, a close-out that needs its predecessors on main, or a
 * session about to deploy what it just landed wants to wait for the answer.
 * This is that wait, opt-in and read-only: it never writes `merges.json`, the
 * register or `merger.json`, never starts a merger, and never cancels or
 * re-queues a job (Martin, 2026-10-10: *"en bevakning som en session kan
 * starta OM den vill"*).
 *
 * The exit code is the answer: 0 merged, 1 red, 2 a pull request that is
 * neither queued nor merged (open, closed, or unknown), 3 `--timeout`
 * elapsed, 4 no merger alive while the job waits. One line is printed per
 * change of state and nothing in between, so a session running it in the
 * background spends nothing on a queue that has not moved.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { inLine, mergesPath, parseQueue, placeOf, queueOrder, queuedFor, samePr, waitingOn } from './merge-queue.js';
import { readMerger, stepsBeforeDone } from './merger.js';
import { workRoot } from './paths.js';

/**
 * How often the queue is read. `merges.json` is a local file, so polling it
 * costs nothing; GitHub is asked only once, when the job has left the queue
 * (or was never in it).
 */
export const WATCH_POLL_MS = 10_000;

export const WATCH_TIMEOUT_MIN = 30;

/**
 * Where one pull request stands in the queue, from the entries alone:
 * `queued` (place counted from 1, `ahead` the same repository's numbers
 * before it), `waiting` on its parent, `landing` (with the other jobs of the
 * same round, if it is a batch), `red`, or `gone` — which only GitHub can
 * resolve, and the loop asks. A queued job whose plan's earlier step is not
 * `done` carries `waits_for: '<project> step <n>'` (`ordered`, merger.js
 * `stepsBeforeDone`). A job that waits while no merger is alive carries
 * `merger: false`.
 */
export function watchState(entries, { repo, pr, merger = null, ordered = () => true } = {}) {
  const entry = queuedFor(entries, repo, pr);
  if (!entry) return { kind: 'gone' };
  if (entry.state === 'red') return { kind: 'red', reason: entry.reason, answered: entry.answered };
  if (entry.state === 'landing') {
    const batch = entry.started == null ? [] : entries
      .filter((other) => !samePr(other, entry) && other.state === 'landing' && other.started === entry.started)
      .map((other) => other.pr);
    return { kind: 'landing', batch, pid: merger?.pid ?? null };
  }
  const waits = waitingOn(entries, { ordered }).find((other) => samePr(other.entry, entry)) || null;
  const line = queueOrder(inLine(entries)).filter((other) => other.repo === entry.repo);
  const state = waits?.parent != null
    ? { kind: 'waiting', parent: waits.parent }
    : {
      kind: 'queued',
      place: placeOf(entries, repo, pr) + 1,
      ahead: line.slice(0, line.findIndex((other) => samePr(other, entry))).map((other) => other.pr),
    };
  if (state.kind === 'queued' && waits?.step) state.waits_for = `${waits.step.project} step ${waits.step.number}`;
  if (!merger) state.merger = false;
  return state;
}

const prs = (numbers) => numbers.map((number) => `#${number}`).join(' ');

/** The state as a line, whether or not it changed. */
function lineOf(pr, state) {
  const noMerger = state.merger === false ? ' — no merger is running' : '';
  if (state.kind === 'queued') {
    const where = state.ahead.length ? `behind ${prs(state.ahead)}` : 'next in line';
    const order = state.waits_for ? `, waits for ${state.waits_for}` : '';
    return `mc: #${pr} queued — place ${state.place}, ${where}${order}${noMerger}`;
  }
  if (state.kind === 'waiting') return `mc: #${pr} waits for #${state.parent} (stacked on it) to land${noMerger}`;
  if (state.kind === 'landing') {
    const pid = state.pid ? ` (pid ${state.pid})` : '';
    return state.batch.length
      ? `mc: #${pr} landing in a batch with ${prs(state.batch)}${pid}`
      : `mc: #${pr} landing — the merger has it${pid}`;
  }
  if (state.kind === 'red') return `mc: #${pr} red — ${state.reason || 'no reason recorded'}; fix it on its branch and mc merge again`;
  return null;
}

/**
 * The line to print for `next`, or null when nothing a reader cares about
 * changed: same kind, same place, same parent, same step waited for, same
 * batch, same merger.
 */
export function watchLine(prev, next, { pr = null } = {}) {
  if (!next || next.kind === 'gone') return null;
  if (prev && prev.kind === next.kind
    && prev.place === next.place
    && prev.parent === next.parent
    && (prev.waits_for ?? null) === (next.waits_for ?? null)
    && String(prev.batch ?? '') === String(next.batch ?? '')
    && (prev.merger === false) === (next.merger === false)) return null;
  return lineOf(pr ?? next.pr ?? '?', next);
}

function elapsed(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

const realSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * The loop: read the queue and the merger every `pollMs`, print a line when
 * the state changed, and end with the answer. Returns `{ code, result }`,
 * `result` being what `--json` prints.
 */
export async function watch({
  repo, pr, timeoutMs = WATCH_TIMEOUT_MIN * 60_000, pollMs = WATCH_POLL_MS,
  readQueue, readMerger, prView, ordered = () => true, now = Date.now, sleep = realSleep, print = () => {},
}) {
  const number = Number(pr);
  const start = now();
  let prev = null;
  let place = null;
  let mergerless = 0;
  const end = (code, outcome, { line = null, mergeCommit = null, reason = null } = {}) => {
    if (line) print(line);
    return {
      code,
      result: { repo, pr: number, outcome, merge_commit: mergeCommit, reason, place, seconds: Math.round((now() - start) / 1000) },
    };
  };

  for (;;) {
    const state = watchState(readQueue(), { repo, pr: number, merger: readMerger(), ordered });
    if (state.kind === 'gone') {
      const view = prView(repo, number);
      const took = elapsed((now() - start) / 1000);
      if (view?.state === 'MERGED') {
        const oid = typeof view.mergeCommit === 'string' ? view.mergeCommit : view.mergeCommit?.oid || null;
        return end(0, 'merged', { mergeCommit: oid, line: `mc: #${number} merged into main${oid ? ` as ${oid.slice(0, 7)}` : ''} (${took})` });
      }
      if (view?.state === 'OPEN') return end(2, 'open', { line: `mc: #${number} is open and not in the merge queue — mc merge ${repo} ${number} queues it` });
      if (view?.state === 'CLOSED') return end(2, 'closed', { line: `mc: #${number} is closed without merging and not in the merge queue` });
      return end(2, 'unknown', { line: `mc: #${number} is not in the merge queue and GitHub could not say what it is` });
    }
    if (state.place != null) place = state.place;
    const line = watchLine(prev, state, { pr: number });
    if (state.kind === 'red') return end(1, 'red', { reason: state.reason, line });
    if (line) print(line);
    mergerless = state.merger === false ? mergerless + 1 : 0;
    if (mergerless >= 2) {
      return end(4, 'no-merger', { line: `mc: no merger is running and the job waits — the next mc merge or runner pass starts one` });
    }
    if (now() - start >= timeoutMs) {
      const minutes = Math.round(timeoutMs / 60_000);
      return end(3, 'timeout', { line: `${lineOf(number, state)} — still ${state.kind} after ${minutes}m; the job stays in the queue` });
    }
    prev = state;
    await sleep(pollMs);
  }
}

const realRead = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };

/** What GitHub says of a pull request: `{ state, mergeCommit }`, or null when it cannot be asked. */
function ghPrView(repoPath) {
  return (repo, pr) => {
    const r = spawnSync('gh', ['pr', 'view', String(pr), '--json', 'state,mergeCommit'], { cwd: repoPath, encoding: 'utf8' });
    if (r.status !== 0) return null;
    try {
      const view = JSON.parse(r.stdout);
      return { state: view.state || null, mergeCommit: view.mergeCommit?.oid || null };
    } catch { return null; }
  };
}

/**
 * The watch wired to this machine: the queue and the merger from the work
 * root, GitHub through `gh` in the repository. Both `mc merge watch` and
 * `mc merge --watch` end here. Returns the exit code; `--json` prints the
 * result as one object at the end and no lines before it.
 */
export async function followMerge({ repoPath, pr, timeoutMs = WATCH_TIMEOUT_MIN * 60_000, json = false, stdout, deps = {} }) {
  // The queue names a repository by its directory, as `queueForMerger` wrote it.
  const repo = basename(String(repoPath).replace(/\/+$/u, ''));
  const root = deps.root || workRoot(process.env);
  const { code, result } = await (deps.watch || watch)({
    repo,
    pr,
    timeoutMs,
    readQueue: deps.readQueue || (() => parseQueue(realRead(mergesPath(root)))),
    readMerger: deps.readMerger || (() => readMerger({ root })),
    prView: deps.prView || ghPrView(repoPath),
    ordered: deps.ordered || stepsBeforeDone(root),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    print: json ? () => {} : (line) => stdout.write(`${line}\n`),
  });
  if (json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return code;
}
