/**
 * `mc merge <repo> <pr> --docs` — land a pull request that touches nothing
 * outside `docs/`, without the suite.
 *
 * A plan is a file under `docs/project/`; its PR is docs-only by
 * construction, and there is no test to run on it. Waiting for a click
 * before the runner could see it was the friction this removes. The check
 * is GitHub's own file list for the PR, never a local diff, so a stale
 * checkout cannot make a code PR look like documentation.
 */
import { spawnSync } from 'node:child_process';

export const DOCS_PREFIX = 'docs/';
/**
 * How long to wait for GitHub to make up its mind about mergeability, as
 * tries and the pause between them. Exported because the note that describes
 * this form states the wait in words, and a doc that names a number goes
 * stale silently (tests/mc/merge-doc.test.js).
 */
export const MERGEABILITY_TRIES = 12;
export const MERGEABILITY_WAIT_MS = 5000;

function ghRunner(cwd) {
  return (args) => {
    const r = spawnSync('gh', args, { cwd, encoding: 'utf8', timeout: 60_000 });
    return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
}

function view(gh, pr, fields) {
  const r = gh(['pr', 'view', String(pr), '--json', fields]);
  if (!r.ok) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

/** The first path outside docs/, or null when every file is documentation. */
export function firstNonDoc(files) {
  return (files || []).map((f) => (typeof f === 'string' ? f : f.path)).find((p) => !String(p).startsWith(DOCS_PREFIX)) || null;
}

export async function runDocsMerge({
  repoPath, pr, gh = ghRunner(repoPath), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onProgress = () => {}, now = () => new Date(),
} = {}) {
  const started = now();
  const report = { repo: repoPath, pr: { number: pr }, mode: 'docs', ok: false, merged: false, stopped_at: null, reason: null, files: [], merge_commit: null, started_at: started.toISOString() };
  const finish = (stopped, reason) => ({ ...report, stopped_at: stopped, reason, duration_ms: now() - started });

  const info = view(gh, pr, 'number,title,state,isDraft,baseRefName,files');
  if (!info) return finish('read', `gh could not read #${pr}`);
  report.pr = { number: info.number, title: info.title, base: info.baseRefName };
  report.files = (info.files || []).map((f) => f.path);
  if (info.state !== 'OPEN') return finish('state', `#${pr} is ${String(info.state).toLowerCase()}, not open`);
  if (info.isDraft) return finish('draft', `#${pr} is a draft`);
  const outside = firstNonDoc(report.files);
  if (outside) return finish('not-docs', `#${pr} touches ${outside} — outside ${DOCS_PREFIX}, so this is the gate's, not --docs'`);
  if (!report.files.length) return finish('empty', `#${pr} changes no files`);

  // GitHub reports UNKNOWN for a few seconds after a push; merging then
  // fails for no real reason. Wait for a verdict first.
  let mergeable = 'UNKNOWN';
  for (let i = 0; i < MERGEABILITY_TRIES && mergeable === 'UNKNOWN'; i += 1) {
    mergeable = view(gh, pr, 'mergeable')?.mergeable || 'UNKNOWN';
    if (mergeable === 'UNKNOWN') { onProgress(`waiting for GitHub's mergeability of #${pr}`); await sleep(MERGEABILITY_WAIT_MS); }
  }
  if (mergeable === 'CONFLICTING') return finish('conflicting', `#${pr} conflicts with ${report.pr.base} — merge ${report.pr.base} in and push`);

  const merged = gh(['pr', 'merge', String(pr), '--squash', '--subject', `${info.title} (#${info.number})`]);
  const after = view(gh, pr, 'state,mergeCommit');
  if (after?.state !== 'MERGED') {
    const error = merged.stderr.trim().split('\n').at(-1) || `gh could not merge #${pr}`;
    return finish(merged.ok ? 'merge-unknown' : 'merge', error);
  }
  report.merged = true;
  report.ok = true;
  report.merge_commit = after.mergeCommit?.oid || null;
  report.merged_into = report.pr.base;
  return { ...report, duration_ms: now() - started };
}

export function docsMergeLines(report) {
  if (report.ok) {
    return [
      `mc: merged #${report.pr.number} into ${report.merged_into} as ${String(report.merge_commit || '').slice(0, 7)} (squash, docs only: ${report.files.length} file${report.files.length === 1 ? '' : 's'} under ${DOCS_PREFIX})`,
    ];
  }
  return [`mc: NOT merged — ${report.reason}`];
}
