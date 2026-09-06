/**
 * Opening a piece of work with (and without) a chosen model.
 *
 * The parallel-operation guarantee is tested here, not asserted: without
 * `--model`, both launch paths build exactly the argv they built before the
 * flag existed. With it, the raw value reaches the tool — and a resumed
 * conversation is put back on the model its own transcript records, so a
 * restart lands where the conversation was.
 *
 * Fixtures are Claude conversations: Claude's store is plain files under a
 * directory named for the launch cwd, so a temp CLAUDE_CONFIG_DIR is the
 * whole store. Codex argv shapes are covered by the adapter tests.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { sharedRoleText, textDigest } from '../../src/mc/roles.js';
import { openInWorkArea, startInBackground } from '../../src/mc/work-open.js';
import { markStopped, readStopMark } from '../../src/mc/work-stop-marker.js';

const CONVERSATION_ID = '3f9d2c81-0000-4000-8000-000000000001';

/** A work area plus a tool store, both throwaway. */
function fixture({ entries = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-work-open-'));
  const areaRoot = join(root, 'area');
  mkdirSync(areaRoot, { recursive: true });
  const claudeHome = join(root, 'claude-home');
  const codexHome = join(root, 'codex-home');
  mkdirSync(codexHome, { recursive: true });
  if (entries) {
    const projectDir = join(claudeHome, 'projects', areaRoot.replace(/[/.]/gu, '-'));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, `${CONVERSATION_ID}.jsonl`),
      `${entries.map((entry) => JSON.stringify({ cwd: areaRoot, ...entry })).join('\n')}\n`,
    );
  }
  return {
    areaRoot,
    worktree: { repo: null, path: areaRoot, is_git: false },
    env: { ...process.env, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome },
  };
}

function opening(overrides = {}) {
  const calls = [];
  const options = {
    tool: 'claude',
    spawn: (bin, args, spawnOptions) => { calls.push({ bin, args, spawnOptions }); return { status: 0 }; },
    loadProfile: async () => 'PROFILE',
    ...overrides,
  };
  return { calls, options };
}

describe('openInWorkArea and --model', () => {
  it('a new conversation gets the model first, then the profile', async () => {
    const { areaRoot, worktree, env } = fixture();
    const { calls, options } = opening();
    const result = await openInWorkArea({ areaRoot, worktree, env, model: 'opus', ...options });
    assert.equal(result.ok, true);
    assert.deepEqual(calls[0].args, ['--model', 'opus', '--append-system-prompt', 'PROFILE']);
  });

  it('without the flag a new conversation launches exactly as before', async () => {
    const { areaRoot, worktree, env } = fixture();
    const { calls, options } = opening();
    const result = await openInWorkArea({ areaRoot, worktree, env, ...options });
    assert.equal(result.ok, true);
    assert.deepEqual(calls[0].args, ['--append-system-prompt', 'PROFILE']);
  });

  it('resuming puts the conversation back on the model its transcript records', async () => {
    const { areaRoot, worktree, env } = fixture({
      entries: [
        { type: 'user', message: { content: 'first' } },
        { type: 'assistant', message: { model: 'claude-fable-5', content: [] } },
      ],
    });
    const { calls, options } = opening();
    const result = await openInWorkArea({ areaRoot, worktree, env, ...options });
    assert.equal(result.ok, true);
    assert.equal(result.resumed, true);
    assert.deepEqual(calls[0].args, ['--resume', CONVERSATION_ID, '--model', 'claude-fable-5']);
  });

  it('an explicit --model on resume outranks the transcript', async () => {
    const { areaRoot, worktree, env } = fixture({
      entries: [
        { type: 'assistant', message: { model: 'claude-fable-5', content: [] } },
      ],
    });
    const { calls, options } = opening();
    await openInWorkArea({
      areaRoot, worktree, env, pick: CONVERSATION_ID.slice(0, 8), model: 'opus', ...options,
    });
    assert.deepEqual(calls[0].args, ['--resume', CONVERSATION_ID, '--model', 'opus']);
  });

  it('a transcript that names no model resumes exactly as before', async () => {
    const { areaRoot, worktree, env } = fixture({
      entries: [
        { type: 'user', message: { content: 'first' } },
      ],
    });
    const { calls, options } = opening();
    const result = await openInWorkArea({ areaRoot, worktree, env, ...options });
    assert.equal(result.resumed, true);
    assert.deepEqual(calls[0].args, ['--resume', CONVERSATION_ID]);
  });
});

describe('openInWorkArea in a role area', () => {
  // The shared text every role session is told rides between the two: the
  // profile is the user's, the shared text is every role's, the overlay is
  // this role's. An area with no role gets neither (see above).
  it('the overlay rides behind the profile and the role model is the default', async () => {
    const { areaRoot, worktree, env } = fixture();
    const { calls, options } = opening();
    const result = await openInWorkArea({
      areaRoot, worktree, env, overlay: 'OVERLAY', defaultModel: 'fable', ...options,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls[0].args, [
      '--model', 'fable', '--append-system-prompt', `PROFILE\n\n---\n\n${sharedRoleText()}\n\n---\n\nOVERLAY`,
    ]);
  });

  it('an explicit --model outranks the role default', async () => {
    const { areaRoot, worktree, env } = fixture();
    const { calls, options } = opening();
    await openInWorkArea({
      areaRoot, worktree, env, model: 'opus', overlay: 'OVERLAY', defaultModel: 'fable', ...options,
    });
    assert.equal(calls[0].args[1], 'opus');
  });

  it('on resume the transcript model outranks the role default', async () => {
    const { areaRoot, worktree, env } = fixture({
      entries: [
        { type: 'assistant', message: { model: 'claude-fable-5', content: [] } },
      ],
    });
    const { calls, options } = opening();
    const result = await openInWorkArea({
      areaRoot, worktree, env, overlay: 'OVERLAY', defaultModel: 'opus', ...options,
    });
    assert.equal(result.resumed, true);
    assert.deepEqual(calls[0].args, ['--resume', CONVERSATION_ID, '--model', 'claude-fable-5']);
  });

  it('the role default never rides into a resume', async () => {
    // A resume lands where the conversation was: with no recorded model and
    // no flag, it stays unpinned rather than being quietly switched to the
    // role default.
    const { areaRoot, worktree, env } = fixture({
      entries: [
        { type: 'user', message: { content: 'first' } },
      ],
    });
    const { calls, options } = opening();
    await openInWorkArea({ areaRoot, worktree, env, defaultModel: 'fable', ...options });
    assert.deepEqual(calls[0].args, ['--resume', CONVERSATION_ID]);
  });

  it('the role default follows the role tool, not every tool in the area', async () => {
    // The role's model is written for its own tool; a claude launch in an
    // area whose role defaults belong to codex gets no model at all.
    const { areaRoot, worktree, env } = fixture();
    const { calls, options } = opening();
    await openInWorkArea({
      areaRoot, worktree, env, defaultModel: 'gpt-5.3-codex', defaultModelTool: 'codex', ...options,
    });
    assert.deepEqual(calls[0].args, ['--append-system-prompt', 'PROFILE']);
  });
});

/**
 * The register is the opener's only side effect, and it must be paired with
 * the call that blocks rather than with the call that returns: a tool that
 * throws on its way out would otherwise leave NOW claiming a session forever.
 */
describe('openInWorkArea and the foreground register', () => {
  function registering() {
    const events = [];
    const register = (item) => {
      events.push({ ...item, event: 'register' });
      return () => events.push({ event: 'release' });
    };
    return { events, register };
  }

  it('registers the verb, the area, the tool and the model, and releases when the tool is done', async () => {
    const { areaRoot, worktree, env } = fixture();
    const { events, register } = registering();
    const { options } = opening();
    await openInWorkArea({
      areaRoot, worktree, env, verb: 'plan', areaName: 'mc-ui', model: 'opus', register, ...options,
    });
    assert.deepEqual(events, [
      { event: 'register', verb: 'plan', area: 'mc-ui', tool: 'claude', model: 'opus', env, role: null },
      { event: 'release' },
    ]);
  });

  /**
   * The whole of what a session can be asked afterwards: which role it was
   * given, out of which catalogue, and a digest of the text it was handed.
   * The launcher exits with its argv; without this nobody could tell a
   * session running today's `brief.md` from one running last week's — which
   * is exactly what happened to this project's own brief on 2026-09-06.
   */
  it('records the role, its catalogue, and a digest of the very text handed to the tool', async () => {
    const { areaRoot, worktree, env } = fixture();
    const { events, register } = registering();
    const { calls, options } = opening();
    await openInWorkArea({
      areaRoot, worktree, env, verb: 'brief', overlay: 'OVERLAY',
      roleName: 'brief', roleSource: 'canon', register, ...options,
    });
    const handed = calls[0].args[calls[0].args.indexOf('--append-system-prompt') + 1];
    assert.equal(handed, `PROFILE\n\n---\n\n${sharedRoleText()}\n\n---\n\nOVERLAY`);
    assert.deepEqual(events[0].role, {
      name: 'brief',
      source: 'canon',
      // The profile, the shared text and the overlay, joined as a launch
      // joins them — asserted against the string the tool actually got.
      digest: textDigest(handed),
      text_digest: textDigest('OVERLAY'),
    });
  });

  it('a resumed conversation records the role and no digest — it was handed nothing', async () => {
    const { areaRoot, worktree, env } = fixture({
      entries: [{ type: 'user', message: { content: 'first' } }],
    });
    const { events, register } = registering();
    const { options } = opening();
    const result = await openInWorkArea({
      areaRoot, worktree, env, verb: 'work', overlay: 'OVERLAY',
      roleName: 'worker', roleSource: 'catalogue', register, ...options,
    });
    assert.equal(result.resumed, true);
    assert.deepEqual(events[0].role, {
      name: 'worker', source: 'catalogue', digest: null, text_digest: null,
    });
  });

  it('releases even when the tool throws on the way out', async () => {
    const { areaRoot, worktree, env } = fixture();
    const { events, register } = registering();
    const { options } = opening({ spawn: () => { throw new Error('no such binary'); } });
    await assert.rejects(openInWorkArea({
      areaRoot, worktree, env, verb: 'brief', register, ...options,
    }));
    assert.deepEqual(events.map((item) => item.event), ['register', 'release']);
  });

  it('a caller that names no verb registers nothing — the register is opt-in', async () => {
    const { areaRoot, worktree, env } = fixture();
    const { events, register } = registering();
    const { options } = opening();
    await openInWorkArea({ areaRoot, worktree, env, register, ...options });
    assert.deepEqual(events, [
      { event: 'register', verb: null, area: null, tool: 'claude', model: null, env, role: null },
      { event: 'release' },
    ]);
  });
});

describe('startInBackground and --model', () => {
  /** tmux, faked: no session exists, creation succeeds, everything recorded. */
  function tmux() {
    const calls = [];
    const run = (args) => {
      calls.push(args);
      if (args[0] === 'has-session') return { status: 1 };
      return { status: 0 };
    };
    return { calls, run };
  }

  function creation(calls) {
    const found = calls.find((args) => args[0] === 'new-session');
    assert.ok(found, 'expected a tmux new-session call');
    return found[found.length - 1];
  }

  // The profile source is stubbed in every case: the real one reads a cache
  // under MC_HOME, and MC_HOME is whatever the machine running the suite has
  // — a launch assertion that depends on it passes on one machine and fails
  // on the next.
  it('the model survives the shell, quoting and all', () => {
    const { areaRoot, worktree, env } = fixture();
    const { calls, run } = tmux();
    const started = startInBackground({
      name: 'x', areaRoot, worktree, tool: 'claude', model: "o'pus model", task: 'fix it', env, run,
      loadProfile: () => null,
    });
    assert.equal(started.ok, true);
    // Single-quoted for the shell tmux runs the command through: an embedded
    // quote becomes '\'' and spaces stay inside one argument.
    assert.equal(creation(calls), `'claude' '--model' 'o'\\''pus model' 'fix it'`);
  });

  it('the model rides in front of the profile, both quoted', () => {
    const { areaRoot, worktree, env } = fixture();
    const { calls, run } = tmux();
    const started = startInBackground({
      name: 'x', areaRoot, worktree, tool: 'claude', model: 'opus', env, run,
      loadProfile: () => 'THE\nPROFILE',
    });
    assert.equal(started.ok, true);
    assert.equal(creation(calls), `'claude' '--model' 'opus' '--append-system-prompt' 'THE\nPROFILE'`);
  });

  it('without the flag the command is exactly what it always was', () => {
    const { areaRoot, worktree, env } = fixture();
    const { calls, run } = tmux();
    const started = startInBackground({
      name: 'x', areaRoot, worktree, tool: 'claude', env, run, loadProfile: () => null,
    });
    assert.equal(started.ok, true);
    assert.equal(creation(calls), `'claude'`);
  });

  it('opening the area again removes the mark mc work stop left (KP-09)', async () => {
    const { areaRoot, worktree, env } = fixture();
    markStopped(areaRoot, { by: 'pm' });
    const { run } = tmux();
    const started = startInBackground({
      name: 'x', areaRoot, worktree, tool: 'claude', env, run, loadProfile: () => null,
    });
    assert.equal(started.ok, true);
    assert.equal(readStopMark(areaRoot), null, 'the background start left the mark');

    markStopped(areaRoot, { by: 'pm' });
    const { options } = opening();
    await openInWorkArea({ areaRoot, worktree, env, ...options });
    assert.equal(readStopMark(areaRoot), null, 'the terminal open left the mark');
  });

  it('the role default follows the role tool here too', () => {
    const { areaRoot, worktree, env } = fixture();
    const { calls, run } = tmux();
    const started = startInBackground({
      name: 'x', areaRoot, worktree, tool: 'claude', env, run, loadProfile: () => null,
      defaultModel: 'gpt-5.3-codex', defaultModelTool: 'codex',
    });
    assert.equal(started.ok, true);
    assert.equal(creation(calls), `'claude'`);
  });
});
