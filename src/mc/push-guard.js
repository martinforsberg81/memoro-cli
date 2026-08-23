/**
 * A push to a branch that was already merged is said before it happens.
 *
 * Three different parties did it on one day (2026-08-23, D-0164): a plan's
 * owner, a Fable session, and PM. The shape is identical every time — the work
 * gets done, git accepts the push, everything looks right, and the content is
 * not where anybody reads it. A squash merge closes the pull request and
 * leaves the branch standing; the next commit on it goes up to a branch whose
 * pull request is closed, and nothing on the way says so. Each time it was
 * caught by somebody measuring against `origin/main` instead of trusting an
 * outcome. The merge-base mechanism says where something *went*; this is the
 * other half — where it did *not* go.
 *
 * The moment is the push, so the mechanism is a `pre-push` hook. It asks the
 * forge whether the branch has a merged pull request and git whether the
 * branch carries commits `origin/main` does not have. Both true is the case:
 * the push is refused with the pull request's number and date and the way
 * forward (a new branch from `origin/main`). `MC_PUSH_ANYWAY=1` lets a
 * deliberate push through — the hook is a question, not a lock.
 *
 * It never blocks on not knowing. No `gh`, no network, no pull request found:
 * the push goes, and the hook says in one line what it could not ask. A
 * guard that refuses pushes when GitHub is down would be a worse fault than
 * the one it exists for.
 *
 * Installed into the repository's *common* hooks directory, so every worktree
 * of the repository is covered by one file — mc adds worktrees, mc installs
 * the hook. A hook somebody else wrote is never overwritten: mc's carries a
 * marker line and only replaces what carries it.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MARKER = '# mc push-guard (D-0164) — replaced by mc, never by hand';

/**
 * The hook, as a file. `sh`, not bash — git runs hooks with whatever the user
 * has. It calls `mc` off PATH rather than by absolute path on purpose: the mc
 * that installs it may be running out of a worktree that is released next
 * week, and a hook pointing at a directory that is gone would fail every push
 * for a reason nobody could read. No mc on PATH is said, and the push goes.
 */
export function hookScript() {
  return [
    '#!/bin/sh',
    MARKER,
    '# Refuses a push to a branch whose pull request is already merged. See',
    '# src/mc/push-guard.js. MC_PUSH_ANYWAY=1 lets a deliberate push through.',
    'if command -v mc >/dev/null 2>&1; then exec mc repo push-check "$1" "$2"; fi',
    'echo "mc: push-guard: mc is not on PATH — pushing unchecked" >&2',
    'exit 0',
    '',
  ].join('\n');
}

/**
 * Install into one repository; idempotent, and it keeps its hands off a hook
 * it did not write.
 */
export function installPushGuard(repoPath, { git = defaultGit } = {}) {
  const common = git(['-C', repoPath, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common) return { ok: false, reason: 'not a git repository' };
  // core.hooksPath moves the hooks away from the repository; a user who set it
  // has their own arrangement, and mc writing into .git/hooks would install
  // a hook git never runs — which would look installed and guard nothing.
  const hooksPath = git(['-C', repoPath, 'config', '--get', 'core.hooksPath']);
  if (hooksPath) return { ok: false, reason: `core.hooksPath is set to ${hooksPath} — install the hook there by hand, or unset it` };
  const dir = join(common, 'hooks');
  const path = join(dir, 'pre-push');
  const wanted = hookScript();
  if (existsSync(path)) {
    const current = readFileSync(path, 'utf8');
    if (!current.includes(MARKER)) return { ok: false, reason: `${path} exists and is not mc's — left alone`, path };
    if (current === wanted) return { ok: true, installed: false, path };
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, wanted);
  chmodSync(path, 0o755);
  return { ok: true, installed: true, path };
}

/** Is mc's hook in place for this repository? */
export function pushGuardState(repoPath, { git = defaultGit } = {}) {
  const common = git(['-C', repoPath, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common) return { installed: false, reason: 'not a git repository' };
  const path = join(common, 'hooks', 'pre-push');
  if (!existsSync(path)) return { installed: false, path, reason: 'no pre-push hook' };
  const text = readFileSync(path, 'utf8');
  return text.includes(MARKER)
    ? { installed: true, path }
    : { installed: false, path, reason: 'a pre-push hook that is not mc\'s' };
}

/**
 * The question, for one local branch about to be pushed.
 *
 *   refuse   a merged pull request exists and the branch has commits main lacks
 *   allow    no merged pull request, or nothing to push main does not have
 *   unknown  could not ask — allowed, with the reason
 */
export function pushVerdict({
  cwd, branch, git = defaultGit, gh = defaultGh, base = null, now = new Date(),
} = {}) {
  if (!branch) return { verdict: 'allow', reason: 'not a branch' };
  const baseRef = base || git(['-C', cwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']) || 'origin/main';
  const ahead = git(['-C', cwd, 'rev-list', '--count', `${baseRef}..${branch}`]);
  if (ahead === null) return { verdict: 'unknown', reason: `could not compare ${branch} with ${baseRef}` };
  if (Number(ahead) === 0) return { verdict: 'allow', reason: `nothing on ${branch} that ${baseRef} lacks` };

  const asked = gh(['pr', 'list', '--head', branch, '--state', 'merged', '--limit', '5',
    '--json', 'number,title,mergedAt,mergeCommit'], { cwd });
  if (!asked.ok) return { verdict: 'unknown', reason: `could not ask GitHub whether ${branch} was merged — ${asked.reason}` };
  let merged = [];
  try { merged = JSON.parse(asked.stdout || '[]'); } catch { return { verdict: 'unknown', reason: 'GitHub answered something that was not a list' }; }
  if (!Array.isArray(merged) || merged.length === 0) return { verdict: 'allow', reason: `no merged pull request for ${branch}` };

  // The newest merge wins the sentence; a branch reused across two pull
  // requests is the case this exists for, and its last merge is the fact.
  const latest = merged.slice().sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)))[0];
  return {
    verdict: 'refuse',
    pr: latest.number,
    title: latest.title,
    merged_at: latest.mergedAt,
    merge_commit: latest.mergeCommit?.oid?.slice(0, 7) || null,
    ahead: Number(ahead),
    base: baseRef,
    reason: `${branch} was merged as #${latest.number}${latest.mergedAt ? ` ${ago(latest.mergedAt, now)}` : ''}`
      + ` — ${ahead} commit${Number(ahead) === 1 ? '' : 's'} here would go up to a branch nobody reads any more`,
  };
}

/**
 * What the hook prints. Everything on stderr: git shows hook output to the
 * person pushing, and it is the one place the sentence reaches them in time.
 */
export function pushCheckLines(verdict, { branch, anyway = false }) {
  if (verdict.verdict === 'refuse') {
    const lines = [
      `mc: push refused — ${verdict.reason}.`,
      `mc: the pull request is closed; pushing to ${branch} does not reopen it, and nothing reads the branch.`,
      `mc: start from ${verdict.base}: git switch -c <new-branch> ${verdict.base} && git cherry-pick <your commits>`,
    ];
    if (anyway) lines.push('mc: MC_PUSH_ANYWAY=1 is set — pushing regardless.');
    else lines.push('mc: if you mean it: MC_PUSH_ANYWAY=1 git push …');
    return lines;
  }
  if (verdict.verdict === 'unknown') return [`mc: push-guard could not check ${branch}: ${verdict.reason} — pushing`];
  return [];
}

function ago(iso, now) {
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h ago`;
  return `on ${iso.slice(0, 10)}`;
}

function defaultGit(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout.trim() || '') : null;
}

function defaultGh(args, { cwd } = {}) {
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8' });
  if (r.error?.code === 'ENOENT') return { ok: false, reason: 'gh is not installed' };
  if (r.status !== 0) return { ok: false, reason: (r.stderr || '').split('\n').find(Boolean)?.trim() || `gh exited ${r.status}` };
  return { ok: true, stdout: r.stdout };
}
