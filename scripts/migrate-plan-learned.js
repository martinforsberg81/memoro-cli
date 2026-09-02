#!/usr/bin/env node
/**
 * One-off: move a plan's top-level `what_the_code_taught_us` onto its steps.
 *
 * The field was a list of `{ title, body }` at the top of `PLAN.json`, shared
 * by every step session of a project and validated like everything else in the
 * file. On 2026-09-02 that cost three plans: two sessions wrote a `body` the
 * schema refused and were logged `plan-trespass` for it, and `new-user`'s plan
 * — whose five entries carry a `body` string rather than an array — sat
 * unreadable on `origin/main` for a day while the runner logged a skip line
 * nobody reads. Prose in a schema-validated shared field is prose in the wrong
 * place (Martin, 2026-09-02: "Flytta in i steget: `steps[i].learned`").
 *
 * `learned` is the same shape as `goal`, `contract` and `instruction`: an array
 * of paragraph strings. An entry becomes its title as a bold paragraph followed
 * by its body paragraphs, which is lossless and keeps the diff line-oriented.
 *
 * **Where an entry goes.** Nothing in the old shape said which step taught it,
 * so this puts every entry on the last `done` step — the one that most recently
 * ran — and, where no step is done, on the first. That is a rule, not a
 * reading: it is right about the plan's shape and silent about which session
 * actually learned what.
 *
 * Idempotent: a plan with no `what_the_code_taught_us` is left byte for byte.
 *
 *   node scripts/migrate-plan-learned.js [<repo-root> …] [--dry-run]
 *
 * With no root, the repository this script lives in.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every `docs/project/<programme>/<project>/PLAN.json` under one repository root. */
function planPaths(root) {
  const base = join(root, 'docs', 'project');
  if (!existsSync(base)) return [];
  const out = [];
  for (const programme of readdirSync(base, { withFileTypes: true })) {
    if (!programme.isDirectory()) continue;
    const dir = join(base, programme.name);
    for (const project of readdirSync(dir, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const path = join(dir, project.name, 'PLAN.json');
      if (existsSync(path)) out.push(path);
    }
  }
  return out.sort();
}

/** One `{ title, body }` as paragraphs. `body` is an array, a string, or absent. */
export function lessonParagraphs(entry) {
  const body = Array.isArray(entry?.body)
    ? entry.body.map((p) => String(p))
    : (entry?.body == null ? [] : [String(entry.body)]);
  const title = typeof entry?.title === 'string' ? entry.title.trim() : '';
  const paragraphs = body.map((p) => p.trim()).filter(Boolean);
  return title ? [`**${title}**`, ...paragraphs] : paragraphs;
}

/** Which step an entry with no step of its own belongs to. */
export function targetStep(steps = []) {
  for (let i = steps.length - 1; i >= 0; i -= 1) if (steps[i]?.status === 'done') return i;
  return 0;
}

/** `learned` goes straight after `instruction`, so a step reads in the order it happened. */
function withLearned(step, paragraphs) {
  const out = {};
  let placed = false;
  for (const [key, value] of Object.entries(step)) {
    if (key === 'learned') continue;
    out[key] = value;
    if (key === 'instruction') {
      out.learned = [...(Array.isArray(step.learned) ? step.learned : []), ...paragraphs];
      placed = true;
    }
  }
  if (!placed) out.learned = [...(Array.isArray(step.learned) ? step.learned : []), ...paragraphs];
  return out;
}

/**
 * The migrated plan and what moved, or null when there is nothing to do.
 * Returns `{ plan, entries, step }` — `step` is the 0-based index it went onto.
 */
export function migratePlan(plan) {
  const lessons = plan?.what_the_code_taught_us;
  if (lessons === undefined) return null;
  const entries = Array.isArray(lessons) ? lessons : [];
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const at = targetStep(steps);
  const paragraphs = entries.flatMap((entry) => lessonParagraphs(entry));

  const next = {};
  for (const [key, value] of Object.entries(plan)) {
    if (key === 'what_the_code_taught_us') continue;
    next[key] = value;
  }
  if (paragraphs.length && steps.length) {
    next.steps = steps.map((step, i) => (i === at ? withLearned(step, paragraphs) : step));
  }
  return { plan: next, entries: entries.length, step: steps.length ? at : -1, done: steps[at]?.status === 'done' };
}

function main(argv) {
  const dry = argv.includes('--dry-run');
  const roots = argv.filter((arg) => !arg.startsWith('--'));
  const targets = roots.length ? roots : [join(HERE, '..')];
  let files = 0;
  let moved = 0;
  let ambiguous = 0;
  for (const root of targets) {
    for (const path of planPaths(root)) {
      const text = readFileSync(path, 'utf8');
      let plan;
      try { plan = JSON.parse(text); } catch (error) {
        console.error(`skip ${path}: not JSON — ${error.message}`);
        continue;
      }
      const result = migratePlan(plan);
      if (!result) continue;
      files += 1;
      moved += result.entries;
      if (result.entries && !result.done) ambiguous += 1;
      const where = result.entries === 0 ? 'nothing to move' : `${result.entries} → steps[${result.step}]${result.done ? '' : ' (no done step: the first)'}`;
      console.log(`${dry ? 'would write' : 'wrote'} ${path} — ${where}`);
      if (!dry) writeFileSync(path, `${JSON.stringify(result.plan, null, 2)}\n`);
    }
  }
  console.log(`\n${files} plan(s), ${moved} entr${moved === 1 ? 'y' : 'ies'} moved, ${ambiguous} plan(s) with no done step`);
}

if (process.argv[1] && process.argv[1].endsWith('migrate-plan-learned.js')) main(process.argv.slice(2));
