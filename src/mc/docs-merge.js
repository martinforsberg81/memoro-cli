/**
 * `mc merge <repo> <pr> --docs` — land a pull request that touches nothing
 * outside `docs/`, once the tests that read documents are green.
 *
 * A plan is no longer a file in a repository (ruling 48): the route refuses a
 * pull request that adds lines to one, and a pull request that only removes
 * one lands. A document has no suite, but the repository's selector knows
 * which tests read documents, and four documents-only landings turned memoro's
 * main red between 2026-10-20 and 10-24 (docs-measure.js). So the form runs
 * those tests on a candidate of the head and squashes only on green. It never
 * runs the suite, and a red is not merged. The check is GitHub's own file list
 * for the PR, never a local diff, so a stale checkout cannot make a code PR
 * look like documentation.
 */
import { spawnSync } from 'node:child_process';

import { measureDocs } from './docs-measure.js';
import { isRepoPlanPath } from './plan-source.js';

export const DOCS_PREFIX = 'docs/';
/**
 * A script under docs/ is not a document: a tree-wide lint or pin check in the
 * repository's gate reads it, and this door runs no gate (memoro #12534 turned
 * main red this way, 2026-10-04). Exported because the doc names them.
 */
export const SCRIPT_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts'];
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

/** The first path that is a script, in any directory, or null. */
export function firstScript(files) {
  return (files || []).map((f) => (typeof f === 'string' ? f : f.path)).find((p) => SCRIPT_EXTENSIONS.some((ext) => String(p).endsWith(ext))) || null;
}

/**
 * True when there are files and every one is a document under docs/ and none
 * a script — the rule this door lands by. `mc merge` without `--docs` routes a
 * pull request that passes it here, and `mc gate` answers such a diff at once.
 */
export function docsOnly(files) {
  return (files || []).length > 0 && !firstNonDoc(files) && !firstScript(files);
}

/** GitHub's file list for a pull request, or null when gh cannot read it. */
export function prFiles(pr, { repoPath, gh = ghRunner(repoPath) } = {}) {
  const info = view(gh, pr, 'files');
  return Array.isArray(info?.files) ? info.files.map((f) => f.path) : null;
}

export async function runDocsMerge({
  repoPath, pr, gh = ghRunner(repoPath), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onProgress = () => {}, now = () => new Date(), measure = measureDocs,
} = {}) {
  const started = now();
  const report = { repo: repoPath, pr: { number: pr }, mode: 'docs', ok: false, merged: false, stopped_at: null, reason: null, files: [], merge_commit: null, started_at: started.toISOString() };
  const finish = (stopped, reason) => ({ ...report, stopped_at: stopped, reason, duration_ms: now() - started });

  const info = view(gh, pr, 'number,title,state,isDraft,baseRefName,headRefName,body,files,headRefOid');
  if (!info) return finish('read', `gh could not read #${pr}`);
  const head = info.headRefOid || null;
  report.head = head;
  if (!head) return finish('read', `gh gave no head for #${pr}`);
  report.pr = { number: info.number, title: info.title, base: info.baseRefName };
  // The branch and the body name the step the verb books the landing on.
  report.branch = info.headRefName || null;
  report.body = info.body || null;
  report.files = (info.files || []).map((f) => f.path);
  if (info.state !== 'OPEN') return finish('state', `#${pr} is ${String(info.state).toLowerCase()}, not open`);
  if (info.isDraft) return finish('draft', `#${pr} is a draft`);
  const outside = firstNonDoc(report.files);
  if (outside) return finish('not-docs', `#${pr} touches ${outside} — outside ${DOCS_PREFIX}, so this is the gate's, not --docs'`);
  const script = firstScript(report.files);
  if (script) return finish('script', `#${pr} carries ${script} — a script is not a document; land it through the gate: mc merge <repo> ${pr}`);
  // The same objects as report.files, with their line counts: a file that only
  // removes lines (a plan taken out) lands; one that adds them does not.
  const plan = (info.files || []).find((f) => isRepoPlanPath(f.path) && f.additions > 0);
  if (plan) return finish('plan', `#${pr} writes ${plan.path} — a plan is written with mc project new … and lives under ~/mc/programs/, never in a repository`);
  if (!report.files.length) return finish('empty', `#${pr} changes no files`);

  // GitHub reports UNKNOWN for a few seconds after a push; merging then
  // fails for no real reason. Wait for a verdict first.
  let mergeable = 'UNKNOWN';
  for (let i = 0; i < MERGEABILITY_TRIES && mergeable === 'UNKNOWN'; i += 1) {
    mergeable = view(gh, pr, 'mergeable')?.mergeable || 'UNKNOWN';
    if (mergeable === 'UNKNOWN') { onProgress(`waiting for GitHub's mergeability of #${pr}`); await sleep(MERGEABILITY_WAIT_MS); }
  }
  if (mergeable === 'CONFLICTING') return finish('conflicting', `#${pr} conflicts with ${report.pr.base} — merge ${report.pr.base} in and push`);

  const drifted = (headNow) => finish('drift', `#${pr} moved on GitHub from ${String(head).slice(0, 7)} to ${String(headNow || 'nothing').slice(0, 7)} after its files were checked — not merged; run mc merge --docs again`);
  // The squash lands the head whose files were checked and no other (ruling 43),
  // as the gate form pins its squash in repo-merge.js.
  const headNow = view(gh, pr, 'headRefOid')?.headRefOid || null;
  if (headNow !== head) return drifted(headNow);

  // The tests that read the documents, on a candidate of this head with its base
  // merged in. A red, or a measurement that could not run, is not merged.
  const measured = await measure({ repoPath, pr, headSha: head, headRef: report.branch, base: report.pr.base, say: onProgress });
  report.measured = { files: measured.files ?? 0, red: measured.red ?? [], seconds: measured.seconds ?? null, reason: measured.reason ?? null };
  if (!measured.ok) {
    return measured.stopped_at === 'red'
      ? finish('red', `#${pr}: ${measured.reason} — not merged; fix the documents and push`)
      : finish(`measure-${measured.stopped_at}`, `#${pr}: the documents' tests could not be run (${measured.reason}) — not merged`);
  }
  // The tests take a minute, so the head is read again, as the check above reads it.
  const headAfterTests = view(gh, pr, 'headRefOid')?.headRefOid || null;
  if (headAfterTests !== head) return drifted(headAfterTests);

  const merged = gh(['pr', 'merge', String(pr), '--squash', '--subject', `${info.title} (#${info.number})`, '--match-head-commit', head]);
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
    const files = `${report.files.length} file${report.files.length === 1 ? '' : 's'} under ${DOCS_PREFIX}`;
    const measured = report.measured;
    // A repository that declares no select measures nothing, and its line keeps the words it always had.
    const tests = measured && !/nothing to measure/u.test(measured.reason || '')
      ? `; ${measured.files} test file${measured.files === 1 ? '' : 's'} green${measured.seconds == null ? '' : ` in ${measured.seconds}s`}`
      : '';
    return [
      `mc: merged #${report.pr.number} into ${report.merged_into} as ${String(report.merge_commit || '').slice(0, 7)} (squash, docs only: ${files}${tests})`,
    ];
  }
  return [`mc: NOT merged — ${report.reason}`];
}
