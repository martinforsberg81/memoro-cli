/**
 * Pure-helper tests for the fanout brief template (§10a).
 *
 * The brief shape is the quality-lift mechanism — pin it deliberately
 * so future drift is visible in this test rather than at runtime.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildFanoutBrief } from '../../../src/mc/orchestration/brief-template.js';

describe('buildFanoutBrief — required structure', () => {
  const base = {
    planSlug: 'onboarding-flow',
    phaseN: 2,
    phaseTitle: 'Wire the wizard',
    intro: '# Onboarding plan\n\nIntro paragraph.',
    body: 'Build the steps array.\nWire it to the renderer.',
  };

  test('includes plan-slug + phase identity', () => {
    const brief = buildFanoutBrief(base);
    assert.match(brief, /plan/);
    assert.match(brief, /"onboarding-flow"/);
    assert.match(brief, /phase 2: Wire the wizard/);
  });

  test('points the agent at the protocol + skill before starting', () => {
    const brief = buildFanoutBrief(base);
    assert.match(brief, /docs\/coding-agent-protocol\.md/);
    assert.match(brief, /\.claude\/skills\/agent-coordination\.md/);
  });

  test('directs PRs at the collection branch, not main', () => {
    const brief = buildFanoutBrief(base);
    assert.match(brief, /`wip\/onboarding-flow`/);
    assert.match(brief, /\(NOT main\)/);
  });

  test('asks for the standard PR-body shape', () => {
    const brief = buildFanoutBrief(base);
    assert.match(brief, /Summary \/ Judgment calls \/ Test plan \/ Follow-ups/);
  });

  test('forbids guessing on 2+ option design choices', () => {
    const brief = buildFanoutBrief(base);
    assert.match(brief, /2\+ option/);
    assert.match(brief, /do not guess/);
  });

  test('embeds intro + body verbatim', () => {
    const brief = buildFanoutBrief(base);
    assert.match(brief, /Intro paragraph\./);
    assert.match(brief, /Build the steps array\./);
    assert.match(brief, /Wire it to the renderer\./);
  });

  test('honest-uncertainty discipline is called out (pattern 12)', () => {
    const brief = buildFanoutBrief(base);
    assert.match(brief, /pattern 12/);
  });
});

describe('buildFanoutBrief — input validation', () => {
  const ok = {
    planSlug: 'p',
    phaseN: 1,
    phaseTitle: 't',
    intro: '',
    body: '',
  };

  test('rejects missing planSlug', () => {
    assert.throws(() => buildFanoutBrief({ ...ok, planSlug: '' }), /planSlug required/);
    assert.throws(() => buildFanoutBrief({ ...ok, planSlug: null }), /planSlug required/);
  });

  test('rejects non-positive phaseN', () => {
    assert.throws(() => buildFanoutBrief({ ...ok, phaseN: 0 }), /phaseN must be a positive integer/);
    assert.throws(() => buildFanoutBrief({ ...ok, phaseN: -1 }), /phaseN must be a positive integer/);
    assert.throws(() => buildFanoutBrief({ ...ok, phaseN: 1.5 }), /phaseN must be a positive integer/);
    assert.throws(() => buildFanoutBrief({ ...ok, phaseN: '1' }), /phaseN must be a positive integer/);
  });

  test('rejects missing phaseTitle', () => {
    assert.throws(() => buildFanoutBrief({ ...ok, phaseTitle: '' }), /phaseTitle required/);
  });

  test('intro + body accept empty strings (no throw)', () => {
    const brief = buildFanoutBrief({ ...ok, intro: '', body: '' });
    assert.equal(typeof brief, 'string');
    assert.ok(brief.length > 0);
  });

  test('intro + body coerce non-string to empty', () => {
    const brief = buildFanoutBrief({ ...ok, intro: null, body: undefined });
    assert.equal(typeof brief, 'string');
  });
});
