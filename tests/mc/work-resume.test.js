/**
 * Resuming a named conversation in the background (`--resume <id>`).
 *
 * The bug this replaces cost this system a conversation: `mc work <name>
 * --tmux <id>` started a *new* conversation and passed the id in as its
 * opening words. It looked like it had worked. The PM that wrote the order for
 * this fix exists because its predecessor could not be resumed.
 *
 * The mechanism was never missing — `startInBackground` has taken a
 * `conversation` since the singleton roles needed it, which is why `mc pm`
 * resumes fine. Two things kept an id from reaching it: with `--tmux` the whole
 * rest of the line was read as the task, and the background call never passed
 * `conversation` at all.
 *
 * The id is named by a flag rather than recognised in a positional, because
 * "does this look like an id?" is a heuristic, and a short task shaped like an
 * id would be misread in silence. Silent misreadings are the class of failure
 * this whole area has been spent removing.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { installTmuxStub } from './_helpers/tmux-stub.js';
import { runMcCli } from './_helpers/mc-cli.js';
import { parseArgs } from '../../src/mc/commands/work.js';
import { startInBackground } from '../../src/mc/work-open.js';

const ID = '3f9d2c81-0000-4000-8000-000000000001';

/** A work area holding one real Claude transcript. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mc-work-resume-'));
  const areaRoot = join(root, 'area');
  const claudeHome = join(root, 'claude-home');
  mkdirSync(areaRoot, { recursive: true });
  mkdirSync(join(root, 'codex-home'), { recursive: true });
  const dir = join(claudeHome, 'projects', areaRoot.replace(/[/.]/gu, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${ID}.jsonl`),
    `${JSON.stringify({ cwd: areaRoot, type: 'user', message: { role: 'user', content: 'hello' } })}\n`,
  );
  return {
    areaRoot,
    worktree: { repo: null, path: areaRoot, is_git: false },
    env: { ...process.env, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: join(root, 'codex-home') },
    cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } },
  };
}

/** A work root with one area in it, and a tmux that records everything. */
function cliFixture() {
  const root = mkdtempSync(join(tmpdir(), 'mc-work-resume-cli-'));
  const workRoot = join(root, 'work');
  const mcHome = join(root, 'home');
  mkdirSync(join(workRoot, 'alpha'), { recursive: true });
  mkdirSync(mcHome, { recursive: true, mode: 0o700 });
  const tmux = installTmuxStub(root, {});
  return {
    root,
    tmux,
    env: {
      MC_HOME: mcHome,
      MC_WORK_ROOT: workRoot,
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CODEX_HOME: join(root, 'codex'),
      PATH: `${tmux.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    },
    cleanup() { try { rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } },
  };
}

/** Start it in the background and hand back the command tmux was given. */
function start(fx, options) {
  const calls = [];
  const result = startInBackground({
    name: 'probe',
    areaRoot: fx.areaRoot,
    worktree: fx.worktree,
    tool: 'claude',
    env: fx.env,
    run: (args) => { calls.push(args); return args[0] === 'has-session' ? { status: 1 } : { status: 0 }; },
    loadProfile: () => 'PROFILE',
    ...options,
  });
  const created = calls.find((args) => args[0] === 'new-session');
  return { result, calls, launch: created ? created[created.length - 1] : '' };
}

describe('the grammar: an id is named, never recognised', () => {
  it('--resume names the conversation with --tmux, and a task stays a task', () => {
    assert.deepEqual(
      pick(parseArgs(['area', '--tmux', '--resume', 'abc123'])),
      { pick: 'abc123', task: null },
    );
    assert.deepEqual(
      pick(parseArgs(['area', '--tmux', '--resume', 'abc123', 'do the thing'])),
      { pick: 'abc123', task: 'do the thing' },
    );
  });

  it('--tmux without --resume still reads the rest of the line as the task', () => {
    // The behaviour everything else depends on, pinned so this fix cannot
    // quietly change the grammar for everybody who never asked to resume.
    assert.deepEqual(
      pick(parseArgs(['area', '--tmux', 'do the thing'])),
      { pick: null, task: 'do the thing' },
    );
    // Including a task that happens to look like an id — which is exactly why
    // the id is not read out of the positional.
    assert.deepEqual(pick(parseArgs(['area', '--tmux', 'abc123'])), { pick: null, task: 'abc123' });
  });

  it('--resume works without --tmux too, alongside the positional form', () => {
    assert.deepEqual(pick(parseArgs(['area', 'abc123'])), { pick: 'abc123', task: null });
    assert.deepEqual(pick(parseArgs(['area', '--resume', 'abc123'])), { pick: 'abc123', task: null });
  });

  it('--resume without a value is an error rather than a silent nothing', () => {
    assert.match(parseArgs(['area', '--tmux', '--resume']).error, /--resume needs a value/u);
  });

  const pick = (opts) => ({ pick: opts.pick, task: opts.task });
});

describe('what the background actually launches', () => {
  it('resumes the named conversation instead of starting a new one', () => {
    const fx = fixture();
    try {
      const { result, launch } = start(fx, { conversation: { id: ID, model: null } });
      assert.equal(result.ok, true);
      assert.match(launch, /--resume/u);
      assert.match(launch, new RegExp(ID, 'u'));
      // A resumed conversation already carries the profile in its own history.
      assert.doesNotMatch(launch, /--append-system-prompt/u);
    } finally { fx.cleanup(); }
  });

  it('a task given with a resume reaches that conversation', () => {
    const fx = fixture();
    try {
      const { launch } = start(fx, { conversation: { id: ID, model: null }, task: 'do the thing' });
      assert.match(launch, /--resume/u);
      assert.match(launch, /do the thing/u);
    } finally { fx.cleanup(); }
  });

  it('without a conversation it starts a new one, exactly as before', () => {
    const fx = fixture();
    try {
      const { launch } = start(fx, { task: 'do the thing' });
      assert.doesNotMatch(launch, /--resume/u);
      assert.match(launch, /--append-system-prompt/u);
      assert.match(launch, /do the thing/u);
    } finally { fx.cleanup(); }
  });
});

/**
 * The worst property of the old bug: it looked like it had worked.
 *
 * An id matching nothing became a brand new conversation with the id as its
 * opening words, and the only way to notice was to read the transcript
 * afterwards. Asserted at the command line, because the check has to happen in
 * the verb — before anything is started, and before tmux is touched at all.
 */
describe('an id that matches nothing is an error, not a new conversation', () => {
  it('refuses before starting anything, and says where to look', () => {
    const fx = cliFixture();
    try {
      const asked = runMcCli(['work', 'alpha', '--tmux', '--resume', 'deadbeef'], fx.env);
      assert.equal(asked.status, 1, asked.stdout);
      assert.match(asked.stderr, /no conversation in alpha starts with deadbeef/u);
      assert.match(asked.stderr, /mc work alpha lists what is there/u);
      // Nothing was started: no session, and nothing typed at anything.
      assert.deepEqual(fx.tmux.calls().filter((line) => line.startsWith('new-session')), []);
      assert.deepEqual(fx.tmux.calls().filter((line) => line.startsWith('send-keys')), []);
    } finally { fx.cleanup(); }
  });

  it('and it is the resume that is refused, not the area', () => {
    // Same area, no --resume: it starts, which is what makes the refusal above
    // a statement about the id rather than about anything else being wrong.
    const fx = cliFixture();
    try {
      const asked = runMcCli(['work', 'alpha', '--tmux', 'do the thing'], fx.env);
      assert.equal(asked.status, 0, asked.stderr);
      assert.ok(fx.tmux.calls().some((line) => line.startsWith('new-session')));
    } finally { fx.cleanup(); }
  });
});
