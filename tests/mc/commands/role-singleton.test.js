/**
 * The singleton semantics, observed through a stubbed tmux (design note §6).
 * `mc pm` / `mc pm-helper` went dormant with decision mc-1; the machinery
 * they stood on stays until the wider surface cut, and is driven here
 * through its own entry rather than through a dispatch that no longer
 * routes to it:
 *
 *   running        → attach, never a second instance
 *   stopped        → restart: resume the newest conversation, on the model
 *                    its transcript records
 *   does not exist → create: home bootstrapped, a new conversation told
 *                    what it is, on the role's model
 *
 * Everything the subprocess might read is pinned to the fixture, so the
 * suite passes identically inside and outside an mc-managed shell.
 */
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runRoleSingletonCli } from '../_helpers/mc-cli.js';

const PM_MD = `---
name: pm
model: fable
singleton: true
tools: claude
---
You are the PM. Read state.md first.`;

const CONVERSATION_ID = '7c1e4b90-0000-4000-8000-000000000042';

function fixture({ withPmRole = true, tmuxRunning = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-singleton-'));
  const rolesDir = join(root, 'roles');
  mkdirSync(rolesDir);
  if (withPmRole) writeFileSync(join(rolesDir, 'pm.md'), PM_MD);

  const bin = join(root, 'bin');
  mkdirSync(bin);
  const log = join(root, 'tmux.log');
  writeFileSync(join(bin, 'tmux'), [
    '#!/bin/sh',
    `if [ "$1" = "has-session" ]; then exit ${tmuxRunning ? 0 : 1}; fi`,
    'if [ "$1" = "capture-pane" ]; then printf "❯\\n"; exit 0; fi',
    `printf '%s\\n' "$*" >> "${log}"`,
    'exit 0',
  ].join('\n'));
  chmodSync(join(bin, 'tmux'), 0o755);

  const workRoot = join(root, 'work');
  const claudeHome = join(root, 'claude');
  return {
    root,
    workRoot,
    claudeHome,
    log,
    env: {
      MC_HOME: join(root, 'home'),
      MC_WORK_ROOT: workRoot,
      MC_ROLES_DIR: rolesDir,
      CLAUDE_CONFIG_DIR: claudeHome,
      CODEX_HOME: join(root, 'codex'),
      MC_NO_PROMPT: '1',
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    },
  };
}

/** A recorded pm conversation in claude's own store, so restart can find it. */
function recordConversation(fx, entries) {
  const areaPath = join(fx.workRoot, 'pm');
  const projectDir = join(fx.claudeHome, 'projects', areaPath.replace(/[/.]/gu, '-'));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, `${CONVERSATION_ID}.jsonl`),
    `${entries.map((entry) => JSON.stringify({ cwd: areaPath, ...entry })).join('\n')}\n`,
  );
}

function newSessionLine(log) {
  const lines = readFileSync(log, 'utf8').split('\n');
  const found = lines.find((line) => line.startsWith('new-session'));
  assert.ok(found, `expected a tmux new-session call, got:\n${lines.join('\n')}`);
  return found;
}

describe('mc pm', () => {
  it('first start creates the home and a conversation told what it is', () => {
    const fx = fixture();
    const result = runRoleSingletonCli(['pm'], fx.env);
    assert.equal(result.status, 0, `stdout:${result.stdout}\nstderr:${result.stderr}`);
    const home = join(fx.workRoot, 'pm');
    assert.equal(readFileSync(join(home, '.mc-role'), 'utf8'), 'pm\n');
    for (const dir of ['inbox', 'queues', 'decisions', 'digests', 'handoff']) {
      assert.ok(existsSync(join(home, dir, 'README.md')), dir);
    }
    assert.ok(existsSync(join(home, 'state.md')));
    assert.ok(existsSync(join(home, '.git')));
    const line = newSessionLine(fx.log);
    assert.ok(line.includes(`'--model' 'fable'`), line);
    assert.ok(line.includes('You are the PM. Read state.md first.'), line);
    assert.match(result.stdout, /running as mc-pm/u);
  });

  it('the session it creates is dressed for a person to attach to', () => {
    // Asserted here as well as at the seam: `mc pm` is the session a person
    // attaches to most often, and it reaches tmux by its own path.
    const fx = fixture();
    assert.equal(runRoleSingletonCli(['pm'], fx.env).status, 0);
    const lines = readFileSync(fx.log, 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(lines.filter((line) => line.startsWith('set-option')), [
      'set-option -t mc-pm mouse on',
      'set-option -t mc-pm status off',
      'set-option -t mc-pm history-limit 50000',
    ]);
    // And it changed nothing outside the session it made.
    assert.deepEqual(lines.filter((line) => / -g\b/u.test(line)), []);
  });

  it('while it runs, a second mc pm goes to it — never a second instance', () => {
    const fx = fixture({ tmuxRunning: true });
    const result = runRoleSingletonCli(['pm'], fx.env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /joining the pm/u);
    assert.equal(existsSync(fx.log), false, 'nothing should have been started');
    assert.equal(existsSync(join(fx.workRoot, 'pm')), false, 'attach must not create anything');
  });

  it('stopped with a conversation on record restarts it, on its recorded model', () => {
    const fx = fixture();
    mkdirSync(join(fx.workRoot, 'pm'), { recursive: true });
    writeFileSync(join(fx.workRoot, 'pm', '.mc-role'), 'pm\n');
    recordConversation(fx, [
      { type: 'user', message: { content: 'boot' } },
      { type: 'assistant', message: { model: 'claude-fable-5', content: [] } },
    ]);
    const result = runRoleSingletonCli(['pm'], fx.env);
    assert.equal(result.status, 0, `stdout:${result.stdout}\nstderr:${result.stderr}`);
    const line = newSessionLine(fx.log);
    assert.ok(line.includes(`'--resume' '${CONVERSATION_ID}'`), line);
    assert.ok(line.includes(`'--model' 'claude-fable-5'`), line);
    assert.ok(!line.includes('You are the PM'), 'a resume is not re-told what it is');
    assert.match(result.stderr, /resuming 7c1e4b90/u);
  });

  it('an ordinary area wearing the name cannot become the pm', () => {
    const fx = fixture();
    mkdirSync(join(fx.workRoot, 'pm'), { recursive: true });
    const result = runRoleSingletonCli(['pm'], fx.env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot become the pm/u);
  });

  it('no definition, no pm — nothing half-made', () => {
    const fx = fixture({ withPmRole: false });
    const result = runRoleSingletonCli(['pm'], fx.env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no pm role is defined/u);
    assert.equal(existsSync(join(fx.workRoot, 'pm')), false);
  });

  it('--model against the running pm refuses rather than pretending', () => {
    const fx = fixture({ tmuxRunning: true });
    const result = runRoleSingletonCli(['pm', '--model', 'opus'], fx.env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot change model/u);
  });
});

describe('the role home on the status surfaces', () => {
  it('its filing directories are not worktrees', async () => {
    const fx = fixture();
    const created = runRoleSingletonCli(['pm'], fx.env);
    assert.equal(created.status, 0, created.stderr);
    const { inspectWorkArea } = await import('../../../src/mc/work-area.js');
    const area = inspectWorkArea('pm', { ...process.env, ...fx.env });
    assert.deepEqual(area.worktrees, []);
  });
});
