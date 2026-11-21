import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGoal, renderGoal } from '../../src/mc/goals.js';
import { checkVerdict, requiredIds } from '../../src/mc/review-verdict.js';
import { goalJsonV2 } from './_helpers/goal-file.js';

/**
 * The verdict on a goal that is a part of an order (order mc-parts-are-goals, Part 2): REVIEW.md is the head line and
 * one line, `part`. The verdict of a goal of the old form is tested through the move out of review, in
 * commands/goal.test.js; here it is shown only to keep its own lines.
 */

const HEADS = [{ repo: 'memoro-cli', sha: 'abc1234def' }];
const HEAD = 'head: memoro-cli abc1234def';
/** The goal the runner cuts for Part 2 of an order: version 2, `part` 2, no criterion and no other text. */
const PART_GOAL = parseGoal(renderGoal({ version: 2, stage: 'review', status: 'ready', phase: 2, part: 2, repos: ['memoro-cli'], created: '2026-11-01T20:00:00Z', prs: ['memoro-cli#7'], title: 'Two', success_criteria: [], documents: [{ label: 'Part 2', path: '/p/prog/README.md' }] }));
const OLD_GOAL = parseGoal(goalJsonV2());
const check = (goal, text, extra = {}) => checkVerdict({ text, goal, heads: HEADS, ...extra });

// Fault replayed: `checkVerdict` made to accept a verdict without `part` (the `no line for` problem skipped for a goal
// cut from an order). The verdict with the head line alone is then accepted, and the assertion 'a verdict without the
// part line is refused' fails.
test('the verdict on a goal that is a part is the head line and the one part line: OK or NOT OK with its reason, and nothing else is asked or read', () => {
  assert.deepEqual(requiredIds(PART_GOAL, [{ area: 'memoro-cli/system', repo: 'memoro-cli', files: ['a'] }], ['memoro-cli/system'], true), ['part'], 'no untouched, seen or write-back line, whatever the caller was told');
  assert.deepEqual(check(PART_GOAL, `${HEAD}\npart: OK\n`), { problems: [], failed: [] });
  assert.deepEqual(check(PART_GOAL, `${HEAD}\npart: OK\n`, { writeBack: true, seen: ['memoro-cli/system'] }), { problems: [], failed: [] });
  const reason = 'the refusal of mc goal defect is not printed; src/mc/commands/goal.js';
  assert.deepEqual(check(PART_GOAL, `${HEAD}\npart: NOT OK — ${reason}\n\nThe part says exit 2.\n`), { problems: [], failed: [{ id: 'part', reason }] });

  assert.deepEqual(check(PART_GOAL, `${HEAD}\n`).problems, ['no line for part'], 'a verdict without the part line is refused');
  assert.deepEqual(check(PART_GOAL, 'part: OK\n').problems, ['no `head: memoro-cli <sha>` line — the head judged is abc1234def']);
  assert.deepEqual(check(PART_GOAL, 'head: memoro-cli 9999999\npart: OK\n').problems, ['`head: memoro-cli 9999999` is not the head judged, abc1234def']);
  assert.deepEqual(check(PART_GOAL, `${HEAD}\npart: OK\npart: OK\n`).problems, ['more than one line for part']);
  assert.match(check(PART_GOAL, `${HEAD}\npart: NOT OK\n`).problems[0], /^not in form: "part: NOT OK"/u, 'a NOT OK line says what the build does not do');
  // The lines of a goal of the old form are free text here: they neither stand in for the part line nor are faulted.
  const oldLines = `${HEAD}\ncriterion 1: OK\nchange: NOT OK — too wide\nbugs: OK\n`;
  assert.deepEqual(check(PART_GOAL, oldLines), { problems: ['no line for part'], failed: [] });
  assert.deepEqual(check(PART_GOAL, `${oldLines}part: OK\n`), { problems: [], failed: [] });
});

test('a goal of the old form still requires its own lines, and a part line is none of them', () => {
  const ids = ['criterion 1', 'V1', 'obligation Documentation', 'write-back', 'change', 'out-of-scope', 'protection', 'bugs'];
  assert.deepEqual(requiredIds(OLD_GOAL, [], [], true), ids);
  assert.deepEqual(check(OLD_GOAL, `${HEAD}\npart: OK\n`, { writeBack: true }).problems, ids.map((id) => `no line for ${id}`), 'the part line alone is not its verdict');
  const whole = `${HEAD}\n${ids.map((id) => (id === 'write-back' ? 'write-back: OK — none — nothing a page should say' : `${id}: OK`)).join('\n')}\n`;
  assert.deepEqual(check(OLD_GOAL, whole, { writeBack: true }), { problems: [], failed: [] });
  assert.deepEqual(check(OLD_GOAL, `${whole}part: of the free text below\n`, { writeBack: true }), { problems: [], failed: [] }, 'a line beginning "part:" is free text for it, as before');
});
