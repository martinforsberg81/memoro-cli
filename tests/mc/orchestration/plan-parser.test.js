/**
 * Pure-helper tests for the plan-parser (§10a, mc fanout).
 *
 * Pure module — no fixtures, no I/O. Covers:
 *   - intro extraction (no phases, intro larger than cap, blank-only intro)
 *   - phase heading regex (matches valid, ignores zero/negative/bad fmt)
 *   - phase body slicing (between this heading and the next)
 *   - body trim (leading + trailing blanks)
 *   - planSlugFromFilename: accepts good, rejects underscores / dots / caps
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePhases,
  planSlugFromFilename,
  INTRO_MAX_LINES,
} from '../../../src/mc/orchestration/plan-parser.js';

describe('parsePhases — phase extraction', () => {
  test('extracts each `## Phase N:` heading with title + body', () => {
    const text = [
      '# Plan title',
      '',
      'Some intro text.',
      '',
      '## Phase 1: First slice',
      '',
      'Body of phase 1.',
      'Second line of phase 1.',
      '',
      '## Phase 2: Second slice',
      'Body of phase 2.',
      '',
    ].join('\n');
    const { intro, phases } = parsePhases(text);
    assert.match(intro, /# Plan title/);
    assert.match(intro, /Some intro text/);
    assert.equal(phases.length, 2);
    assert.deepEqual(phases.map((p) => p.n), [1, 2]);
    assert.equal(phases[0].title, 'First slice');
    assert.equal(phases[1].title, 'Second slice');
    assert.match(phases[0].body, /Body of phase 1\./);
    assert.match(phases[0].body, /Second line of phase 1\./);
    assert.match(phases[1].body, /Body of phase 2\./);
  });

  test('no phases → intro is whole doc, phases is []', () => {
    const text = '# Plan\n\nNo phases here.\n';
    const { intro, phases } = parsePhases(text);
    assert.equal(phases.length, 0);
    assert.match(intro, /No phases here/);
  });

  test('returns empty result for non-string input', () => {
    const r1 = parsePhases(null);
    const r2 = parsePhases(undefined);
    const r3 = parsePhases(42);
    for (const r of [r1, r2, r3]) {
      assert.deepEqual(r, { intro: '', phases: [] });
    }
  });

  test('intro cap: lines beyond INTRO_MAX_LINES are dropped', () => {
    const introLines = Array.from({ length: INTRO_MAX_LINES + 20 }, (_, i) => `intro line ${i + 1}`);
    const text = [
      ...introLines,
      '## Phase 1: x',
      'body',
    ].join('\n');
    const { intro } = parsePhases(text);
    const introOut = intro.split('\n');
    assert.equal(introOut.length, INTRO_MAX_LINES);
    assert.equal(introOut[0], 'intro line 1');
    assert.equal(introOut[INTRO_MAX_LINES - 1], `intro line ${INTRO_MAX_LINES}`);
  });

  test('introMaxLines override is honoured', () => {
    const text = ['a', 'b', 'c', 'd', '## Phase 1: t', 'body'].join('\n');
    const { intro } = parsePhases(text, { introMaxLines: 2 });
    assert.deepEqual(intro.split('\n'), ['a', 'b']);
  });

  test('phase body trims leading + trailing blanks', () => {
    const text = [
      '## Phase 1: t',
      '',
      '',
      'real body',
      '',
      '',
      '## Phase 2: u',
      'x',
    ].join('\n');
    const { phases } = parsePhases(text);
    assert.equal(phases[0].body, 'real body');
  });

  test('ignores zero/negative phase numbers', () => {
    // Phase 0 should be skipped (regex requires \d+ but ours guards
    // against n <= 0 too); the heading itself isn't a phase boundary.
    const text = [
      '## Phase 0: bogus',
      'body0',
      '## Phase 1: real',
      'body1',
    ].join('\n');
    const { phases } = parsePhases(text);
    assert.equal(phases.length, 1);
    assert.equal(phases[0].n, 1);
  });

  test('does not match malformed headings (missing colon, wrong level)', () => {
    const text = [
      '### Phase 1: too-deep',
      '## Phase one: not-a-number',
      '## Phase 1 missing colon',
      '## Phase 2: real',
      'body2',
    ].join('\n');
    const { phases } = parsePhases(text);
    assert.equal(phases.length, 1);
    assert.equal(phases[0].n, 2);
  });

  test('intro trailing blanks stripped before cap is applied', () => {
    const text = [
      'intro a',
      '',
      '',
      '## Phase 1: x',
      'body',
    ].join('\n');
    const { intro } = parsePhases(text);
    assert.equal(intro, 'intro a');
  });
});

describe('planSlugFromFilename', () => {
  test('strips directory + .md extension', () => {
    assert.deepEqual(planSlugFromFilename('docs/plans/onboarding-flow.md'), { ok: true, slug: 'onboarding-flow' });
    assert.deepEqual(planSlugFromFilename('/abs/path/fix-bug.md'), { ok: true, slug: 'fix-bug' });
    assert.deepEqual(planSlugFromFilename('plan.md'), { ok: true, slug: 'plan' });
  });

  test('rejects empty / non-string input', () => {
    assert.equal(planSlugFromFilename('').ok, false);
    assert.equal(planSlugFromFilename(null).ok, false);
    assert.equal(planSlugFromFilename(undefined).ok, false);
  });

  test('rejects uppercase, underscores, dots, shell metas', () => {
    assert.equal(planSlugFromFilename('Plan.md').ok, false);
    assert.equal(planSlugFromFilename('my_plan.md').ok, false);
    assert.equal(planSlugFromFilename('plan.draft.md').ok, false);
    assert.equal(planSlugFromFilename('plan;rm -rf.md').ok, false);
    assert.equal(planSlugFromFilename('plan$x.md').ok, false);
  });

  test('accepts numbers + hyphens', () => {
    assert.deepEqual(planSlugFromFilename('plan-2026-05.md'), { ok: true, slug: 'plan-2026-05' });
  });
});
