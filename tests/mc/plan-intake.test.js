import { test } from 'node:test';
import assert from 'node:assert/strict';

import { unreadableFile, unreadablePlans, unreadableRow } from '../../src/mc/plan-intake.js';

const UNREADABLE_KEYS = ['project', 'repo', 'problem', 'path'];

/** The rows under the first `|---|` rule, keyed — a pipe inside a cell is written `\|`. */
function intakeRows(text, keys) {
  const lines = text.split('\n');
  const rule = lines.findIndex((line) => /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/u.test(line));
  return lines.slice(rule + 1).filter((line) => line.trim().startsWith('|')).map((line) => {
    const cells = line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split(/(?<!\\)\|/u)
      .map((cell) => cell.replace(/\\\|/gu, '|').trim());
    return Object.fromEntries(keys.map((key, i) => [key, cells[i] ?? '']));
  });
}

/**
 * A plan on origin/main the schema refuses. `chooseKind` already answers
 * `unparseable` and the round already logs it; the line goes to `runner.log`,
 * which is where the old queue's skip lines went to be read by nobody.
 * `new-user`'s plan carried five entries whose `body` was a string, so it
 * failed the schema, and the runner printed that line every round for a day
 * while nothing on any board said the project had stopped.
 */
const refused = {
  project: 'new-user',
  repo: 'memoro',
  path: 'docs/project/onboarding/new-user/PLAN.json',
  legacy: false,
  plan: null,
  problems: ['what_the_code_taught_us[0].body: at least one paragraph', 'steps[1].pr: a pull request number, or null'],
};
const readable = { project: 'action-window', repo: 'memoro', path: 'x/PLAN.json', legacy: false, plan: { steps: [] }, problems: [] };
const unmigrated = { project: 'msr-design', repo: 'memoro', path: 'y/PLAN.md', legacy: true, plan: null, problems: [] };

test('a plan the schema refused gets a row, with its first problem', () => {
  const rows = unreadablePlans([readable, refused]);
  assert.deepEqual(rows, [{
    project: 'new-user',
    repo: 'memoro',
    problem: 'what_the_code_taught_us[0].body: at least one paragraph',
    path: 'docs/project/onboarding/new-user/PLAN.json',
  }]);
});

/**
 * A project still on a PLAN.md is a different answer, and it already has one.
 * Putting it here would fill the table with rows nobody has to act on — the
 * exact failure the runner.log line was.
 */
test('an unmigrated PLAN.md is not an unreadable plan', () => {
  assert.deepEqual(unreadablePlans([unmigrated]), []);
});

test('the file is rewritten whole, so a fixed plan leaves the list by itself', () => {
  const empty = unreadableFile([]);
  assert.match(empty, /# Plans on origin\/main that do not parse/u);
  assert.deepEqual(intakeRows(empty, UNREADABLE_KEYS), []);

  const filled = unreadableFile(unreadablePlans([refused]));
  const [row] = intakeRows(filled, UNREADABLE_KEYS);
  assert.equal(row.project, 'new-user');
  assert.equal(row.repo, 'memoro');
  assert.equal(row.problem, 'what_the_code_taught_us[0].body: at least one paragraph');
  assert.equal(row.path, 'docs/project/onboarding/new-user/PLAN.json');
});

/** A problem naming a pipe would otherwise split one cell into two. */
test('a pipe in a problem stays inside its cell', () => {
  const line = unreadableRow({ project: 'p', repo: 'memoro', problem: 'steps[0].status: one of ready | done | blocked', path: 'z' });
  const [row] = intakeRows(`| a | b | c | d |\n|---|---|---|---|\n${line}\n`, UNREADABLE_KEYS);
  assert.equal(row.problem, 'steps[0].status: one of ready | done | blocked');
});
