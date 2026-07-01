import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  compactSnapshotForSupervisorSync,
  collectSupervisorSnapshot,
  handleSupervisorLine,
  parseSupervisorArgs,
  renderSupervisorHelp,
  renderSupervisorSnapshot,
  run as runSupervisor,
} from '../../../src/mc/commands/supervisor.js';

const NOW = Date.parse('2026-06-22T08:00:00.000Z');

function streams() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    out: () => stdout,
    err: () => stderr,
  };
}

describe('mc supervisor', () => {
  test('parses one-shot snapshot flags', () => {
    const opts = parseSupervisorArgs([
      '--json',
      '--no-output',
      '--include-dead',
      '--only',
      'active',
      '--exclude-worktree',
      'coord',
      '--output-timeout',
      '25',
    ]);

    assert.equal(opts.json, true);
    assert.equal(opts.readOutput, false);
    assert.equal(opts.includeDead, true);
    assert.deepEqual(opts.onlyDispositions, ['awaiting_reply', 'review_suggested', 'working']);
    assert.deepEqual(opts.excludeWorktreeNames, ['coord']);
    assert.equal(opts.outputTimeoutMs, 25);
  });

  test('run emits JSON snapshot without entering the prompt', async () => {
    const io = streams();
    const synced = [];
    const code = await runSupervisor(['--json'], {
      stdout: io.stdout,
      stderr: io.stderr,
      isInteractive: false,
      now: NOW,
      ensureSupervisorAuth: async () => ({
        ok: true,
        token: 'mem_supervisor',
        apiUrl: 'https://meetmemoro.test',
        scope: 'mc.supervisor',
      }),
      syncSnapshot: async (snapshot, { auth }) => {
        synced.push({ snapshot, auth });
        return { ok: true };
      },
      requestBroker: async (message) => {
        assert.deepEqual(message, { type: 'sessions' });
        return {
          ok: true,
          sessions: [{
            id: 'sess_a',
            name: 'legal',
            tool: 'codex',
            cwd: '/repo/legal',
            session_state: 'live',
            attachable: true,
            last_output_at: '2026-06-22T07:59:30.000Z',
          }],
        };
      },
      readOutput: async (id, session) => {
        assert.equal(id, 'sess_a');
        assert.equal(session.name, 'legal');
        return 'Should I merge this?';
      },
    });

    assert.equal(code, 0);
    assert.equal(io.err(), '');
    const parsed = JSON.parse(io.out());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.sessions[0].id, 'sess_a');
    assert.equal(parsed.sessions[0].disposition, 'awaiting_reply');
    assert.equal(synced.length, 1);
    assert.equal(synced[0].auth.token, 'mem_supervisor');
    assert.equal(synced[0].snapshot.sessions[0].latest_text, undefined);
  });

  test('run requires scoped supervisor auth by default', async () => {
    const io = streams();
    const code = await runSupervisor(['--json'], {
      stdout: io.stdout,
      stderr: io.stderr,
      isInteractive: false,
      ensureSupervisorAuth: async () => ({ ok: false, code: 71, error: 'scoped auth failed' }),
      requestBroker: async () => {
        throw new Error('broker should not be read without supervisor auth');
      },
    });

    assert.equal(code, 71);
    assert.match(io.err(), /scoped auth failed/);
    assert.equal(io.out(), '');
  });

  test('--local skips scoped supervisor auth for offline broker inspection', async () => {
    const io = streams();
    const code = await runSupervisor(['--json', '--local', '--no-output'], {
      stdout: io.stdout,
      stderr: io.stderr,
      isInteractive: false,
      ensureSupervisorAuth: async () => {
        throw new Error('scoped auth should be skipped');
      },
      now: NOW,
      requestBroker: async () => ({
        ok: true,
        sessions: [{ id: 'sess_a', name: 'local-only', session_state: 'live', attachable: true }],
      }),
    });

    assert.equal(code, 0);
    assert.equal(io.err(), '');
    const parsed = JSON.parse(io.out());
    assert.equal(parsed.sessions[0].id, 'sess_a');
  });

  test('renders supervisor snapshot as grouped control board', () => {
    const output = renderSupervisorSnapshot({
      ok: true,
      generated_at: '2026-07-01T14:12:26.575Z',
      counts: { review_suggested: 1, working: 1, stale_idle: 1 },
      sessions: [
        {
          id: 'sess_review',
          name: 'app-name',
          disposition: 'review_suggested',
          state: 'live',
          last_output_age_seconds: 10,
          latest_text: 'Svara inte Apple om att saken är löst ännu. Om Till svarar med konkret registrering eller invändning, hantera det då.',
          command: 'mc sessions send sess_review "<message>"',
        },
        {
          id: 'sess_work',
          name: 'chat-mobil',
          disposition: 'working',
          state: 'live',
          last_output_age_seconds: 1,
          latest_text: 'Working(13m 59s - esc to interrupt) dropdowns are being checked.',
        },
        {
          id: 'sess_stale',
          name: 'planning',
          disposition: 'stale_idle',
          state: 'live',
          last_output_age_seconds: 7200,
          latest_text: 'Rekommenderad ordning nu: färdigställ hero-kontraktet och scroll/active-beteendet.',
        },
      ],
    });

    assert.match(output, /^mc supervisor sessions/m);
    assert.match(output, /summary review_suggested=1 working=1 stale_idle=1/);
    assert.match(output, /Review suggested \(1\)/);
    assert.match(output, /Working \(1\)/);
    assert.match(output, /Stale idle \(1\)/);
    assert.match(output, /app-name\s+10s ago\s+live\s+Svara inte Apple/);
    assert.match(output, /Commands\n  read <session>/);
    assert.doesNotMatch(output, /send: mc sessions send/);
    assert.ok(output.split('\n').every((line) => line.length <= 128), output);
  });

  test('logout subcommand delegates to supervisor logout without auth or broker reads', async () => {
    const io = streams();
    const calls = [];
    const code = await runSupervisor(['logout'], {
      stdout: io.stdout,
      stderr: io.stderr,
      logoutSupervisor: async ({ argv }) => {
        calls.push(argv);
        return 0;
      },
      ensureSupervisorAuth: async () => {
        throw new Error('auth should not run for logout');
      },
      requestBroker: async () => {
        throw new Error('broker should not be read for logout');
      },
    });

    assert.equal(code, 0);
    assert.deepEqual(calls, [['logout']]);
  });

  test('compactSnapshotForSupervisorSync strips local transcript text and paths', () => {
    const compact = compactSnapshotForSupervisorSync({
      ok: true,
      generated_at: '2026-07-01T10:00:00.000Z',
      counts: { awaiting_reply: 1 },
      sessions: [{
        id: 'sess_a',
        name: 'legal',
        tool: 'codex',
        cwd: '/Users/me/private/repo/legal',
        worktree_name: 'legal',
        state: 'live',
        attachable: true,
        disposition: 'awaiting_reply',
        latest_text: 'do not sync transcript tails',
        recommended_reply: 'do not sync recommended replies',
      }],
    });

    assert.deepEqual(compact, {
      ok: true,
      generated_at: '2026-07-01T10:00:00.000Z',
      counts: { awaiting_reply: 1 },
      sessions: [{
        id: 'sess_a',
        name: 'legal',
        tool: 'codex',
        worktree_name: 'legal',
        state: 'live',
        attachable: true,
        disposition: 'awaiting_reply',
        last_output_at: null,
        last_input_at: null,
        last_output_age_seconds: null,
      }],
    });
  });

  test('collects local broker snapshots with injected output readers', async () => {
    const snapshot = await collectSupervisorSnapshot({
      opts: parseSupervisorArgs([]),
      stderr: streams().stderr,
      now: NOW,
      request: async (message) => {
        if (message.type === 'sessions') {
          return {
            ok: true,
            sessions: [
              { id: 'sess_working', cwd: '/repo/work', session_state: 'live', attachable: true },
              { id: 'sess_idle', cwd: '/repo/idle', session_state: 'live', attachable: true },
            ],
          };
        }
        throw new Error(`unexpected request: ${message.type}`);
      },
      readOutput: async (id) => id === 'sess_working'
        ? 'Working(4s - esc to interrupt)'
        : 'Done.',
    });

    assert.deepEqual(snapshot.sessions.map((session) => session.id), ['sess_working', 'sess_idle']);
    assert.deepEqual(snapshot.counts, { working: 1, idle: 1 });
  });

  test('send command dispatches through the injected local dispatcher', async () => {
    const io = streams();
    const calls = [];
    const result = await handleSupervisorLine('send legal ship it', {
      stdout: io.stdout,
      stderr: io.stderr,
      dispatch: async (identifier, message) => {
        calls.push({ identifier, message });
        return { ok: true, id: 'sess_a' };
      },
    });

    assert.equal(result.code, 0);
    assert.deepEqual(calls, [{ identifier: 'legal', message: 'ship it' }]);
    assert.match(io.out(), /sent to sess_a/);
    assert.equal(io.err(), '');
  });

  test('read command resolves a session name and prints recent output', async () => {
    const io = streams();
    const result = await handleSupervisorLine('read legal', {
      stdout: io.stdout,
      stderr: io.stderr,
      request: async (message) => {
        assert.deepEqual(message, { type: 'sessions' });
        return { ok: true, sessions: [{ id: 'sess_a', name: 'legal', cwd: '/repo/legal' }] };
      },
      readOutput: async (id, session) => {
        assert.equal(id, 'sess_a');
        assert.equal(session.name, 'legal');
        return 'Recent terminal output';
      },
    });

    assert.equal(result.code, 0);
    assert.match(io.out(), /--- legal \(sess_a\) ---/);
    assert.match(io.out(), /Recent terminal output/);
    assert.equal(io.err(), '');
  });

  test('stop command asks for confirmation before local control', async () => {
    const io = streams();
    const calls = [];
    const result = await handleSupervisorLine('stop legal', {
      stdout: io.stdout,
      stderr: io.stderr,
      request: async () => ({ ok: true, sessions: [{ id: 'sess_a', name: 'legal' }] }),
      confirm: async (question) => {
        assert.match(question, /stop legal\?/);
        return true;
      },
      control: async (identifier, args) => {
        calls.push({ identifier, args });
        return { ok: true, id: 'sess_a' };
      },
    });

    assert.equal(result.code, 0);
    assert.deepEqual(calls, [{ identifier: 'sess_a', args: { action: 'stop', signal: 'SIGTERM' } }]);
    assert.match(io.out(), /stopped sess_a/);
    assert.equal(io.err(), '');
  });

  test('help documents the supervisor control prompt', () => {
    const help = renderSupervisorHelp();
    assert.match(help, /mc supervisor/);
    assert.match(help, /send <label\|id> <message>/);
    assert.match(help, /mc supervisor --json/);
  });
});
