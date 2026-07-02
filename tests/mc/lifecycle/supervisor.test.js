import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  compactSnapshotForSupervisorSync,
  collectSupervisorSnapshot,
  createSupervisorWatchManager,
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

  test('interactive prompt exits cleanly on Ctrl+C', async () => {
    const io = streams();
    const abort = new Error('Aborted with Ctrl+C');
    abort.name = 'AbortError';
    abort.code = 'ABORT_ERR';
    let closed = false;

    const code = await runSupervisor(['--local'], {
      stdout: io.stdout,
      stderr: io.stderr,
      isInteractive: true,
      createInterface: () => ({
        question: async () => { throw abort; },
        close: () => { closed = true; },
      }),
      requestBroker: async (message) => {
        assert.deepEqual(message, { type: 'sessions' });
        return { ok: true, sessions: [] };
      },
    });

    assert.equal(code, 130);
    assert.equal(closed, true);
    assert.match(io.out(), /Type `help` for commands\./);
    assert.doesNotMatch(io.out(), /AbortError/);
    assert.equal(io.err(), '');
  });

  test('interactive prompt exits cleanly on Ctrl+D / EOF', async () => {
    const io = streams();
    let closed = false;

    const code = await runSupervisor(['--local'], {
      stdout: io.stdout,
      stderr: io.stderr,
      isInteractive: true,
      createInterface: () => ({
        question: async () => undefined,
        close: () => { closed = true; },
      }),
      requestBroker: async (message) => {
        assert.deepEqual(message, { type: 'sessions' });
        return { ok: true, sessions: [] };
      },
    });

    assert.equal(code, 0);
    assert.equal(closed, true);
    assert.match(io.out(), /Type `help` for commands\./);
    assert.equal(io.err(), '');
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
        current_branch: 'feature/legal',
        dirty_files: 2,
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
        current_branch: 'feature/legal',
        dirty_files: 2,
        ahead: null,
        behind: null,
        open_question: false,
        safety_verdict: null,
        decision: {
          status: 'needs_user_reply',
          priority: 'high',
          priority_rank: 100,
          needs_user: true,
          action: 'answer_or_delegate',
          next_step: 'Answer the open question or send a concrete instruction to the session.',
          confidence: 'low',
          git: {
            branch: 'feature/legal',
            dirty_files: 2,
            ahead: null,
            behind: null,
            safety_verdict: null,
          },
        },
      }],
    });
    assert.doesNotMatch(JSON.stringify(compact), /do not sync/);
  });

  test('supervisor list tool returns prioritized decision cards', async () => {
    const io = streams();
    const appended = [];
    const turns = [];
    const outputs = new Map([
      ['sess_question', 'Should I merge this?'],
      ['sess_review', 'Min rekommendation: skapa PR och mergea efter grön CI.'],
      ['sess_working', 'Working(4s - esc to interrupt)'],
    ]);
    const result = await handleSupervisorLine('vad är viktigast nu?', {
      stdout: io.stdout,
      stderr: io.stderr,
      opts: parseSupervisorArgs([]),
      supervisorAuth: { token: 'mem_supervisor', apiUrl: 'https://meetmemoro.test' },
      request: async (message) => {
        assert.deepEqual(message, { type: 'sessions' });
        return {
          ok: true,
          sessions: [
            { id: 'sess_question', name: 'legal', session_state: 'live', attachable: true },
            { id: 'sess_review', name: 'planning', session_state: 'live', attachable: true },
            { id: 'sess_working', name: 'automation', session_state: 'live', attachable: true },
          ],
        };
      },
      readOutput: async (id) => outputs.get(id) || '',
      syncSnapshot: async () => ({ ok: true }),
      runSupervisorTurn: async (turn) => {
        turns.push(turn);
        if (turns.length === 1) {
          return {
            ok: true,
            run: {
              id: 'run_1',
              status: 'requires_tool_results',
              response: 'Jag läser sessionslistan.',
              tool_calls: [{
                id: 'call_list',
                tool: 'sessions.list',
                args: { session: null, message: null, max_output_chars: null },
              }],
            },
          };
        }

        const payload = JSON.parse(appended[0].content.replace(/^mc tool results\n/, ''));
        const toolResult = payload.results[0];
        assert.equal(toolResult.tool, 'sessions.list');
        assert.equal(toolResult.sessions.length, 3);
        assert.equal(toolResult.sessions[0].name, 'legal');
        assert.equal(toolResult.sessions[0].decision.status, 'needs_user_reply');
        assert.equal(toolResult.sessions[0].decision.priority, 'high');
        assert.equal(toolResult.sessions[0].latest_signal, 'Should I merge this?');
        assert.equal(toolResult.sessions[1].decision.status, 'review_suggested');
        assert.equal(toolResult.sessions[2].decision.status, 'working');

        return {
          ok: true,
          run: {
            id: 'run_final',
            status: 'completed',
            response: 'Prioritet: legal först, planning därefter.',
            tool_calls: [],
          },
        };
      },
      appendMessage: async (message) => {
        appended.push(message);
        return { ok: true };
      },
    });

    assert.equal(result.code, 0);
    assert.equal(turns.length, 2);
    assert.match(io.out(), /tools\n  list sessions\s+ok 3 sessions/);
    assert.match(io.out(), /supervisor\n  Prioritet: legal först/);
    assert.equal(io.err(), '');
  });

  test('supervisor prints readable run error codes', async () => {
    const io = streams();
    const result = await handleSupervisorLine('har du fått svar?', {
      stdout: io.stdout,
      stderr: io.stderr,
      opts: parseSupervisorArgs([]),
      supervisorAuth: { token: 'mem_supervisor', apiUrl: 'https://meetmemoro.test' },
      request: async (message) => {
        assert.deepEqual(message, { type: 'sessions' });
        return { ok: true, sessions: [] };
      },
      syncSnapshot: async () => ({ ok: true }),
      runSupervisorTurn: async () => ({
        ok: false,
        error: 'MC_SUPERVISOR_AI_RUN_FAILED',
        code: 'MC_SUPERVISOR_AI_RUN_FAILED',
        message: 'Supervisor AI could not complete this request. Try again.',
        retryable: true,
        cause_code: 'PROVIDER_SCHEMA_FAILURE',
      }),
    });

    assert.equal(result.code, 1);
    assert.equal(io.out(), '');
    assert.match(io.err(), /mc: MC_SUPERVISOR_AI_RUN_FAILED/);
    assert.match(io.err(), /Supervisor AI could not complete this request/);
    assert.match(io.err(), /Try again\. If it keeps failing, share this error code\./);
    assert.match(io.err(), /cause: PROVIDER_SCHEMA_FAILURE/);
    assert.doesNotMatch(io.err(), /Memoro 502/);
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

  test('natural language prompt runs the synced supervisor and executes session sends', async () => {
    const io = streams();
    const dispatches = [];
    const turns = [];
    const appended = [];
    const result = await handleSupervisorLine('be legal fortsätta med Apple-svaret', {
      stdout: io.stdout,
      stderr: io.stderr,
      opts: parseSupervisorArgs([]),
      supervisorAuth: { token: 'mem_supervisor', apiUrl: 'https://meetmemoro.test' },
      request: async (message) => {
        assert.deepEqual(message, { type: 'sessions' });
        return {
          ok: true,
          sessions: [{
            id: 'sess_a',
            name: 'legal',
            session_state: 'live',
            attachable: true,
            last_output_at: '2026-06-22T07:59:30.000Z',
          }],
        };
      },
      readOutput: async () => 'Idle.',
      syncSnapshot: async () => ({ ok: true }),
      runSupervisorTurn: async (turn) => {
        turns.push(turn);
        if (turn.message) {
          assert.equal(turn.message.content, 'be legal fortsätta med Apple-svaret');
          return {
            ok: true,
            run: {
              id: 'run_1',
              status: 'requires_tool_results',
              response: 'Jag skickar det till legal.',
              tool_calls: [{
                id: 'call_1',
                tool: 'sessions.send',
                args: {
                  session: 'legal',
                  message: 'Fortsätt med Apple-svaret enligt användarens senaste riktning.',
                  max_output_chars: null,
                },
                reason: 'Steer the legal session.',
              }],
            },
          };
        }
        assert.deepEqual(turn, { continue: true });
        return {
          ok: true,
          run: {
            id: 'run_2',
            status: 'completed',
            response: 'Skickat.',
            tool_calls: [],
          },
        };
      },
      dispatch: async (identifier, message) => {
        dispatches.push({ identifier, message });
        return { ok: true, id: 'sess_a' };
      },
      appendMessage: async (message) => {
        appended.push(message);
        return { ok: true };
      },
    });

    assert.equal(result.code, 0);
    assert.equal(turns.length, 2);
    assert.deepEqual(dispatches, [{
      identifier: 'legal',
      message: 'Fortsätt med Apple-svaret enligt användarens senaste riktning.',
    }]);
    assert.equal(appended.length, 1);
    assert.equal(appended[0].role, 'system');
    assert.match(appended[0].content, /mc tool results/);
    assert.match(appended[0].content, /"tool":"sessions.send"/);
    assert.match(io.out(), /supervisor\n  Jag skickar det till legal/);
    assert.match(io.out(), /tools\n  send legal\s+sent sess_a/);
    assert.match(io.out(), /supervisor\n  Skickat/);
    assert.equal(io.err(), '');
  });

  test('supervisor watch tool creates a local watch and continues cleanly', async () => {
    const io = streams();
    const turns = [];
    const watchAdds = [];
    const appended = [];
    const result = await handleSupervisorLine('säg till när legal är klar', {
      stdout: io.stdout,
      stderr: io.stderr,
      opts: parseSupervisorArgs(['--no-output']),
      supervisorAuth: { token: 'mem_supervisor', apiUrl: 'https://meetmemoro.test' },
      request: async (message) => {
        assert.deepEqual(message, { type: 'sessions' });
        return {
          ok: true,
          sessions: [{
            id: 'sess_a',
            name: 'legal',
            session_state: 'live',
            attachable: true,
            last_output_at: '2026-06-22T07:59:30.000Z',
          }],
        };
      },
      readOutput: async () => 'Working(4s - esc to interrupt)',
      syncSnapshot: async () => ({ ok: true }),
      watchManager: {
        add: async (args) => {
          watchAdds.push(args);
          return {
            ok: true,
            watch: {
              id: 'watch_1',
              session: 'legal',
              session_id: 'sess_a',
              session_name: 'legal',
              condition: 'done_or_review',
              interval_seconds: 20,
              timeout_minutes: 30,
            },
          };
        },
      },
      runSupervisorTurn: async (turn) => {
        turns.push(turn);
        if (turn.message) {
          return {
            ok: true,
            run: {
              id: 'run_1',
              status: 'requires_tool_results',
              response: 'Jag sätter en bevakning.',
              tool_calls: [{
                id: 'call_watch',
                tool: 'sessions.watch',
                args: {
                  session: 'legal',
                  message: null,
                  max_output_chars: null,
                  condition: 'done_or_review',
                  description: 'Säg till när legal är klar eller behöver review.',
                  interval_seconds: 20,
                  timeout_minutes: 30,
                },
                reason: 'User asked for a later notification.',
              }],
            },
          };
        }
        return {
          ok: true,
          run: {
            id: 'run_2',
            status: 'completed',
            response: 'Jag säger till när den är klar.',
            tool_calls: [],
          },
        };
      },
      appendMessage: async (message) => {
        appended.push(message);
        return { ok: true };
      },
    });

    assert.equal(result.code, 0);
    assert.equal(watchAdds.length, 1);
    assert.equal(watchAdds[0].condition, 'done_or_review');
    assert.equal(turns.length, 2);
    assert.match(appended[0].content, /"tool":"sessions.watch"/);
    assert.match(io.out(), /tools\n  watch legal\s+every 20s, timeout 30m/);
    assert.match(io.out(), /supervisor\n  Jag säger till när den är klar/);
    assert.equal(io.err(), '');
  });

  test('supervisor reuses duplicate read results within one prompt', async () => {
    const io = streams();
    const turns = [];
    const appended = [];
    let readCount = 0;
    const result = await handleSupervisorLine('kolla legal', {
      stdout: io.stdout,
      stderr: io.stderr,
      opts: parseSupervisorArgs(['--no-output']),
      supervisorAuth: { token: 'mem_supervisor', apiUrl: 'https://meetmemoro.test' },
      request: async (message) => {
        assert.deepEqual(message, { type: 'sessions' });
        return {
          ok: true,
          sessions: [{
            id: 'sess_a',
            name: 'legal',
            session_state: 'live',
            attachable: true,
            last_output_at: '2026-06-22T07:59:30.000Z',
          }],
        };
      },
      readOutput: async () => {
        readCount += 1;
        return 'Ready for review.';
      },
      syncSnapshot: async () => ({ ok: true }),
      runSupervisorTurn: async (turn) => {
        turns.push(turn);
        if (turns.length <= 2) {
          return {
            ok: true,
            run: {
              id: `run_${turns.length}`,
              status: 'requires_tool_results',
              response: turns.length === 1 ? 'Jag läser legal.' : 'Jag läser legal igen.',
              tool_calls: [{
                id: `call_${turns.length}`,
                tool: 'sessions.read',
                args: {
                  session: 'legal',
                  message: null,
                  max_output_chars: null,
                },
              }],
            },
          };
        }
        return {
          ok: true,
          run: {
            id: 'run_final',
            status: 'completed',
            response: 'Legal är redo för review.',
            tool_calls: [],
          },
        };
      },
      appendMessage: async (message) => {
        appended.push(message);
        return { ok: true };
      },
    });

    assert.equal(result.code, 0);
    assert.equal(readCount, 1);
    assert.equal(turns.length, 3);
    {
      const payload = JSON.parse(appended[0].content.replace(/^mc tool results\n/, ''));
      const toolResult = payload.results[0];
      assert.equal(toolResult.tool, 'sessions.read');
      assert.equal(toolResult.decision.status, 'ready_to_review');
      assert.equal(toolResult.decision.action, 'review_decide');
      assert.equal(toolResult.evidence_excerpt, 'Ready for review.');
    }
    assert.match(appended[1].content, /"cached":true/);
    assert.match(io.out(), /tools\n  read legal\s+cached sess_a/);
    assert.match(io.out(), /supervisor\n  Legal är redo för review/);
    assert.equal(io.err(), '');
  });

  test('supervisor finalizes instead of failing when tool rounds are exhausted', async () => {
    const io = streams();
    const turns = [];
    const appended = [];
    const result = await handleSupervisorLine('vad är viktigast nu?', {
      stdout: io.stdout,
      stderr: io.stderr,
      opts: parseSupervisorArgs([]),
      supervisorAuth: { token: 'mem_supervisor', apiUrl: 'https://meetmemoro.test' },
      request: async (message) => {
        assert.deepEqual(message, { type: 'sessions' });
        return {
          ok: true,
          sessions: [
            { id: 'sess_a', name: 'legal', session_state: 'live', attachable: true },
            { id: 'sess_b', name: 'planning', session_state: 'live', attachable: true },
            { id: 'sess_c', name: 'automation', session_state: 'live', attachable: true },
          ],
        };
      },
      readOutput: async (_id, session) => `${session.name} status`,
      syncSnapshot: async () => ({ ok: true }),
      runSupervisorTurn: async (turn) => {
        turns.push(turn);
        if (turns.length <= 3) {
          const session = ['legal', 'planning', 'automation'][turns.length - 1];
          return {
            ok: true,
            run: {
              id: `run_${turns.length}`,
              status: 'requires_tool_results',
              response: `Jag läser ${session}.`,
              tool_calls: [{
                id: `call_${turns.length}`,
                tool: 'sessions.read',
                args: {
                  session,
                  message: null,
                  max_output_chars: null,
                },
              }],
            },
          };
        }
        assert.deepEqual(turn, { continue: true });
        return {
          ok: true,
          run: {
            id: 'run_final',
            status: 'requires_tool_results',
            response: 'Prioritet: legal först, planning därefter, automation sist.',
            tool_calls: [{
              id: 'call_ignored',
              tool: 'sessions.read',
              args: {
                session: 'legal',
                message: null,
                max_output_chars: null,
              },
            }],
          },
        };
      },
      appendMessage: async (message) => {
        appended.push(message);
        return { ok: true };
      },
    });

    assert.equal(result.code, 0);
    assert.equal(turns.length, 4);
    assert.match(appended.at(-1).content, /tool budget/);
    assert.match(io.out(), /supervisor\n  Prioritet: legal först/);
    assert.doesNotMatch(io.err(), /stopped after/);
  });

  test('local watch manager triggers a follow-up supervisor run when a session becomes idle', async () => {
    const io = streams();
    const appended = [];
    const turns = [];
    let now = NOW;
    let output = 'Working(4s - esc to interrupt)';
    const session = {
      id: 'sess_a',
      name: 'legal',
      session_state: 'live',
      attachable: true,
      last_output_at: '2026-06-22T07:59:30.000Z',
    };
    const context = {
      stdout: io.stdout,
      stderr: io.stderr,
      opts: parseSupervisorArgs([]),
      supervisorAuth: { token: 'mem_supervisor', apiUrl: 'https://meetmemoro.test' },
      interactive: true,
      now: () => now,
      request: async (message) => {
        assert.deepEqual(message, { type: 'sessions' });
        return { ok: true, sessions: [session] };
      },
      readOutput: async () => output,
      appendMessage: async (message) => {
        appended.push(message);
        return { ok: true };
      },
      runSupervisorTurn: async (turn) => {
        turns.push(turn);
        return {
          ok: true,
          run: {
            id: 'run_followup',
            status: 'completed',
            response: 'Legal är klar och redo för review.',
            tool_calls: [],
          },
        };
      },
    };
    const manager = createSupervisorWatchManager(context, { disableTimers: true });
    const added = await manager.add({
      session: 'legal',
      condition: 'idle_after_work',
      description: 'Säg till när legal är klar.',
      interval_seconds: 5,
      timeout_minutes: 30,
    });
    assert.equal(added.ok, true);

    now += 5000;
    output = 'Done. Tests passed. Ready for review.';
    await manager.tick(added.watch.id);

    assert.equal(manager.list().length, 0);
    assert.equal(appended.length, 1);
    assert.match(appended[0].content, /mc watch event/);
    assert.match(appended[0].content, /idle_after_work/);
    assert.deepEqual(turns, [{ continue: true }]);
    assert.match(io.out(), /watch legal/);
    assert.match(io.out(), /triggered:/);
    assert.match(io.out(), /supervisor\n  Legal är klar och redo för review/);
    assert.equal(io.err(), '');
  });

  test('local watch manager refuses missing sessions', async () => {
    const io = streams();
    const manager = createSupervisorWatchManager({
      stdout: io.stdout,
      stderr: io.stderr,
      opts: parseSupervisorArgs([]),
      request: async (message) => {
        assert.deepEqual(message, { type: 'sessions' });
        return { ok: true, sessions: [] };
      },
      readOutput: async () => {
        throw new Error('readOutput should not be called');
      },
      now: () => NOW,
    }, { disableTimers: true });

    const added = await manager.add({
      session: 'missing',
      condition: 'done_or_review',
      description: 'Säg till när missing är klar.',
      interval_seconds: 5,
      timeout_minutes: 30,
    });

    assert.equal(added.ok, false);
    assert.match(added.error, /local session not found: missing/);
    assert.equal(manager.list().length, 0);
    assert.equal(io.out(), '');
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
