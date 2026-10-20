/**
 * Plan-path ratchet: the plan file's name belongs to src/mc/plan-source.js
 * (ruling 48). Every other file under src/mc/ that still spells 'PLAN.json'
 * or 'PLAN.md' is listed in ALLOWED with its count, and that count may only
 * fall. The files listed are removed when plans leave the repositories; when
 * one stops naming the plan file, lower its count or delete its row so it
 * cannot silently come back.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLAN_NAME = /'PLAN\.(json|md)'/g;

const ALLOWED = new Map([
  ['src/mc/page-render.js', 1],
]);

function collectSourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) collectSourceFiles(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

function planNameCounts() {
  const counts = new Map();
  for (const file of collectSourceFiles(path.join(ROOT, 'src', 'mc'))) {
    const repoRelative = path.relative(ROOT, file);
    if (repoRelative === 'src/mc/plan-source.js') continue;
    const count = (readFileSync(file, 'utf8').match(PLAN_NAME) || []).length;
    if (count > 0) counts.set(repoRelative, count);
  }
  return counts;
}

test('plan file names outside plan-source.js only shrink', () => {
  const offenders = [];
  const observed = planNameCounts();
  for (const [file, count] of observed) {
    if (!ALLOWED.has(file)) {
      offenders.push(`${file}: ${count} plan-file literal(s), not allowed; `
        + 'name the plan file through src/mc/plan-source.js instead');
    } else if (count > ALLOWED.get(file)) {
      offenders.push(`${file}: ${count} plan-file literal(s), allowed ${ALLOWED.get(file)}`);
    }
  }
  assert.deepEqual(offenders, [], 'Plan-file literal outside src/mc/plan-source.js.');
});
