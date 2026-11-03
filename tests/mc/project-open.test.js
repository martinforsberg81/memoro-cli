/**
 * A project's number at the page opens a session in the project's runner
 * area, as a session of its programme — never a workarea of its own
 * (goal mc/no-work). Every door is handed in: no tool starts, no git runs.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { PROJECT_VERB, openProject } from '../../src/mc/project-open.js';

const root = mkdtempSync(join(tmpdir(), 'mc-project-open-'));
const env = { MC_WORK_ROOT: root };

function sink() {
  const out = { text: '', write(chunk) { out.text += chunk; } };
  return out;
}

const area = (over = {}) => ({
  name: 'step/ui', path: join(root, 'step', 'ui'), exists: true,
  worktrees: [{ repo: 'memoro-cli', path: join(root, 'step', 'ui', 'memoro-cli'), is_git: true, branch: 'ui' }],
  conversations: [{ id: 'c0ffee00-0000-0000-0000-000000000000', tool: 'claude-code', updated_ms: 0, bytes: 10 }],
  ...over,
});

describe('openProject', () => {
  it('opens the runner area as a session of the programme, registered under its own verb', async () => {
    const calls = [];
    const stderr = sink();
    const code = await openProject('ui', {
      programme: 'mc', env, stdout: sink(), stderr,
      inspect: (name) => { calls.push(['inspect', name]); return area(); },
      occupants: () => [],
      ask: () => false,
      open: async (args) => { calls.push(['open', args]); return { ok: true, code: 0 }; },
    });
    assert.equal(code, 0);
    assert.deepEqual(calls[0], ['inspect', 'step/ui']);
    const [, args] = calls[1];
    assert.equal(args.verb, PROJECT_VERB);
    assert.equal(args.programme, 'mc');
    assert.equal(args.areaName, 'step/ui');
    assert.equal(args.worktree.path, join(root, 'step', 'ui', 'memoro-cli'));
    assert.match(stderr.text, /memoro-cli — programme mc/u);
  });

  it('makes nothing for a project the runner has not started, and says so', async () => {
    let opened = false;
    const stderr = sink();
    const code = await openProject('fresh', {
      programme: 'mc', env, stdout: sink(), stderr,
      inspect: () => area({ name: 'step/fresh', path: join(root, 'step', 'fresh'), exists: false, worktrees: [], conversations: [] }),
      occupants: () => [],
      open: async () => { opened = true; return { ok: true }; },
    });
    assert.equal(code, 1);
    assert.equal(opened, false);
    assert.match(stderr.text, /fresh has no runner area yet — the runner makes .*step\/fresh when it starts the project's first step/u);
  });

  it('refuses a workplace a tool already stands in, and names it', async () => {
    let opened = false;
    const stderr = sink();
    const code = await openProject('ui', {
      programme: 'mc', env, stdout: sink(), stderr,
      inspect: () => area(),
      occupants: () => [{ name: 'claude', pid: 4242, directory: join(root, 'step', 'ui', 'memoro-cli') }],
      ask: () => false,
      open: async () => { opened = true; return { ok: true }; },
    });
    assert.equal(code, 1);
    assert.equal(opened, false);
    assert.match(stderr.text, /ui is occupied — claude \(pid 4242\) is working in/u);
  });

  it('says why a launch failed', async () => {
    const stderr = sink();
    const code = await openProject('ui', {
      env, stdout: sink(), stderr, inspect: () => area(), occupants: () => [], ask: () => false,
      open: async () => ({ ok: false, reason: 'tool-unavailable', hint: 'install claude' }),
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /could not open ui \(tool-unavailable\)\nmc: install claude/u);
  });
});
