/**
 * A session started outside mc's naming is found by where it stands
 * (D-0136 point 2). Nine sessions ran as `clean`, `ops`, `vocab`, … and
 * every wake to them reported "nothing is running" while they ran.
 *
 * The wake is gone with the inbox channel it knocked for; what it exposed is
 * not. `backgroundTarget` is how `mc work` and `mc work stop` find a session
 * somebody started outside mc, and it is asserted here on its own.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { installTmuxStub } from './_helpers/tmux-stub.js';
import { runMcCli } from './_helpers/mc-cli.js';
import { backgroundTarget, discoveredTarget } from '../../src/mc/work-open.js';

const SAFE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

describe('backgroundTarget finds a session by where it stands', () => {
  const env = { MC_WORK_ROOT: '/w' };
  const tmux = (panes, alive = false) => (args) => {
    if (args[0] === 'has-session') return { status: alive ? 0 : 1 };
    if (args[0] === 'list-panes') return { status: 0, stdout: panes.map((p) => p.join('\t')).join('\n') + '\n' };
    return { status: 1 };
  };

  it('mc-<name> first, whatever the panes say', () => {
    assert.equal(backgroundTarget('alpha', { run: tmux([['ops', '%3', '1', '1', '1', '/w/alpha']], true), env }), 'mc-alpha');
  });

  it('a pane standing in the area or under it is the address — the session name when it is alone', () => {
    assert.equal(backgroundTarget('alpha', { run: tmux([['ops', '%3', '1', '1', '1', '/w/alpha/memoro']]), env }), 'ops');
    assert.equal(discoveredTarget('alpha', { tmux: tmux([['ops', '%3', '1', '1', '1', '/w/alpha']]), env }), 'ops');
  });

  it('a pane among several is addressed by its id, so the knock lands in that one', () => {
    assert.equal(backgroundTarget('alpha', { run: tmux([['ops', '%7', '0', '2', '3', '/w/alpha/memoro']]), env }), '%7');
  });

  it('a pane in a neighbouring area is not this one, and none at all is null', () => {
    assert.equal(backgroundTarget('alpha', { run: tmux([['ops', '%3', '1', '1', '1', '/w/alphabet']]), env }), null);
    assert.equal(backgroundTarget('alpha', { run: tmux([]), env }), null);
    assert.equal(backgroundTarget('alpha', { run: () => ({ status: 1 }), env }), null);
  });
});

function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-session-address-'));
  const workRoot = join(root, 'work');
  const mcHome = join(root, 'home');
  mkdirSync(join(workRoot, 'alpha'), { recursive: true });
  mkdirSync(mcHome, { recursive: true, mode: 0o700 });
  const tmux = installTmuxStub(root, { ...options, panes: options.panesFor ? options.panesFor(workRoot) : options.panes || [] });
  const env = {
    MC_HOME: mcHome, MC_WORK_ROOT: workRoot, CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'),
    PATH: `${tmux.bin}:${SAFE_PATH}`,
  };
  return {
    root, workRoot, tmux, env,
    send: (args) => runMcCli(['work', 'send', ...args], env, { cwd: join(workRoot, 'alpha') }),
    messages: () => (existsSync(join(workRoot, 'alpha', 'inbox')) ? readdirSync(join(workRoot, 'alpha', 'inbox')) : []),
    cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } },
  };
}
