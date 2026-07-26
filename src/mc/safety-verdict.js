/**
 * Escalate-only safety verdict derivation.
 *
 * Stored verdicts can go stale while git facts move on. Freshly observed
 * facts may only make a verdict LESS safe (escalate), never more safe —
 * a stored SAFE_TO_END must never survive observed dirty files, but a
 * stored NEEDS_REVIEW is kept even when facts look clean, because the
 * flow that stored it may know more than git does. Full recomputation
 * (both directions) stays where it always was: `mc end`'s computeVerdict.
 *
 * IS_ACTIVE_NOW is trusted as-is: callers are responsible for clearing it
 * (pass stored=null) when the session is not actually reachable.
 */
export function escalateSafetyVerdict({ stored = null, dirtyFiles = null, ahead = null } = {}) {
  const dirty = Number.isFinite(dirtyFiles) ? dirtyFiles : null;
  const aheadCount = Number.isFinite(ahead) ? ahead : null;
  if (stored === 'IS_ACTIVE_NOW') return stored;
  if (stored === 'IS_SQUASH_PHANTOM') {
    return dirty > 0 ? 'NEEDS_REVIEW' : 'IS_SQUASH_PHANTOM';
  }
  if (dirty > 0) return 'NEEDS_REVIEW';
  if (aheadCount > 0 && (!stored || stored === 'SAFE_TO_END')) return 'HAS_UNMERGED_WORK';
  if (stored) return stored;
  return dirty === 0 && aheadCount === 0 ? 'SAFE_TO_END' : 'NEEDS_REVIEW';
}
