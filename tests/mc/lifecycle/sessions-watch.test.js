import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWatchSnapshot,
  extractRecommendedReply,
  renderWatchSnapshot,
  run as runSessionsWatch,
} from '../../../src/mc/commands/sessions-watch.js';

const NOW = Date.parse('2026-06-09T12:00:00.000Z');

describe('mc sessions watch', () => {
  test('classifies local broker sessions and extracts recommended replies', () => {
    const snapshot = buildWatchSnapshot({
      now: NOW,
      sessions: [
        {
          id: 'sess_working',
          tool: 'codex',
          cwd: '/repo/working',
          session_state: 'live',
          attachable: true,
          last_output_at: '2026-06-09T11:59:58.000Z',
        },
        {
          id: 'sess_awaiting',
          tool: 'codex',
          cwd: '/repo/legal',
          session_state: 'live',
          attachable: true,
          last_output_at: '2026-06-09T11:50:00.000Z',
        },
        {
          id: 'sess_dead',
          tool: 'codex',
          cwd: '/repo/dead',
          session_state: 'dead',
          attachable: false,
          exit: { code: 0 },
          last_output_at: '2026-06-09T10:00:00.000Z',
        },
        {
          id: 'sess_review',
          tool: 'codex',
          cwd: '/repo/scoped-session-action',
          session_state: 'live',
          attachable: true,
          last_output_at: '2026-06-09T11:55:00.000Z',
        },
      ],
      outputs: new Map([
        ['sess_working', 'Working(12s • esc to interrupt)'],
        ['sess_awaiting', 'Agenten föreslår ändring.\nRekommenderat svar: "Ja, använd den formuleringen."'],
        ['sess_review', 'Så min reviderade plan: behåll action-sessionen som en enkel finisher.'],
      ]),
      includeDead: true,
    });

    assert.deepEqual(snapshot.counts, {
      awaiting_reply: 1,
      review_suggested: 1,
      working: 1,
      dead: 1,
    });
    assert.deepEqual(snapshot.sessions.map((s) => s.id), [
      'sess_awaiting',
      'sess_review',
      'sess_working',
      'sess_dead',
    ]);
    assert.equal(snapshot.sessions[0].disposition, 'awaiting_reply');
    assert.equal(snapshot.sessions[0].recommended_reply, 'Ja, använd den formuleringen.');
    assert.equal(snapshot.sessions[1].disposition, 'review_suggested');
    assert.equal(snapshot.sessions[2].disposition, 'working');
  });

  test('can exclude the current orchestrator worktree by name', () => {
    const snapshot = buildWatchSnapshot({
      now: NOW,
      excludeWorktreeNames: ['coord-v2'],
      sessions: [
        { id: 'sess_self', cwd: '/repo/coord-v2', session_state: 'live', attachable: true },
        { id: 'sess_other', cwd: '/repo/legal', session_state: 'live', attachable: true },
      ],
    });
    assert.deepEqual(snapshot.sessions.map((s) => s.id), ['sess_other']);
  });

  test('run emits machine-readable JSON from an injected broker', async () => {
    const stdout = [];
    const stderr = [];
    const status = await runSessionsWatch(['--json'], {
      stdout: { write: (value) => stdout.push(value) },
      stderr: { write: (value) => stderr.push(value) },
      now: NOW,
      requestBroker: async (msg) => {
        assert.deepEqual(msg, { type: 'sessions' });
        return {
          ok: true,
          sessions: [{
            id: 'sess_a',
            cwd: '/repo/a',
            tool: 'codex',
            session_state: 'live',
            attachable: true,
            last_output_at: '2026-06-09T11:59:00.000Z',
          }],
        };
      },
      readOutput: async (id) => {
        assert.equal(id, 'sess_a');
        return 'Should I proceed?';
      },
    });

    assert.equal(status, 0);
    assert.equal(stderr.join(''), '');
    const parsed = JSON.parse(stdout.join(''));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.sessions[0].id, 'sess_a');
    assert.equal(parsed.sessions[0].disposition, 'awaiting_reply');
  });

  test('human output includes text, recommendation, send command, and counts', () => {
    const snapshot = buildWatchSnapshot({
      now: NOW,
      sessions: [{
        id: 'sess_a',
        cwd: '/repo/a',
        tool: 'codex',
        session_state: 'live',
        attachable: true,
        last_output_at: '2026-06-09T11:59:00.000Z',
      }],
      outputs: new Map([
        ['sess_a', 'Recommended reply: "Use the scoped version."'],
      ]),
    });
    const output = renderWatchSnapshot(snapshot);
    assert.match(output, /mc sessions watch/);
    assert.match(output, /\[a\]\s+awaiting_reply/);
    assert.match(output, /recommended: Use the scoped version\./);
    assert.match(output, /send: mc sessions send sess_a/);
    assert.match(output, /awaiting_reply=1/);
  });

  test('extractRecommendedReply accepts Swedish and English labels', () => {
    assert.equal(
      extractRecommendedReply('Föreslaget svar: “Ja, kör.”'),
      'Ja, kör.',
    );
    assert.equal(
      extractRecommendedReply('Recommended reply: "Ship it."'),
      'Ship it.',
    );
  });
});
