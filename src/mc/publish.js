/**
 * `mc publish` — the publication sequence memoro's `AGENTS.md` spells out in
 * prose (§ *Deterministic publication sequence*), as code, and answered in
 * five lines.
 *
 * The prose asks a session for: a clean task tree; a non-force `git push` of
 * the branch it stands on; never moving a remote branch whose head differs
 * from the expected one; one `gh pr create` or `gh pr edit`, never a second
 * pull request; then one `gh pr view` snapshot of the planned head. Each
 * rule is a check here, and each check refuses with the reason and nothing
 * happens. What a session used to do in four to six Bash turns — push, list,
 * create, view, and the reading between them — is one call, and its output
 * is the pull request's number and URL, the head that is on it, and the
 * next line to run.
 *
 * Pure over facts about the tree; the verb gathers them.
 */

/** The branches nobody publishes from: a pull request is opened *to* them. */
export const PROTECTED = new Set(['main', 'master', 'HEAD']);

/**
 * Why the publication cannot go, or null. `remoteHead` is the branch's head
 * on origin (null when it has none), `remoteIsAncestor` whether that head
 * is in the local branch's history — false means somebody moved the remote
 * branch, and a push would need force, which never happens here.
 */
export function refusal({ branch, dirty = [], remoteHead = null, localHead, remoteIsAncestor = true }) {
  if (!branch || PROTECTED.has(branch)) {
    return `on ${branch || 'no branch'} — a pull request is opened from a branch, to ${branch === 'master' ? 'master' : 'main'}; check one out first`;
  }
  if (dirty.length) {
    const shown = dirty.slice(0, 10).map((line) => `  ${line}`);
    return [`the tree is not clean — commit the reviewed files first, or move what is not the change to $MC_SCRATCH:`,
      ...shown, ...(dirty.length > 10 ? [`  … and ${dirty.length - 10} more`] : [])].join('\n');
  }
  if (remoteHead && remoteHead !== localHead && !remoteIsAncestor) {
    return `origin/${branch} is at ${remoteHead.slice(0, 7)}, which is not in this branch's history — somebody moved it, and mc never force-pushes. `
      + `Read it (git log HEAD..origin/${branch}), merge it in, and publish again`;
  }
  return null;
}

/** The pull request title and body when the caller gave none: the last commit's. */
export function messageParts(commitMessage) {
  const [subject, ...rest] = String(commitMessage || '').split('\n');
  const body = rest.join('\n').replace(/^\n+/u, '').replace(/\n+$/u, '');
  return { title: subject.trim(), body };
}

/**
 * The lines a session reads back. Number and URL first — that is what it
 * needs — then the head as GitHub holds it against the head that was
 * pushed, and the one line to run next.
 */
export function publishLines({ pr, localHead, branch, pushed, created, repo }) {
  const head = String(pr.headRefOid || '');
  const same = head.startsWith(localHead) || localHead.startsWith(head);
  return [
    `#${pr.number} ${pr.url}`,
    `${created ? 'opened' : 'already open'} from ${branch} → ${pr.baseRefName}; ${pushed ? 'pushed' : 'nothing to push'} ${localHead.slice(0, 7)}${same ? '' : ` — GitHub holds ${head.slice(0, 7)}, not the head that was pushed: read gh pr view ${pr.number}`}`,
    ...(pr.mergeStateStatus && pr.mergeStateStatus !== 'UNKNOWN' ? [`state ${pr.mergeStateStatus.toLowerCase()}${pr.mergeable ? `, ${String(pr.mergeable).toLowerCase()}` : ''}`] : []),
    `next: mc merge ${repo} ${pr.number}`,
  ];
}
