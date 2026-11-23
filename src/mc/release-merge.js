import { canRepairRelease, readRelease } from './deploy-release.js';
import { belongsToRelease, readMainMends } from './main-repair.js';
import { takeBackReading } from './take-back.js';

export const isReleaseBase = (base) => Boolean(base?.startsWith('release/'));

/** PR number AND head branch carry the ownership recorded before queueing. */
export function releaseMendOf({ root, repo, pr, head, read }) {
  if (repo !== 'memoro') return null;
  return readMainMends({ root, repo, read }).find((entry) =>
    entry.release_branch && entry.pr === Number(pr) && (!head || entry.branch === head) &&
    ['published', 'running'].includes(entry.state)) || null;
}

export function releaseMergeAdmission({ root, repo, pr, head, base, read }) {
  const mend = releaseMendOf({ root, repo, pr, head, read });
  const label = `mc: ${repo}#${pr}`;
  if (!isReleaseBase(base)) return mend
    ? { stop: 'merge', reason: `${label} repairs ${mend.release_branch} — base it there (mc publish --base ${mend.release_branch})` }
    : {};
  const release = repo === 'memoro' ? readRelease(root, read) : null;
  if (mend && head && base === mend.release_branch && belongsToRelease(mend, release)) {
    if (!release.closed && !release.push_pending && canRepairRelease(release)) return { release };
    return { stop: 'release-closed', reason: `${label} came after ${base} went green — not landed; the release takes nothing more` };
  }
  return { stop: 'merge', reason: `${label} is based on ${base}, which takes only its own repairs — base it on main (mc publish --base main)` };
}

export function releaseFastPathRefusal(pr) {
  const admission = releaseMergeAdmission(pr);
  return admission.reason || (admission.release
    ? `mc: ${pr.repo}#${pr.pr} needs the release repair's measured merge — publish it with mc publish --base ${pr.base}`
    : null);
}

/**
 * Read the measured tree with the cut's reader, never code supplied by a PR.
 * Read the delta as well as the cumulative change: a further edit to an
 * already listed migration could leave the cumulative wording identical;
 * restoring a binding missing at the cut can remove an existing reason.
 */
export async function releaseReadingChange({ path, candidate, release, read = takeBackReading }) {
  if (!candidate) return 'could not identify the measured candidate';
  const cut = release.cut.sha;
  const at = (from) => read({ path, from, to: candidate, readerRev: cut });
  const delta = await at(cut);
  if (!delta.made) return delta.why;
  const first = delta.reasons[0];
  if (first) return ['migration-after', 'migration-before'].includes(first.kind) ? `adds ${first.file}` : first.what;

  if (release.take_back?.made) {
    const next = await at(release.live);
    if (!next.made) return next.why;
    const key = ({ kind, file, what }) => JSON.stringify([kind, file, what]);
    const before = new Set(release.take_back.reasons.map(key));
    const after = new Set(next.reasons.map(key));
    return next.reasons.find((reason) => !before.has(key(reason)))?.what
      || release.take_back.reasons.find((reason) => !after.has(key(reason)))?.what || null;
  }
  return null;
}
