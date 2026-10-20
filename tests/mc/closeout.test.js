/**
 * The closeout a finished project leaves in git (closeout.js): what it holds,
 * what it sums, and which session results it reads.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';

import {
  buildCloseout, closeoutPath, closeoutText, readSessionResults, sessionFileRe,
} from '../../src/mc/closeout.js';
import { RUNS_HEADER } from '../../src/mc/run-plan.js';

const row = (cells) => RUNS_HEADER.map((key) => cells[key] ?? '-').join('\t');
const RUNS = [
  RUNS_HEADER.join('\t'),
  row({ ts: '2026-10-01T09:00:00Z', name: 'ui-faults', kind: 'step', exit: '0', seconds: '100', pr: '10', turns: '20', input: '1000', output: '200', cache_read: '5000', cache_write: '300', session: 's1', note: 'success · open', land_seconds: '5', model: 'opus' }),
  row({ ts: '2026-10-01T11:00:00Z', name: 'ui-faults', kind: 'step', exit: '0', seconds: '50', pr: '10', turns: '8', input: '400', output: '100', cache_read: '2000', cache_write: '100', session: 's2', note: 'success · merged', land_seconds: '7', model: 'opus' }),
  row({ ts: '2026-10-01T11:30:00Z', name: 'ui-faults', kind: 'merge', exit: '0', seconds: '600', pr: '10', note: 'merged' }),
  row({ ts: '2026-10-01T12:00:00Z', name: 'ui-faults-2', kind: 'step', exit: '0', seconds: '999', pr: '10', session: 'other', note: 'success' }),
  row({ ts: '2026-10-02T09:00:00Z', name: 'ui-faults', kind: 'step', exit: '0', seconds: '30', pr: '11', turns: '4', input: '100', output: '50', cache_read: '700', cache_write: '20', session: 's3', note: 'success · merged', land_seconds: '3', model: 'sonnet' }),
  '',
].join('\n');

const PLAN = {
  goal: 'Faults on the page.',
  success_criteria: [{ criterion: 'It shows.', check: 'Look.', met: true }],
  steps: [
    { title: '1. First', done_when: 'One is done.' },
    { title: '2. Second', done_when: 'Two is done.' },
  ],
};

const ENTRY = {
  project: 'ui-faults', repo: 'memoro-cli', programme: 'mc', plan: 'docs/project/mc/ui-faults/PLAN.json',
  steps: [
    { status: 'done', pr: 10, attempts: 1, reason: null, comments: ['one'], landed: { sha: 'aaa', into: 'main', at: '2026-10-01T11:31:00Z' } },
    { status: 'done', pr: 11, attempts: 0, reason: null, comments: [], landed: { sha: 'bbb', into: 'main', at: '2026-10-02T09:10:00Z' } },
  ],
};

describe('the session results of one project', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-closeout-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'ui-faults-20261001T090000Z.json'), `${JSON.stringify({ session_id: 's1', total_cost_usd: 1.25 })}\n`);
  writeFileSync(join(dir, 'ui-faults-20261001T110000Z.json.gz'), gzipSync(`${JSON.stringify({ session_id: 's2', total_cost_usd: 0.5 })}\n`));
  writeFileSync(join(dir, 'ui-faults-2-20261001T120000Z.json'), `${JSON.stringify({ session_id: 'other', total_cost_usd: 99 })}\n`);
  writeFileSync(join(dir, 'ui-faults-20261001T130000Z.json'), 'not json');
  writeFileSync(join(dir, 'ui-faults-20261001T090000Z.jsonl'), '{}\n');

  it('reads plain and gzipped files of that project and nobody else', () => {
    const results = readSessionResults({ dir, project: 'ui-faults' });
    assert.deepEqual(results.map((r) => r.session_id).sort(), ['s1', 's2']);
    assert.equal(sessionFileRe('ui-faults').test('ui-faults-2-20261001T120000Z.json'), false);
    assert.equal(sessionFileRe('ui-faults-2').test('ui-faults-2-20261001T120000Z.json'), true);
  });

  it('sums per step, and a session with no result is unknown, not estimated', () => {
    const sessions = readSessionResults({ dir, project: 'ui-faults' });
    const closeout = buildCloseout({ plan: PLAN, entry: ENTRY, runs: RUNS, sessions, archivedAt: '2026-10-03' });
    assert.equal(closeout.schema, 'mc-closeout');
    assert.equal(closeout.version, 1);
    assert.equal(closeout.archived, '2026-10-03');
    assert.equal(closeout.goal, 'Faults on the page.');
    assert.equal('plan' in closeout, false);
    assert.deepEqual(closeout.sessions.map((s) => s.session), ['s1', 's2', 's3'], 'merge rows and other projects are not its sessions');
    assert.deepEqual(closeout.sessions.map((s) => s.cost_usd), [1.25, 0.5, null]);

    const [one, two] = closeout.steps;
    assert.deepEqual({ sessions: one.sessions, seconds: one.seconds, cost_usd: one.cost_usd }, { sessions: 2, seconds: 150, cost_usd: 1.75 });
    assert.deepEqual({ sessions: two.sessions, seconds: two.seconds, cost_usd: two.cost_usd }, { sessions: 1, seconds: 30, cost_usd: null });
    assert.deepEqual(one.landed, { sha: 'aaa', into: 'main', at: '2026-10-01T11:31:00Z' });
    assert.equal(one.title, '1. First');
    assert.equal(two.done_when, 'Two is done.');

    assert.deepEqual(closeout.totals, {
      sessions: 3, seconds: 180, land_seconds: 15, cost_usd: 1.75, cost_unknown: 1,
      input: 1500, output: 350, cache_read: 7700, cache_write: 420,
      first: '2026-10-01T09:00:00Z', landed: '2026-10-02T09:10:00Z',
    });
  });
});

describe('the file', () => {
  it('lives beside its programme', () => {
    assert.equal(closeoutPath('mc', 'retention'), 'docs/project/mc/closeout/retention.json');
  });

  it('is exactly this text for a small case', () => {
    const runs = [RUNS_HEADER.join('\t'),
      row({ ts: '2026-10-01T09:00:00Z', name: 'p', kind: 'step', exit: '0', seconds: '10', pr: '5', turns: '1', input: '1', output: '2', cache_read: '3', cache_write: '4', session: 'x', note: 'success', land_seconds: '1', model: 'opus' })].join('\n');
    const closeout = buildCloseout({
      plan: { goal: 'G.', success_criteria: [], steps: [{ title: '1. Only', done_when: 'Done.' }] },
      entry: { project: 'p', repo: 'memoro-cli', programme: 'mc', plan: 'docs/project/mc/p/PLAN.json', steps: [{ status: 'done', pr: 5, attempts: 0, reason: null, comments: [], landed: { sha: 'abc', into: 'main', at: '2026-10-01T10:00:00Z' } }] },
      runs,
      sessions: [{ session_id: 'x', total_cost_usd: 0.1 }],
      archivedAt: new Date('2026-10-02T08:00:00Z'),
    });
    assert.equal(closeoutText(closeout), `{
  "schema": "mc-closeout",
  "version": 1,
  "project": "p",
  "programme": "mc",
  "repo": "memoro-cli",
  "plan_path": "docs/project/mc/p/PLAN.json",
  "archived": "2026-10-02",
  "goal": "G.",
  "success_criteria": [],
  "steps": [
    {
      "title": "1. Only",
      "done_when": "Done.",
      "status": "done",
      "pr": 5,
      "landed": {
        "sha": "abc",
        "into": "main",
        "at": "2026-10-01T10:00:00Z"
      },
      "attempts": 0,
      "reason": null,
      "comments": [],
      "sessions": 1,
      "seconds": 10,
      "cost_usd": 0.1
    }
  ],
  "sessions": [
    {
      "ts": "2026-10-01T09:00:00Z",
      "kind": "step",
      "seconds": 10,
      "land_seconds": 1,
      "pr": 5,
      "turns": 1,
      "input": 1,
      "output": 2,
      "cache_read": 3,
      "cache_write": 4,
      "model": "opus",
      "note": "success",
      "session": "x",
      "cost_usd": 0.1
    }
  ],
  "totals": {
    "sessions": 1,
    "seconds": 10,
    "land_seconds": 1,
    "cost_usd": 0.1,
    "cost_unknown": 0,
    "input": 1,
    "output": 2,
    "cache_read": 3,
    "cache_write": 4,
    "first": "2026-10-01T09:00:00Z",
    "landed": "2026-10-01T10:00:00Z"
  }
}
`);
  });

  it('says plan: null when the plan could not be had', () => {
    const closeout = buildCloseout({ plan: null, entry: ENTRY, runs: '', archivedAt: '2026-10-03' });
    assert.equal(closeout.plan, null);
    assert.equal(closeout.goal, null);
    assert.equal(closeout.success_criteria, null);
    assert.deepEqual(closeout.steps.map((s) => s.title), [null, null]);
    assert.equal(closeout.steps[0].pr, 10);
  });
});
