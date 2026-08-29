/**
 * `mc worker <name>` — a project folder born with the worker role.
 *
 * The launch is observed through a stubbed tmux (`--tmux` path), because
 * that is the one launch mode a test can watch without opening a real tool:
 * the recorded new-session command shows exactly what the conversation was
 * told and which model it was put on.
 *
 * The definition comes from `canon/roles/worker.md` in the package, the way
 * `mc plan` reads its own (decision mc-1), so a machine with no role
 * catalogue still gets the whole role. A catalogue that defines `worker`
 * still wins — it is the user's rulebook.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runMcCli } from '../_helpers/mc-cli.js';

const WORKER_MD = `---
name: worker
model: fable
singleton: false
tools: claude, codex
---
You are a worker. Escalate to the PM.`;

function fixture({ withWorkerRole = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-worker-'));
  const rolesDir = join(root, 'roles');
  mkdirSync(rolesDir);
  if (withWorkerRole) writeFileSync(join(rolesDir, 'worker.md'), WORKER_MD);

  // A tmux that says "not running" to has-session, shows a ready prompt to
  // capture-pane, and records everything else it is asked to run.
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const log = join(root, 'tmux.log');
  writeFileSync(join(bin, 'tmux'), [
    '#!/bin/sh',
    'if [ "$1" = "has-session" ]; then exit 1; fi',
    'if [ "$1" = "capture-pane" ]; then printf "❯\\n"; exit 0; fi',
    `printf '%s\\n' "$*" >> "${log}"`,
    'exit 0',
  ].join('\n'));
  chmodSync(join(bin, 'tmux'), 0o755);

  const workRoot = join(root, 'work');
  return {
    workRoot,
    log,
    env: {
      MC_HOME: join(root, 'home'),
      MC_WORK_ROOT: workRoot,
      MC_ROLES_DIR: rolesDir,
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CODEX_HOME: join(root, 'codex'),
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    },
  };
}

function newSessionLine(log) {
  const lines = readFileSync(log, 'utf8').split('\n');
  const found = lines.find((line) => line.startsWith('new-session'));
  assert.ok(found, `expected a tmux new-session call, got:\n${lines.join('\n')}`);
  return found;
}

describe('mc worker', () => {
  it('creates the area marked worker and starts on the role model with the overlay', () => {
    const { workRoot, log, env } = fixture();
    const result = runMcCli(['worker', 'w1', 'do the thing', '--tmux'], env);
    assert.equal(result.status, 0, `stdout:${result.stdout}\nstderr:${result.stderr}`);
    assert.equal(readFileSync(join(workRoot, 'w1', '.mc-role'), 'utf8'), 'worker\n');
    const line = newSessionLine(log);
    assert.ok(line.includes(`'--model' 'fable'`), line);
    assert.ok(line.includes('You are a worker. Escalate to the PM.'), line);
    assert.ok(line.includes(`'do the thing'`), line);
  });

  it('an explicit --model outranks the role default', () => {
    const { log, env } = fixture();
    const result = runMcCli(['worker', 'w2', 'task', '--tmux', '--model', 'opus'], env);
    assert.equal(result.status, 0, result.stderr);
    const line = newSessionLine(log);
    assert.ok(line.includes(`'--model' 'opus'`), line);
    assert.ok(!line.includes(`'fable'`), line);
  });

  it('an ordinary area cannot become a worker afterwards', () => {
    const { workRoot, env } = fixture();
    mkdirSync(join(workRoot, 'plain'), { recursive: true });
    const result = runMcCli(['worker', 'plain'], env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /a role is decided at creation/u);
  });

  it('an area carrying a role nothing defines still opens, and says the overlay is missing', () => {
    // The definition is a creation requirement, not an opening one: the
    // area exists and its work must stay reachable; openArea warns that the
    // overlay is not being delivered.
    const { workRoot, env } = fixture({ withWorkerRole: false });
    mkdirSync(join(workRoot, 'w5'), { recursive: true });
    writeFileSync(join(workRoot, 'w5', '.mc-role'), 'ghost\n');
    const result = runMcCli(['work', 'w5', '--tmux', 'task'], env);
    assert.equal(result.status, 0, `stdout:${result.stdout}\nstderr:${result.stderr}`);
    assert.match(result.stderr, /no definition was found/u);
    assert.match(result.stderr, /opening without the role overlay/u);
  });

  it('needs no role catalogue at all — the shipped definition is the worker', () => {
    const { workRoot, log, env } = fixture({ withWorkerRole: false });
    const result = runMcCli(['worker', 'w3', 'task', '--tmux'], env);
    assert.equal(result.status, 0, `stdout:${result.stdout}\nstderr:${result.stderr}`);
    assert.equal(readFileSync(join(workRoot, 'w3', '.mc-role'), 'utf8'), 'worker\n');
    assert.match(result.stdout, /role from .*canon\/roles\/worker\.md/u);
    assert.ok(newSessionLine(log).includes('You are a worker on one project.'));
    // The escalation the role now carries: a decision file, not a PM. The
    // overlay is several lines, so it is read off the whole recording.
    const recorded = readFileSync(log, 'utf8');
    assert.match(recorded, /\.\.\/decisions\/<project>-<date>\.md/u);
    assert.doesNotMatch(recorded, /escalate to the PM/iu);
  });
});
