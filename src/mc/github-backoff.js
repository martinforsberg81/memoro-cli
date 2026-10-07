/**
 * When GitHub cannot be asked: how long the runner leaves a repository alone,
 * and why it could not ask.
 *
 * The round asks `gh pr list` once per repository (`queue()` in run.js). A
 * failed ask used to be one line in `runner.log` and the next round asked
 * again. On 2026-09-20 a locked login keychain made every ask hang on a
 * `security` call and leave a macOS modal behind — 30, then 44 processes — and
 * the page showed nothing of it. #771 bounded each ask; this bounds how often
 * one is made, and says on the page what failed and what fixes it.
 *
 * The state is `~/mc/runner/github.json`, beside the lane files: one record
 * per repository whose last ask failed, gone on the first ask that answers.
 * Its keys are the runner's `prsFailed` as it stands between rounds, which is
 * why the page reads it rather than asking GitHub itself.
 */

/** The file under `~/mc/runner/`. */
export const GITHUB_STATE = 'github.json';

/** Minutes after the n-th failure in a row before the next ask; the last repeats. */
export const GITHUB_BACKOFF_MINUTES = Object.freeze([1, 2, 5, 15]);

/** How long each diagnosing tool may take: a locked keychain does not answer at all. */
export const DIAGNOSE_TIMEOUT_MS = 2_000;

/** What each diagnosis says on the page, and the command that fixes it. */
export const GITHUB_CAUSES = Object.freeze({
  keychain: Object.freeze({ label: 'keychain locked', fix: 'security unlock-keychain' }),
  token: Object.freeze({ label: 'gh token invalid', fix: 'gh auth login -h github.com' }),
});

/** Milliseconds to wait after `attempts` failures in a row. */
export function backoffMs(attempts) {
  const index = Math.min(Math.max(1, attempts), GITHUB_BACKOFF_MINUTES.length) - 1;
  return GITHUB_BACKOFF_MINUTES[index] * 60_000;
}

/** When a repository with this record may be asked again, as an ISO string. */
export function nextAskAt(record) {
  const last = Date.parse(record?.last);
  if (!Number.isFinite(last)) return null;
  return new Date(last + backoffMs(record.attempts || 1)).toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

/** Whether the round may ask GitHub about a repository whose record is this. */
export function mayAsk(record, now) {
  const next = nextAskAt(record);
  return !next || now.getTime() >= Date.parse(next);
}

/**
 * The record after one more failure: `since` stays the first of the streak,
 * `last` and `attempts` move, and the diagnosis is the one made now.
 */
export function failedAsk(record, { at, error, diagnosis = null }) {
  const attempts = (record?.attempts || 0) + 1;
  const next = {
    since: record?.since || at,
    last: at,
    attempts,
    error: String(error || '').slice(0, 300),
    cause: diagnosis?.cause || null,
  };
  return { ...next, next_ask: nextAskAt(next) };
}

/**
 * Why GitHub could not be asked, in one pass of two short calls.
 *
 * `security show-keychain-info` answers at once on an open keychain and hangs
 * or fails on a locked one — where gh keeps its token on a Mac. Only when the
 * keychain answers is `gh auth status` asked, and a failure there is the
 * token. Anything else is no diagnosis: the error itself is what the page
 * shows. `run(cmd, args)` answers `{ ok, stdout, stderr }` and stops the tool
 * after `DIAGNOSE_TIMEOUT_MS`.
 */
export function diagnoseGithub({ run, platform = process.platform }) {
  if (platform === 'darwin') {
    const keychain = run('security', ['show-keychain-info']);
    if (!keychain.ok) return { cause: 'keychain' };
  }
  const auth = run('gh', ['auth', 'status']);
  if (!auth.ok) return { cause: 'token' };
  return { cause: null };
}

/** The records as the page shows them: one per repository, with the words and the fix. */
export function githubFailures(state, { now = new Date() } = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return [];
  return Object.entries(state)
    .filter(([, record]) => record && typeof record === 'object' && record.since)
    .map(([repo, record]) => {
      const cause = GITHUB_CAUSES[record.cause] || null;
      const since = Date.parse(record.since);
      return {
        repo,
        since: record.since,
        since_seconds: Number.isFinite(since) ? Math.max(0, Math.round((now.getTime() - since) / 1000)) : null,
        attempts: record.attempts || 1,
        error: record.error || null,
        cause: record.cause || null,
        label: cause?.label || null,
        fix: cause?.fix || null,
        next_ask: record.next_ask || nextAskAt(record),
      };
    })
    .sort((a, b) => a.repo.localeCompare(b.repo));
}
