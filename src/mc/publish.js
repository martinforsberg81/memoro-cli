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

/** Keep every occurrence, including its heading, so adding a second Aim or Decisions is not a factual edit. */
function areaHeldSections(text, title) {
  const sections = [];
  let current = null;
  for (const line of text.split('\n')) {
    const heading = /^ {0,3}(#{1,2})[ \t]+(.*)$/u.exec(line);
    if (heading) {
      current = null;
      if (heading[1] === '##' && heading[2].replace(/[ \t]+#+[ \t]*$/u, '').trim().toLowerCase() === title) {
        current = [line];
        sections.push(current);
      }
    } else if (current) current.push(line);
  }
  return JSON.stringify(sections.map(lines => lines.join('\n').trimEnd()));
}

// Tabs advance to the next four-column stop, including after a list marker.
function markdownIndent(whitespace, column = 0) {
  for (const char of whitespace) column += char === '\t' ? 4 - column % 4 : 1;
  return column;
}

// CommonMark 0.31.2 §4.6, in start-condition order. Types 1–5 end on a delimiter.
const HTML_DELIMITED = [
  { start: /^<(?:pre|script|style|textarea)(?=[ \t>]|$)/i, end: /<\/(?:pre|script|style|textarea)>/i },
  { start: /^<!--/u, end: /-->/u },
  { start: /^<\?/u, end: /\?>/u },
  { start: /^<![A-Za-z]/u, end: />/u },
  { start: /^<!\[CDATA\[/u, end: /\]\]>/u },
];
const HTML_BLOCK_TAGS = new Set(`address article aside base basefont blockquote body caption center col colgroup
dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header
hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary
table tbody td tfoot th thead title tr track ul`.split(/\s+/u));
const HTML_UNTIL_BLANK = { end: null };
// Type 7 requires a whole open or closing tag on the line (§6.6 tag grammar).
const HTML_ATTRIBUTE = /[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t"'=<>\x60]+|'[^']*'|"[^"]*"))?/u;
const HTML_COMPLETE_TAG = new RegExp(`^<(?:/[A-Za-z][A-Za-z0-9-]*[ \\t]*|[A-Za-z][A-Za-z0-9-]*(?:${HTML_ATTRIBUTE.source})*[ \\t]*/?)>[ \\t]*$`, 'u');

function learningHtmlBlock(content, paragraph) {
  if (!content.startsWith('<')) return null;
  const delimited = HTML_DELIMITED.find(({ start }) => start.test(content));
  if (delimited) return delimited;
  const tag = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?=[ \t>]|\/>|$)/u.exec(content)?.[1];
  if (!tag) return null;
  const name = tag.toLowerCase();
  if (HTML_BLOCK_TAGS.has(name)) return HTML_UNTIL_BLANK;
  if (paragraph || (!content.startsWith('</') && /^(?:pre|script|style|textarea)$/u.test(name))) return null;
  return HTML_COMPLETE_TAG.test(content) ? HTML_UNTIL_BLANK : null;
}

/**
 * Pin structural blocks in order, including their surrounding nonblank lines.
 * In addition to possible headings, fences, raw HTML and reference definitions,
 * keep top-level indented code. Indentation alone is not code within a paragraph
 * or at a list item's content column. Only a nonempty item continues across a
 * blank line. Also pin each recognized HTML leaf's source, which can span
 * several of these conservative chunks.
 */
function learningStructure(text) {
  const structural = /\x60{3,}|~{3,}|<[A-Za-z/!?]|\]:|^[ \t>]*(?:#{1,6}(?:[ \t]|$)|(?:=+|-+)[ \t]*$)/mu;
  const boundary = /^(?:#{1,6}(?:[ \t]|$)|(?:\x60{3,}|~{3,}|>)|(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$)/u;
  const listMarker = /^([-+*]|\d{1,9}[.)])([ \t]+|$)(.*)$/u;
  const items = [];
  const pinned = [], htmlSpans = [];
  // The leaf belongs to the deepest active item (or the document at depth zero).
  let html = null, fence = null;
  function closeHtml(end) {
    if (!html) return;
    htmlSpans.push(text.slice(html.start, end));
    html = null;
  }
  // Keep the conservative chunks unchanged, but count their original separators
  // in source offsets. The first newline still belongs to the preceding line.
  const chunks = text.split(/(\r?\n(?:[ \t]*\r?\n)+)/u);
  let offset = 0;
  for (let i = 0; i < chunks.length; i += 2) {
    const block = chunks[i], separator = chunks[i + 1] ?? '';
    const newline = /^\r?\n/u.exec(separator)?.[0] ?? '';
    let paragraph = false, code = false;
    for (const [rawLine, line] of (block + newline).matchAll(/([^\n]*?)(?:\r?\n|$)/gu)) {
      if (!rawLine) continue;
      const lineStart = offset;
      offset += rawLine.length;
      const indent = /^[ \t]*/u.exec(line)[0];
      let column = markdownIndent(indent);
      let content = line.slice(indent.length);
      if (!content && html?.end === null) closeHtml(lineStart);
      let depth = items.length;
      while (depth && column < items[depth - 1].column) depth--;

      // Classify inline item contents the same way as a later indented line.
      while (content) {
        const parent = items[depth - 1];
        const relative = column - (parent?.column ?? 0);
        // A matched HTML leaf owns the whole line, even if it resembles a new
        // block or includes the end delimiter. Unmatched leaves close below.
        if (depth === items.length && html) {
          if (html.end?.test(content)) closeHtml(offset);
          break;
        }
        const fenceLine = relative < 4 && /^(\x60{3,}|~{3,})(.*)$/u.exec(content);
        if (depth === items.length && fence) {
          if (fenceLine && fenceLine[1].startsWith(fence) && /^[ \t]*$/u.test(fenceLine[2])) fence = null;
          break;
        }
        const startsHtml = relative < 4 && learningHtmlBlock(content, paragraph);
        const startsBlock = startsHtml || (relative < 4 && boundary.test(content));
        const marker = relative < 4 && !startsBlock ? listMarker.exec(content) : null;
        const style = marker?.[1].at(-1);
        // A sibling can be empty or have any start number; a new list cannot
        // interrupt prose unless it starts with content and (if ordered) at 1.
        const startsItem = marker && (!paragraph || style === items[depth]?.style
          || (marker[3] && /^([-+*]|0*1[.)])$/u.test(marker[1])));

        if (depth < items.length) {
          // Only the paragraph at the deepest active item can continue lazily.
          if (paragraph && !startsBlock && !startsItem) break;
          items.length = depth;
          paragraph = false;
          closeHtml(lineStart);
          fence = null;
        }
        if (parent) parent.hasContent = true;
        if (relative >= 4) {
          // Within prose this is continuation text. Pin only top-level code.
          if (!parent && !paragraph) code = true;
          break;
        }
        if (startsHtml) {
          paragraph = false;
          html = { start: lineStart, end: startsHtml.end };
          if (html.end?.test(content)) closeHtml(offset);
          break;
        }
        if (fenceLine && (fenceLine[1][0] === '~' || !fenceLine[2].includes('`'))) fence = fenceLine[1];
        if (startsItem) {
          const markerEnd = column + marker[1].length;
          column = markdownIndent(marker[2], markerEnd);
          content = marker[3];
          const padding = column - markerEnd;
          const contentPadding = content && padding >= 1 && padding <= 4 ? padding : 1;
          items.push({ column: markerEnd + contentPadding, style, hasContent: false });
          depth++;
          paragraph = false;
          continue;
        }
        paragraph = !startsBlock && (paragraph
          ? !/^(?:=+|-+)[ \t]*$/u.test(content) // A setext underline ends the paragraph.
          : !/^\[[^\]]+\]:/u.test(content));
        break;
      }
    }
    if (code || structural.test(block) || MARTIN_DECIDED.test(block)) pinned.push(block);
    if (separator) {
      // A blank ends the leaf paragraph and any still-empty item. Delimited
      // HTML instead owns the blanks until its delimiter or item closure.
      if (items.at(-1)?.hasContent === false) items.pop();
      if (html?.end === null) closeHtml(offset);
      offset += separator.length - newline.length;
    }
  }
  closeHtml(text.length);
  return JSON.stringify([pinned, htmlSpans]);
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
 * The blocks are aligned over every pairing, not greedily: a superseded block removed before an unchanged block with the
 * same citation is a removal, not a replacement by its neighbour.
 */
function decisionsCorrected(before, after, superseded) {
  const was = blocksOf(before);
  const now = blocksOf(after);
  const seen = new Map();
  const aligns = (i, j) => {
    if (i === was.length) return j === now.length;
    const key = i * (now.length + 1) + j;
    if (seen.has(key)) return seen.get(key);
    const block = was[i];
    const same = j < now.length && textOf(now[j]) === textOf(block);
    const gone = superseded(block);
    const cited = citation(block);
    const ok = (same && aligns(i + 1, j + 1))
      || (gone && aligns(i + 1, j))
      || (gone && j < now.length && cited !== null && citation(now[j]) === cited && aligns(i + 1, j + 1));
    seen.set(key, ok);
    return ok;
  };
  return aligns(0, 0);
}

/**
 * Why the manager may not publish this diff, or null (D6). `files` is `[{ path, before, after }]`: each file the branch
 * changes against origin/main with its text there and at the branch's head, null where it is not (added, deleted).
 * It refuses a file outside `docs/technical/`, `docs/technical/memoro-me.md`, a change to the `## Aim` of an area page, a
 * change to its `## Decisions` other than the correction of a superseded dated block, and any removal or alteration of a
 * block that holds a dated decision of Martin's unless the same file keeps, unchanged, a dated block with a later date (D2).
 */
export function managerGuard(files, { areaPage = null } = {}) {
  const found = [];
  for (const { path, before, after } of files) {
    if (!path.startsWith(MANAGER_ROOT)) { found.push(`${path} is outside docs/technical/`); continue; }
    if (path === MANAGER_ME) { found.push(`${path} is Martin's own text`); continue; }
    if (areaPage !== null) {
      if (path !== areaPage || before === null || after === null) { found.push(`${path} is not an edit to the declared area page ${areaPage}`); continue; }
      if (areaHeldSections(before, 'decisions') !== areaHeldSections(after, 'decisions')) found.push(`${path} changes its ## Decisions`);
      if (areaHeldSections(before, 'aim') !== areaHeldSections(after, 'aim')) found.push(`${path} changes its ## Aim`);
      if (learningStructure(before) !== learningStructure(after)) found.push(`${path} changes its Markdown structure or raw HTML`);
      if (JSON.stringify(martinBlocks(before)) !== JSON.stringify(martinBlocks(after))) found.push(`${path} changes a dated decision of Martin's`);
      continue;
    }
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
  return `the ${areaPage === null ? 'manager' : 'learning role'} publishes only what its role may change — ${found.join('; ')}; a text of Martin's goes to the desk with mc martin propose`;
}
