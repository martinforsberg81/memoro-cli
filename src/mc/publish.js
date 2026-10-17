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

/** The heading `mc publish` writes over the commits after the head the description describes. */
export const AFTER_HEADING = '## After the description';

/** The mark that ends a description: the head it describes (ruling 43). */
const MARK = /^<!-- mc:described ([0-9a-f]{7,40}) -->$/u;

/** Trailers a commit carries for its author or its tool, not for a reader of the description. */
const TRAILER = /^(Co-Authored-By|Claude-Session|Signed-off-by):/iu;

/** The description with its mark, the mark last; just the mark when there is no text. */
export function markedBody(text, sha) {
  const mark = `<!-- mc:described ${sha} -->`;
  return text.trim() ? `${text.trimEnd()}\n\n${mark}` : mark;
}

/**
 * The description as `mc publish` reads it: the text above the generated
 * section, and the head its mark names, null when it has none. The mark's
 * line and the section go; what the author wrote stays as written.
 */
export function readBody(body) {
  const lines = String(body || '').split(/\r?\n/u);
  const at = lines.findLastIndex((line) => MARK.test(line));
  const described = at >= 0 ? MARK.exec(lines[at])[1] : null;
  const kept = at >= 0 ? lines.filter((_, index) => index !== at) : lines;
  const cut = kept.indexOf(AFTER_HEADING);
  return { text: (cut >= 0 ? kept.slice(0, cut) : kept).join('\n').trimEnd(), described };
}

/**
 * The generated section: one entry per commit, oldest first — its short sha
 * and subject, then its body's lines indented two spaces, without the
 * trailers. Empty when there are no commits.
 */
export function afterSection(commits) {
  if (!commits.length) return '';
  const entries = commits.map(({ sha, subject, body }) => [
    `- \`${sha.slice(0, 7)}\` ${subject}`,
    ...String(body || '').split(/\r?\n/u).filter((line) => line.trim() && !TRAILER.test(line)).map((line) => `  ${line}`),
  ].join('\n'));
  return `${AFTER_HEADING}\n\n${entries.join('\n')}`;
}

/** The description a publication writes: its text, the section for the commits after `described`, and the mark. */
export function describedBody({ text, described, commits }) {
  const section = afterSection(commits);
  const whole = section ? (text.trim() ? `${text.trimEnd()}\n\n${section}` : section) : text;
  return markedBody(whole, described);
}

/**
 * The lines a session reads back. Number and URL first — that is what it
 * needs — then the head as GitHub holds it against the head that was
 * pushed, and the one line to run next.
 */
export function publishLines({ pr, localHead, branch, pushed, created, repo, after = 0, described = null }) {
  const head = String(pr.headRefOid || '');
  const same = head.startsWith(localHead) || localHead.startsWith(head);
  return [
    `#${pr.number} ${pr.url}`,
    `${created ? 'opened' : 'already open'} from ${branch} → ${pr.baseRefName}; ${pushed ? 'pushed' : 'nothing to push'} ${localHead.slice(0, 7)}${same ? '' : ` — GitHub holds ${head.slice(0, 7)}, not the head that was pushed: read gh pr view ${pr.number}`}`,
    ...(after > 0 ? [`description at ${described.slice(0, 7)}; ${after} later commit${after === 1 ? '' : 's'} under "After the description" — --body-file rewrites it`] : []),
    ...(pr.mergeStateStatus && pr.mergeStateStatus !== 'UNKNOWN' ? [`state ${pr.mergeStateStatus.toLowerCase()}${pr.mergeable ? `, ${String(pr.mergeable).toLowerCase()}` : ''}`] : []),
    `next: mc merge ${repo} ${pr.number}`,
  ];
}
