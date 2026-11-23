import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { recordReleaseCut } from './deploys.js';

// Part 3 opens the door only once the runner can finish a typed release.
export const RELEASE_CUTTING = false;

const SCHEMA = 'mc-deploy-release';
const short = (sha) => sha?.slice(0, 7) || 'unknown';
const when = (at) => String(at || '').slice(0, 16).replace('T', ' ');

export const releaseBranch = (sha) => `release/${short(sha)}`;
export const releaseRef = (branch) => `origin/${branch}`;

export function releasePath(root) {
  return join(root, 'runner', 'deploy-release.json');
}

function closedPath(root, record) {
  const id = `${record.row.started}-${record.cut.sha}`.replace(/[^a-z0-9-]/giu, '');
  return join(root, 'runner', 'deploy-releases', `${id}.json`);
}

export function readClosedRelease(root, record) {
  try { return JSON.parse(readFileSync(closedPath(root, record), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function readRelease(root) {
  try {
    const record = JSON.parse(readFileSync(releasePath(root), 'utf8'));
    if (record?.schema === SCHEMA && record.cut?.sha && record.branch === releaseBranch(record.cut.sha)) return record;
    throw new Error('invalid release record');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function writeRelease(root, release) {
  // A watcher of the old release still needs its result if a new cut
  // replaces the current record before its next read.
  if (release.closed === 'merged' || release.closed === 'dropped') writeJsonAtomic(closedPath(root, release), release);
  writeJsonAtomic(releasePath(root), { ...release, schema: SCHEMA });
}

export function openRelease(root) {
  const record = readRelease(root);
  return record && !record.closed && !record.push_pending ? record : null;
}

export function releaseRedNames(run) {
  return [...new Set([...(run?.red || []), ...(run?.stalled_files || []), ...(run?.cut_files || [])])];
}

function finishCut(root, record, env) {
  recordReleaseCut({ key: record.row, holder: record.holder, branch: record.branch, gate: record.gate, takeBack: record.take_back_cells }, env);
  const { push_pending: _, push_pid: _pid, ...release } = record;
  writeRelease(root, release);
  return release;
}

function remoteHead(path, git, ref) {
  const result = git(path, ['ls-remote', '--heads', 'origin', ref]);
  return result === null ? null : result.split(/\s+/u)[0];
}

export function confirmCutTip(path, git, sha) {
  const tip = remoteHead(path, git, 'refs/heads/main');
  return tip === sha ? null : tip
    ? `main moved to ${short(tip)}; mc deploy reads the new tip`
    : 'could not confirm the tip of main on origin';
}

/** The intent and its settlement take the register's lock, not the network
 * calls between them. A lost process leaves enough to recover an exact push. */
export function beginCut({ root, plan, full, holder, gate, reading, now = () => new Date() }) {
  const sha = plan.tip;
  const branch = releaseBranch(sha);
  const at = now().toISOString();
  const reds = releaseRedNames(full.run);
  const record = {
    branch, cut: { sha, at }, head: sha, live: plan.live, state: 'red', state_at: at,
    row: { started: at, sha }, holder, reds, repairs: [], merge_back: null,
    cut_run: full.run, claimed_reds: reds, take_back: plan.take_back,
    take_back_cells: reading, gate, push_pending: true, push_pid: process.pid,
  };
  writeRelease(root, record);
  return record;
}

export function settleCut(record, { root, env, path, git, admit, push = false, dryRun = false }) {
  const ref = `refs/heads/${record.branch}`;
  const sha = record.cut.sha;
  const pushed = push && git(path, ['push', '--quiet', `--force-with-lease=${ref}:`, 'origin', `${sha}:${ref}`]) !== null;
  const remote = pushed ? sha : remoteHead(path, git, ref);
  const finish = () => {
    // Another reader may have recovered this intent while we read origin.
    const current = readRelease(root);
    if (!current?.push_pending || current.row.started !== record.row.started) return { release: openRelease(root) };
    if (remote === sha) return { release: dryRun ? current : finishCut(root, current, env) };
    if (!dryRun) {
      writeRelease(root, { ...current, push_pid: null,
        ...(remote === '' ? { push_pending: false, closed: 'not-cut' } : {}) });
    }
    if (remote === '') return push ? { error: `could not push ${record.branch} at ${short(sha)}` } : {};
    if (remote === null) return { error: `could not check the pending push of ${record.branch}` };
    return { error: `${record.branch} already exists at ${short(remote)}, not the cut at ${short(sha)}` };
  };
  return dryRun ? finish() : admit(finish);
}

export function releaseSummary({ branch, cut, head, state, reds, repairs, merge_back }) {
  return { branch, cut, head, state, reds, repairs, merge_back };
}

export function releaseOpenLine({ branch, cut, repairs }) {
  return `mc: ${branch} is open — cut ${when(cut.at)}, ${repairs.length} repair${repairs.length === 1 ? '' : 's'} landed`;
}

export function releaseStateLine({ state, state_at, head, reds, build, merge_back }) {
  const full = `mc: full run of ${short(head)} (the release head):`;
  switch (state) {
    case 'measuring': return `${full} measuring since ${when(state_at)}`;
    case 'red': return `${full} RED (${reds.length})${reds.length ? `: ${reds.join(', ')}` : ''} — a repair is on its way`;
    case 'green': return `${full} green — the suites run against a local server of it`;
    case 'deploying': return `mc: deploying ${short(head)} since ${when(state_at)}`;
    case 'deployed': return `mc: deployed as build ${build}; going back to main through memoro#${merge_back}`;
  }
}

export function releaseCutLines(plan, full, { dryRun }) {
  const branch = releaseBranch(plan.tip);
  const count = releaseRedNames(full.run).length;
  const verdict = full.state === 'stalled' ? 'STALLED' : `RED (${count})`;
  const gap = plan.gap == null ? 'the number of commits is unknown' : `${plan.gap} commit${plan.gap === 1 ? '' : 's'} would ship`;
  return [
    `mc: main's tip ${short(plan.tip)} is ${verdict}, and nothing after live ${short(plan.live)} is green`,
    `mc: ${dryRun ? 'would cut' : 'cut'} ${branch} at main's tip — ${gap}`,
    dryRun ? 'mc: --dry-run — nothing was cut'
      : 'mc: the release is repaired, measured and shipped by itself; mc deploy --follow watches it',
  ];
}
