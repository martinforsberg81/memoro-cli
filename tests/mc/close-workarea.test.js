import { test } from 'node:test';
import assert from 'node:assert/strict';

import { closable, lastRunFor, unplannedFile, unplannedRow } from '../../src/mc/close-workarea.js';

/**
 * The closable rule: three facts and no judgement. Measured on 2026-08-29,
 * `~/mc` held 61 workareas — seven finished and merged weeks earlier, sixteen
 * with no plan on main at all, and the runner had no way to tell them apart.
 */
const HEAD = 'ts\tname\tkind\texit\tseconds\tpr\tturns\tinput\toutput\tcache_read\tcache_write\tsession\tnote\n';
const row = (ts, name, note) => `${ts}\t${name}\tstep\t0\t10\t77\t4\t1\t2\t3\t4\tsid\t${note}\n`;
const donePlan = { project: 'docs-structure', repo: 'memoro', status: 'done' };
const merged = { note: 'success,merged' };

/**
 * The runner squash-merges, so every finished branch is "ahead" of main by
 * commits forever — that is why commit counting is not one of the three
 * facts. A plan that says done, a clean worktree and a last row that ends
 * `merged` is the whole rule.
 */
test('a squash-merged workarea is closable: plan done, nothing uncommitted, last run merged', () => {
  const verdict = closable({ plan: donePlan, dirty: false, lastRun: merged });
  assert.equal(verdict.close, true);
  assert.equal(verdict.unplanned, false);
  assert.equal(verdict.why, 'plan done, worktree clean, last run merged');
});

test('an uncommitted change keeps the workarea, whatever the plan says', () => {
  const verdict = closable({ plan: donePlan, dirty: true, lastRun: merged });
  assert.equal(verdict.close, false);
  assert.equal(verdict.why, 'an uncommitted change');
});

test('a plan that is not done is not a reason to remove anything', () => {
  assert.deepEqual(closable({ plan: { status: 'ready' }, lastRun: merged }),
    { close: false, unplanned: false, why: 'the plan is ready' });
  assert.equal(closable({ plan: {}, lastRun: merged }).why, 'the plan is unreadable');
});

test('no plan on main is a different answer, not a failed one', () => {
  const verdict = closable({ plan: null, dirty: false, lastRun: merged });
  assert.equal(verdict.close, false);
  assert.equal(verdict.unplanned, true);
  assert.equal(verdict.why, 'no plan on main');
});

test('a last run that did not merge, and no last run at all, both keep the workarea', () => {
  assert.equal(closable({ plan: donePlan, lastRun: { note: 'success,open' } }).why, 'the last run says success,open');
  assert.equal(closable({ plan: donePlan, lastRun: { note: '' } }).why, 'the last run says -');
  assert.equal(closable({ plan: donePlan, lastRun: null }).why, 'no runner step to point at');
});

test('a live tmux session is the same refusal a step already makes', () => {
  assert.equal(closable({ plan: donePlan, live: true, lastRun: merged }).why, 'a live tmux session');
});

test('the last row for a project is the one that decides, not the first', () => {
  const tsv = HEAD + row('2026-08-26T01:00:00Z', 'docs-structure', 'success,merged')
    + row('2026-08-27T01:00:00Z', 'other', 'success,open')
    + row('2026-08-29T01:00:00Z', 'docs-structure', 'success,open');
  assert.equal(lastRunFor(tsv, 'docs-structure').note, 'success,open');
  assert.equal(lastRunFor(tsv, 'never-ran'), null);
  assert.equal(lastRunFor('', 'docs-structure'), null);
});

/**
 * The intake file is rewritten every round rather than appended to: it is a
 * picture of what is there now, and a workarea that got its plan leaves the
 * list by itself.
 */
test('the unplanned file is a whole table, and a header on its own when there is nothing to say', () => {
  const text = unplannedFile([
    unplannedRow({ name: 'msr-track-1', repo: 'memoro', uncommitted: 0, lastCommit: '2026-08-24', branch: 'ahead' }),
  ]);
  assert.match(text, /\| name \| repo \| uncommitted \| last commit \| branch \|/u);
  assert.match(text, /\| msr-track-1 \| memoro \| 0 \| 2026-08-24 \| ahead \|\n$/u);
  assert.equal(unplannedFile([]).includes('|---|'), true);
  assert.equal(unplannedFile([]).trimEnd().endsWith('|---|---|---|---|---|'), true);
});

test('a pipe in a cell never breaks the table', () => {
  assert.match(unplannedRow({ name: 'a|b', repo: 'memoro', uncommitted: 1, lastCommit: '-', branch: 'unknown' }),
    /\| a\\\|b \| memoro \| 1 \| - \| unknown \|/u);
});
