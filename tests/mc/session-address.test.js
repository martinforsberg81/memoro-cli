/**
 * A session started outside mc's naming is found by where it stands
 * (D-0136 point 2). Nine sessions ran as `clean`, `ops`, `vocab`, … and
 * every wake to them reported "nothing is running" while they ran.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { installTmuxStub } from './_helpers/tmux-stub.js';
import { runMcCli } from './_helpers/mc-cli.js';
import { backgroundTarget, discoveredTarget } from '../../src/mc/work-open.js';
import { sendToArea } from '../../src/mc/work-send.js';

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

describe('a wake reaches a session started outside mc', () => {
  it('knocks on the pane found by its path, and says where it knocked', () => {
    // No mc-alpha; a session called `ops` stands in the area's worktree.
    const fx = fixture({ panesFor: (workRoot) => [{ session: 'ops', path: join(workRoot, 'alpha', 'memoro') }] });
    try {
      const sent = fx.send(['alpha', '--wake', 'read me']);
      assert.equal(sent.status, 0, sent.stderr);
      assert.match(sent.stdout, /woke alpha/u, sent.stdout);
      assert.ok(fx.tmux.keys().some((line) => line.startsWith('send-keys -t ops ')), fx.tmux.keys().join('\n'));
      assert.equal(fx.tmux.submitted().length, 1);
    } finally { fx.cleanup(); }
  });

  it('a tool with no pane at all is said as what it is, never as nothing running', () => {
    const fx = fixture();
    try {
      const result = sendToArea({
        name: 'alpha', message: 'read me', wake: true, env: fx.env,
        run: (args) => (args[0] === 'has-session' ? { status: 1 } : { status: 0, stdout: '' }),
        processes: () => [{ pid: 77, name: 'claude', directory: join(fx.workRoot, 'alpha') }],
      });
      assert.equal(result.reason, 'not-addressable');
      assert.equal(result.processes[0].pid, 77);
      assert.equal(result.woke, false);
      assert.equal(fx.messages().length, 1, 'the file is delivered either way');
    } finally { fx.cleanup(); }
  });

  it('and nothing running is still nothing running', () => {
    const fx = fixture();
    try {
      const sent = fx.send(['alpha', '--wake', 'read me']);
      assert.match(sent.stdout, /nothing is running in alpha — it reads its inbox when it starts/u);
    } finally { fx.cleanup(); }
  });
});
