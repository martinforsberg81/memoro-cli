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
const merged = { note: 'success,merged', pr: '77' };

/**
 * The two facts that say a folder is the runner's to take: it came through
 * `PLAN.json`, and its branch holds nothing main does not. Both default to the
 * safe answer, so a case that does not name them is asking about something
 * else.
 */
const mine = { planWorld: true, landed: 'landed' };

/**
 * The runner squash-merges, so every finished branch is "ahead" of main by
 * commits forever — that is why commit counting is not one of the three
 * facts. A plan that says done, a clean worktree and a last row that ends
 * `merged` is the whole rule.
 */
test('a squash-merged workarea is closable: plan done, nothing uncommitted, last run merged', () => {
  const verdict = closable({ ...mine, plan: donePlan, dirty: false, lastRun: merged });
  assert.equal(verdict.close, true);
  assert.equal(verdict.unplanned, false);
  assert.equal(verdict.why, 'plan done, worktree clean, branch landed, last delivery merged');
});

test('an uncommitted change keeps the workarea, whatever the plan says', () => {
  const verdict = closable({ ...mine, plan: donePlan, dirty: true, lastRun: merged });
  assert.equal(verdict.close, false);
  assert.equal(verdict.why, 'an uncommitted change');
});

test('a plan that is not done is not a reason to remove anything', () => {
  assert.deepEqual(closable({ ...mine, plan: { status: 'ready' }, lastRun: merged }),
    { close: false, unplanned: false, why: 'the plan is ready' });
  assert.equal(closable({ ...mine, plan: {}, lastRun: merged }).why, 'the plan is unreadable');
});

test('no project at all is a different answer, not a failed one', () => {
  const verdict = closable({ ...mine, plan: null, archived: false, dirty: false, lastRun: merged });
  assert.equal(verdict.close, false);
  assert.equal(verdict.unplanned, true);
  assert.equal(verdict.why, 'no project on main');
});

/**
 * The plan goes first and the workarea second, and for a while both had to
 * happen in the same round: the rule tested `status: done`, so a plan an
 * earlier round had already archived read as "no plan on main" and the folder
 * was never touched again. Measured 2026-08-30, the one round that archived
 * three projects was cut short by STOP before it reached the closing.
 */
test('a project the runner archived in an earlier round is still closable', () => {
  const verdict = closable({ ...mine, plan: null, archived: true, dirty: false, lastRun: merged });
  assert.equal(verdict.close, true);
  assert.equal(verdict.unplanned, false);
  assert.equal(verdict.why, 'project archived, worktree clean, branch landed, last delivery merged');
});

/**
 * What keeps that widening from taking anything it should not: the two facts
 * after it. A folder somebody made by hand that happens to share a name with
 * an archived project has no runner step to point at.
 */
test('an archived name alone removes nothing — the worktree and the last run still decide', () => {
  assert.equal(closable({ ...mine, plan: null, archived: true, lastRun: null }).why, 'no runner step to point at');
  assert.equal(closable({ ...mine, plan: null, archived: true, dirty: true, lastRun: merged }).why, 'an uncommitted change');
  assert.equal(closable({ ...mine, plan: null, archived: true, live: true, lastRun: merged }).why, 'a live tmux session');
  assert.equal(closable({ ...mine, plan: null, archived: true, lastRun: { note: 'success,open' } }).why, 'its last delivery says success,open');
  for (const verdict of [
    closable({ ...mine, plan: null, archived: true, lastRun: null }),
    closable({ ...mine, plan: null, archived: true, dirty: true, lastRun: merged }),
  ]) assert.equal(verdict.unplanned, false, 'it is a kept project, not a folder nobody can explain');
});

test('a last run that did not merge, and no last run at all, both keep the workarea', () => {
  assert.equal(closable({ ...mine, plan: donePlan, lastRun: { note: 'success,open' } }).why, 'its last delivery says success,open');
  assert.equal(closable({ ...mine, plan: donePlan, lastRun: { note: '' } }).why, 'its last delivery says -');
  assert.equal(closable({ ...mine, plan: donePlan, lastRun: null }).why, 'no runner step to point at');
});

/**
 * The boundary Martin drew on 2026-08-30, after a round removed 22 workareas in
 * one evening and every one of them turned out to be a PLAN.md project: what
 * the plan world built, a round may take down; what predates it is his.
 */
test('a finished project from before PLAN.json is listed, never taken', () => {
  const verdict = closable({ plan: donePlan, planWorld: false, landed: 'landed', lastRun: merged });
  assert.equal(verdict.close, false);
  assert.equal(verdict.legacy, true, 'it is a different answer, not a failed one');
  assert.equal(verdict.unplanned, false, 'and not a folder nobody can explain either');
  assert.equal(verdict.why, 'finished, but from before PLAN.json \u2014 yours to remove');
});

/**
 * What `git status --porcelain` cannot see. It reports uncommitted changes and
 * says nothing about a commit that was never pushed \u2014 and the close ends in
 * `git branch -D`. A row in runs.tsv saying `merged` is evidence that *a* pull
 * request landed, never that this branch has nothing left on it.
 */
test('a branch main does not already hold keeps the workarea, however merged its last delivery', () => {
  for (const landed of ['ahead', 'unknown']) {
    const verdict = closable({ plan: donePlan, planWorld: true, landed, lastRun: merged });
    assert.equal(verdict.close, false, landed);
    assert.equal(verdict.legacy, true, landed);
    assert.match(verdict.why, /main does not hold everything it has/u);
  }
});

test('a live tmux session is the same refusal a step already makes', () => {
  assert.equal(closable({ ...mine, plan: donePlan, live: true, lastRun: merged }).why, 'a live tmux session');
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
