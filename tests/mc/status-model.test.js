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

describe('the suite row beside a living holder', () => {
  it('says the holder is alive instead of "nothing running"', () => {
    const page = report(null);
    page.suite = {
      lease: { held: true, holder: 'pm', errand: 'gate round', age_ms: 20 * 60000, owner_pid: 42074, owner_alive: true, orphaned: false },
      running: [],
    };
    const lines = renderLines(page, { columns: 140, now: 61000 });
    // Asserted on the head of the sentence: the row is clipped to the
    // terminal like every other, and the tail may fall off at 140 columns.
    assert.ok(lines.some((line) => /no suite visible, but the holder's process \(pid 42074\) is alive/u.test(line)), lines.join('\n'));
    assert.ok(!lines.some((line) => line.includes('nothing running')), 'the misreading stayed on the board');
  });
});

describe('a stop on purpose on the status page (KP-09)', () => {
  const stopped = { at: new Date(60000).toISOString(), by: 'pm' };
  it('says who stopped the area and when, while nothing runs there', () => {
    const page = report(null);
    page.areas[0].stopped = stopped;
    page.areas[0].conversations[0].live = false;
    page.areas[0].conversations[0].state = 'idle';
    const lines = renderLines(page, { columns: 120, now: 20 * 60000 });
    assert.ok(lines.some((line) => /■ stopped by pm \d\d:\d\d \(19m\) — mc work api picks it up/u.test(line)), lines.join('\n'));
  });

  it('says nothing about a mark under a running conversation — that mark is stale', () => {
    const page = report(null);
    page.areas[0].stopped = stopped;
    page.areas[0].conversations[0].live = true;
    const lines = renderLines(page, { columns: 120, now: 20 * 60000 });
    assert.ok(!lines.some((line) => line.includes('stopped by')), lines.join('\n'));
  });
});

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

describe('a worktree without its dependency tree says so on the page (D-0152)', () => {
  const withTree = (dependencies) => {
    const page = report('claude-fable-5');
    page.areas[0].worktrees = [{
      repo: 'memoro', path: '/x/api/memoro', branch: 'fix', is_git: true, git_common_dir: '/r/.git',
      uncommitted: 0, unmerged_commits: 1, dependencies,
    }];
    return renderLines(page, { columns: 120, now: 61000 }).join('\n');
  };
  it('names it beside the branch', () => {
    assert.match(withTree('missing'), /memoro  fix  1 unmerged  no node_modules/u);
  });
  it('and says nothing when the tree is there, or the question does not arise', () => {
    assert.doesNotMatch(withTree('present'), /node_modules/u);
    assert.doesNotMatch(withTree(null), /node_modules/u);
  });
});

describe('the suite row on the page (D-0141, D-0155)', () => {
  const withSuite = (suite) => {
    const page = report('claude-fable-5');
    page.suite = suite;
    return renderLines(page, { columns: 140, now: 10 * 60000 }).join('\n');
  };
  it('says free and nothing running', () => {
    assert.match(withSuite({ lease: { held: false }, running: [] }), /suite {2}free {2}· {2}nothing running/u);
  });
  it('says who holds it and what runs, for how long', () => {
    const page = withSuite({
      lease: { held: true, holder: 'msr-cleanup', errand: 'contract on #10820', age_ms: 7 * 60000, since: null },
      running: [{ pid: 4242, area: 'msr-cleanup', directory: '/x', elapsed: '07:12', command: 'npm run test:msr:contract' }],
    });
    assert.match(page, /suite {2}msr-cleanup “contract on #10820” held for 7m {2}· {2}running in msr-cleanup for 7m \(pid 4242\)/u);
  });
  it('says nothing when the report has no suite field', () => {
    assert.doesNotMatch(withSuite(undefined), /suite/u);
  });
});
