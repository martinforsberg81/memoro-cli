/**
 * `goal-convert.js` — `mc goal convert`: the goals written before GOAL.json
 * (a `GOAL.md` of front matter and markdown) turned into GOAL.json, once.
 *
 * Front matter becomes fields; `# ` is the title; `## Goal` the goal's
 * paragraphs, `## Contract` the contract's and `## Out of scope` its
 * out-of-scope; each top-level bullet of `## Criteria` a criterion, whose
 * check is the text after its `*Check:*`, or the whole bullet when it has
 * none. A section of any other name is kept as paragraphs of the goal under
 * its heading, so nothing is lost. A goal in `review` or `done` has its
 * criteria `met` — a session has judged them — and any other none. The
 * GOAL.md converted is removed; `goals/.archive/` is never read.
 *
 * This is the one place in mc that reads GOAL.md (`docs/technical/mc-goals.md`).
 */
import { join } from 'node:path';

import { GOAL_FILE, GOALS_DIR, listDirsOf, readTextOrNull, renderGoal } from './goals.js';

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

/** The top-level `- ` or `* ` items of `lines`, each with its continuation lines, as one line of text. */
function bullets(lines) {
  const items = [];
  for (const line of lines) {
    const start = line.match(/^[-*] +(.*)$/u);
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
  const goal = { status: fields.status, repos: list(fields.repos), class: fields.class, created: fields.created || null, after: list(fields.after), prs: list(fields.prs),
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
export function convertGoals({ home, programme = null, list = listDirsOf, read = readTextOrNull, write, remove }) {
  const answers = [];
  const programmes = programme ? [programme] : list(home);
  for (const one of programmes) {
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
  }
  return answers;
}
