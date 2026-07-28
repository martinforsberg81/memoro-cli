/**
 * TDD spec for `mc resume <name>` (§2).
 *
 * Per the plan §2:
 *   mc resume <name>
 *     cd to worktree, then attach to the broker-owned PTY when it is live.
 *     If the PTY is gone, do not silently relaunch a new tool session in the
 *     same worktree. Interactive restart must be confirmed.
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
  launchFreshSession,
  launchResumeSession,
  parseArgs,
  run as runResume,
  runResumePicker,
  resumeSelectedChoice,
  selectLiveBrokerSessionForEntry,
  resumableEntries,
} from '../../../src/mc/commands/resume.js';
import * as claudeAdapter from '../../../src/adapters/claude-code.js';
import * as codexAdapter from '../../../src/adapters/codex.js';
import { LOCAL_AUTH_MODES } from '../../../src/mc/local-auth-mode.js';
import { MANAGED_CODEX_PROVIDER_ID } from '../../../src/mc/provider-adapters/codex-managed.js';

const MANAGED_GENERATION = '019dbb46-5772-4493-a627-f8ae48954a64';

describe('mc resume <name>', () => {
  let repo;
  beforeEach(() => { repo = makeTempRepo({ name: 'resume' }); });
  after(() => { repo?.cleanup(); });

  test('mc open is the primary session-opening surface', () => {
    writeRegistry(repo.mcHome, [
      makeEntry({
        name: 'from-codex',
        branch: 'sess/from-codex',
        tool: 'codex',
        worktree_path: '/tmp/from-codex',
      }),
    ]);
    const r = runMc(['open'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    assert.match(r.stdout, /mc sessions available to open/);
    assert.match(r.stdout, /from-codex/);
    assert.match(r.stdout, /mc open <name>/);
  });

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

  test('--managed-portable still validates the requested registry entry before launch', async () => {
    const stderr = [];
    const status = await runResume(['missing', '--managed-portable'], {
      stderr: { write: (value) => stderr.push(value) },
      findEntry: () => null,
      attachLiveBrokerSession: async () => assert.fail('must not attach'),
      materialiseVaultBeforeLaunch: async () => assert.fail('must not touch vault startup'),
      launchResumeSession: async () => assert.fail('must not launch'),
      launchFreshSession: async () => assert.fail('must not launch'),
    });

    assert.equal(status, 1);
    assert.match(stderr.join(''), /no such session "missing"/);
  });

  test('managed resume refuses a live native PTY without attach, custody, or relaunch', async () => {
    const stderr = [];
    const entry = {
      name: 'native-live',
      tool: 'codex',
      worktree_path: '/tmp/native-live',
      coding_session_id: 'sess_native_live',
      tool_session_id: '019dbb46-5772-7493-a627-f8ae48954a64',
      tool_session_source: 'codex',
    };
    const status = await runResume(['native-live', '--managed-portable'], {
      stderr: { write: (value) => stderr.push(value) },
      stdout: { write() {} },
      stdin: {},
      findEntry: () => entry,
      inspectLocalBrokerSessionForEntry: async () => ({
        verdict: 'live',
        session: {
          id: 'sess_native_live',
          session_state: 'live',
          attachable: true,
        },
      }),
      attachBrokerSession: async () => assert.fail('managed mode must not attach'),
      materialiseVaultBeforeLaunch: async () => assert.fail('managed conflict must not open vault'),
      launchResumeSession: async () => assert.fail('managed conflict must not resume'),
      launchFreshSession: async () => assert.fail('managed conflict must not relaunch'),
    });

    assert.equal(status, 1);
    assert.match(stderr.join(''), /managed portable launch conflicts/);
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

  test('interactive picker fresh-starts a selected local session that has never launched', async () => {
    const stdout = [];
    const stderr = [];
    const freshLaunched = [];
    let resumed = false;
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
          resumed = true;
          return 0;
        },
        launchFreshSession: ({ entry }) => {
          freshLaunched.push(entry);
          return 0;
        },
      },
    });
    assert.equal(status, 0);
    assert.equal(resumed, false);
    assert.equal(stderr.join(''), '');
    assert.match(stdout.join(''), /Select a session number/);
    assert.equal(freshLaunched.length, 1);
    assert.equal(freshLaunched[0].name, 'local-dead');
  });

  test('picker renders registry-live sessions with no live local session as stale', async () => {
    const stdout = [];
    const stderr = [];
    const status = await runResumePicker({
      opts: { name: null, tool: null, noLaunch: false, json: false },
      stdin: { isTTY: false },
      stdout: { isTTY: false, write: (s) => stdout.push(s) },
      stderr: { write: (s) => stderr.push(s) },
      deps: {
        readRegistry: () => ({ entries: [
          makeEntry({
            name: 'ghost',
            branch: 'sess/ghost',
            tool: 'codex',
            coding_session_id: 'sess_ghost',
            session_state: 'live',
            worktree_path: '/tmp/ghost',
          }),
          makeEntry({
            name: 'truly-live',
            branch: 'sess/truly-live',
            tool: 'codex',
            coding_session_id: 'sess_truly',
            session_state: 'live',
            worktree_path: '/tmp/truly-live',
          }),
        ] }),
        fetchLocalBrokerSessions: async () => ({
          ok: true,
          sessions: [{ coding_session_id: 'sess_truly' }],
          warning: null,
        }),
        fetchActiveSessions: async () => ({ ok: true, sessions: [] }),
      },
    });
    assert.equal(status, 0);
    const out = stdout.join('');
    assert.match(out, /ghost\s+.*stale/);
    assert.match(out, /truly-live\s+.*live/);
    assert.match(stderr.join(''), /1 session\(s\) marked live in the registry/);
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
    const upserts = [];
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
        upsertEntry: (entry) => {
          upserts.push(entry);
          return entry;
        },
        now: () => '2026-07-11T10:00:00.000Z',
      });
      assert.equal(status, 0);
      assert.equal(launched, false);
      assert.deepEqual(upserts, [{
        name: 'data',
        last_opened_at: '2026-07-11T10:00:00.000Z',
      }]);
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

  test('direct resume fresh-starts an idle tracked session that has never launched', async () => {
    const old = process.env.MC_TEST_MODE;
    delete process.env.MC_TEST_MODE;
    let resumed = false;
    const freshLaunched = [];
    try {
      const status = await runResume(['i18n'], {
        stdout: { write() {} },
        stderr: { write() {} },
        findEntry: () => makeEntry({
          name: 'i18n',
          branch: 'sess/i18n',
          worktree_path: '/tmp/i18n',
          session_state: 'no-session-yet',
          focus: 'French UI locale',
          tool: 'codex',
        }),
        requestBroker: async () => ({ ok: true, sessions: [] }),
        fetchActiveSessions: async () => ({ ok: true, sessions: [] }),
        launchResumeSession: () => {
          resumed = true;
          return 0;
        },
        launchFreshSession: ({ entry, apiArgv }) => {
          freshLaunched.push({ entry, apiArgv });
          return 0;
        },
      });

      assert.equal(status, 0);
      assert.equal(resumed, false);
      assert.equal(freshLaunched.length, 1);
      assert.equal(freshLaunched[0].entry.name, 'i18n');
      assert.equal(freshLaunched[0].entry.focus, 'French UI locale');
      assert.deepEqual(freshLaunched[0].apiArgv, ['i18n']);
    } finally {
      if (old === undefined) delete process.env.MC_TEST_MODE;
      else process.env.MC_TEST_MODE = old;
    }
  });

  test('direct resume launches provider-native resume when the broker PTY is gone', async () => {
    const old = process.env.MC_TEST_MODE;
    delete process.env.MC_TEST_MODE;
    const resumed = [];
    try {
      const status = await runResume(['data'], {
        stdout: { write() {} },
        stderr: { write() {} },
        findEntry: () => makeEntry({
          name: 'data',
          branch: 'sess/data',
          worktree_path: '/tmp/data',
          coding_session_id: 'sess_data',
          session_state: 'live',
          tool: 'codex',
        }),
        requestBroker: async () => ({ ok: true, sessions: [] }),
        fetchActiveSessions: async () => ({ ok: true, sessions: [] }),
        launchResumeSession: ({ entry, apiArgv }) => {
          resumed.push({ entry, apiArgv });
          return 0;
        },
      });

      assert.equal(status, 0);
      assert.equal(resumed.length, 1);
      assert.equal(resumed[0].entry.name, 'data');
      assert.deepEqual(resumed[0].apiArgv, ['data']);
    } finally {
      if (old === undefined) delete process.env.MC_TEST_MODE;
      else process.env.MC_TEST_MODE = old;
    }
  });

  test('direct resume backfills provider-native id from a matching transcript', async () => {
    const old = process.env.MC_TEST_MODE;
    delete process.env.MC_TEST_MODE;
    const resumed = [];
    const upserts = [];
    try {
      const status = await runResume(['data'], {
        stdout: { write() {} },
        stderr: { write() {} },
        findEntry: () => makeEntry({
          name: 'data',
          branch: 'sess/data',
          worktree_path: '/tmp/data',
          coding_session_id: 'sess_data',
          session_state: 'live',
          tool: 'codex',
        }),
        requestBroker: async () => ({ ok: true, sessions: [] }),
        fetchActiveSessions: async () => ({ ok: true, sessions: [] }),
        resolveToolSessionForResume: async ({ entry, launchTool }) => ({
          ok: true,
          from: 'transcript',
          source: launchTool.id,
          sessionId: 'cx_discovered',
          transcriptPath: '/tmp/codex.jsonl',
          entry,
        }),
        launchResumeSession: ({ entry }) => {
          resumed.push(entry);
          return 0;
        },
        upsertEntry: (patch) => {
          upserts.push(patch);
          return patch;
        },
      });

      assert.equal(status, 0);
      assert.equal(resumed.length, 1);
      assert.equal(resumed[0].tool_session_id, 'cx_discovered');
      assert.equal(resumed[0].tool_session_source, 'codex');
      assert.equal(resumed[0].tool_transcript_path, '/tmp/codex.jsonl');
      assert.deepEqual(upserts[0], {
        name: 'data',
        tool_session_id: 'cx_discovered',
        tool_session_source: 'codex',
        tool_transcript_path: '/tmp/codex.jsonl',
        provider_sessions: {
          schema: 1,
          providers: {
            codex: {
              session_id: 'cx_discovered', transcript_path: '/tmp/codex.jsonl',
              runtime_generation: null, last_consumed_handoff_sequence: 0,
            },
          },
        },
      });
    } finally {
      if (old === undefined) delete process.env.MC_TEST_MODE;
      else process.env.MC_TEST_MODE = old;
    }
  });

  test('invalid provider session state refuses before launch or registry mutation', async () => {
    const launches = [];
    const mutations = [];
    const status = await runResume(['data'], {
      stdout: { write() {} },
      stderr: { write() {} },
      findEntry: () => makeEntry({
        name: 'data', tool: 'codex', coding_session_id: 'sess_data',
        provider_sessions: { schema: 2, providers: {} }, tool_session_id: 'cx_legacy',
      }),
      upsertEntry: (patch) => { mutations.push(patch); return patch; },
      launchFreshSession: () => { launches.push('fresh'); return 0; },
      launchResumeSession: () => { launches.push('resume'); return 0; },
    });
    assert.equal(status, 1);
    assert.deepEqual(launches, []);
    assert.deepEqual(mutations, []);
  });

  test('--json includes provider-native id backfilled from transcript', async () => {
    const stdout = [];
    const upserts = [];
    const status = await runResume(['data', '--no-launch', '--json'], {
      stdout: { write: (s) => stdout.push(s) },
      stderr: { write() {} },
      findEntry: () => makeEntry({
        name: 'data',
        branch: 'sess/data',
        worktree_path: '/tmp/data',
        coding_session_id: 'sess_data',
        session_state: 'live',
        tool: 'codex',
      }),
      resolveToolSessionForResume: async () => ({
        ok: true,
        from: 'transcript',
        source: 'codex',
        sessionId: 'cx_discovered',
        transcriptPath: '/tmp/codex.jsonl',
      }),
      upsertEntry: (patch) => {
        upserts.push(patch);
        return patch;
      },
    });

    assert.equal(status, 0);
    const j = JSON.parse(stdout.join(''));
    assert.equal(j.tool_session_id, 'cx_discovered');
    assert.equal(j.tool_session_source, 'codex');
    assert.equal(j.tool_transcript_path, '/tmp/codex.jsonl');
    assert.equal(upserts.length, 1);
  });

  test('direct resume does not ask before native provider resume', async () => {
    const old = process.env.MC_TEST_MODE;
    delete process.env.MC_TEST_MODE;
    const resumed = [];
    try {
      const status = await runResume(['data'], {
        stdin: { isTTY: true },
        stdout: { isTTY: true, write() {} },
        stderr: { write() {} },
        isTTY: true,
        readLine: async () => assert.fail('resume must not ask to start a replacement session'),
        findEntry: () => makeEntry({
          name: 'data',
          branch: 'sess/data',
          worktree_path: '/tmp/data',
          coding_session_id: 'sess_data',
          session_state: 'live',
          tool: 'codex',
        }),
        requestBroker: async () => ({ ok: true, sessions: [] }),
        fetchActiveSessions: async () => ({ ok: true, sessions: [] }),
        launchResumeSession: ({ entry }) => {
          resumed.push(entry);
          return 0;
        },
      });

      assert.equal(status, 0);
      assert.equal(resumed.length, 1);
      assert.equal(resumed[0].name, 'data');
    } finally {
      if (old === undefined) delete process.env.MC_TEST_MODE;
      else process.env.MC_TEST_MODE = old;
    }
  });

  test('direct resume switches provider via a fresh grounded launch on the same coding session', async () => {
    const old = process.env.MC_TEST_MODE;
    delete process.env.MC_TEST_MODE;
    const stderr = [];
    const resumed = [];
    const freshLaunched = [];
    const upserts = [];
    try {
      const status = await runResume(['data', '--codex'], {
        stdin: { isTTY: true },
        stdout: { isTTY: true, write() {} },
        stderr: { write: (s) => stderr.push(s) },
        isTTY: true,
        readLine: async () => assert.fail('switch must not prompt for a replacement session'),
        findEntry: () => makeEntry({
          name: 'data',
          branch: 'sess/data',
          worktree_path: '/tmp/data',
          coding_session_id: 'sess_data',
          // Stale provider-native transcript from the previous (Claude) tool.
          tool_session_id: 'claude_native_xyz',
          session_state: 'live',
          tool: 'claude',
        }),
        requestBroker: async () => ({ ok: true, sessions: [] }),
        fetchActiveSessions: async () => ({ ok: true, sessions: [] }),
        launchResumeSession: ({ entry }) => { resumed.push(entry); return 0; },
        launchFreshSession: ({ entry }) => { freshLaunched.push(entry); return 0; },
        upsertEntry: (entry) => {
          upserts.push(entry);
          return makeEntry({
            name: entry.name,
            branch: 'sess/data',
            worktree_path: '/tmp/data',
            coding_session_id: 'sess_data',
            ...entry,
          });
        },
      });

      assert.equal(status, 0);
      // Fresh grounded launch — never a provider-native resume of the old tool.
      assert.equal(resumed.length, 0, 'must not resume the old provider transcript');
      assert.equal(freshLaunched.length, 1);
      assert.equal(freshLaunched[0].tool, 'codex');
      assert.equal(freshLaunched[0].coding_session_id, 'sess_data', 'coding_session_id preserved');
      assert.equal(freshLaunched[0].tool_session_id ?? null, null, 'stale native transcript cleared');
      // Registry flipped tool + cleared the old native-transcript pointers.
      const switchPatch = upserts.find((u) => u.tool === 'codex');
      assert.ok(switchPatch, 'tool flipped to codex in registry');
      assert.equal(switchPatch.tool_session_id, null);
      assert.equal(switchPatch.tool_transcript_path, null);
      assert.equal(switchPatch.provider_sessions.providers['claude-code'].session_id, 'claude_native_xyz');
      assert.equal(switchPatch.provider_sessions.providers['claude-code'].last_consumed_handoff_sequence, 0);
      assert.doesNotMatch(stderr.join(''), /different tool/);
    } finally {
      if (old === undefined) delete process.env.MC_TEST_MODE;
      else process.env.MC_TEST_MODE = old;
    }
  });

  test('plain open proceeds only when local evidence proves the exact server generation exited', async () => {
    const old = process.env.MC_TEST_MODE;
    delete process.env.MC_TEST_MODE;
    const resumed = [];
    const generation = '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701';
    try {
      const status = await runResume(['data'], {
        stdin: { isTTY: true },
        stdout: { isTTY: true, write() {} },
        stderr: { write() {} },
        findEntry: () => makeEntry({
          name: 'data', branch: 'sess/data', worktree_path: '/tmp/data',
          coding_session_id: 'sess_data', tool_session_id: 'native_abc',
          session_state: 'live', tool: 'claude',
        }),
        attachLiveBrokerSession: async () => ({
          attached: false,
          localPresence: { verdict: 'exited', runtime_generation: generation },
        }),
        fetchActiveSessions: async () => ({
          ok: true,
          sessions: [{
            coding_session_id: 'sess_data',
            label: 'data',
            machine_id: 'this-host',
            runtime_generation: generation,
          }],
        }),
        launchResumeSession: ({ entry }) => { resumed.push(entry); return 0; },
        launchFreshSession: () => assert.fail('has a native session — must resume, not restart'),
        upsertEntry: (e) => e,
      });
      assert.equal(status, 0);
      assert.equal(resumed.length, 1, 'the exited generation must not block the relaunch');
    } finally {
      if (old === undefined) delete process.env.MC_TEST_MODE;
      else process.env.MC_TEST_MODE = old;
    }
  });

  test('plain open never treats same-host naming as proof that an unreachable runtime exited', async () => {
    const old = process.env.MC_TEST_MODE;
    delete process.env.MC_TEST_MODE;
    const stdoutOut = [];
    try {
      const status = await runResume(['data'], {
        stdin: { isTTY: true },
        stdout: { isTTY: true, write: (text) => stdoutOut.push(text) },
        stderr: { write() {} },
        findEntry: () => makeEntry({
          name: 'data', branch: 'sess/data', worktree_path: '/tmp/data',
          coding_session_id: 'sess_data', tool_session_id: 'native_abc',
          session_state: 'live', tool: 'claude',
        }),
        attachLiveBrokerSession: async () => ({
          attached: false,
          localPresence: { verdict: 'unknown' },
        }),
        fetchActiveSessions: async () => ({
          ok: true,
          sessions: [{
            coding_session_id: 'sess_data',
            label: 'data',
            machine_id: 'this-host',
            runtime_generation: '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701',
          }],
        }),
        hostname: () => 'this-host',
        launchResumeSession: () => assert.fail('unknown liveness must not launch'),
        launchFreshSession: () => assert.fail('unknown liveness must not launch'),
        upsertEntry: (entry) => entry,
      });
      assert.equal(status, 0);
      assert.match(stdoutOut.join(''), /already active/);
    } finally {
      if (old === undefined) delete process.env.MC_TEST_MODE;
      else process.env.MC_TEST_MODE = old;
    }
  });

  test('plain open blocks a locally journaled live generation when its broker is unreachable', async () => {
    const old = process.env.MC_TEST_MODE;
    delete process.env.MC_TEST_MODE;
    const stderrOut = [];
    try {
      const status = await runResume(['data'], {
        stdin: { isTTY: true },
        stdout: { isTTY: true, write() {} },
        stderr: { write: (text) => stderrOut.push(text) },
        findEntry: () => makeEntry({
          name: 'data', branch: 'sess/data', worktree_path: '/tmp/data',
          coding_session_id: 'sess_data', tool_session_id: 'native_abc',
          session_state: 'live', tool: 'claude',
        }),
        attachLiveBrokerSession: async () => ({
          attached: false,
          localPresence: {
            verdict: 'unreachable',
            runtime_generation: '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701',
          },
        }),
        fetchActiveSessions: async () => ({ ok: true, sessions: [] }),
        launchResumeSession: () => assert.fail('unreachable live generation must not launch'),
        launchFreshSession: () => assert.fail('unreachable live generation must not launch'),
        upsertEntry: (entry) => entry,
      });
      assert.equal(status, 1);
      assert.match(stderrOut.join(''), /locally recorded live runtime.*refusing to start a duplicate/s);
    } finally {
      if (old === undefined) delete process.env.MC_TEST_MODE;
      else process.env.MC_TEST_MODE = old;
    }
  });

  test('plain open fails closed when cross-source active presence cannot be verified', async () => {
    const old = process.env.MC_TEST_MODE;
    delete process.env.MC_TEST_MODE;
    const stderrOut = [];
    try {
      const status = await runResume(['data'], {
        stdin: { isTTY: true },
        stdout: { isTTY: true, write() {} },
        stderr: { write: (text) => stderrOut.push(text) },
        findEntry: () => makeEntry({
          name: 'data', branch: 'sess/data', worktree_path: '/tmp/data',
          coding_session_id: 'sess_data', tool_session_id: 'native_abc',
          session_state: 'dead', tool: 'claude',
        }),
        attachLiveBrokerSession: async () => ({
          attached: false,
          localPresence: {
            verdict: 'exited',
            runtime_generation: '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701',
          },
        }),
        fetchActiveSessions: async () => ({
          ok: false,
          sessions: [],
          warning: 'control plane unavailable',
        }),
        launchResumeSession: () => assert.fail('unverified cross-source state must not launch'),
        launchFreshSession: () => assert.fail('unverified cross-source state must not launch'),
        upsertEntry: (entry) => entry,
      });
      assert.equal(status, 1);
      assert.match(stderrOut.join(''), /cannot verify.*another source.*refusing to start a duplicate/s);
    } finally {
      if (old === undefined) delete process.env.MC_TEST_MODE;
      else process.env.MC_TEST_MODE = old;
    }
  });

  test('switch refuses while the session is live locally, with the exact way out', async () => {
    const old = process.env.MC_TEST_MODE;
    delete process.env.MC_TEST_MODE;
    const stderrOut = [];
    try {
      const status = await runResume(['data', '--codex'], {
        stdin: { isTTY: true },
        stdout: { isTTY: true, write() {} },
        stderr: { write: (t) => stderrOut.push(t) },
        findEntry: () => makeEntry({
          name: 'data', branch: 'sess/data', worktree_path: '/tmp/data',
          coding_session_id: 'sess_data', session_state: 'live', tool: 'claude',
        }),
        inspectLocalBrokerSessionForEntry: async () => ({
          verdict: 'live',
          session: { id: 'sess_data', attachable: true },
        }),
        fetchActiveSessions: async () => ({ ok: true, sessions: [] }),
        launchResumeSession: () => assert.fail('must not launch'),
        launchFreshSession: () => assert.fail('must not launch'),
        upsertEntry: (e) => e,
      });
      assert.equal(status, 1);
      assert.match(stderrOut.join(''), /running here.*Ctrl\+D.*mc end data/s);
    } finally {
      if (old === undefined) delete process.env.MC_TEST_MODE;
      else process.env.MC_TEST_MODE = old;
    }
  });

  test('switch proceeds past the exact server generation after positive local exit evidence', async () => {
    const old = process.env.MC_TEST_MODE;
    delete process.env.MC_TEST_MODE;
    const freshLaunched = [];
    try {
      const status = await runResume(['data', '--codex'], {
        stdin: { isTTY: true },
        stdout: { isTTY: true, write() {} },
        stderr: { write() {} },
        findEntry: () => makeEntry({
          name: 'data', branch: 'sess/data', worktree_path: '/tmp/data',
          coding_session_id: 'sess_data', session_state: 'live', tool: 'claude',
        }),
        inspectLocalBrokerSessionForEntry: async () => ({
          verdict: 'exited',
          runtime_generation: '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701',
        }),
        fetchActiveSessions: async () => ({
          ok: true,
          sessions: [{
            coding_session_id: 'sess_data',
            label: 'data',
            machine_id: 'this-host',
            runtime_generation: '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701',
          }],
        }),
        launchResumeSession: () => assert.fail('switch must not resume the old provider'),
        launchFreshSession: ({ entry }) => { freshLaunched.push(entry); return 0; },
        upsertEntry: (e) => ({ ...makeEntry({ name: e.name, branch: 'sess/data', worktree_path: '/tmp/data', coding_session_id: 'sess_data' }), ...e }),
      });
      assert.equal(status, 0);
      assert.equal(freshLaunched.length, 1);
      assert.equal(freshLaunched[0].tool, 'codex');
    } finally {
      if (old === undefined) delete process.env.MC_TEST_MODE;
      else process.env.MC_TEST_MODE = old;
    }
  });

  test('switch stays blocked when the session is active on another machine', async () => {
    const old = process.env.MC_TEST_MODE;
    delete process.env.MC_TEST_MODE;
    const stdoutOut = [];
    try {
      const status = await runResume(['data', '--codex'], {
        stdin: { isTTY: true },
        stdout: { isTTY: true, write: (t) => stdoutOut.push(t) },
        stderr: { write() {} },
        findEntry: () => makeEntry({
          name: 'data', branch: 'sess/data', worktree_path: '/tmp/data',
          coding_session_id: 'sess_data', session_state: 'live', tool: 'claude',
        }),
        inspectLocalBrokerSessionForEntry: async () => ({ verdict: 'unknown' }),
        fetchActiveSessions: async () => ({
          ok: true,
          sessions: [{ coding_session_id: 'sess_data', label: 'data', machine_id: 'other-host' }],
        }),
        hostname: () => 'this-host',
        launchResumeSession: () => assert.fail('must not launch'),
        launchFreshSession: () => assert.fail('must not launch'),
        upsertEntry: (e) => e,
      });
      assert.equal(status, 0);
      assert.match(stdoutOut.join(''), /active/i);
    } finally {
      if (old === undefined) delete process.env.MC_TEST_MODE;
      else process.env.MC_TEST_MODE = old;
    }
  });

  test('picker resume attaches a live local session before any tool write (same tool)', async () => {
    const attached = [];
    let launched = false;
    const upserts = [];
    const status = await resumeSelectedChoice(makeEntry({
      name: 'data',
      branch: 'sess/data',
      worktree_path: '/tmp/data',
      coding_session_id: 'sess_data',
      session_state: 'live',
      tool: 'claude',
    }), {
      // Same tool as the entry → not a switch → a live session still attaches.
      opts: { tool: 'claude', noLaunch: false },
      stdout: { write() {} },
      stderr: { write() {} },
      attachLiveBrokerSession: async (entry) => {
        attached.push(entry);
        return { attached: true, code: 0, id: entry.coding_session_id };
      },
      launchResumeSession: () => {
        launched = true;
        return 0;
      },
      upsertEntry: (entry) => {
        upserts.push(entry);
        return entry;
      },
      deps: { now: () => '2026-07-11T11:00:00.000Z' },
      resolvedTool: { id: 'claude-code', shortName: 'claude' },
    });

    assert.equal(status, 0);
    assert.equal(launched, false);
    assert.deepEqual(upserts, [{
      name: 'data',
      last_opened_at: '2026-07-11T11:00:00.000Z',
    }]);
    assert.equal(attached.length, 1);
    assert.equal(attached[0].tool, 'claude');
  });

  test('picker resume switches provider with a fresh grounded launch (skips old-tool attach)', async () => {
    const attached = [];
    const freshLaunched = [];
    const upserts = [];
    const status = await resumeSelectedChoice(makeEntry({
      name: 'data',
      branch: 'sess/data',
      worktree_path: '/tmp/data',
      coding_session_id: 'sess_data',
      tool_session_id: 'claude_native_xyz',
      session_state: 'live',
      tool: 'claude',
    }), {
      opts: { tool: 'codex', noLaunch: false },
      stdout: { write() {} },
      stderr: { write() {} },
      attachLiveBrokerSession: async (entry) => {
        attached.push(entry);
        return { attached: true, code: 0, id: entry.coding_session_id };
      },
      launchFreshSession: ({ entry }) => { freshLaunched.push(entry); return 0; },
      launchResumeSession: () => assert.fail('switch must not resume the old provider'),
      upsertEntry: (entry) => {
        upserts.push(entry);
        return { ...entry };
      },
      deps: { now: () => '2026-07-11T11:00:00.000Z' },
      resolvedTool: { id: 'codex', shortName: 'codex' },
    });

    assert.equal(status, 0);
    assert.equal(attached.length, 0, 'switch skips attaching the old tool');
    assert.equal(freshLaunched.length, 1);
    assert.equal(freshLaunched[0].tool, 'codex');
    const switchPatch = upserts.find((u) => u.tool === 'codex');
    assert.ok(switchPatch, 'tool flipped to codex');
    assert.equal(switchPatch.tool_session_id, null, 'stale native transcript cleared');
    assert.equal(switchPatch.provider_sessions.providers['claude-code'].session_id, 'claude_native_xyz');
  });

  test('picker resume launches native provider resume when local broker PTY is gone', async () => {
    const resumed = [];
    const status = await resumeSelectedChoice(makeEntry({
      name: 'data',
      branch: 'sess/data',
      worktree_path: '/tmp/data',
      coding_session_id: 'sess_data',
      session_state: 'live',
      tool: 'codex',
    }), {
      opts: { noLaunch: false },
      stdin: { isTTY: true },
      stdout: { isTTY: true, write() {} },
      stderr: { write() {} },
      attachLiveBrokerSession: async () => ({ attached: false }),
      launchResumeSession: ({ entry }) => {
        resumed.push(entry);
        return 0;
      },
      deps: {
        isTTY: true,
        readLine: async () => assert.fail('resume must not ask to start a replacement session'),
      },
    });

    assert.equal(status, 0);
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0].name, 'data');
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

  test('live broker session matching normalizes cwd variants', () => {
    const sessions = [
      { id: 'by-cwd', cwd: '/tmp/data/', session_state: 'live', attachable: true },
    ];

    assert.equal(selectLiveBrokerSessionForEntry({
      name: 'data',
      worktree_path: '/tmp/data',
    }, sessions).id, 'by-cwd');
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

  test('mc open observes branch drift without overwriting the session branch', () => {
    git(repo.dir, 'branch sess/r main');
    const wt = join(repo.mcHome, 'worktrees', 'repo', 'r');
    addWorktree(repo.dir, wt, 'sess/r');
    git(wt, 'checkout -q -b scratch/from-tool');
    writeRegistry(repo.mcHome, [makeEntry({
      name: 'r', branch: 'sess/r', worktree_path: wt, tool: 'codex',
    })]);

    const r = runMc(['open', 'r', '--no-launch', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });

    assert.equal(r.status, 0, `stderr:${r.stderr}`);
    const j = parseJsonOrNull(r.stdout);
    assert.equal(j.current_branch, 'scratch/from-tool');
    assert.equal(j.original_branch, 'sess/r');

    const reg = JSON.parse(readFileSync(join(repo.mcHome, REGISTRY_REL_PATH), 'utf8'));
    const entry = reg.entries.find((e) => e.name === 'r');
    assert.equal(entry.branch, 'sess/r');
    assert.equal(entry.current_branch, 'scratch/from-tool');
    assert.equal(entry.original_branch, 'sess/r');
    assert.match(entry.observed_head, /^[a-f0-9]{40}$/);
  });

  test('--codex updates the stored session tool before first launch', () => {
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
    assert.equal(parseArgs(['r']).managedPortable, false);
    assert.equal(parseArgs(['r', '--managed-portable']).managedPortable, true);
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
        resolveToolSessionForResume: async ({ entry, launchTool }) => ({
          ok: true,
          source: launchTool.id,
          sessionId: 'cl_provider_data',
          transcriptPath: '/tmp/claude.jsonl',
          entry,
        }),
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
    assert.deepEqual(launchCalls[0].argv, ['--resume', 'cl_provider_data']);
    assert.equal(launchCalls[0].sendStartupMessage, false);
    assert.equal(launchCalls[0].localAuthMode, LOCAL_AUTH_MODES.NATIVE);
    assert.deepEqual(launchCalls[0].env, { PATH: '/bin', MC_GROUNDING_TOOL: 'codex' });
    assert.deepEqual(upserts, [{
      name: 'data',
      coding_session_id: 'sess_resume_data',
      session_state: 'live',
      tool_session_id: 'cl_provider_data',
      tool_session_source: 'claude-code',
      tool_transcript_path: '/tmp/claude.jsonl',
      provider_sessions: {
        schema: 1,
        providers: {
          'claude-code': {
            session_id: 'cl_provider_data', transcript_path: '/tmp/claude.jsonl',
            runtime_generation: null, last_consumed_handoff_sequence: 0,
          },
        },
      },
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
        resolveToolSessionForResume: async () => ({
          ok: true,
          source: 'codex',
          sessionId: 'cx_provider_data',
          transcriptPath: '/tmp/codex.jsonl',
        }),
        launchBrokerOwnedSession: async (arg) => {
          launchCalls.push(arg);
          return { code: 0 };
        },
      },
    });

    assert.equal(status, 0);
    assert.deepEqual(materialiseCalls[0].adapters, [codexAdapter]);
    assert.equal(launchCalls[0].tool, 'codex');
    assert.deepEqual(launchCalls[0].argv, ['resume', 'cx_provider_data']);
    assert.equal(launchCalls[0].sendStartupMessage, false);
  });

  test('managed resume and fresh launch skip legacy vault and local provider discovery', async () => {
    const resumeEntry = {
      name: 'managed',
      tool: 'codex',
      worktree_path: '/tmp/memoro-managed',
      tool_session_id: 'cx_provider_managed',
      tool_session_source: 'codex',
      tool_session_provider_adapter: MANAGED_CODEX_PROVIDER_ID,
      tool_session_provider_generation: MANAGED_GENERATION,
    };
    const launches = [];
    const deps = {
      materialiseVaultBeforeLaunch: async () => assert.fail('must not touch vault startup'),
      resolveToolSessionForResume: async () => assert.fail('must not inspect local provider state'),
      launchBrokerOwnedSession: async (options) => {
        launches.push(options);
        return { code: 0 };
      },
    };

    const resumeStatus = await launchResumeSession({
      entry: resumeEntry,
      localAuthMode: LOCAL_AUTH_MODES.MANAGED_PORTABLE,
      stderr: { write() {} },
      deps,
    });
    const freshStatus = await launchFreshSession({
      entry: {
        name: 'managed-fresh',
        tool: 'codex',
        worktree_path: '/tmp/memoro-managed-fresh',
      },
      localAuthMode: LOCAL_AUTH_MODES.MANAGED_PORTABLE,
      stderr: { write() {} },
      deps,
    });

    assert.equal(resumeStatus, 0);
    assert.equal(freshStatus, 0);
    assert.deepEqual(launches.map((options) => ({
      mode: options.mode,
      argv: options.argv,
      auth: options.localAuthMode,
    })), [
      {
        mode: 'resume',
        argv: ['resume', 'cx_provider_managed'],
        auth: LOCAL_AUTH_MODES.MANAGED_PORTABLE,
      },
      {
        mode: 'new',
        argv: [],
        auth: LOCAL_AUTH_MODES.MANAGED_PORTABLE,
      },
    ]);
  });

  test('prelaunch rejects padded managed or injected provider identity before broker spawn', async () => {
    for (const scenario of [
      {
        entry: {
          name: 'managed',
          tool: 'codex',
          tool_session_id: ' cx_padded',
          tool_session_provider_adapter: MANAGED_CODEX_PROVIDER_ID,
          tool_session_provider_generation: MANAGED_GENERATION,
          provider_sessions: {
            schema: 1,
            providers: {
              codex: {
                session_id: 'cx_previous',
                transcript_path: null,
                runtime_generation: null,
                last_consumed_handoff_sequence: 0,
              },
            },
          },
        },
        localAuthMode: LOCAL_AUTH_MODES.MANAGED_PORTABLE,
        deps: {},
      },
      {
        entry: { name: 'native', tool: 'codex' },
        localAuthMode: LOCAL_AUTH_MODES.NATIVE,
        deps: {
          materialiseVaultBeforeLaunch: async () => ({ ok: true, materialised: [], skipped: [] }),
          resolveToolSessionForResume: async () => ({
            ok: true,
            source: 'codex',
            sessionId: 'cx_valid',
            transcriptPath: ' relative/transcript.jsonl',
          }),
        },
      },
    ]) {
      let launched = false;
      const stderr = [];
      const status = await launchResumeSession({
        entry: scenario.entry,
        localAuthMode: scenario.localAuthMode,
        stderr: { write: (value) => stderr.push(value) },
        deps: {
          ...scenario.deps,
          launchBrokerOwnedSession: async () => {
            launched = true;
            return { code: 0 };
          },
        },
      });
      assert.equal(status, 1);
      assert.equal(launched, false);
      assert.match(stderr.join(''), /provider session state is invalid/);
    }
  });

  test('picker selections preserve managed mode for fresh and provider-native launches', async () => {
    const managedGate = () => ({
      ok: true,
      mode: LOCAL_AUTH_MODES.MANAGED_PORTABLE,
      state: 'test-ready',
      portable: true,
    });
    const launched = [];
    const common = {
      opts: {},
      apiArgv: ['--api-url', 'https://memoro.test'],
      env: { PATH: '/bin' },
      localAuthMode: LOCAL_AUTH_MODES.MANAGED_PORTABLE,
      stdin: {},
      stdout: { write() {} },
      stderr: { write() {} },
      attachLiveBrokerSession: async () => ({ attached: false }),
      upsertEntry: (patch) => patch,
      deps: {
        requireLocalAuthMode: managedGate,
      },
    };

    await resumeSelectedChoice({
      type: 'local',
      name: 'fresh',
      tool: 'codex',
      worktree_path: '/tmp/fresh',
    }, {
      ...common,
      launchFreshSession: async (options) => {
        launched.push({ kind: 'fresh', options });
        return 0;
      },
      launchResumeSession: async () => assert.fail('fresh choice must not resume'),
    });
    await resumeSelectedChoice({
      type: 'local',
      name: 'resume',
      tool: 'codex',
      worktree_path: '/tmp/resume',
      tool_session_id: 'cx_provider_resume',
      tool_session_source: 'codex',
      tool_session_provider_adapter: MANAGED_CODEX_PROVIDER_ID,
      tool_session_provider_generation: MANAGED_GENERATION,
    }, {
      ...common,
      launchFreshSession: async () => assert.fail('provider choice must resume'),
      launchResumeSession: async (options) => {
        launched.push({ kind: 'resume', options });
        return 0;
      },
    });

    assert.deepEqual(launched.map(({ kind, options }) => ({
      kind,
      localAuthMode: options.localAuthMode,
      apiArgv: options.apiArgv,
      env: options.env,
    })), [
      {
        kind: 'fresh',
        localAuthMode: LOCAL_AUTH_MODES.MANAGED_PORTABLE,
        apiArgv: ['--api-url', 'https://memoro.test'],
        env: { PATH: '/bin' },
      },
      {
        kind: 'resume',
        localAuthMode: LOCAL_AUTH_MODES.MANAGED_PORTABLE,
        apiArgv: ['--api-url', 'https://memoro.test'],
        env: { PATH: '/bin' },
      },
    ]);
  });

  test('prelaunch falls back to a fresh grounded launch when no provider session exists', async () => {
    const freshLaunched = [];
    const stderr = [];
    const status = await launchResumeSession({
      entry: {
        name: 'data',
        tool: 'codex',
        worktree_path: '/tmp/memoro-resume-data',
        coding_session_id: 'sess_keepme01',
      },
      stderr: { write: (s) => stderr.push(s) },
      deps: {
        materialiseVaultBeforeLaunch: async () => ({ ok: true, materialised: [], skipped: [] }),
        resolveToolSessionForResume: async () => ({
          ok: false,
          reason: 'no-tool-session-id',
          source: 'codex',
          transcriptPath: null,
        }),
        launchFreshSession: async ({ entry }) => { freshLaunched.push(entry); return 0; },
        launchBrokerOwnedSession: async () => {
          assert.fail('must go through the fresh grounded path, not a raw resume launch');
        },
      },
    });

    // Announced, never silent — and the fresh launch keeps the same coding
    // session so server continuity grounds the replacement.
    assert.equal(status, 0);
    assert.equal(freshLaunched.length, 1);
    assert.equal(freshLaunched[0].coding_session_id, 'sess_keepme01');
    assert.match(stderr.join(''), /no codex-native session to resume/);
    assert.match(stderr.join(''), /fresh grounded session on the same coding session/);
  });

  test('fresh launch starts a grounded tool session in the same worktree', async () => {
    const materialiseCalls = [];
    const launchCalls = [];
    const upserts = [];
    const status = await launchFreshSession({
      entry: {
        name: 'data',
        tool: 'codex',
        label: 'identity cleanup',
        focus: 'project focus',
        worktree_path: '/tmp/memoro-resume-data',
      },
      env: { PATH: '/bin' },
      stderr: { write() {} },
      deps: {
        materialiseVaultBeforeLaunch: async (arg) => {
          materialiseCalls.push(arg);
          return { ok: true, materialised: [], skipped: [] };
        },
        launchBrokerOwnedSession: async (arg) => {
          launchCalls.push(arg);
          await arg.onLaunched?.({ codingSessionId: 'sess_restart_data' });
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
    assert.deepEqual(materialiseCalls[0].adapters, [codexAdapter]);

    assert.equal(launchCalls.length, 1);
    assert.equal(launchCalls[0].cwd, '/tmp/memoro-resume-data');
    assert.equal(launchCalls[0].sessionName, 'data');
    assert.equal(launchCalls[0].tool, 'codex');
    assert.equal(launchCalls[0].focus, 'project focus');
    assert.deepEqual(launchCalls[0].argv, []);
    assert.equal(launchCalls[0].sendStartupMessage, true);
    assert.deepEqual(upserts, [{
      name: 'data',
      coding_session_id: 'sess_restart_data',
      session_state: 'live',
    }]);
  });
});
