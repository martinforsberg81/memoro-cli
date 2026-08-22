/**
 * The model on the status page: visible per conversation, and invisible to
 * the change-detector.
 *
 * `signature()` wakes whoever is watching when something worth waking for
 * happens. A conversation's model is not that — it changes at most on a
 * relaunch, which already moves the state — so it must stay out of the
 * signature, or a `--wait` would fire on nothing.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderLines, width } from '../../src/mc/status-render.js';
import { signature } from '../../src/mc/work-status.js';

function report(model) {
  return {
    areas: [{
      name: 'api',
      path: '/x/api',
      running: [],
      worktrees: [],
      conversations: [{
        id: '3f9d2c81-0000-4000-8000-000000000001',
        tool: 'claude-code',
        model,
        said: 'done',
        state: 'waiting',
        updated_ms: 1000,
        bytes: 2048,
      }],
      waiting: true,
      working: false,
    }],
    summary: { areas: 1, waiting: 1, working: 0 },
  };
}

describe('model on the status page', () => {
  it('shows up beside the tool when the transcript names one', () => {
    const lines = renderLines(report('claude-fable-5'), { columns: 100, now: 61000 });
    assert.ok(lines.some((line) => line.includes('claude · claude-fable-5 · 1m · 2 kB')), lines.join('\n'));
  });

  it('leaves the row exactly as it was when there is none', () => {
    const lines = renderLines(report(null), { columns: 100, now: 61000 });
    assert.ok(lines.some((line) => line.includes('claude · 1m · 2 kB')), lines.join('\n'));
  });

  it('never wakes a watcher: the signature ignores the model', () => {
    assert.equal(signature(report('claude-fable-5')), signature(report(null)));
  });

  it('a long model name is clipped like every other row, never wrapped', () => {
    const lines = renderLines(report('us.anthropic.claude-fable-5-20251101-v1:0-with-a-very-long-suffix'), {
      columns: 80, now: 61000,
    });
    for (const line of lines) {
      assert.ok(width(line) <= 80, `line wider than the terminal: "${line}"`);
    }
    assert.ok(lines.some((line) => line.includes('…')), 'expected the meta row to be clipped');
  });
});
describe('a clock a session set for itself is on the page (D-0155)', () => {
  const withClock = (wakeup, now) => {
    const page = report('claude-fable-5');
    page.areas[0].conversations[0].wakeup = wakeup;
    return renderLines(page, { columns: 120, now }).join('\n');
  };
  it('names what it will run and when', () => {
    const page = withClock({ prompt: 'npm run test:msr:contract', due_at: '2026-08-22T12:10:00.000Z' }, Date.parse('2026-08-22T12:01:00Z'));
    assert.match(page, /⏰ wakeup in 9m: npm run test:msr:contract/u);
  });
  it('an overdue one is still shown — the session may be gone, the clock was set', () => {
    assert.match(withClock({ prompt: 'poll CI', due_at: '2026-08-22T12:00:00.000Z' }, Date.parse('2026-08-22T12:05:00Z')), /⏰ wakeup overdue 5m: poll CI/u);
  });
  it('and nothing is said when none is set', () => {
    assert.doesNotMatch(withClock(null, 1000), /wakeup/u);
  });
});
