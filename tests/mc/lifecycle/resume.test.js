/**
 * TDD spec for `mc resume <name>` (§2).
 *
 * Per the plan §2:
 *   mc resume <name>
 *     cd to worktree, then attach to the broker-owned PTY when it is live.
 *     If the PTY is gone, relaunch the stored tool without sending a fresh
 *     startup prompt. Claude gets its native --resume flag; Codex must not,
 *     because an empty Codex launch can open Codex's own resume picker
 *     instead of the mc worktree session.
 *
 * Per §2b, `mc resume` emits a `cd <worktree>` directive on fd 3
 * *before* launching the tool (so the launched tool's cwd is correct).
 *
 * We test resume in `--no-launch` mode: implementation honours the flag
 * by emitting the cd directive and returning without spawning the tool.
 * This isolates resume's contract (resolve name → emit cd → look up
 * tool) from the tool-spawning machinery.
 */
import test, { describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import { runMc, parseJsonOrNull } from '../_helpers/cli.js';
import { makeTempRepo, git, addWorktree } from '../_helpers/git-fixture.js';
import { writeRegistry, makeEntry, REGISTRY_REL_PATH } from '../_helpers/registry-fixture.js';
import {
  launchResumeSession,
  parseArgs,
  run as runResume,
  runResumePicker,
  selectLiveBrokerSessionForEntry,
  resumableEntries,
} from '../../../src/mc/commands/resume.js';
import * as claudeAdapter from '../../../src/adapters/claude-code.js';
import * as codexAdapter from '../../../src/adapters/codex.js';

describe('mc resume <name>', () => {
  let repo;
  beforeEach(() => { repo = makeTempRepo({ name: 'resume' }); });
  after(() => { repo?.cleanup(); });

  test('without a name lists mc sessions across tools instead of opening a tool-native picker', () => {
    writeRegistry(repo.mcHome, [
      makeEntry({
        name: 'from-claude',
        branch: 'sess/from-claude',
        tool: 'claude',
        worktree_path: '/tmp/from-claude',
      }),
      makeEntry({
        name: 'from-codex',
        branch: 'sess/from-codex',
        tool: 'codex',
        worktree_path: '/tmp/from-codex',
      }),
    ]);
    const r = runMc(['resume'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    assert.match(r.stdout, /mc sessions available to resume/);
    assert.match(r.stdout, /from-claude/);
    assert.match(r.stdout, /claude/);
    assert.match(r.stdout, /from-codex/);
    assert.match(r.stdout, /codex/);
    assert.match(r.stdout, /mc resume <name>/);
    assert.doesNotMatch(r.stdout + r.stderr, /Codex.*Resume session|Resume session/i);
  });

  test('without a name --json lists all mc sessions across tools', () => {
    writeRegistry(repo.mcHome, [
      makeEntry({ name: 'a', tool: 'claude', branch: 'sess/a' }),
      makeEntry({ name: 'b', tool: 'codex', branch: 'sess/b' }),
    ]);
    const r = runMc(['resume', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.deepEqual(j.entries.map((e) => [e.name, e.tool]), [
      ['a', 'claude'],
      ['b', 'codex'],
    ]);
  });

  test('resumableEntries is tool-agnostic and sorted by name', () => {
    const entries = resumableEntries({
      entries: [
        makeEntry({ name: 'z', tool: 'codex' }),
        makeEntry({ name: 'a', tool: 'claude' }),
      ],
    });
    assert.deepEqual(entries.map((e) => [e.name, e.tool]), [
      ['a', 'claude'],
      ['z', 'codex'],
    ]);
  });

  test('interactive picker launches a selected local stopped session', async () => {
    const stdout = [];
    const stderr = [];
    const launched = [];
    const status = await runResumePicker({
      opts: { name: null, tool: null, noLaunch: false, json: false },
      stdin: { isTTY: true },
      stdout: { isTTY: true, write: (s) => stdout.push(s) },
      stderr: { write: (s) => stderr.push(s) },
      deps: {
        readRegistry: () => ({ entries: [
          makeEntry({
            name: 'local-dead',
            branch: 'sess/local-dead',
            tool: 'codex',
            session_state: 'dead',
            worktree_path: '/tmp/local-dead',
          }),
        ] }),
        fetchActiveSessions: async () => ({ ok: true, sessions: [] }),
        readLine: async () => '1',
        attachLiveBrokerSession: async () => ({ attached: false }),
        launchResumeSession: ({ entry }) => {
          launched.push(entry);
          return 0;
        },
      },
    });
    assert.equal(status, 0);
    assert.equal(stderr.join(''), '');
    assert.match(stdout.join(''), /Select a session number/);
    assert.equal(launched.length, 1);
    assert.equal(launched[0].name, 'local-dead');
  });

  test('interactive picker selection of an active session explains send/read instead of launching', async () => {
    const stdout = [];
    let launched = false;
    const status = await runResumePicker({
      opts: { name: null, tool: null, noLaunch: false, json: false },
      stdin: { isTTY: true },
      stdout: { isTTY: true, write: (s) => stdout.push(s) },
      stderr: { write() {} },
      deps: {
        readRegistry: () => ({ entries: [
          makeEntry({
            name: 'data',
            branch: 'sess/data',
            coding_session_id: 'sess_data',
            session_state: 'live',
          }),
        ] }),
        fetchActiveSessions: async () => ({
          ok: true,
          sessions: [{
            coding_session_id: 'sess_data',
            label: 'data',
            repo: 'memoro',
            branch: 'main',
            machine_id: 'host-a',
            source: 'codex',
            idle_seconds: 2,
          }],
        }),
        readLine: async () => '1',
        attachLiveBrokerSession: async () => ({ attached: false }),
        launchResumeSession: () => {
          launched = true;
          return 0;
        },
      },
    });
    assert.equal(status, 0);
    assert.equal(launched, false);
    const out = stdout.join('');
    assert.match(out, /already active/);
    assert.match(out, /mc sessions send sess_data "<message>"/);
    assert.match(out, /mc sessions read sess_data/);
  });

  test('interactive picker selection of a local active broker session attaches', async () => {
    const stdout = [];
    const attached = [];
    let launched = false;
    const status = await runResumePicker({
      opts: { name: null, tool: null, noLaunch: false, json: false },
      stdin: { isTTY: true },
      stdout: { isTTY: true, write: (s) => stdout.push(s) },
      stderr: { write() {} },
      deps: {
        readRegistry: () => ({ entries: [
          makeEntry({
            name: 'data',
            branch: 'sess/data',
            coding_session_id: 'sess_data',
            session_state: 'live',
          }),
        ] }),
        fetchActiveSessions: async () => ({
          ok: true,
          sessions: [{
            coding_session_id: 'sess_data',
            label: 'data',
            repo: 'memoro',
            branch: 'main',
            machine_id: 'host-a',
          }],
        }),
        readLine: async () => '1',
        attachLiveBrokerSession: async (entry) => {
          attached.push(entry);
          return { attached: true, code: 0, id: entry.coding_session_id };
        },
        launchResumeSession: () => {
          launched = true;
          return 0;
        },
      },
    });

    assert.equal(status, 0);
    assert.equal(launched, false);
    assert.equal(attached.length, 1);
    assert.equal(attached[0].coding_session_id, 'sess_data');
    assert.doesNotMatch(stdout.join(''), /Send a message with:/);
  });

  test('direct resume of an active server-visible session does not spawn a duplicate', async () => {
    const old = process.env.MC_TEST_MODE;
    delete process.env.MC_TEST_MODE;
    const stdout = [];
    let launched = false;
    let upserted = false;
    try {
      const status = await runResume(['data', '--codex'], {
        stdout: { write: (s) => stdout.push(s) },
        stderr: { write() {} },
        findEntry: () => makeEntry({
          name: 'data',
          branch: 'sess/data',
          worktree_path: '/tmp/data',
          coding_session_id: 'sess_data',
        }),
        fetchActiveSessions: async () => ({
          ok: true,
          sessions: [{
            coding_session_id: 'sess_data',
            label: 'data',
            repo: 'memoro',
            branch: 'main',
            machine_id: 'host-a',
          }],
        }),
        requestBroker: async () => {
          throw new Error('no local broker in test');
        },
        launchResumeSession: () => {
          launched = true;
          return 0;
        },
        upsertEntry: () => {
          upserted = true;
          return makeEntry({ name: 'data', tool: 'codex' });
        },
      });
      assert.equal(status, 0);
      assert.equal(launched, false);
      assert.equal(upserted, false);
      assert.match(stdout.join(''), /already active/);
    } finally {
      if (old === undefined) delete process.env.MC_TEST_MODE;
      else process.env.MC_TEST_MODE = old;
    }
  });

  test('direct resume attaches to a live local broker session without relaunching', async () => {
    const old = process.env.MC_TEST_MODE;
    delete process.env.MC_TEST_MODE;
    const attached = [];
    let launched = false;
    let fetchedActive = false;
    try {
      const status = await runResume(['data'], {
        stdout: { write() {} },
        stderr: { write() {} },
        findEntry: () => makeEntry({
          name: 'data',
          branch: 'sess/data',
          worktree_path: '/tmp/data',
          coding_session_id: 'sess_data',
          tool: 'codex',
        }),
        requestBroker: async (message) => {
          assert.deepEqual(message, { type: 'sessions' });
          return {
            ok: true,
            sessions: [{
              id: 'sess_data',
              name: 'data',
              cwd: '/tmp/data',
              session_state: 'live',
              attachable: true,
            }],
          };
        },
        attachBrokerSession: async (arg) => {
          attached.push(arg);
          return 0;
        },
        fetchActiveSessions: async () => {
          fetchedActive = true;
          return { ok: true, sessions: [] };
        },
        launchResumeSession: () => {
          launched = true;
          return 0;
        },
      });

      assert.equal(status, 0);
      assert.equal(launched, false);
      assert.equal(fetchedActive, false);
      assert.equal(attached.length, 1);
      assert.equal(attached[0].id, 'sess_data');
    } finally {
      if (old === undefined) delete process.env.MC_TEST_MODE;
      else process.env.MC_TEST_MODE = old;
    }
  });

  test('live broker session matching falls back from id to cwd and name', () => {
    const sessions = [
      { id: 'dead', name: 'data', cwd: '/tmp/data', session_state: 'dead' },
      { id: 'by-cwd', cwd: '/tmp/data', session_state: 'live', attachable: true },
      { id: 'by-name', name: 'data', session_state: 'live', attachable: true },
    ];

    assert.equal(selectLiveBrokerSessionForEntry({
      name: 'data',
      worktree_path: '/tmp/data',
    }, sessions).id, 'by-cwd');
    assert.equal(selectLiveBrokerSessionForEntry({
      name: 'data',
    }, sessions).id, 'by-name');
  });

  test('rejects unknown name', () => {
    const r = runMc(['resume', 'nope', '--no-launch'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /unknown|not.found|no such/i);
  });

  test('--json reports the resolved tool + worktree path', () => {
    git(repo.dir, 'branch sess/r main');
    const wt = join(repo.mcHome, 'worktrees', 'repo', 'r');
    addWorktree(repo.dir, wt, 'sess/r');
    writeRegistry(repo.mcHome, [makeEntry({
      name: 'r', branch: 'sess/r', worktree_path: wt, tool: 'claude',
    })]);
    const r = runMc(['resume', 'r', '--no-launch', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.ok(j, `expected JSON, got: ${r.stdout}`);
    assert.equal(j.name, 'r');
    assert.equal(j.tool, 'claude');
    assert.equal(j.worktree_path, wt);
  });

  test('--codex updates the stored session tool before relaunch', () => {
    git(repo.dir, 'branch sess/r main');
    const wt = join(repo.mcHome, 'worktrees', 'repo', 'r');
    addWorktree(repo.dir, wt, 'sess/r');
    writeRegistry(repo.mcHome, [makeEntry({
      name: 'r', branch: 'sess/r', worktree_path: wt, tool: 'claude',
    })]);
    const r = runMc(['resume', 'r', '--codex', '--no-launch', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j.tool, 'codex');

    const reg = JSON.parse(readFileSync(join(repo.mcHome, REGISTRY_REL_PATH), 'utf8'));
    assert.equal(reg.entries.find((e) => e.name === 'r')?.tool, 'codex');
  });

  test('tool flags reject conflicts and unknown values', () => {
    assert.match(parseArgs(['r', '--tool', 'claude', '--codex']).error, /conflicting/);
    assert.match(parseArgs(['r', '--tool']).error, /requires a value/);
  });

  test('prelaunch uses the registry tool adapter and broker resume payload', async () => {
    const materialiseCalls = [];
    const launchCalls = [];
    const upserts = [];
    const status = await launchResumeSession({
      entry: {
        name: 'data',
        tool: 'claude',
        label: 'identity cleanup',
        worktree_path: '/tmp/memoro-resume-data',
      },
      env: { PATH: '/bin', MC_GROUNDING_TOOL: 'codex' },
      stderr: { write() {} },
      deps: {
        materialiseVaultBeforeLaunch: async (arg) => {
          materialiseCalls.push(arg);
          return { ok: true, materialised: [], skipped: [] };
        },
        launchBrokerOwnedSession: async (arg) => {
          launchCalls.push(arg);
          await arg.onLaunched?.({ codingSessionId: 'sess_resume_data' });
          return { code: 0 };
        },
        upsertEntry: (entry) => {
          upserts.push(entry);
          return entry;
        },
      },
    });

    assert.equal(status, 0);
    assert.equal(materialiseCalls.length, 1);
    assert.equal(materialiseCalls[0].sessionId, 'data');
    assert.equal(materialiseCalls[0].worktreePath, '/tmp/memoro-resume-data');
    assert.deepEqual(materialiseCalls[0].adapters, [claudeAdapter]);
    assert.notDeepEqual(materialiseCalls[0].adapters, [codexAdapter]);

    assert.equal(launchCalls.length, 1);
    assert.equal(launchCalls[0].cwd, '/tmp/memoro-resume-data');
    assert.equal(launchCalls[0].sessionName, 'data');
    assert.equal(launchCalls[0].tool, 'claude-code');
    assert.equal(launchCalls[0].label, 'identity cleanup');
    assert.equal(launchCalls[0].focus, 'identity cleanup');
    assert.deepEqual(launchCalls[0].argv, ['--resume']);
    assert.equal(launchCalls[0].sendStartupMessage, false);
    assert.deepEqual(launchCalls[0].env, { PATH: '/bin', MC_GROUNDING_TOOL: 'codex' });
    assert.deepEqual(upserts, [{
      name: 'data',
      coding_session_id: 'sess_resume_data',
      session_state: 'live',
    }]);
  });

  test('prelaunch uses a resume-overridden codex tool', async () => {
    const materialiseCalls = [];
    const launchCalls = [];
    const status = await launchResumeSession({
      entry: {
        name: 'data',
        tool: 'codex',
        label: 'identity cleanup',
        worktree_path: '/tmp/memoro-resume-data',
      },
      env: { PATH: '/bin', MC_GROUNDING_TOOL: 'claude-code' },
      stderr: { write() {} },
      deps: {
        materialiseVaultBeforeLaunch: async (arg) => {
          materialiseCalls.push(arg);
          return { ok: true, materialised: [], skipped: [] };
        },
        launchBrokerOwnedSession: async (arg) => {
          launchCalls.push(arg);
          return { code: 0 };
        },
      },
    });

    assert.equal(status, 0);
    assert.deepEqual(materialiseCalls[0].adapters, [codexAdapter]);
    assert.equal(launchCalls[0].tool, 'codex');
    assert.deepEqual(launchCalls[0].argv, ['--resume']);
    assert.equal(launchCalls[0].sendStartupMessage, false);
  });
});
