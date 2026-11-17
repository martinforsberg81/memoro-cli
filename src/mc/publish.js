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
 * pushed, and the one line to run next — none when `mc publish` queues the
 * pull request itself, and the merge's own lines follow.
 */
export function publishLines({ pr, localHead, branch, pushed, created, repo, after = 0, described = null, queued = false, handOff = null }) {
  const head = String(pr.headRefOid || '');
  const same = head.startsWith(localHead) || localHead.startsWith(head);
  return [
    `#${pr.number} ${pr.url}`,
    `${created ? 'opened' : 'already open'} from ${branch} → ${pr.baseRefName}; ${pushed ? 'pushed' : 'nothing to push'} ${localHead.slice(0, 7)}${same ? '' : ` — GitHub holds ${head.slice(0, 7)}, not the head that was pushed: read gh pr view ${pr.number}`}`,
    ...(after > 0 ? [`description at ${described.slice(0, 7)}; ${after} later commit${after === 1 ? '' : 's'} under "After the description" — --body-file rewrites it`] : []),
    ...(pr.mergeStateStatus && pr.mergeStateStatus !== 'UNKNOWN' ? [`state ${pr.mergeStateStatus.toLowerCase()}${pr.mergeable ? `, ${String(pr.mergeable).toLowerCase()}` : ''}`] : []),
    ...(handOff ? [handOff] : queued ? [] : [`next: mc merge ${repo} ${pr.number}`]),
  ];
}

/* ------------------------------------------------------------ the manager's guard */

/** What the manager may change: its curation of the area texts is `docs/technical/` and nothing else (D6). */
const MANAGER_ROOT = 'docs/technical/';
const MANAGER_ME = 'docs/technical/memoro-me.md';
const AREA_PAGE = /^docs\/technical\/areas\/[^/]+\.md$/u;
/** A dated decision of Martin's: his name, a comma and a date, as every decision in the standards is written. */
const MARTIN_DECIDED = /Martin, \d{4}-\d\d-\d\d/u;
const BLOCK_START = /^(\s*([-*]|\d+\.)\s|#{1,6}\s)/u;

/** The body of a `## <heading>` section of `text`, up to the next `## ` heading: '' when the section is not there. */
function sectionOf(text, heading) {
  const lines = String(text ?? '').split('\n');
  const start = lines.findIndex((line) => line.trimEnd() === `## ${heading}`);
  if (start < 0) return '';
  let end = lines.findIndex((line, at) => at > start && line.startsWith('## '));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

/**
 * The blocks of `text`, each as its lines: a list item with its continuation lines, a heading, or a paragraph up to
 * the next blank line. A line that starts a list item or a heading starts a block of its own.
 */
export function blocksOf(text) {
  const blocks = []; let current = [];
  const close = () => { if (current.length) blocks.push(current); current = []; };
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) { close(); continue; }
    if (BLOCK_START.test(line)) close();
    current.push(line);
  }
  close();
  return blocks;
}

/** The blocks of `text` that hold a dated decision of Martin's. */
export function martinBlocks(text) {
  return blocksOf(text).filter((block) => MARTIN_DECIDED.test(block.join('\n')));
}

const textOf = (block) => block.join('\n');

/** The latest date of Martin's decisions in a block, as YYYY-MM-DD; '' when it holds none. */
function blockDate(block) {
  return [...textOf(block).matchAll(/Martin, (\d{4}-\d\d-\d\d)/gu)].map((match) => match[1]).sort().at(-1) ?? '';
}

/** The citation a block ends with: its last `Martin, YYYY-MM-DD` and what follows it on the line, up to a `)`. */
function citation(block) {
  return [...textOf(block).matchAll(/Martin, \d{4}-\d\d-\d\d[^)\n]*/gu)].map((match) => match[0]).at(-1) ?? null;
}

/**
 * Which dated blocks of `before` the new text supersedes (D2). A block of before is kept when `after` holds it unchanged;
 * a dated block that is not kept is superseded when a kept block has a later date.
 */
function supersession(before, after) {
  const afterTexts = new Set(martinBlocks(after).map(textOf));
  const kept = martinBlocks(before).filter((block) => afterTexts.has(textOf(block)));
  const keptTexts = new Set(kept.map(textOf));
  const newest = kept.map(blockDate).sort().at(-1) ?? '';
  return {
    kept: keptTexts,
    superseded: (block) => MARTIN_DECIDED.test(textOf(block)) && !keptTexts.has(textOf(block)) && blockDate(block) < newest,
  };
}

/**
 * Whether the `## Decisions` of an area page changed only by the removal or the correction of superseded dated blocks: each
 * block of before is in after unchanged, or is superseded and is removed, or is replaced in its place by a block with the
 * same citation. Nothing else may differ — a block added, an undated block changed, a block changed that is not superseded.
 */
function decisionsCorrected(before, after, superseded) {
  const was = blocksOf(before);
  const now = blocksOf(after);
  let at = 0;
  for (const block of was) {
    if (at < now.length && textOf(now[at]) === textOf(block)) { at++; continue; }
    if (!superseded(block)) return false;
    if (at < now.length && citation(now[at]) !== null && citation(now[at]) === citation(block)) at++;
  }
  return at === now.length;
}

/**
 * Why the manager may not publish this diff, or null (D6). `files` is `[{ path, before, after }]`: each file the branch
 * changes against origin/main with its text there and at the branch's head, null where it is not (added, deleted).
 * It refuses a file outside `docs/technical/`, `docs/technical/memoro-me.md`, a change to the `## Aim` of an area page, a
 * change to its `## Decisions` other than the correction of a superseded dated block, and any removal or alteration of a
 * block that holds a dated decision of Martin's unless the same file keeps, unchanged, a dated block with a later date (D2).
 */
export function managerGuard(files) {
  const found = [];
  for (const { path, before, after } of files) {
    if (!path.startsWith(MANAGER_ROOT)) { found.push(`${path} is outside docs/technical/`); continue; }
    if (path === MANAGER_ME) { found.push(`${path} is Martin's own text`); continue; }
    const { kept, superseded } = supersession(before, after);
    if (AREA_PAGE.test(path)) {
      if (sectionOf(before, 'Aim') !== sectionOf(after, 'Aim')) found.push(`${path} changes its ## Aim`);
      if (!decisionsCorrected(sectionOf(before, 'Decisions'), sectionOf(after, 'Decisions'), superseded)) found.push(`${path} changes its ## Decisions`);
    }
    const here = new Set(String(after ?? '').split('\n'));
    for (const block of martinBlocks(before)) {
      if (kept.has(textOf(block)) || superseded(block)) continue;
      const lost = block.find((line) => !here.has(line)) ?? block[0];
      found.push(`${path} removes or alters a line of a dated decision of Martin's (${JSON.stringify(lost.trim().slice(0, 60))})`);
    }
  }
  if (!found.length) return null;
  return `the manager publishes only what its role may change — ${found.join('; ')}; a text of Martin's goes to the desk with mc martin propose`;
}
