/**
 * The foreground register: the file a verb writes while it holds the
 * terminal, and what the page makes of it.
 *
 * Every test writes into a throwaway work root through MC_WORK_ROOT, so the
 * register under the user's own ~/mc is never touched. The last one goes the
 * whole way round — register, then read the directory back with the page's
 * own reader — because the two halves agreeing is the only thing that makes
 * NOW true.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { foregroundDir, registerForeground } from '../../src/mc/foreground.js';
import { readForeground, sessionsSection } from '../../src/mc/page-collect.js';

function root() {
  return mkdtempSync(join(tmpdir(), 'mc-foreground-'));
}

const NOW = new Date('2026-08-29T12:00:00Z');

describe('the foreground register', () => {
  it('writes <pid>.json with the verb, the area, the tool and the model, and removes it on release', () => {
    const env = { MC_WORK_ROOT: root() };
    const release = registerForeground({
      verb: 'brief', area: null, tool: 'claude', model: 'opus', env, pid: 4711, now: () => NOW,
      onExit: () => {},
    });
    const path = join(foregroundDir(env), '4711.json');
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
      verb: 'brief', area: null, tool: 'claude', model: 'opus', pid: 4711,
      started: '2026-08-29T12:00:00Z',
    });
    release();
    assert.equal(existsSync(path), false);
  });

  it('releases once, however many times it is asked', () => {
    const env = { MC_WORK_ROOT: root() };
    const removed = [];
    const release = registerForeground({
      verb: 'plan', area: 'mc-ui', env, pid: 4712, onExit: () => {},
      remove: (path) => removed.push(path),
    });
    release();
    release();
    assert.equal(removed.length, 1);
  });

  it('registers nothing without a verb — the caller that says nothing writes nothing', () => {
    const env = { MC_WORK_ROOT: root() };
    registerForeground({ verb: null, env, pid: 4713, onExit: () => {} })();
    assert.equal(existsSync(foregroundDir(env)), false);
  });

  it('hands back a no-op when the register cannot be written', () => {
    const env = { MC_WORK_ROOT: root() };
    const release = registerForeground({
      verb: 'brief', env, pid: 4714, onExit: () => {},
      write: () => { throw new Error('read-only'); },
      remove: () => assert.fail('nothing was written, so nothing may be removed'),
    });
    release();
  });

  it('sweeps the files of processes that are gone and keeps the ones that are not', () => {
    const env = { MC_WORK_ROOT: root() };
    const dir = foregroundDir(env);
    mkdirSync(dir, { recursive: true });
    for (const name of ['100.json', '200.json', '300.json', 'notes.md']) {
      writeFileSync(join(dir, name), '{}\n');
    }
    registerForeground({
      verb: 'work', area: 'mc-ui', env, pid: 300, onExit: () => {},
      alive: (pid) => Number(pid) === 200,
    });
    assert.equal(existsSync(join(dir, '100.json')), false, 'a dead pid goes');
    assert.equal(existsSync(join(dir, '200.json')), true, 'a live pid stays');
    assert.equal(existsSync(join(dir, '300.json')), true, 'our own file is the one we just wrote');
    assert.equal(existsSync(join(dir, 'notes.md')), true, 'a file that is not a pid is not ours to delete');
  });

  it('round trip: a registered verb is what the page names, and is gone after release', () => {
    const env = { MC_WORK_ROOT: root() };
    const release = registerForeground({
      verb: 'brief', area: null, tool: 'claude', model: 'opus', env, onExit: () => {},
    });
    const dir = foregroundDir(env);
    const sessions = sessionsSection({ foreground: readForeground(dir), now: NOW });
    // `brief` is one of the two desks, so it is the slot rather than the list.
    assert.equal(sessions.desks.brief.pid, process.pid);
    release();
    assert.deepEqual(readForeground(dir), []);
  });
});
