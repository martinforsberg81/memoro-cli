import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { BrokerRuntime } from '../../../src/mc/broker/runtime.js';

function makeFakePtyFactory() {
  const ptys = [];
  const calls = [];
  const factory = {
    spawn(bin, args, options) {
      let dataHandler = null;
      let exitHandler = null;
      const pty = {
        pid: 9100 + ptys.length,
        writes: [],
        resizes: [],
        kills: [],
        onData(handler) { dataHandler = handler; },
        onExit(handler) { exitHandler = handler; },
        write(data) { this.writes.push(data); },
        resize(cols, rows) { this.resizes.push({ cols, rows }); },
        kill(signal) { this.kills.push(signal); },
        emitData(data) { dataHandler?.(data); },
        emitExit(event) { exitHandler?.(event); },
      };
      calls.push({ bin, args, options });
      ptys.push(pty);
      return pty;
    },
  };
  return { factory, calls, ptys };
}

function makeLaunchResolver({ ok = true } = {}) {
  const calls = [];
  return {
    calls,
    resolve(toolInput) {
      calls.push(toolInput);
      if (!ok) {
        return { ok: false, reason: 'missing-bin', hint: `missing ${toolInput}` };
      }
      return {
        ok: true,
        id: 'claude-code',
        shortName: 'claude',
        spec: {
          bin: 'claude',
          args: (argv = []) => ['--wrapped', ...argv],
        },
      };
    },
  };
}

function makeRuntime(opts = {}) {
  const fake = makeFakePtyFactory();
  const resolver = makeLaunchResolver(opts.launch || {});
  const sidecars = [];
  let now = 1_000;
  const runtime = new BrokerRuntime({
    ptyFactory: fake.factory,
    launchResolver: resolver.resolve.bind(resolver),
    env: { BASE: '1', MC_GROUNDING_TOOL: 'codex' },
    cwd: () => '/fallback',
    clock: () => now,
    sidecarFactory: (spec) => {
      const sidecar = {
        spec,
        started: false,
        stopped: false,
        start() { this.started = true; },
        stop() { this.stopped = true; },
      };
      sidecars.push(sidecar);
      return sidecar;
    },
  });
  return {
    runtime,
    fake,
    resolver,
    sidecars,
    tick(ms = 1) {
      now += ms;
      return now;
    },
  };
}

describe('BrokerRuntime', () => {
  test('launch_session resolves the tool locally and creates an owned PTY session', () => {
    const { runtime, fake, resolver } = makeRuntime();

    const res = runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_a',
        name: 'alpha',
        cwd: '/repo/a',
        tool: 'claude',
        argv: ['--resume'],
        cols: 120,
        rows: 32,
        env: { EXTRA: '2' },
      },
    });

    assert.equal(res.ok, true);
    assert.equal(res.session.id, 'sess_a');
    assert.equal(res.session.name, 'alpha');
    assert.equal(res.session.tool, 'claude');
    assert.equal(res.session.pty_pid, 9100);
    assert.deepEqual(resolver.calls, ['claude']);
    assert.deepEqual(fake.calls[0].args, ['--wrapped', '--resume']);
    assert.equal(fake.calls[0].options.cwd, '/repo/a');
    assert.equal(fake.calls[0].options.cols, 120);
    assert.equal(fake.calls[0].options.rows, 32);
    assert.equal(fake.calls[0].options.env.BASE, '1');
    assert.equal(fake.calls[0].options.env.EXTRA, '2');
    assert.equal(fake.calls[0].options.env.MEMORO_MC_BROKER, '1');
    assert.equal(fake.calls[0].options.env.MEMORO_MC_PARENT, '1');
  });

  test('launch_session defaults tool, cwd, terminal size, and argv', () => {
    const { runtime, fake, resolver } = makeRuntime();

    const res = runtime.handle({ type: 'launch_session', session: { id: 'sess_a' } });

    assert.equal(res.ok, true);
    assert.deepEqual(resolver.calls, ['codex']);
    assert.equal(fake.calls[0].options.cwd, '/fallback');
    assert.equal(fake.calls[0].options.cols, 80);
    assert.equal(fake.calls[0].options.rows, 24);
    assert.deepEqual(fake.calls[0].args, ['--wrapped']);
  });

  test('launch_session repairs headless terminal env before spawning the PTY', () => {
    const { runtime, fake } = makeRuntime();

    const res = runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_a',
        term_name: 'dumb',
        env: {
          TERM: 'dumb',
          NO_COLOR: '1',
          CLICOLOR: '0',
        },
      },
    });

    assert.equal(res.ok, true);
    assert.equal(fake.calls[0].options.name, 'xterm-256color');
    assert.equal(fake.calls[0].options.env.TERM, 'xterm-256color');
    assert.equal(fake.calls[0].options.env.NO_COLOR, undefined);
    assert.equal(fake.calls[0].options.env.CLICOLOR, undefined);
    assert.equal(fake.calls[0].options.env.COLORTERM, 'truecolor');
  });

  test('launch_session can unset runtime-only secrets before spawning the provider', () => {
    const { runtime, fake } = makeRuntime();

    const res = runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_a',
        env: {
          MEMORO_TOKEN: 'mem_runtime_secret_123456789',
          OPENAI_API_KEY: 'sk-secretvalue123456789',
          SAFE_VISIBLE: '1',
        },
        env_unset: ['MEMORO_TOKEN', 'OPENAI_API_KEY'],
      },
    });

    assert.equal(res.ok, true);
    assert.equal(fake.calls[0].options.env.MEMORO_TOKEN, undefined);
    assert.equal(fake.calls[0].options.env.OPENAI_API_KEY, undefined);
    assert.equal(fake.calls[0].options.env.SAFE_VISIBLE, '1');
  });

  test('list and status expose live broker sessions', () => {
    const { runtime } = makeRuntime();

    runtime.handle({ type: 'launch_session', session: { id: 'sess_a' } });

    assert.deepEqual(runtime.handle({ type: 'sessions' }).sessions.map((s) => s.id), ['sess_a']);
    const status = runtime.handle({ type: 'session_status', id: 'sess_a' });
    assert.equal(status.ok, true);
    assert.equal(status.session.id, 'sess_a');
    assert.equal(status.session.session_state, 'live');
  });

  test('list exposes repo and worktree metadata for browser session lists', () => {
    const { runtime } = makeRuntime();

    runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_a',
        name: 'alpha',
        cwd: '/Users/me/.memoro/mc/worktrees/memoro-cli/alpha',
        sidecars: {
          repo: 'memoro-cli',
          branch: 'sess/alpha',
          worktreeName: 'alpha',
        },
      },
    });

    const [session] = runtime.handle({ type: 'sessions' }).sessions;
    assert.equal(session.name, 'alpha');
    assert.equal(session.repo, 'memoro-cli');
    assert.equal(session.branch, 'sess/alpha');
    assert.equal(session.worktree_name, 'alpha');
  });

  test('list derives repo and worktree metadata from cwd for older sessions', () => {
    const { runtime } = makeRuntime();

    runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_a',
        cwd: '/Users/me/.memoro/mc/worktrees/memoro-cli/smoke-test',
      },
    });

    const [session] = runtime.handle({ type: 'sessions' }).sessions;
    assert.equal(session.repo, 'memoro-cli');
    assert.equal(session.worktree_name, 'smoke-test');
  });

  test('write, dispatch, resize, stop, and remove forward to the session manager', () => {
    const { runtime, fake } = makeRuntime();

    runtime.handle({ type: 'launch_session', session: { id: 'sess_a' } });

    assert.equal(runtime.handle({ type: 'write_session', id: 'sess_a', data: 'raw' }).ok, true);
    assert.equal(runtime.handle({ type: 'dispatch_session', id: 'sess_a', message: 'prompt' }).ok, true);
    assert.equal(runtime.handle({ type: 'resize_session', id: 'sess_a', cols: 100, rows: 40 }).ok, true);
    assert.equal(runtime.handle({ type: 'stop_session', id: 'sess_a', signal: 'SIGHUP' }).ok, true);
    assert.deepEqual(fake.ptys[0].writes, ['raw', 'prompt\r']);
    assert.deepEqual(fake.ptys[0].resizes, [{ cols: 100, rows: 40 }]);
    assert.deepEqual(fake.ptys[0].kills, ['SIGHUP']);

    const removed = runtime.handle({ type: 'remove_session', id: 'sess_a' });
    assert.deepEqual(removed, { ok: true, removed: true });
    assert.deepEqual(runtime.handle({ type: 'sessions' }), { ok: true, sessions: [] });
  });

  test('fetch_session_output returns recent PTY output without attaching', () => {
    const { runtime, fake } = makeRuntime();

    runtime.handle({ type: 'launch_session', session: { id: 'sess_a' } });
    fake.ptys[0].emitData('hello');
    fake.ptys[0].emitData(' world');

    const res = runtime.handle({ type: 'fetch_session_output', id: 'sess_a' });

    assert.equal(res.ok, true);
    assert.equal(res.output, 'hello world');
    assert.equal(res.session.id, 'sess_a');
    assert.equal(res.session.session_state, 'live');
    assert.equal(res.session.attachable, true);
  });

  test('attachConnection bridges a raw socket to an owned PTY session', () => {
    const { runtime, fake } = makeRuntime();
    const writes = [];
    const conn = {
      handlers: new Map(),
      write(data) { writes.push(String(data)); },
      end() {
        this.ended = true;
        this.handlers.get('end')?.();
      },
      on(event, handler) { this.handlers.set(event, handler); },
      off(event, handler) {
        if (this.handlers.get(event) === handler) this.handlers.delete(event);
      },
      emit(event, value) { this.handlers.get(event)?.(value); },
    };

    runtime.handle({ type: 'launch_session', session: { id: 'sess_a' } });
    fake.ptys[0].emitData('snapshot');

    const res = runtime.attachConnection({ id: 'sess_a', cols: 100, rows: 40 }, conn, Buffer.from('first'));

    assert.equal(res.ok, true);
    assert.equal(JSON.parse(writes[0]).ok, true);
    assert.equal(writes[1], 'snapshot');
    assert.deepEqual(fake.ptys[0].resizes, [{ cols: 100, rows: 40 }]);
    assert.deepEqual(fake.ptys[0].writes, ['first']);

    conn.emit('data', Buffer.from('input'));
    fake.ptys[0].emitData('output');
    assert.deepEqual(fake.ptys[0].writes, ['first', 'input']);
    assert.equal(writes.at(-1), 'output');

    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    assert.equal(conn.ended, true);
  });

  test('attachConnection lets parallel attaches write to the same PTY', () => {
    const { runtime, fake } = makeRuntime();
    const makeConn = () => {
      const writes = [];
      return {
        writes,
        handlers: new Map(),
        write(data) { writes.push(String(data)); },
        end() { this.handlers.get('end')?.(); },
        on(event, handler) { this.handlers.set(event, handler); },
        off(event, handler) {
          if (this.handlers.get(event) === handler) this.handlers.delete(event);
        },
        emit(event, value) { this.handlers.get(event)?.(value); },
      };
    };

    runtime.handle({ type: 'launch_session', session: { id: 'sess_a' } });
    const first = makeConn();
    const second = makeConn();

    runtime.attachConnection({ id: 'sess_a', attach_id: 'att_first' }, first);
    runtime.attachConnection({ id: 'sess_a', attach_id: 'att_second' }, second);

    assert.equal(JSON.parse(first.writes[0]).writer, true);
    assert.equal(JSON.parse(second.writes[0]).writer, true);
    assert.equal(JSON.parse(second.writes[0]).attach.mode, 'write');
    assert.deepEqual(runtime.listSessions()[0].attached.map((a) => a.attach_id), ['att_first', 'att_second']);
    assert.equal(runtime.listSessions()[0].writer_attach_id, null);

    first.emit('data', Buffer.from('yes'));
    second.emit('data', Buffer.from('no'));
    assert.deepEqual(fake.ptys[0].writes, ['yes', 'no']);

    first.emit('end');
    assert.equal(runtime.listSessions()[0].writer_attach_id, null);

    const next = makeConn();
    runtime.attachConnection({ id: 'sess_a', attach_id: 'att_next' }, next);
    assert.equal(JSON.parse(next.writes[0]).writer, true);
    next.emit('data', Buffer.from('again'));
    assert.deepEqual(fake.ptys[0].writes, ['yes', 'no', 'again']);
  });

  test('launch_session starts and stops sidecars when requested', () => {
    const { runtime, sidecars } = makeRuntime();

    const res = runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_a',
        sidecars: {
          codingSessionId: 'sess_real',
          apiUrl: 'https://memoro.test',
          token: 'tok',
        },
      },
    });

    assert.equal(res.ok, true);
    assert.deepEqual(res.sidecars, { ok: true });
    assert.equal(sidecars.length, 1);
    assert.equal(sidecars[0].started, true);
    assert.equal(sidecars[0].spec.session.id, 'sess_a');
    assert.equal(sidecars[0].spec.coding.codingSessionId, 'sess_real');

    runtime.handle({ type: 'remove_session', id: 'sess_a' });
    assert.equal(sidecars[0].stopped, true);
  });

  test('returns structured errors for launch failures and invalid payloads', () => {
    const failed = makeRuntime({ launch: { ok: false } }).runtime.handle({
      type: 'launch_session',
      session: { id: 'sess_a', tool: 'codex' },
    });
    assert.deepEqual(failed, {
      ok: false,
      reason: 'missing-bin',
      error: 'missing codex',
    });

    const { runtime } = makeRuntime();
    assert.equal(runtime.handle({ type: 'bogus' }), null);
    assert.match(runtime.handle({ type: 'launch_session', session: { id: '' } }).error, /session id/);
    assert.match(runtime.handle({ type: 'write_session', id: 'missing', data: 'x' }).error, /unknown broker session/);
    assert.match(runtime.handle({ type: 'resize_session', id: 'missing', cols: 0, rows: 24 }).error, /cols/);
  });
});
