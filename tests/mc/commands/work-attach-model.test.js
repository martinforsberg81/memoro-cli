/**
 * `--model` against a piece of work that is already running.
 *
 * A live conversation cannot change model, and quietly attaching would leave
 * the user believing it did — the whole session's output would come from the
 * wrong model with nothing saying so. So mc refuses and says what to do
 * instead, rather than honouring half the command.
 *
 * tmux is stubbed: a `tmux` on PATH whose `has-session` succeeds is
 * indistinguishable from a running background session, which is the point —
 * the refusal must fire before anything real is attached.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// `mc work` lives on the `mc` binary (src/mc-cli.js), not on bin-mc.js that
// the shared runMc helper spawns.
const MC_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'mc-cli.js');

function runWork(args, env) {
  return spawnSync(process.execPath, [MC_CLI, 'work', ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, MC_TEST_MODE: '1', MEMORO_API_URL: 'http://127.0.0.1:1', ...env },
  });
}

function fixture({ running }) {
  const root = mkdtempSync(join(tmpdir(), 'mc-work-attach-'));
  const workRoot = join(root, 'mc');
  mkdirSync(join(workRoot, 'foo'), { recursive: true });
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const tmux = join(bin, 'tmux');
  writeFileSync(tmux, `#!/bin/sh\nexit ${running ? 0 : 1}\n`);
  chmodSync(tmux, 0o755);
  return {
    env: {
      // Everything the subprocess might read is pinned to the fixture, so the
      // test passes identically inside and outside an mc-managed shell.
      MC_HOME: join(root, 'mc-home'),
      MC_WORK_ROOT: workRoot,
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      CLAUDE_CONFIG_DIR: join(root, 'claude-home'),
      CODEX_HOME: join(root, 'codex-home'),
    },
  };
}

describe('mc work --model against a running background session', () => {
  it('refuses instead of silently attaching on the old model', () => {
    const { env } = fixture({ running: true });
    const result = runWork(['foo', '--model', 'opus'], env);
    assert.equal(result.status, 1, `stdout:${result.stdout}\nstderr:${result.stderr}`);
    assert.match(result.stderr, /cannot change model/u);
    assert.match(result.stderr, /mc work stop foo/u);
  });
});
