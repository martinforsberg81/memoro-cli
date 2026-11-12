/**
 * `goal-convert.js` — `mc goal convert`: the goals written before GOAL.json
 * (a `GOAL.md` of front matter and markdown) turned into GOAL.json, once.
 *
 * Front matter becomes fields; `# ` is the title; `## Goal` the goal's
 * paragraphs, `## Contract` the contract's and `## Out of scope` its
 * out-of-scope; each top-level bullet or numbered item of `## Criteria` a criterion, whose
 * check is the text after its `*Check:*`, or the whole bullet when it has
 * none. A section of any other name is kept as paragraphs of the goal under
 * its heading, so nothing is lost. A goal in `review` or `done` has its
 * criteria `met` — a session has judged them — and any other none. The
 * GOAL.md converted is removed; `goals/.archive/` is never read.
 *
 * This is the one place in mc that reads GOAL.md (`docs/technical/mc-goals.md`).
 *
 * `phaseGoals` is the second conversion, from goals that started after other
 * goals (`after`, and the status they waited in) to phases, from the one
 * `status` a goal had before stages to its `stage` and `status`
 * (`stageOfLegacy`), and from stage `plan` to `draft` (renamed 2026-11-07):
 * the one place in mc that still reads `after`, an old status or the old word.
 */
import { join } from 'node:path';

import { appendEntry, FINISHED, GOAL_FILE, GOALS_DIR, isPhase, LEGACY_AFTER, LEGACY_STATUSES, LOG_FILE, listDirsOf, logStamp, parseLog, readStage, readTextOrNull, renderGoal, renumberPhases, validateGoal } from './goals.js';
import { admitWriter } from './programme-lifecycle.js';

/** The stage word `draft` was written as until 2026-11-07; a GOAL.json still carrying it is rewritten once. */
const RENAMED_STAGE = 'plan';

/** The status a goal waited in while its `after` had not landed, before phases. */
const LEGACY_STATUS = 'waiting';

/** The first line of an entry's `Done:`. */
const doneLine = (entry) => String(entry?.done ?? '').split('\n')[0];

/**
 * The stage a goal `blocked` before stages was blocked in, from its log, last
 * entry first: a red review's verdict is `finish`; the merger's red or a
 * green the runner queued is `merge`; the runner's word on a review (no
 * verdict, no pull request, a moved head) or an entry in `review` is
 * `review`; anything else — a build session's question, three sessions
 * without a word, an entry in `open` — is `build`. The runner's entry after
 * a plan session (`plan session ended …`) says nothing of where, and a
 * person's block is read past to what came before it.
 */
function blockedStage(log) {
  for (const entry of [...log].reverse()) {
    const done = doneLine(entry);
    const runner = entry.tool === 'runner';
    if (runner && done.startsWith('plan session ended')) continue;
    if (/^red\b.*\b[0-9a-f]{7,40}\b/u.test(done)) return 'finish';
    if (runner && (/^merger answered red/u.test(done) || /^queued #\d+/u.test(done))) return 'merge';
    if (runner && /review left no verdict|^in review, but|^green on/u.test(String(entry.comment ?? ''))) return 'review';
    if (entry.status === 'review') return 'review';
    if (entry.status === 'open' || entry.status === LEGACY_STATUS) return 'build';
    if (entry.tool === 'person') continue;
    return 'build';
  }
  return 'build';
}

/**
 * A goal's `{ stage, status }` from the one status it had before stages
 * (`LEGACY_STATUSES`) and its log: `open` (and `waiting`) is `build ·
 * ready`; `review` is `review · ready`, or `merge · ready` when the
 * runner's last word on it queued it for the merger; `blocked` is the stage
 * its log says it was blocked in (`blockedStage`) · `blocked`; `done` and
 * `dropped` are as they are.
 */
export function stageOfLegacy(status, log = []) {
  if (FINISHED.includes(status)) return { stage: status, status: 'ready' };
  if (status === 'review') {
    const last = log.findLast((entry) => entry.tool !== 'person');
    return { stage: last?.tool === 'runner' && /^queued #\d+/u.test(doneLine(last)) ? 'merge' : 'review', status: 'ready' };
  }
  if (status === 'blocked') return { stage: blockedStage(log), status: 'blocked' };
  return { stage: 'build', status: 'ready' };
}

/** The file a goal was written in before GOAL.json. */
export const LEGACY_GOAL_FILE = 'GOAL.md';

const FRONT = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/u;
const SECTION_FIELD = { goal: 'goal', contract: 'contract', 'out of scope': 'out_of_scope' };

/** Blocks of `lines` between blank lines, each its lines joined, trimmed; none empty. */
function paragraphs(lines) {
  const out = [];
  let block = [];
  for (const line of [...lines, '']) {
    if (line.trim() === '') { if (block.length) out.push(block.join('\n').trim()); block = []; } else block.push(line.replace(/\s+$/u, ''));
  }
  return out.filter(Boolean);
}

/** The top-level `- `, `* ` or `1. ` items of `lines`, each with its continuation lines, as one line of text. */
function bullets(lines) {
  const items = [];
  for (const line of lines) {
    const start = line.match(/^(?:[-*]|\d+[.)]) +(.*)$/u);
    if (start) items.push([start[1]]);
    else if (items.length && line.trim() !== '') items.at(-1).push(line.trim());
  }
  return items.map((parts) => parts.join(' ').replace(/\s+/gu, ' ').trim()).filter(Boolean);
}

/** A criterion from a bullet's text: what precedes `*Check:*`, and what follows it as the check. */
function criterionOf(textOf, met) {
  const split = textOf.match(/^(.*?)\s*\*Check:?\*:?\s*(.+)$/u);
  const criterion = (split ? split[1] : textOf).trim() || textOf;
  return { criterion, check: (split ? split[2] : textOf).trim(), met };
}

/**
 * A GOAL.md's text as a GOAL.json goal (the shape `renderGoal` takes), or
 * `{ problems }` when its front matter does not read.
 */
export function goalFromMarkdown(text) {
  const match = String(text ?? '').match(FRONT);
  if (!match) return { problems: [`${LEGACY_GOAL_FILE} has no front matter between --- lines`] };
  const fields = {};
  for (const line of match[1].split('\n')) {
    const field = line.match(/^([a-z]+):\s*(.*)$/u);
    if (field) fields[field[1]] = field[2].trim();
  }
  const list = (value) => [...new Set(String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean))];
  const body = text.slice(match[0].length).split('\n');
  let title = null;
  const sections = [];
  const lead = [];
  for (const line of body) {
    const heading = line.match(/^## +(.+?)\s*$/u);
    if (!title && /^# /u.test(line)) title = line.slice(2).trim();
    else if (heading) sections.push({ name: heading[1], lines: [] });
    else (sections.length ? sections.at(-1).lines : lead).push(line);
  }
  const met = fields.status === 'review' || fields.status === 'done';
  const goal = { ...(LEGACY_STATUSES.includes(fields.status) ? stageOfLegacy(fields.status) : { status: fields.status }), repos: list(fields.repos), class: fields.class, created: fields.created || null, prs: list(fields.prs),
    title: title || 'untitled', goal: paragraphs(lead), contract: [], out_of_scope: [], success_criteria: [], documents: [] };
  for (const section of sections) {
    const key = section.name.toLowerCase();
    if (key === 'criteria') goal.success_criteria.push(...bullets(section.lines).map((item) => criterionOf(item, met)));
    else if (SECTION_FIELD[key]) goal[SECTION_FIELD[key]].push(...paragraphs(section.lines));
    else {
      const kept = paragraphs(section.lines);
      if (kept.length) goal.goal.push(`${section.name}:`, ...kept);
    }
  }
  try {
    renderGoal(goal);
  } catch (error) {
    return { problems: [error.message] };
  }
  return { goal };
}

/**
 * Every goal of `programme` (every programme when null) that has a GOAL.md and
 * no GOAL.json, converted: GOAL.json written, GOAL.md removed. Returns one
 * answer per goal looked at: `{ name, converted: true, criteria }`, or `{ name,
 * problems }` with the GOAL.md left as it is. Dot-directories (`.archive/`)
 * are never listed.
 */
export function convertGoals({ home, programme = null, list = listDirsOf, read = readTextOrNull, write, remove, env = process.env, lifecycle = admitWriter }) {
  const answers = [];
  const programmes = programme ? [programme] : list(home);
  for (const one of programmes) {
    // Runner callers do not necessarily enter through `mc goal`; hold an
    // admission lease across the direct GOAL.json write and GOAL.md removal.
    const writer = lifecycle([one], { env, name: 'legacy goal conversion' });
    try {
    const goalsDir = join(home, one, GOALS_DIR);
    for (const name of list(goalsDir)) {
      const dir = join(goalsDir, name);
      const text = read(join(dir, LEGACY_GOAL_FILE));
      if (text === null) continue;
      const ref = `${one}/${name}`;
      if (read(join(dir, GOAL_FILE)) !== null) { answers.push({ name: ref, problems: [`it has a ${GOAL_FILE} already; ${LEGACY_GOAL_FILE} is left for a person`] }); continue; }
      const converted = goalFromMarkdown(text);
      if (converted.problems) { answers.push({ name: ref, problems: converted.problems }); continue; }
      write(join(dir, GOAL_FILE), renderGoal(converted.goal));
      remove(join(dir, LEGACY_GOAL_FILE));
      answers.push({ name: ref, converted: true, criteria: converted.goal.success_criteria.length });
    }
    } finally {
      writer.release();
    }
  }
  return answers;
}

/**
 * Every goal of `programme` (every programme when null) that still names an
 * `after`, or has no `stage` (`stageOfLegacy` gives it one from its old
 * status and log), or is in stage `plan` (written `draft`, `RENAMED_STAGE`),
 * or is in the status it waited in, given a phase by the depth of its
 * chain: a goal whose `after` has all landed — done, dropped, or no goal any
 * more — keeps its phase (1 when it has none); a goal after one that has not
 * is one phase past the latest of those. `after` is removed, and a waiting goal
 * is `build · ready`. Each goal whose phase or stage changes gets a log entry from
 * `tool`; the programmes touched are renumbered (`renumberPhases`). A pass with
 * nothing to convert writes nothing. Returns `[{ name, phase, stage, status, after, from }]`
 * for every goal written, or `{ name, problems }` for one that would not
 * validate, left as it is. Goals of other programmes are read to see whether
 * an `after` landed.
 */
export function phaseGoals({ home, programme = null, list = listDirsOf, read = readTextOrNull, write, now = new Date(), tool = 'person', env = process.env, lifecycle = admitWriter }) {
  const raw = new Map();
  for (const one of list(home)) {
    for (const name of list(join(home, one, GOALS_DIR))) {
      const dir = join(home, one, GOALS_DIR, name);
      const text = read(join(dir, GOAL_FILE));
      if (text === null) continue;
      let value;
      try { value = JSON.parse(text); } catch { continue; }
      if (value && typeof value === 'object' && !Array.isArray(value)) raw.set(`${one}/${name}`, { programme: one, dir, value });
    }
  }
  const legacy = (value) => Object.hasOwn(value, LEGACY_AFTER) || value.stage === undefined || value.stage === RENAMED_STAGE;
  const depth = new Map();
  const phaseOf = (ref, seen = new Set()) => {
    if (depth.has(ref)) return depth.get(ref);
    const own = raw.get(ref).value;
    let phase = isPhase(own.phase) ? own.phase : 1;
    seen.add(ref);
    for (const other of Array.isArray(own[LEGACY_AFTER]) ? own[LEGACY_AFTER] : []) {
      const target = raw.get(other);
      // Landed, let go or gone holds nothing back; a ring is cut where it closes.
      if (!target || FINISHED.includes(target.value.stage ?? target.value.status) || seen.has(other)) continue;
      phase = Math.max(phase, phaseOf(other, seen) + 1);
    }
    seen.delete(ref);
    depth.set(ref, phase);
    return phase;
  };
  const answers = [];
  const touched = new Set();
  const selected = programme ? [programme] : list(home);
  for (const one of selected) {
    const candidates = [...raw].filter(([, item]) => item.programme === one && legacy(item.value));
    if (!candidates.length) continue;
    let writer;
    try { writer = lifecycle([one], { env, name: 'legacy goal phasing' }); }
    catch (error) { answers.push({ name: one, deferred: error.message }); continue; }
    try {
      for (const [ref, { dir, value }] of candidates) {
        const after = Array.isArray(value[LEGACY_AFTER]) ? value[LEGACY_AFTER] : [];
        const phase = phaseOf(ref);
        const staged = value.stage === undefined ? stageOfLegacy(value.status, parseLog(read(join(dir, LOG_FILE)) ?? '')) : { stage: readStage(value.stage), status: value.status };
        const { [LEGACY_AFTER]: _after, stage: _stage, status: _status, ...rest } = value;
        const next = { ...rest, ...staged, phase };
        const problems = validateGoal(next, { draft: true });
        if (problems.length) { answers.push({ name: ref, problems }); continue; }
        write(join(dir, GOAL_FILE), renderGoal(next));
        const restaged = value.stage === undefined;
        const renamed = value.stage === RENAMED_STAGE;
        if (restaged || renamed || phase !== (isPhase(value.phase) ? value.phase : 1)) {
          const said = [
            ...(restaged ? [`${staged.stage} · ${staged.status}, from ${value.status}`] : []),
            ...(renamed ? [`stage ${staged.stage}, from ${RENAMED_STAGE} (the stage was renamed 2026-11-07)`] : []),
            after.length ? `phase ${phase}, from after ${after.join(', ')}` : `phase ${phase}`,
          ];
          appendEntry({ dir, entry: { at: logStamp(now), tool, model: null, ...staged, done: said.join('; '), comment: null, next: null }, read, write });
        }
        touched.add(one);
        answers.push({ name: ref, phase, ...staged, after, from: restaged ? value.status : renamed ? RENAMED_STAGE : null });
      }
      if (touched.has(one)) {
        renumberPhases({ home, programme: one, list, read, write, env, lifecycle: () => ({ release() {} }) });
      }
    } finally {
      writer.release();
    }
  }
  return answers;
}
