/**
 * The evidence a build session gives for a goal's items, and the check on a build session's move to review that reads
 * it (docs/technical/mc-goals.md, "Evidence and heads"; mc/evidence-at-current-head).
 *
 * The records are in `.evidence.json` in the goal's directory, beside GOAL.json and LOG.md and not part of the goal's
 * text: the brief never holds them, and no LOG.md entry is written for one (the runner reads
 * LOG.md to tell whether a session spoke). Each record is kept under the id the review's verdict uses for the item —
 * `criterion <n>`, a preserve id (`V1`) or `obligation <area>` — and holds the head of every worktree of the goal at
 * the time, the time, the writer's tool and model, and the text. A criterion's record also holds the criterion's text,
 * and a record whose text is not its criterion's counts as none. mc judges presence and head, never whether the
 * evidence is good: that is the review's.
 *
 * Every function takes what it reads and writes (`read`, `write`, `git`, `exists`) from the caller, so a test runs
 * it with no repository.
 */
import { join } from 'node:path';

import { writeFileAtomic } from './atomic-write.js';
import { goalBranch, readTextOrNull } from './goals.js';

export const EVIDENCE_FILE = '.evidence.json';

/** `{ items }` read from the goal's directory (`{}` when there is no file), or `{ problem }` when the file is not the records. */
export function readEvidence(dir, read = readTextOrNull) {
  const text = read(join(dir, EVIDENCE_FILE));
  if (text === null) return { items: {} };
  try {
    const file = JSON.parse(text);
    if (file && typeof file === 'object' && file.items && typeof file.items === 'object' && !Array.isArray(file.items)) return { items: file.items };
  } catch { /* the problem below */ }
  return { problem: `${join(dir, EVIDENCE_FILE)} is not the goal's evidence records` };
}

/** The records written whole; an empty set removes nothing and writes nothing new when there was no file. */
export function writeEvidence(dir, items, { read = readTextOrNull, write = writeFileAtomic } = {}) {
  if (!Object.keys(items).length && read(join(dir, EVIDENCE_FILE)) === null) return;
  write(join(dir, EVIDENCE_FILE), `${JSON.stringify({ items }, null, 2)}\n`);
}

/** The record `id` as `{ items }` with it set; `{ problem }` when the file cannot be read. */
export function setItem(dir, id, record, io = {}) {
  const read = io.read ?? readTextOrNull;
  const { items, problem } = readEvidence(dir, read);
  if (problem) return { problem };
  writeEvidence(dir, { ...items, [id]: record }, io);
  return {};
}

/** The records of `ids` removed; nothing is written when none of them is there. Returns the ids removed. */
export function dropItems(dir, ids, io = {}) {
  const read = io.read ?? readTextOrNull;
  const { items, problem } = readEvidence(dir, read);
  if (problem) return { problem, dropped: [] };
  const dropped = ids.filter((id) => Object.hasOwn(items, id));
  if (!dropped.length) return { dropped };
  const kept = Object.fromEntries(Object.entries(items).filter(([id]) => !dropped.includes(id)));
  writeEvidence(dir, kept, io);
  return { dropped };
}

/** Criterion `n` taken out of the goal: its record is dropped and the later ones follow their criteria down one number. */
export function removeCriterionItem(dir, n, io = {}) {
  const read = io.read ?? readTextOrNull;
  const { items, problem } = readEvidence(dir, read);
  if (problem) return { problem };
  if (!Object.keys(items).some((id) => /^criterion \d+$/u.test(id))) return {};
  const next = {};
  for (const [id, record] of Object.entries(items)) {
    const match = /^criterion (\d+)$/u.exec(id);
    if (!match) { next[id] = record; continue; }
    const at = Number(match[1]);
    if (at === n) continue;
    next[at > n ? `criterion ${at - 1}` : id] = record;
  }
  writeEvidence(dir, next, io);
  return {};
}

/** The ids `mc goal evidence` takes for a goal: its preserve ids and the areas of its touched obligations. */
export function evidenceIds(goal) {
  if (goal.version !== 2) return { preserve: [], areas: [] };
  return {
    preserve: (goal.preserve ?? []).map((item) => item.id),
    areas: (goal.obligations ?? []).filter((one) => one.stand === 'touched').map((one) => one.area),
  };
}

/** The key an item's record is kept under: a preserve id as it is, an area as `obligation <area>` (the review's id). */
export function itemKey(goal, id) {
  const { preserve, areas } = evidenceIds(goal);
  if (preserve.includes(id)) return id;
  if (areas.includes(id)) return `obligation ${id}`;
  return null;
}

/**
 * Each repository of the goal as `{ repo, path, present, head, dirty }`: `present` when its worktree is a git
 * checkout whose HEAD can be read; `dirty` when `git status --short` lists a change.
 */
export function worktreeHeads({ goal, dir, git, exists }) {
  return goal.repos.map((repo) => {
    const path = join(dir, repo);
    if (!exists(path)) return { repo, path, present: false, head: null, dirty: false };
    const status = git(path, ['status', '--short']);
    const head = git(path, ['rev-parse', 'HEAD']);
    const sha = head.ok ? head.stdout.trim() : '';
    if (!status.ok || !sha) return { repo, path, present: false, head: null, dirty: false };
    return { repo, path, present: true, head: sha, dirty: status.stdout.split('\n').some((line) => line.trim() !== '') };
  });
}

/** The heads of the worktrees that are there, as the record keeps them: `{ <repo>: <sha> }`. */
export function headsRecord(states) {
  return Object.fromEntries(states.filter((state) => state.present).map((state) => [state.repo, state.head]));
}

/** The record of a mark or an item's evidence, as the file keeps it. */
export function makeRecord({ states, at, tool, model, role, text, criterion }) {
  return { at, tool, model, role, heads: headsRecord(states), text, ...(criterion === undefined ? {} : { criterion }) };
}

/**
 * Where criterion `n`'s record stands against the heads now: `none` (no record, or a record of another text),
 * `stale` (at another head, or at none the worktrees can be compared with) or `current`.
 */
export function criterionState(items, n, criterionText, states) {
  const record = items[`criterion ${n}`];
  if (!record || record.criterion !== criterionText) return { status: 'none', record: null, differs: [] };
  const differs = states.filter((state) => state.present && record.heads?.[state.repo] !== state.head).map((state) => state.repo);
  return { status: differs.length ? 'stale' : 'current', record, differs };
}

const short = (sha) => (sha ? String(sha).slice(0, 12) : 'none');

/**
 * The branch each worktree is on and whether its HEAD is the one published there (refs/remotes/origin/<branch>), as
 * `{ repo, branch, head, published }`; `published` is null when that ref cannot be read.
 */
export function publishedHeads({ goal, dir, name, git, states }) {
  return states.filter((state) => state.present).map((state) => {
    const branch = goalBranch({ git, dir, goal: name.split('/')[1], repo: state.repo });
    const ref = git(state.path, ['rev-parse', `refs/remotes/origin/${branch}`]);
    return { repo: state.repo, branch, head: state.head, published: ref.ok && ref.stdout.trim() ? ref.stdout.trim() : null };
  });
}

/**
 * Why a build session's move to review is refused for want of evidence, or null: every problem named on its own line.
 * A repository with no worktree; a worktree whose HEAD is not the published one (naming `mc publish --no-merge`); a
 * criterion with no record or a record at another head (naming its check to run again); and, for a version 2 goal, a
 * preserve item or touched obligation with no record. The untouched obligations are not asked. A goal that is a part
 * of an order has none of those records: it is asked for a worktree per repository with nothing uncommitted and the
 * published head, and nothing else.
 */
export function evidenceRefusal({ goal, dir, name, git, exists, read }) {
  const { items, problem } = readEvidence(dir, read);
  if (problem) return problem;
  const states = worktreeHeads({ goal, dir, git, exists });
  const lines = [];
  for (const state of states.filter((one) => !one.present)) lines.push(`${state.repo} has no worktree at ${state.path} — a build session moves a goal to review from its worktrees, one per repository`);
  // A goal that is a part of an order has no record to be stale: its move asks for a clean worktree and a published head.
  if (goal.part !== undefined) for (const state of states.filter((one) => one.dirty)) lines.push(`${state.repo} has uncommitted changes — commit them, then publish that head with mc publish --no-merge`);
  for (const one of publishedHeads({ goal, dir, name, git, states })) {
    if (one.published === null) lines.push(`${one.repo}: ${one.branch} is not published (no refs/remotes/origin/${one.branch}) — publish it with mc publish --no-merge`);
    else if (one.published !== one.head) lines.push(`${one.repo}: HEAD ${short(one.head)} is not the published ${one.branch} (${short(one.published)}) — publish it with mc publish --no-merge`);
  }
  (goal.success_criteria ?? []).forEach((criterion, index) => {
    const n = index + 1;
    const state = criterionState(items, n, criterion.criterion, states);
    const again = `run its check and record it: mc goal criterion met ${name} ${n} --evidence "…"`;
    if (state.status === 'none') lines.push(`criterion ${n} has no record — ${again}`);
    else if (state.status === 'stale') {
      const moved = state.differs.map((repo) => `${repo} ${short(state.record.heads?.[repo])} → ${short(states.find((one) => one.repo === repo).head)}`).join(', ');
      lines.push(`criterion ${n} was recorded at an earlier head (${moved}) — run its check again at this head and record it: mc goal criterion met ${name} ${n} --evidence "…"`);
    }
  });
  const { preserve, areas } = evidenceIds(goal);
  for (const id of preserve) if (!items[id]) lines.push(`${id} has no evidence — mc goal evidence ${name} ${id} --text "…"`);
  for (const area of areas) if (!items[`obligation ${area}`]) lines.push(`obligation ${area} has no evidence — mc goal evidence ${name} ${area} --text "…"`);
  if (!lines.length) return null;
  return `${goal.part !== undefined ? 'its worktrees are not clean at a published head' : 'no evidence at the head it publishes'} —\n  ${lines.join('\n  ')}`;
}

/**
 * `mc goal show`'s EVIDENCE part as lines, and the numbers of the met criteria whose record is stale. A criterion
 * marked met with no record is said so; a record's text is indented under its line.
 */
export function evidenceLines({ goal, dir, git, exists, read }) {
  const { items, problem } = readEvidence(dir, read);
  if (problem) return { lines: [`  ${problem}`], stale: [] };
  // With no record there is nothing to compare, and the worktrees are not asked.
  const states = Object.keys(items).length ? worktreeHeads({ goal, dir, git, exists }) : [];
  const lines = [];
  const stale = [];
  const put = (id, record, note) => {
    const heads = Object.entries(record.heads ?? {}).map(([repo, sha]) => `${repo} ${short(sha)}`).join(', ') || 'no head';
    lines.push(`  ${id} · ${heads} · ${record.at ?? '—'} · ${record.tool ?? '—'} ${record.model ?? '—'}${note}`);
    if (record.text) lines.push(...String(record.text).split('\n').map((line) => `      ${line}`));
  };
  (goal.success_criteria ?? []).forEach((criterion, index) => {
    const n = index + 1;
    const state = criterionState(items, n, criterion.criterion, states);
    if (state.status === 'none') { if (criterion.met) lines.push(`  criterion ${n} · met, no record`); return; }
    const old = criterion.met && state.status === 'stale';
    if (old) stale.push(n);
    put(`criterion ${n}`, state.record, old ? ' · stale: recorded at an earlier head' : '');
  });
  const { preserve, areas } = evidenceIds(goal);
  for (const id of [...preserve, ...areas.map((area) => `obligation ${area}`)]) if (items[id]) put(id, items[id], '');
  return { lines, stale };
}
