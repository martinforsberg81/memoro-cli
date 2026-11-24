import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { recordReleaseCut } from './deploys.js';

export const RELEASE_CUTTING = true;

const SCHEMA = 'mc-deploy-release';
const short = (sha) => sha?.slice(0, 7) || 'unknown';
const when = (at) => String(at || '').slice(0, 16).replace('T', ' ');

export const releaseBranch = (sha) => `release/${short(sha)}`;
export const releaseRef = (branch) => `origin/${branch}`;
export const canRepairRelease = (record) => Boolean(record && !record.drop_reason && !record.activity && !record.stop && ['red', 'measuring'].includes(record.state));
export const releaseHolder = (record) => `${record.branch} for ${record.holder}, ${record.cut.at}`;
export const sameRelease = (a, b) => Boolean(a && b && a.branch === b.branch && a.cut.at === b.cut.at);
export const releaseShippedLines = (record) => [
  `mc: deployed ${short(record.head)} as build ${record.build} (${record.branch}, cut by a typed deploy ${when(record.cut.at)}, ${record.repairs.length} repair${record.repairs.length === 1 ? '' : 's'})`,
  ...(record.merge_back ? [`mc: ${record.branch} goes back to main through memoro#${record.merge_back} (a merge commit)`] : []),
];

export function releaseWaitLine(record) {
  const pr = record.merge_back ? `memoro#${record.merge_back}, ${record.merge_status || 'queued'}` : 'opening the pull request';
  return `mc: ${record.branch} is not back on main yet (${pr}) — the next deploy waits for it; mc prs shows it`;
}

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

export function readRelease(root, read = (path) => readFileSync(path, 'utf8')) {
  try {
    const text = read(releasePath(root));
    if (text == null) return null;
    const record = JSON.parse(text);
    if (record?.schema === SCHEMA && record.cut?.sha && record.branch === releaseBranch(record.cut.sha)) return record;
    throw new Error('invalid release record');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function writeRelease(root, release, write = writeJsonAtomic) {
  // A watcher of the old release still needs its result if a new cut
  // replaces the current record before its next read.
  if (release.closed === 'merged' || release.closed === 'dropped') write(closedPath(root, release), release);
  write(releasePath(root), { ...release, schema: SCHEMA });
}

export function openRelease(root, read) {
  const record = readRelease(root, read);
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

/** Where main stands on origin when a measured commit is cut. The full run takes
 * long and main keeps landing meanwhile: a tip that moved on is not a reason to
 * drop the measurement, so the cut stands at the measured commit as long as
 * origin's main still contains it. `{ tip }` is origin's main now; `{ error }`
 * when it cannot be read or no longer contains the commit. */
export function cutTipOnMain(path, git, sha) {
  if (git(path, ['fetch', 'origin', 'main', '--quiet']) === null) return { error: 'could not read the tip of main on origin' };
  const tip = git(path, ['rev-parse', '--verify', 'origin/main']);
  if (!tip) return { error: 'could not read the tip of main on origin' };
  if (tip === sha) return { tip };
  return git(path, ['merge-base', '--is-ancestor', sha, tip]) === null
    ? { error: `main on origin (${short(tip)}) no longer contains ${short(sha)}; mc deploy reads the new tip` }
    : { tip };
}

/** The intent and its settlement take the register's lock, not the network
 * calls between them. A lost process leaves enough to recover an exact push. */
export function beginCut({ root, plan, full, holder, gate, reading, claimFiles = [], now = () => new Date() }) {
  const sha = plan.tip;
  const branch = releaseBranch(sha);
  const at = now().toISOString();
  const reds = releaseRedNames(full.run);
  const record = {
    branch, cut: { sha, at }, head: sha, live: plan.live, state: 'red', state_at: at,
    row: { started: at, sha }, holder, reds, repairs: [], merge_back: null,
    cut_run: full.run, claimed_reds: [...new Set([...reds, ...claimFiles])], take_back: plan.take_back,
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
    case 'deployed': return `mc: deployed as build ${build}; ${merge_back ? `going back to main through memoro#${merge_back}` : 'returning to main'}`;
  }
}

export function releaseCutLines(plan, full, { dryRun, mainTip = null }) {
  const branch = releaseBranch(plan.tip);
  const count = releaseRedNames(full.run).length;
  const verdict = full.state === 'stalled' ? 'STALLED' : `RED (${count})`;
  const gap = plan.gap == null ? 'the number of commits is unknown' : `${plan.gap} commit${plan.gap === 1 ? '' : 's'} would ship`;
  return [
    `mc: main's tip ${short(plan.tip)} is ${verdict}, and nothing after live ${short(plan.live)} is green`,
    ...(mainTip && mainTip !== plan.tip
      ? [`mc: main moved to ${short(mainTip)} while ${short(plan.tip)} was measured; the newer commits wait for the release to go back to main`]
      : []),
    `mc: ${dryRun ? 'would cut' : 'cut'} ${branch} at ${mainTip && mainTip !== plan.tip ? short(plan.tip) : "main's tip"} — ${gap}`,
    dryRun ? 'mc: --dry-run — nothing was cut'
      : 'mc: the release is repaired, measured and shipped by itself; mc deploy --follow watches it',
  ];
}
