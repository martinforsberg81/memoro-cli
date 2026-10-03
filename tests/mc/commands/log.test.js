/**
 * `mc log` prints what else a run logged — the one-line view marks it, and
 * `mc log <run>` lists it with its fields.
 *
 * The case that asked for it: `dev-server-lifecycle` needed `mc log` to show
 * `dev-server-stopped` with `reason: worktree-removed`, and the event was in
 * the file but in no form of the command's output.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { run } from '../../../src/mc/commands/log.js';
import { setLogPath } from '../../../src/mc/logger.js';

const RUN = 'run_f0b0cce9ef1a';
const EVENTS = [
  { at: '2026-09-26T09:46:57.479Z', pid: 22115, run: RUN, event: 'mc.start', verb: 'work', sub: 'remove', args: ['dsl-verify', 'memoro'], flags: [], argc: 4, holder: 'dev-server-lifecycle' },
  { at: '2026-09-26T09:47:00.129Z', pid: 22115, run: RUN, event: 'dev-server-stopped', instance_id: 'static-629e8750', service: 'memoro-static', worktree_path: '/w/dsl-verify/memoro', reason: 'worktree-removed', ok: true },
  { at: '2026-09-26T09:47:03.037Z', pid: 22115, run: RUN, event: 'mc.end', verb: 'work', exit_code: 0, duration_ms: 5558, threw: false },
  { at: '2026-09-26T09:50:00.000Z', pid: 22300, run: 'run_quiet', event: 'mc.start', verb: 'brief', args: [], flags: [] },
  { at: '2026-09-26T09:50:01.000Z', pid: 22300, run: 'run_quiet', event: 'mc.end', verb: 'brief', exit_code: 0, duration_ms: 1000, threw: false },
];

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mc-log-cmd-'));
  mkdirSync(join(root, 'logs'), { recursive: true });
});

afterEach(() => {
  setLogPath(null);
  rmSync(root, { recursive: true, force: true });
});

function write(events) {
  writeFileSync(join(root, 'logs', 'mc.log'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  setLogPath(join(root, 'logs', 'mc.log'));
}

async function mcLog(argv) {
  let out = '';
  const stdout = { isTTY: false, write: (text) => { out += text; } };
  const stderr = { write: () => {} };
  const code = await run(argv, { stdout, stderr, root, alive: () => false, self: null });
  return { code, out };
}

describe('mc log shows the events a command logged', () => {
  it('mc log <run> lists each one by name, with its fields', async () => {
    write(EVENTS);
    const { code, out } = await mcLog([RUN]);
    assert.equal(code, 0);
    assert.match(out, /^ {2}logged$/mu);
    assert.match(out, /dev-server-stopped {2}instance_id=static-629e8750 {2}service=memoro-static {2}worktree_path=\/w\/dsl-verify\/memoro {2}reason=worktree-removed {2}ok=true/u);
  });

  it('mc log <run> --json carries them as data', async () => {
    write(EVENTS);
    const { out } = await mcLog([RUN, '--json']);
    const story = JSON.parse(out);
    assert.equal(story.logged.length, 1);
    assert.equal(story.logged[0].event, 'dev-server-stopped');
    assert.equal(story.logged[0].fields.reason, 'worktree-removed');
  });

  it('the one-line view marks the run that logged one, and only that run', async () => {
    write(EVENTS);
    const { out } = await mcLog(['--all', '--limit', '5']);
    const [work, brief] = out.trimEnd().split('\n');
    assert.match(work, /work remove dsl-verify memoro/u);
    assert.match(work, /\+ dev-server-stopped$/u);
    assert.doesNotMatch(brief, /\+/u);
  });

  it('repeats are counted, and past three names the rest are a number', async () => {
    write([
      EVENTS[0],
      ...['a', 'a', 'b', 'c', 'd', 'e'].map((name, i) => ({ at: `2026-09-26T09:47:0${i}.000Z`, pid: 22115, run: RUN, event: `x.${name}` })),
      EVENTS[2],
    ]);
    const { out } = await mcLog([]);
    assert.match(out, /\+ x\.a ×2, x\.b, x\.c and 2 more$/mu);
  });
});
