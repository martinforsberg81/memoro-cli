import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import test from 'node:test';

// A project directory holds one plan, and the runner can read it.
//
// The shape used to be a convention: sections with the right names, a `next:`
// line carrying its own "done when". Nothing checked it, so two of twenty-six
// plans were missing the sections the step role sends a session to, and the
// runner found out by spending a ninety-minute session on one. `mc run`
// validates a plan against `plan-schema.js` before it hands out a step; this is
// the same question asked here, where the plan is written.
//
// The full schema lives in memoro-cli, which this repository does not depend
// on. What is checked here is what a plan cannot be wrong about without the
// runner refusing it: it is the only plan in its directory, it parses, and it
// carries every field with something in it.
const ROOT = resolve(import.meta.dirname, '../..');
const PROJECT = resolve(ROOT, 'docs/project');

const REQUIRED = Object.freeze([
  'goal',
  'contract',
  'out_of_scope',
  'success_criteria',
  'steps',
]);

const STEP_STATUSES = new Set(['ready', 'done', 'blocked']);

async function projectDirs() {
  const out = [];
  for (const programme of await readdir(PROJECT, { withFileTypes: true })) {
    if (!programme.isDirectory()) continue;
    const at = resolve(PROJECT, programme.name);
    for (const project of await readdir(at, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      out.push(resolve(at, project.name));
    }
  }
  return out;
}

const dirs = await projectDirs();

test('a project directory holds PLAN.json and no PLAN.md', async () => {
  const wrong = [];
  for (const dir of dirs) {
    const names = new Set(await readdir(dir));
    if (names.has('PLAN.md')) wrong.push(`${relative(ROOT, dir)}: PLAN.md — the plan is PLAN.json`);
  }
  assert.deepEqual(wrong, [], `see docs/project/README.md § What a PLAN.json is: ${wrong.join(', ')}`);
});

test('every plan parses and carries every field', async () => {
  const problems = [];
  for (const dir of dirs) {
    const names = new Set(await readdir(dir));
    if (!names.has('PLAN.json')) continue;
    const at = relative(ROOT, resolve(dir, 'PLAN.json'));

    let plan;
    try {
      plan = JSON.parse(await readFile(resolve(dir, 'PLAN.json'), 'utf8'));
    } catch (err) {
      problems.push(`${at}: not JSON — ${err.message}`);
      continue;
    }

    if (plan?.schema !== 'mc-plan') problems.push(`${at}: schema must be "mc-plan"`);
    for (const field of REQUIRED) {
      if (!Array.isArray(plan?.[field]) || plan[field].length === 0) {
        problems.push(`${at}: ${field} is empty — the runner refuses a plan that does not say it`);
      }
    }
    // The two the step role sends a session to, and the one it verifies.
    for (const [index, step] of (plan?.steps || []).entries()) {
      const where = `${at}: steps[${index}]`;
      if (!step?.title?.trim()) problems.push(`${where}.title is empty`);
      if (!STEP_STATUSES.has(step?.status)) problems.push(`${where}.status is not a step status`);
      if (!step?.done_when?.trim()) problems.push(`${where}.done_when is empty — a session would have nothing to verify`);
      if ((step?.status === 'blocked') && !step?.blocked_by?.name) {
        problems.push(`${where} is ${step.status} and does not name what it waits for`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});
