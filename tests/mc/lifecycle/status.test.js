/**
 * TDD spec for `mc status <name>` (§9a).
 *
 * Per the plan §9a, `mc status <name>` returns the derived fields for a
 * single session, with a safety verdict ∈ {
 *   SAFE_TO_END,
 *   NEEDS_REVIEW,
 *   HAS_UNMERGED_WORK,
 *   IS_ACTIVE_NOW,
 *   IS_SQUASH_PHANTOM
 * }.
 *
 * Tests pre-seed the registry with each verdict and confirm `mc status`
 * surfaces it verbatim.
 *
 * Open-question heuristic (also tested here, since `mc status` reports
 * the open-question flag): ends with `?`, or contains "Vill du" /
 * "Want me to" / "A or B" / numbered choices. Implementation may
 * fall back to a small LLM call when ambiguous; the heuristic-only
 * cases are what we lock down here.
 */
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runMc, parseJsonOrNull } from '../_helpers/cli.js';
import { writeRegistry, makeEntry } from '../_helpers/registry-fixture.js';

describe('mc status <name>', () => {
  let mcHome;
  before(() => {
    mcHome = mkdtempSync(join(tmpdir(), 'mc-status-'));
    writeRegistry(mcHome, [
      makeEntry({
        name: 'safe',
        safety_verdict: 'SAFE_TO_END',
        dirty_files: 0,
        ahead: 0,
        session_state: 'dead',
        last_assistant_text: 'All done. Branch merged.',
      }),
      makeEntry({
        name: 'review',
        safety_verdict: 'NEEDS_REVIEW',
        dirty_files: 2,
        last_assistant_text: 'I have made changes — please review.',
      }),
      makeEntry({
        name: 'unmerged',
        safety_verdict: 'HAS_UNMERGED_WORK',
        ahead: 4,
        dirty_files: 0,
      }),
      makeEntry({
        name: 'active',
        safety_verdict: 'IS_ACTIVE_NOW',
        session_state: 'live',
      }),
      makeEntry({
        name: 'phantom',
        safety_verdict: 'IS_SQUASH_PHANTOM',
        ahead: 1,
        dirty_files: 0,
      }),
      makeEntry({
        name: 'question-qmark',
        last_assistant_text: 'Should I update the schema?',
        open_question: true,
        safety_verdict: 'NEEDS_REVIEW',
      }),
      makeEntry({
        name: 'question-vill-du',
        last_assistant_text: 'Vill du att jag fortsätter med detta?',
        open_question: true,
        safety_verdict: 'NEEDS_REVIEW',
      }),
      makeEntry({
        name: 'question-want-me',
        last_assistant_text: 'Want me to push the changes now?',
        open_question: true,
        safety_verdict: 'NEEDS_REVIEW',
      }),
      makeEntry({
        name: 'question-a-or-b',
        last_assistant_text: 'Should I go with A or B?',
        open_question: true,
        safety_verdict: 'NEEDS_REVIEW',
      }),
      makeEntry({
        name: 'question-numbered',
        last_assistant_text: 'Options:\n  1. Add a guard\n  2. Refactor caller\n  3. Hold',
        open_question: true,
        safety_verdict: 'NEEDS_REVIEW',
      }),
      makeEntry({
        name: 'no-question',
        last_assistant_text: 'Changes have been committed.',
        open_question: false,
        safety_verdict: 'SAFE_TO_END',
      }),
      makeEntry({
        name: 'codex-session',
        tool: 'codex',
        safety_verdict: 'IS_ACTIVE_NOW',
      }),
    ]);
  });
  after(() => { rmSync(mcHome, { recursive: true, force: true }); });

  for (const verdict of [
    'SAFE_TO_END', 'NEEDS_REVIEW', 'HAS_UNMERGED_WORK',
    'IS_ACTIVE_NOW', 'IS_SQUASH_PHANTOM',
  ]) {
    const name = {
      SAFE_TO_END: 'safe',
      NEEDS_REVIEW: 'review',
      HAS_UNMERGED_WORK: 'unmerged',
      IS_ACTIVE_NOW: 'active',
      IS_SQUASH_PHANTOM: 'phantom',
    }[verdict];

    test(`reports ${verdict} for the ${name} fixture`, () => {
      const r = runMc(['status', name, '--json'], { env: { MC_HOME: mcHome } });
      assert.equal(r.status, 0, `stderr:${r.stderr}`);
      const j = parseJsonOrNull(r.stdout);
      assert.ok(j, `expected JSON, got: ${r.stdout}`);
      assert.equal(j.name, name);
      assert.equal(j.safety_verdict, verdict);
    });
  }

  test('returns required derived fields', () => {
    const r = runMc(['status', 'review', '--json'], { env: { MC_HOME: mcHome } });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j);
    for (const k of [
      'name', 'branch', 'safety_verdict', 'dirty_files', 'ahead',
      'last_activity', 'session_state', 'tool', 'relaunch_command',
    ]) {
      assert.ok(k in j, `field ${k} missing from status output`);
    }
  });

  test('surfaces session tool + relaunch command in JSON', () => {
    const r = runMc(['status', 'codex-session', '--json'], { env: { MC_HOME: mcHome } });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j);
    assert.equal(j.tool, 'codex');
    assert.equal(j.relaunch_command, 'mc resume codex-session');
  });

  test('human output includes tool + relaunch command', () => {
    const r = runMc(['status', 'codex-session'], { env: { MC_HOME: mcHome } });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    assert.match(r.stdout, /tool\s+codex/);
    assert.match(r.stdout, /relaunch\s+mc resume codex-session/);
  });

  test('unknown name → non-zero exit + error', () => {
    const r = runMc(['status', 'does-not-exist', '--json'], { env: { MC_HOME: mcHome } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /not.found|unknown|no such/i);
  });

  // Open-question heuristic — §9a + the hint in the prompt brief.
  for (const name of [
    'question-qmark',
    'question-vill-du',
    'question-want-me',
    'question-a-or-b',
    'question-numbered',
  ]) {
    test(`open_question flag is true for ${name}`, () => {
      const r = runMc(['status', name, '--json'], { env: { MC_HOME: mcHome } });
      assert.equal(r.status, 0, `stderr:${r.stderr}`);
      const j = parseJsonOrNull(r.stdout);
      assert.equal(j.open_question, true);
    });
  }

  test('open_question is false when the assistant did not pose a question', () => {
    const r = runMc(['status', 'no-question', '--json'], { env: { MC_HOME: mcHome } });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j.open_question, false);
  });
});
