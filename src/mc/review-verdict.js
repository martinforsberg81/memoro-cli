/**
 * The review's verdict: REVIEW.md in its fixed form, and the areas a goal
 * declared untouched that its branch nevertheless changed (the tripwires).
 *
 * REVIEW.md holds one `head: <repo> <sha>` line per repository of the goal,
 * then one line per item: `<id>: OK` or `<id>: NOT OK — <what and where>`. The
 * ids are `criterion <n>`, the preserve ids (`V1`…), `obligation <area>` for
 * each touched obligation, `untouched <area>` for each tripped area, and
 * `change`, `out-of-scope`, `protection`, `bugs`; and `seen <area>` for each area the review was told is judged as the
 * user sees it (an area that declares `"seen": true` and that the goal stands touched on or trips: `seenAreas`). A
 * goal cut from an order (`cutFromOrder`) has one item instead of all of these, `part`: does the build do what the
 * part says. A
 * `seen` line is `OK — <shots>[ — <words>]` or `NOT OK — <shots> — <words>`, where `<shots>` is one or more
 * `shots/<name>.png` paths, separated by `, `, files in the goal's directory, or is `none` and the words are the
 * reason; a `seen` line is never carried. A narrow round copies a line
 * it did not rejudge as `<id>: OK — carried from round <n>`. A version 1 goal
 * has the criteria lines only. Free text may follow the lines. mc checks that
 * the lines are present and consistent (`checkVerdict`), never the judgement
 * (docs/technical/mc-goals.md, "What a review session does").
 *
 * `trippedAreas` is the one function that decides which untouched rule areas a
 * branch changed (a source area is never one): the review prompt (run.js) and the move to merge or build
 * (commands/goal.js) both call it, so what the reviewer is told and what mc
 * then requires are the same list. `seenAreas` is asked once, by the runner at the review's launch: its list goes to the
 * prompt and, as MC_REVIEW_SEEN, to the session's environment, and the move out of review asks for exactly that list.
 */
import { join } from 'node:path';

import { isSourceArea, readAreas } from './areas.js';
import { cutFromOrder } from './goal-parts.js';

/** The items every version 2 verdict holds, besides criteria, preserve ids and areas. */
export const FIXED_IDS = Object.freeze(['change', 'out-of-scope', 'protection', 'bugs']);

/** The id of the write-back line: held only by a review the runner launched with `MC_REVIEW_WRITE_BACK=1`. */
export const WRITE_BACK_ID = 'write-back';

/** The one id of a verdict on a goal cut from an order: `part: OK` or `part: NOT OK — <what the part says that the build does not do, and where>`. */
export const PART_ID = 'part';

const HEAD_LINE = /^head: (\S+) (\S+)\s*$/u;
const ID = /^(criterion \d+|V\d+|obligation \S+|untouched \S+|seen \S+|write-back|change|out-of-scope|protection|bugs)(?=:)/u;
const ITEM = /^(criterion \d+|V\d+|obligation \S+|untouched \S+|seen \S+|write-back|change|out-of-scope|protection|bugs): (OK|NOT OK)(?: — (.+?))?\s*$/u;
const PART_LINE = /^part(?=:)/u;
const PART_ITEM = /^(part): (OK|NOT OK)(?: — (.+?))?\s*$/u;

/**
 * REVIEW.md's `text` read into `{ heads: [{ repo, sha }], items: [{ id, ok, reason }], malformed: [line] }`.
 * A line that starts with an item id and a colon but is not `OK` or `NOT OK — <what and where>` is malformed; a
 * line that starts with neither an id nor `head:` is free text and read as nothing. With `part` (the verdict on a goal
 * cut from an order) the one id read is `part`, and every other line but a head is free text.
 */
export function parseVerdict(text, { part = false } = {}) {
  const [id, form] = part ? [PART_LINE, PART_ITEM] : [ID, ITEM];
  const heads = [];
  const items = [];
  const malformed = [];
  for (const line of String(text ?? '').split('\n')) {
    const head = HEAD_LINE.exec(line);
    if (head) { heads.push({ repo: head[1], sha: head[2] }); continue; }
    if (/^head:/u.test(line)) { malformed.push(line); continue; }
    if (!id.test(line)) continue;
    const item = form.exec(line);
    if (!item || (item[2] === 'NOT OK' && !item[3])) { malformed.push(line); continue; }
    items.push({ id: item[1], ok: item[2] === 'OK', reason: item[3] ?? null });
  }
  return { heads, items, malformed };
}

/**
 * The ids a verdict on `goal` holds, in the order they are written; `tripped` is `trippedAreas`' list, `seen` `seenAreas`'.
 * A goal cut from an order holds `part` and nothing else, whatever the other arguments say.
 */
export function requiredIds(goal, tripped = [], seen = [], writeBack = false) {
  if (cutFromOrder(goal)) return [PART_ID];
  const criteria = (goal.success_criteria ?? []).map((_, index) => `criterion ${index + 1}`);
  if (goal.version !== 2) return criteria;
  return [
    ...criteria,
    ...(goal.preserve ?? []).map((item) => item.id),
    ...(goal.obligations ?? []).filter((one) => one.stand === 'touched').map((one) => `obligation ${one.area}`),
    ...tripped.map((one) => `untouched ${one.area}`),
    ...seen.map((area) => `seen ${area}`),
    ...(writeBack ? [WRITE_BACK_ID] : []),
    ...FIXED_IDS,
  ];
}

/** Whether two commit ids name the same commit: equal, or one a prefix of the other, at least seven characters. */
export function sameHead(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 7 && long.startsWith(short);
}

const SEEN_FORM = '`seen <area>: OK — shots/<name>.png[, …][ — <words>]` or `seen <area>: NOT OK — shots/<name>.png[, …] — <what and where>`, with `none — <reason>` in place of the screenshots';

const WRITE_BACK_FORM = '`write-back: OK — <repo>/docs/technical/<page>.md § <section>[, …]`, `write-back: OK — none — <reason>` or `write-back: NOT OK — <what the goal made true that no page says>`';

/** One page a `write-back` line names: `<repo>/docs/technical/<page>.md § <section>`. */
const WRITE_BACK_PAGE = /^[^\s/,]+\/docs\/technical\/\S+\.md § \S.*$/u;

/**
 * What is wrong with a `write-back` line, or null when it is in form: an OK line names one or more pages and a section of
 * each (a comma inside a section name is kept: the entries split where the next one starts with a repository's
 * `docs/technical/` path), or says `none — <reason>`; a NOT OK line has its reason already (`parseVerdict`). Never carried.
 */
export function writeBackFault(item) {
  const reason = item.reason ?? '';
  if (/^carried from round \d+$/u.test(reason)) return `a \`write-back\` line is not carried from an earlier round — judge it again: ${WRITE_BACK_FORM}`;
  if (!item.ok) return null;
  if (!reason) return `an OK line names the pages or says why none: ${WRITE_BACK_FORM}`;
  if (reason === 'none' || reason.startsWith('none — ')) return reason.slice('none'.length).replace(/^ — /u, '').trim() ? null : `\`none\` needs its reason: ${WRITE_BACK_FORM}`;
  const entries = reason.split(/, (?=[^\s/,]+\/docs\/technical\/)/u);
  return entries.every((entry) => WRITE_BACK_PAGE.test(entry)) ? null : WRITE_BACK_FORM;
}

/** A path a `seen` line may name: under `shots/`, a `.png`, no space, comma or `..`. */
const SHOT = /^shots\/[^\s,]+\.png$/u;

/**
 * What is wrong with the reason of a `seen` line, as `{ fault, shots }`: `fault` is null when it is in form, `shots`
 * the paths it names (none for `none`).
 */
function seenReason(item) {
  const reason = item.reason ?? '';
  if (/^carried from round \d+$/u.test(reason)) return { fault: 'a `seen` line is not carried from an earlier round — copy the earlier round\'s line as it stands when the diff since leaves the area\'s paths alone, or judge again with new screenshots', shots: [] };
  const [first, ...rest] = reason.split(' — ');
  const words = rest.join(' — ').trim();
  if (first === 'none') return words ? { fault: null, shots: [] } : { fault: `\`none\` needs its reason: ${SEEN_FORM}`, shots: [] };
  const shots = first.split(', ');
  if (!reason || !shots.every((path) => SHOT.test(path) && !path.includes('..'))) return { fault: SEEN_FORM, shots: [] };
  if (!item.ok && !words) return { fault: `a NOT OK line says what and where after the screenshots: ${SEEN_FORM}`, shots };
  return { fault: null, shots };
}

/**
 * What is wrong with REVIEW.md's `text` for `goal`, as `{ problems: [string], failed: [{ id, reason }] }`. Checked: a head
 * line for each repository of the goal, each head the one in `heads` (`[{ repo, sha }]`, where a sha is null the
 * line only has to be there), every id of `requiredIds` once, no line that is not in form, no id the goal does not have.
 * With `writeBack` the verdict holds one `write-back` line in form (`writeBackFault`); without it a `write-back` line is not an
 * item of the verdict. For each area in `seen` the line's form and that each screenshot it names is a file (`isFile(path)`, the path as written,
 * read from the goal's directory). `failed` lists the NOT OK items. For a goal cut from an order the head lines and
 * the one `part` line are all that is read and asked.
 */
export function checkVerdict({ text, goal, tripped = [], heads = [], seen = [], writeBack = false, isFile = () => false }) {
  const read = parseVerdict(text, { part: cutFromOrder(goal) });
  const problems = [];
  for (const line of read.malformed) problems.push(`not in form: "${line}" — ${'`<id>: OK` or `<id>: NOT OK — <what and where>`, and `head: <repo> <sha>`'}`);
  for (const repo of goal.repos ?? []) {
    const lines = read.heads.filter((one) => one.repo === repo);
    const expected = heads.find((one) => one.repo === repo)?.sha ?? null;
    if (lines.length === 0) { problems.push(`no \`head: ${repo} <sha>\` line${expected ? ` — the head judged is ${expected}` : ''}`); continue; }
    if (lines.length > 1) problems.push(`more than one \`head: ${repo}\` line`);
    if (expected && !sameHead(lines[0].sha, expected)) problems.push(`\`head: ${repo} ${lines[0].sha}\` is not the head judged, ${expected}`);
  }
  const required = requiredIds(goal, tripped, seen, writeBack);
  for (const id of required) {
    const count = read.items.filter((one) => one.id === id).length;
    if (count === 0) problems.push(`no line for ${id}`);
    else if (count > 1) problems.push(`more than one line for ${id}`);
  }
  for (const item of read.items) if (!required.includes(item.id)) problems.push(`${item.id} is not an item of this goal's verdict`);
  for (const item of read.items) {
    if (!item.id.startsWith('seen ') || !required.includes(item.id)) continue;
    const { fault, shots } = seenReason(item);
    if (fault) { problems.push(`${item.id}: not in form — ${fault}`); continue; }
    for (const path of shots) if (!isFile(path)) problems.push(`${item.id}: ${path} is not a file in the goal's directory — save it there with \`mc shot … --out <goal directory>/${path}\``);
  }
  for (const item of read.items) {
    if (item.id !== WRITE_BACK_ID || !required.includes(item.id)) continue;
    const fault = writeBackFault(item);
    if (fault) problems.push(`${item.id}: not in form — ${fault}`);
  }
  return { problems, failed: read.items.filter((one) => !one.ok).map((one) => ({ id: one.id, reason: one.reason })) };
}

/** Whether `file` is `path` or under it (`path` is a file, or a directory with or without its closing slash). */
export function underPath(file, path) {
  return file === path || file.startsWith(path.endsWith('/') ? path : `${path}/`);
}

/**
 * The heads judged and the untouched areas the goal's branch changed.
 * `{ heads: [{ repo, sha }], tripped: [{ area, repo, files }] }`, or `{ error }` when a repository cannot be read.
 *
 * For each repository of the goal with a worktree in `dir`: the first repository's head is `head` (MC_REVIEW_HEAD), any
 * other's its worktree's HEAD; the files are `git diff --name-only origin/main...<head>`; the areas are the repository's
 * at origin/main (`readAreas`), and the goal's obligation for `<repo>/<id>` must stand `untouched`. A file counts for an
 * area when it is under one of the area's paths. A source area asks no stand and is never tripped. Version 1 goals and goals with no untouched obligation read no git.
 * `git(cwd, args)` answers `{ ok, stdout, stderr }`.
 */
export function trippedAreas({ goal, dir, head, git, exists = () => true }) {
  const heads = [];
  const tripped = [];
  const untouched = new Set((goal.version === 2 ? goal.obligations ?? [] : []).filter((one) => one.stand === 'untouched').map((one) => one.area));
  (goal.repos ?? []).forEach((repo, index) => {
    const cwd = join(dir, repo);
    if (index === 0) heads.push({ repo, sha: head ?? null });
    else if (exists(cwd)) {
      const parsed = git(cwd, ['rev-parse', 'HEAD']);
      heads.push({ repo, sha: parsed.ok ? parsed.stdout.trim() || null : null });
    } else heads.push({ repo, sha: null });
  });
  for (const [index, repo] of (goal.repos ?? []).entries()) {
    if (untouched.size === 0) break;
    const cwd = join(dir, repo);
    if (!exists(cwd)) continue;
    const sha = heads[index].sha ?? 'HEAD';
    const declared = readAreas(cwd, { git, at: 'origin/main', repo });
    if (!declared.ok) return { error: declared.reason };
    const areas = declared.areas.filter((area) => !isSourceArea(area) && untouched.has(`${repo}/${area.id}`));
    if (areas.length === 0) continue;
    const diff = git(cwd, ['diff', '--name-only', `origin/main...${sha}`]);
    if (!diff.ok) return { error: `could not list what ${repo} changed against origin/main — ${(diff.stderr || '').trim() || 'git failed'}` };
    const files = diff.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    for (const area of areas) {
      const own = files.filter((file) => area.paths.some((path) => underPath(file, path)));
      if (own.length) tripped.push({ area: `${repo}/${area.id}`, repo, files: own });
    }
  }
  return { heads, tripped };
}

/**
 * The areas a review is held to a `seen <area>` line for: `{ seen: ['<repo>/<id>', …] }` or `{ error }`. An area is in
 * it when it is a rule area that declares `"seen": true` at origin/main and the goal either stands `touched` on it or
 * trips it (`tripped` is `trippedAreas`' list). In the order of the goal's repositories and of each declaration. A
 * version 1 goal reads nothing, and an area the goal has no stand on is never in it. `git` and `exists` as `trippedAreas`.
 */
export function seenAreas({ goal, dir, tripped = [], git, exists = () => true }) {
  if (goal.version !== 2) return { seen: [] };
  const touched = new Set((goal.obligations ?? []).filter((one) => one.stand === 'touched').map((one) => one.area));
  const trips = new Set(tripped.map((one) => one.area));
  const seen = [];
  for (const repo of goal.repos ?? []) {
    const wanted = (id) => touched.has(`${repo}/${id}`) || trips.has(`${repo}/${id}`);
    if (![...touched, ...trips].some((area) => area.startsWith(`${repo}/`))) continue;
    const cwd = join(dir, repo);
    if (!exists(cwd)) continue;
    const declared = readAreas(cwd, { git, at: 'origin/main', repo });
    if (!declared.ok) return { error: declared.reason };
    for (const area of declared.areas) if (!isSourceArea(area) && area.seen === true && wanted(area.id)) seen.push(`${repo}/${area.id}`);
  }
  return { seen };
}
