import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { describe } from 'node:test';

import {
  projectRuntimeSession,
  projectStructuredEvents,
  projectTranscriptSession,
  resolveSessionSourceIdentity,
  sanitizeSessionProjection,
  SessionProjectionTracker,
} from '../../src/mc/session-projector.js';

const NOW = Date.parse('2026-07-21T08:02:00.000Z');
const fixture = JSON.parse(readFileSync(
  new URL('../fixtures/mc-session-projection-v1.json', import.meta.url),
  'utf8',
));

function cleanGit(overrides = {}) {
  return {
    current_branch: 'main',
    dirty_files: 0,
    ahead: 0,
    behind: 0,
    safety_verdict: 'SAFE_TO_END',
    observed_at: '2026-07-21T08:01:55.000Z',
    ...overrides,
  };
}

describe('mc-session-projection-v1 shared fixtures', () => {
  test('accepts every valid fixture and rejects every invalid fixture', () => {
    assert.equal(fixture.contract_version, 'mc-session-projection-v1');
    for (const row of fixture.valid) {
      assert.ok(sanitizeSessionProjection(row.projection), row.name);
    }
    for (const row of fixture.invalid) {
      assert.equal(sanitizeSessionProjection(row.projection), null, row.name);
    }
  });
});

describe('runtime projection', () => {
  test('projects fresh output as active without exposing output text', () => {
    const projected = projectRuntimeSession({
      now: NOW,
      session: {
        session_state: 'live',
        attachable: true,
        last_output_at: '2026-07-21T08:01:30.000Z',
      },
      output: 'Running tests for src/secret.js',
      git: cleanGit({ dirty_files: 3, safety_verdict: 'NEEDS_REVIEW' }),
    });
    assert.equal(projected.status, 'active');
    assert.equal(projected.reason_code, 'tool_activity');
    assert.doesNotMatch(JSON.stringify(projected), /secret\.js|Running tests/);

    const legacyHeartbeat = projectRuntimeSession({
      now: NOW,
      session: { session_state: 'live', attachable: true, idle_seconds: 5 },
      git: cleanGit(),
    });
    assert.deepEqual([legacyHeartbeat.status, legacyHeartbeat.reason_code], ['active', 'recent_output']);
  });

  test('projects questions and test failures as attention', () => {
    const base = {
      now: NOW,
      session: {
        session_state: 'live',
        attachable: true,
        last_output_at: '2026-07-21T08:01:30.000Z',
      },
      git: cleanGit(),
    };
    assert.deepEqual(
      [projectRuntimeSession({ ...base, output: 'Should I continue?' }).status,
        projectRuntimeSession({ ...base, output: 'Should I continue?' }).reason_code],
      ['needs_attention', 'awaiting_reply'],
    );
    assert.equal(projectRuntimeSession({ ...base, output: '2 tests failed' }).reason_code, 'tests_failed');
    assert.equal(
      projectRuntimeSession({ ...base, output: 'Rekommenderat svar: "Fortsätt."' }).reason_code,
      'awaiting_reply',
    );
  });

  test('never treats sleeping, stopping, or clean exit as completion', () => {
    for (const session of [
      { session_state: 'sleeping', last_output_at: '2026-07-21T08:00:00.000Z' },
      { session_state: 'stopped', last_output_at: '2026-07-21T08:00:00.000Z' },
      { session_state: 'dead', exit: { code: 0, at: '2026-07-21T08:00:00.000Z' } },
    ]) {
      const projected = projectRuntimeSession({ session, now: NOW, git: cleanGit() });
      assert.equal(projected.status, 'resting');
      assert.notEqual(projected.status, 'completed');
    }
  });

  test('projects failed runtime and stale live runtime safely', () => {
    const failed = projectRuntimeSession({
      session: { session_state: 'dead', exit: { code: 2, at: '2026-07-21T08:01:00.000Z' } },
      now: NOW,
      git: cleanGit(),
    });
    assert.deepEqual([failed.status, failed.reason_code], ['needs_attention', 'runtime_failed']);

    const repair = projectRuntimeSession({
      session: { session_state: 'failed', needs_repair: true },
      now: NOW,
      git: cleanGit(),
    });
    assert.deepEqual([repair.status, repair.reason_code], ['needs_attention', 'repair_required']);

    const stale = projectRuntimeSession({
      session: {
        session_state: 'live',
        attachable: true,
        started_at: '2026-07-21T07:00:00.000Z',
        last_output_at: '2026-07-21T07:30:00.000Z',
      },
      now: NOW,
      git: cleanGit(),
    });
    assert.equal(stale.status, 'resting');
  });

  test('new input supersedes prior state and stale active expires automatically', () => {
    const completed = projectTranscriptSession({
      now: NOW,
      parsed: { messages: [{ role: 'assistant', content: 'Done. Tests pass.', at: '2026-07-21T08:00:00.000Z' }] },
      git: cleanGit(),
    });
    const resumed = projectRuntimeSession({
      now: NOW,
      session: {
        session_projection: completed,
        session_state: 'live',
        attachable: true,
        last_input_at: '2026-07-21T08:01:30.000Z',
      },
      git: cleanGit(),
    });
    assert.deepEqual([resumed.status, resumed.reason_code], ['active', 'turn_started']);

    const expired = projectRuntimeSession({
      now: NOW,
      session: {
        session_projection: {
          ...completed,
          status: 'active',
          reason_code: 'recent_output',
          classification_basis: 'runtime_fallback',
          observed_at: '2026-07-21T07:00:00.000Z',
        },
        session_state: 'live',
        attachable: true,
      },
      git: cleanGit(),
    });
    assert.equal(expired.status, 'resting');
  });
});

describe('terminal transcript projection', () => {
  test('requires a guarded final assistant conclusion for completion', () => {
    const completed = projectTranscriptSession({
      now: NOW,
      parsed: {
        messages: [
          { role: 'user', content: 'Investigate the cache bug', at: '2026-07-21T08:00:00.000Z' },
          { role: 'assistant', content: 'Conclusion:\nThe invalidation key caused it. Tests pass.', at: '2026-07-21T08:01:00.000Z' },
        ],
      },
      git: cleanGit(),
    });
    assert.deepEqual([completed.status, completed.reason_code], ['completed', 'agent_concluded']);
    assert.equal(completed.classification_basis, 'deterministic_final_turn');

    const ambiguous = projectTranscriptSession({
      now: NOW,
      parsed: {
        messages: [
          { role: 'user', content: 'Look around', at: '2026-07-21T08:00:00.000Z' },
          { role: 'assistant', content: 'I inspected three files.', at: '2026-07-21T08:01:00.000Z' },
        ],
      },
      git: cleanGit(),
    });
    assert.equal(ambiguous.status, 'resting');

    for (const content of [
      'I have not implemented the fix.',
      'The tests do not pass.',
      'Next I will implement the remaining change.',
      'Inte klart. Återstår att testa migreringen.',
    ]) {
      const incomplete = projectTranscriptSession({
        now: NOW,
        parsed: { messages: [{ role: 'assistant', content, at: '2026-07-21T08:01:00.000Z' }] },
        git: cleanGit(),
      });
      assert.equal(incomplete.status, 'resting', content);
    }
  });

  test('later input or tool activity prevents completion', () => {
    const parsed = {
      messages: [
        { role: 'assistant', content: 'Done. Tests pass.', at: '2026-07-21T08:00:00.000Z' },
        { role: 'user', content: 'One more thing', at: '2026-07-21T08:01:00.000Z' },
      ],
      activities: [{ kind: 'tool_call', at: '2026-07-21T08:01:30.000Z' }],
    };
    assert.equal(projectTranscriptSession({ parsed, now: NOW, git: cleanGit() }).status, 'resting');

    const resumed = projectTranscriptSession({
      parsed,
      now: NOW,
      git: cleanGit(),
      runtimeLifecycle: 'live',
    });
    assert.deepEqual([resumed.status, resumed.reason_code], ['active', 'tool_activity']);

    const waitingForAssistant = projectTranscriptSession({
      parsed: { messages: [{ role: 'user', content: 'Continue', at: '2026-07-21T08:01:00.000Z' }] },
      now: NOW,
      git: cleanGit(),
      runtimeLifecycle: 'live',
    });
    assert.deepEqual([waitingForAssistant.status, waitingForAssistant.reason_code], ['active', 'turn_started']);
  });

  test('question, review handoff, and dirty conclusion require attention', () => {
    const project = (content, git = cleanGit()) => projectTranscriptSession({
      now: NOW,
      parsed: { messages: [{ role: 'assistant', content, at: '2026-07-21T08:01:00.000Z' }] },
      git,
    });
    assert.equal(project('Which option should I use?').reason_code, 'awaiting_reply');
    assert.equal(project('Implemented. Ready for review.').reason_code, 'review_requested');
    assert.equal(project('Implemented and tests pass.', cleanGit({
      dirty_files: 2,
      safety_verdict: 'NEEDS_REVIEW',
    })).reason_code, 'changes_require_review');
  });

  test('new structured activity supersedes a prior conclusion', () => {
    const projected = projectStructuredEvents({
      now: NOW,
      events: [
        { type: 'agent_concluded', at: '2026-07-21T08:00:00.000Z' },
        { type: 'turn_started', at: '2026-07-21T08:01:00.000Z' },
      ],
      git: cleanGit(),
    });
    assert.deepEqual([projected.status, projected.reason_code], ['active', 'turn_started']);

    const input = projectStructuredEvents({
      now: NOW,
      events: [
        { type: 'agent_concluded', at: '2026-07-21T08:00:00.000Z' },
        { type: 'user_input', at: '2026-07-21T08:01:00.000Z' },
      ],
      git: cleanGit(),
    });
    assert.deepEqual([input.status, input.reason_code], ['active', 'turn_started']);
  });
});

describe('projection tracker and identity', () => {
  test('refreshes git once per meaningful transition', () => {
    let reads = 0;
    const tracker = new SessionProjectionTracker({
      cwd: '/repo',
      now: () => NOW,
      observeGit: () => {
        reads += 1;
        return { ok: true, ...cleanGit() };
      },
    });
    const active = {
      session: { session_state: 'live', last_output_at: '2026-07-21T08:01:30.000Z' },
      output: 'Working(2s)',
    };
    tracker.runtime(active);
    tracker.runtime(active);
    tracker.runtime({ session: { session_state: 'sleeping' } });
    assert.equal(reads, 2);

    tracker.transcript({
      parsed: { messages: [{ role: 'assistant', content: 'Done.', at: '2026-07-21T08:01:00.000Z' }] },
    });
    tracker.transcript({
      parsed: { messages: [{ role: 'assistant', content: 'Done.', at: '2026-07-21T08:01:00.000Z' }] },
    });
    assert.equal(reads, 3);
  });

  test('builds bounded source-aware local and cloud identities', () => {
    assert.deepEqual(resolveSessionSourceIdentity({ machineId: 'Martin Mac' }), {
      source_id: 'local:Martin-Mac',
      source_kind: 'local',
      source_name: 'Martin Mac',
      cloud_session_id: null,
    });
    assert.equal(resolveSessionSourceIdentity({
      machineId: 'runner',
      env: { MC_SOURCE_ID: 'cloud:one', MC_SOURCE_KIND: 'cloud', MC_CLOUD_SESSION_ID: 'cld_one' },
    }).source_id, 'cloud:one');
  });
});
