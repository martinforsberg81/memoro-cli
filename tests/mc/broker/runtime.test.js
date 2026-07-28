import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { BrokerRuntime } from '../../../src/mc/broker/runtime.js';

function makeFakePtyFactory({ exitOnExitSubscription = null } = {}) {
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
        onExit(handler) {
          exitHandler = handler;
          if (exitOnExitSubscription) handler(exitOnExitSubscription);
        },
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
  const fake = makeFakePtyFactory(opts.pty || {});
  const resolver = makeLaunchResolver(opts.launch || {});
  const sidecars = [];
  const lifecycleWrites = [];
  let now = 1_000;
  const runtime = new BrokerRuntime({
    ptyFactory: fake.factory,
    launchResolver: resolver.resolve.bind(resolver),
    env: { BASE: '1', MC_GROUNDING_TOOL: 'codex' },
    cwd: () => '/fallback',
    clock: () => now,
    managedProviderResolver: opts.managedProviderResolver,
    credentialDomainCloser: opts.credentialDomainCloser,
    lifecycleWriter: (record) => {
      lifecycleWrites.push(record);
      return record;
    },
    sidecarFactory: opts.sidecarFactory || ((spec) => {
      const sidecar = {
        spec,
        started: false,
        stopped: false,
        stopOptions: null,
        start() { this.started = true; },
        stop(options) {
          this.stopped = true;
          this.stopOptions = options;
        },
        currentProjection() {
          return {
            contract_version: 'mc-session-projection-v1',
            status: 'active',
            reason_code: 'recent_output',
            observed_at: '2026-07-21T08:00:00.000Z',
            classifier_version: 'mc-session-projector-v1',
            classification_basis: 'runtime_fallback',
            runtime: null,
            git: null,
          };
        },
      };
      sidecars.push(sidecar);
      return sidecar;
    }),
  });
  return {
    runtime,
    fake,
    resolver,
    sidecars,
    lifecycleWrites,
    tick(ms = 1) {
      now += ms;
      return now;
    },
  };
}

function makeConn() {
  const writes = [];
  return {
    writes,
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

  test('launch_session reuses an existing live session for the same cwd', () => {
    const { runtime, fake } = makeRuntime();

    const first = runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_a',
        name: 'alpha',
        cwd: '/repo/a',
        tool: 'codex',
      },
    });
    const second = runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_b',
        name: 'alpha',
        cwd: '/repo/a/',
        tool: 'claude',
      },
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.reused, true);
    assert.equal(second.session.id, 'sess_a');
    assert.equal(second.session.cwd, '/repo/a');
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(runtime.handle({ type: 'sessions' }).sessions.map((s) => s.id), ['sess_a']);
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

  test('managed launch replaces broker env and closes its credential domain on exit', async () => {
    const closed = [];
    const descriptor = {
      schema: 'mc-local-codex-credential-domain/v1',
      domain_path: '/credential/domain',
    };
    const { runtime, fake } = makeRuntime({
      managedProviderResolver: ({ launch, input }) => ({
        ok: true,
        launch: {
          ...launch,
          shortName: 'codex',
          spec: {
            bin: '/verified/codex',
            args: () => ['--strict-config'],
          },
        },
        environmentMode: 'replace',
        env: {
          PATH: '/usr/bin:/bin',
          HOME: '/credential/home',
          CODEX_HOME: '/credential/home/.codex',
        },
        descriptor: input.credential_domain,
      }),
      credentialDomainCloser: async (input) => {
        closed.push(input);
        return { ok: true, persisted: true };
      },
    });

    const result = runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_managed',
        tool: 'codex',
        env: {
          MEMORO_TOKEN: 'must-not-reach-child',
          OPENAI_API_KEY: 'must-not-reach-child-either',
        },
        sidecars: { enabled: false },
        credential_domain: descriptor,
      },
    });

    assert.equal(result.ok, true);
    const childEnv = fake.calls[0].options.env;
    assert.equal(childEnv.BASE, undefined);
    assert.equal(childEnv.MEMORO_TOKEN, undefined);
    assert.equal(childEnv.OPENAI_API_KEY, undefined);
    assert.equal(childEnv.CODEX_HOME, '/credential/home/.codex');
    assert.equal(childEnv.MEMORO_MC_BROKER, '1');

    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(closed, [{
      descriptor,
      portal: {
        apiUrl: null,
        token: null,
      },
    }]);
  });

  test('managed reopen waits for prior credential custody to close before replacing the dead runtime', async () => {
    const firstDescriptor = {
      schema: 'mc-local-codex-credential-domain/v1',
      domain_path: '/credential/first',
    };
    const nextDescriptor = {
      schema: 'mc-local-codex-credential-domain/v1',
      domain_path: '/credential/next',
    };
    const closeCalls = [];
    let finishFirstClose;
    const { runtime, fake } = makeRuntime({
      managedProviderResolver: ({ launch, input }) => ({
        ok: true,
        launch,
        environmentMode: 'replace',
        env: {
          PATH: '/usr/bin:/bin',
          HOME: input.credential_domain.domain_path,
          CODEX_HOME: `${input.credential_domain.domain_path}/.codex`,
        },
        descriptor: input.credential_domain,
      }),
      credentialDomainCloser: (input) => {
        closeCalls.push(input);
        if (closeCalls.length === 1) {
          return new Promise((resolve) => { finishFirstClose = resolve; });
        }
        return Promise.resolve({ ok: true, persisted: true });
      },
    });
    const launch = (descriptor) => runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_managed_reopen',
        tool: 'codex',
        credential_domain: descriptor,
      },
    });

    assert.equal(launch(firstDescriptor).ok, true);
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    const reopening = launch(nextDescriptor);

    assert.equal(typeof reopening?.then, 'function');
    assert.equal(fake.ptys.length, 1, 'replacement must wait for prior custody close');
    finishFirstClose({ ok: true, persisted: true });
    const reopened = await reopening;

    assert.equal(reopened.ok, true);
    assert.equal(fake.ptys.length, 2);
    assert.equal(fake.calls[1].options.env.CODEX_HOME, '/credential/next/.codex');
    fake.ptys[1].emitExit({ exitCode: 0, signal: null });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closeCalls.length, 2);
    assert.equal(closeCalls[1].descriptor, nextDescriptor);
  });

  test('a duplicate old managed exit never closes the replacement credential domain', async () => {
    const firstDescriptor = { schema: 'mc-local-codex-credential-domain/v1', domain_path: '/credential/first' };
    const nextDescriptor = { schema: 'mc-local-codex-credential-domain/v1', domain_path: '/credential/next' };
    const closeCalls = [];
    const { runtime, fake } = makeRuntime({
      managedProviderResolver: ({ launch, input }) => ({
        ok: true,
        launch,
        environmentMode: 'replace',
        env: { PATH: '/usr/bin:/bin', HOME: input.credential_domain.domain_path },
        descriptor: input.credential_domain,
      }),
      credentialDomainCloser: async (input) => {
        closeCalls.push(input.descriptor);
        return { ok: true, persisted: true };
      },
    });
    const launch = (descriptor) => runtime.handle({
      type: 'launch_session',
      session: { id: 'sess_managed_generation_owner', tool: 'codex', credential_domain: descriptor },
    });

    assert.equal(launch(firstDescriptor).ok, true);
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(closeCalls, [firstDescriptor]);

    assert.equal(launch(nextDescriptor).ok, true);
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(closeCalls, [firstDescriptor]);

    fake.ptys[1].emitExit({ exitCode: 0, signal: null });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(closeCalls, [firstDescriptor, nextDescriptor]);
  });

  test('managed launch never reuses an existing native broker session', () => {
    const { runtime } = makeRuntime({
      managedProviderResolver: ({ launch, input }) => {
        if (input.credential_domain) {
          assert.fail('conflicting domain must not be opened by broker');
        }
        return {
          ok: true,
          launch,
          environmentMode: 'inherit',
          env: input.env || {},
        };
      },
    });
    assert.equal(runtime.handle({
      type: 'launch_session',
      session: { id: 'sess_existing', cwd: '/repo', tool: 'codex' },
    }).ok, true);

    const conflict = runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_managed_new',
        cwd: '/repo',
        tool: 'codex',
        credential_domain: { schema: 'mc-local-codex-credential-domain/v1' },
      },
    });

    assert.equal(conflict.ok, false);
    assert.equal(conflict.reason, 'managed-provider-session-conflict');
  });

  test('managed removal waits for provider exit and confirmed credential cleanup', async () => {
    const descriptor = {
      schema: 'mc-local-codex-credential-domain/v1',
      domain_path: '/credential/domain',
    };
    const closeCalls = [];
    let finishClose;
    const { runtime, fake } = makeRuntime({
      managedProviderResolver: ({ launch, input }) => ({
        ok: true,
        launch,
        environmentMode: 'replace',
        env: {
          PATH: '/usr/bin:/bin',
          HOME: '/credential/home',
          CODEX_HOME: '/credential/home/.codex',
        },
        descriptor: input.credential_domain,
      }),
      credentialDomainCloser: (input) => {
        closeCalls.push(input);
        return new Promise((resolve) => { finishClose = resolve; });
      },
    });
    assert.equal(runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_managed_remove',
        tool: 'codex',
        credential_domain: descriptor,
      },
    }).ok, true);

    const removing = runtime.handle({
      type: 'remove_session',
      id: 'sess_managed_remove',
    });
    assert.equal(typeof removing?.then, 'function');
    assert.deepEqual(fake.ptys[0].kills, ['SIGTERM']);
    assert.equal(closeCalls.length, 0, 'custody must not refresh before provider exit');

    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closeCalls.length, 1);
    assert.equal(runtime.handle({ type: 'sessions' }).sessions.length, 1);

    finishClose({ ok: true, persisted: true });
    assert.deepEqual(await removing, {
      ok: true,
      removed: true,
      credential_cleanup: 'confirmed',
    });
    assert.equal(runtime.handle({ type: 'sessions' }).sessions.length, 0);
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
          repoRef: 'martinforsberg81/memoro-cli',
          branch: 'sess/alpha',
          worktreeName: 'alpha',
          transcriptPath: '/Users/me/.codex/sessions/alpha.jsonl',
        },
      },
    });

    const [session] = runtime.handle({ type: 'sessions' }).sessions;
    assert.equal(session.name, 'alpha');
    assert.equal(session.repo, 'memoro-cli');
    assert.equal(session.repo_ref, 'martinforsberg81/memoro-cli');
    assert.equal(session.branch, 'sess/alpha');
    assert.equal(session.worktree_name, 'alpha');
    assert.equal('transcript_path' in session, false);
    assert.equal('provider_sessions_dir' in session, false);
    assert.equal('codex_artifact_capture' in session, false);
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

  test('write, dispatch, resize, stop, and remove forward to the session manager', async () => {
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
    assert.equal(typeof removed?.then, 'function');
    assert.deepEqual(fake.ptys[0].kills, ['SIGHUP', 'SIGTERM']);
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    assert.deepEqual(await removed, { ok: true, removed: true });
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
    const conn = makeConn();

    runtime.handle({ type: 'launch_session', session: { id: 'sess_a' } });
    fake.ptys[0].emitData('snapshot');

    const res = runtime.attachConnection({ id: 'sess_a', cols: 100, rows: 40 }, conn, Buffer.from('first'));

    assert.equal(res.ok, true);
    assert.equal(JSON.parse(conn.writes[0]).ok, true);
    assert.equal(conn.writes[1], 'snapshot');
    assert.deepEqual(fake.ptys[0].resizes, [{ cols: 100, rows: 40 }]);
    assert.deepEqual(fake.ptys[0].writes, ['first']);

    conn.emit('data', Buffer.from('input'));
    fake.ptys[0].emitData('output');
    assert.deepEqual(fake.ptys[0].writes, ['first', 'input']);
    assert.equal(conn.writes.at(-1), 'output');

    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    assert.equal(conn.ended, true);
  });

  test('cloud attaches cannot narrow the PTY while a local attach is active', () => {
    const { runtime, fake } = makeRuntime();

    runtime.handle({ type: 'launch_session', session: { id: 'sess_a' } });
    const local = makeConn();
    const cloud = makeConn();

    runtime.attachConnection({
      id: 'sess_a',
      attach_id: 'att_local',
      side: 'local',
      cols: 120,
      rows: 40,
    }, local);
    runtime.attachConnection({
      id: 'sess_a',
      attach_id: 'att_cloud',
      side: 'cloud',
      cols: 42,
      rows: 20,
    }, cloud);

    assert.deepEqual(fake.ptys[0].resizes, [{ cols: 120, rows: 40 }]);
    assert.deepEqual(runtime.handle({
      type: 'resize_session',
      id: 'sess_a',
      cols: 44,
      rows: 22,
      side: 'cloud',
      attach_id: 'att_cloud',
    }), { ok: true, applied: false });
    assert.deepEqual(fake.ptys[0].resizes, [{ cols: 120, rows: 40 }]);

    assert.deepEqual(runtime.handle({
      type: 'resize_session',
      id: 'sess_a',
      cols: 132,
      rows: 44,
    }), { ok: true, applied: true });
    assert.deepEqual(fake.ptys[0].resizes, [
      { cols: 120, rows: 40 },
      { cols: 132, rows: 44 },
    ]);

    local.emit('end');
    assert.deepEqual(runtime.handle({
      type: 'resize_session',
      id: 'sess_a',
      cols: 52,
      rows: 24,
      side: 'cloud',
      attach_id: 'att_cloud',
    }), { ok: true, applied: true });
    assert.deepEqual(fake.ptys[0].resizes.at(-1), { cols: 52, rows: 24 });
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

  test('attachConnection cleans up when the client socket is already gone', () => {
    const { runtime } = makeRuntime();
    const conn = {
      handlers: new Map(),
      write() {
        const err = new Error('write EPIPE');
        err.code = 'EPIPE';
        throw err;
      },
      end() {},
      on(event, handler) { this.handlers.set(event, handler); },
      off(event, handler) {
        if (this.handlers.get(event) === handler) this.handlers.delete(event);
      },
    };

    runtime.handle({ type: 'launch_session', session: { id: 'sess_a' } });

    assert.deepEqual(runtime.attachConnection({ id: 'sess_a', attach_id: 'att_dead' }, conn), { ok: true });
    assert.deepEqual(runtime.listSessions()[0].attached, []);
  });

  test('launch_session starts and stops sidecars when requested', () => {
    const { runtime, fake, sidecars } = makeRuntime();

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
    assert.equal(res.session.session_projection.status, 'active');
    assert.equal(runtime.listSessions()[0].session_projection.reason_code, 'recent_output');

    runtime.handle({ type: 'remove_session', id: 'sess_a' });
    assert.equal(sidecars[0].stopped, false, 'sidecars stay alive until the PTY confirms exit');
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    assert.equal(sidecars[0].stopped, true);
    assert.deepEqual(sidecars[0].stopOptions, { terminal: true });
  });

  test('journals the exact runtime generation before launch and before terminal sidecar cleanup', () => {
    const generation = '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701';
    const { runtime, fake, sidecars, lifecycleWrites } = makeRuntime();
    const launched = runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_lifecycle',
        runtime_generation: generation,
        sidecars: {
          codingSessionId: 'sess_lifecycle',
          runtimeGeneration: generation,
          apiUrl: 'https://memoro.test',
          token: 'secret-stays-broker-side',
        },
      },
    });

    assert.equal(launched.ok, true);
    assert.equal(lifecycleWrites.length, 1);
    assert.equal(lifecycleWrites[0].state, 'live');
    assert.equal(lifecycleWrites[0].runtimeGeneration, generation);
    assert.equal(JSON.stringify(lifecycleWrites[0]).includes('secret-stays-broker-side'), false);
    assert.equal(runtime.listSessions()[0].runtime_generation, generation);

    fake.ptys[0].emitExit({ exitCode: 0, signal: null });

    assert.equal(lifecycleWrites.length, 2);
    assert.equal(lifecycleWrites[1].state, 'exited');
    assert.equal(lifecycleWrites[1].runtimeGeneration, generation);
    assert.equal(lifecycleWrites[1].exitCode, 0);
    assert.equal(sidecars[0].stopped, true);
    assert.deepEqual(sidecars[0].stopOptions, { terminal: true });
  });

  test('replacement waits for the previous PTY exit and a duplicate old exit cannot overwrite it', async () => {
    const firstGeneration = '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701';
    const nextGeneration = 'd5e6439f-54e2-493b-a10f-5e5e014a2904';
    const { runtime, fake, sidecars, lifecycleWrites } = makeRuntime();
    const launch = (runtimeGeneration) => runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_replaced',
        runtime_generation: runtimeGeneration,
        sidecars: {
          codingSessionId: 'sess_replaced',
          runtimeGeneration,
          apiUrl: 'https://memoro.test',
          token: 'broker-only',
        },
      },
    });

    assert.equal(launch(firstGeneration).ok, true);
    const removing = runtime.handle({ type: 'remove_session', id: 'sess_replaced' });
    assert.equal(typeof removing?.then, 'function');
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    assert.equal((await removing).ok, true);
    assert.equal(launch(nextGeneration).ok, true);
    assert.deepEqual(
      lifecycleWrites.map((record) => [record.state, record.runtimeGeneration]),
      [['live', firstGeneration], ['exited', firstGeneration], ['live', nextGeneration]],
    );

    // Node-pty should only emit once, but a duplicate late notification from
    // the retired generation must not touch the replacement state.
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });

    assert.equal(sidecars[0].stopped, true);
    assert.equal(sidecars[1].stopped, false);
    assert.deepEqual(
      lifecycleWrites.map((record) => [record.state, record.runtimeGeneration]),
      [['live', firstGeneration], ['exited', firstGeneration], ['live', nextGeneration]],
      'old exit must not overwrite the replacement live journal',
    );

    fake.ptys[1].emitExit({ exitCode: 0, signal: null });
    assert.equal(sidecars[1].stopped, true);
    assert.deepEqual(lifecycleWrites.at(-1), {
      path: lifecycleWrites.at(-1).path,
      codingSessionId: 'sess_replaced',
      runtimeGeneration: nextGeneration,
      state: 'exited',
      observedAt: lifecycleWrites.at(-1).observedAt,
      exitCode: 0,
    });
  });

  test('removing a replacement generation never reuses the prior generation finalization', async () => {
    const firstGeneration = '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701';
    const nextGeneration = 'd5e6439f-54e2-493b-a10f-5e5e014a2904';
    const { runtime, fake } = makeRuntime();
    const launch = (runtimeGeneration) => runtime.handle({
      type: 'launch_session',
      session: { id: 'sess_generation_owner', runtime_generation: runtimeGeneration },
    });

    assert.equal(launch(firstGeneration).ok, true);
    const removeFirst = runtime.handle({ type: 'remove_session', id: 'sess_generation_owner' });
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    assert.equal((await removeFirst).ok, true);
    assert.equal(launch(nextGeneration).ok, true);

    const removeSecond = runtime.handle({ type: 'remove_session', id: 'sess_generation_owner' });
    assert.equal(typeof removeSecond?.then, 'function');
    assert.equal(runtime.handle({ type: 'session_status', id: 'sess_generation_owner' }).session.session_state, 'live');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.handle({ type: 'session_status', id: 'sess_generation_owner' }).session.session_state, 'live');

    fake.ptys[1].emitExit({ exitCode: 0, signal: null });
    assert.equal((await removeSecond).ok, true);
  });

  test('synchronous PTY exit owns metadata before launch and never starts sidecars', () => {
    const generation = '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701';
    const { runtime, sidecars, lifecycleWrites } = makeRuntime({
      pty: { exitOnExitSubscription: { exitCode: 1, signal: null } },
    });

    const result = runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_immediate_exit',
        runtime_generation: generation,
        sidecars: { codingSessionId: 'sess_immediate_exit', runtimeGeneration: generation },
      },
    });

    assert.deepEqual(result, {
      ok: false,
      reason: 'broker-session-exited',
      error: 'broker session exited before it could become live',
    });
    assert.equal(sidecars.length, 0);
    assert.deepEqual(lifecycleWrites.map((entry) => [entry.state, entry.runtimeGeneration]), [
      ['live', generation],
      ['exited', generation],
    ]);
  });

  test('sidecar startup failure stops the runtime and waits for terminal finalization', async () => {
    let finishTerminal;
    const { runtime, fake } = makeRuntime({
      sidecarFactory: () => ({
        start() { throw new Error('socket bind failed'); },
        stop() { return new Promise((resolve) => { finishTerminal = resolve; }); },
      }),
    });

    const launch = runtime.handle({
      type: 'launch_session',
      session: { id: 'sess_sidecar_failure', sidecars: { codingSessionId: 'sess_sidecar_failure' } },
    });
    assert.equal(typeof launch?.then, 'function');
    assert.deepEqual(fake.ptys[0].kills, ['SIGTERM']);
    fake.ptys[0].emitExit({ exitCode: 1, signal: null });
    finishTerminal(true);
    const result = await launch;
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'sidecar-start-failed');
    assert.match(result.error, /socket bind failed/);
  });

  test('shutdown waits for PTY exit and terminal sidecar finalization', async () => {
    let finishTerminal;
    const { runtime, fake } = makeRuntime({
      sidecarFactory: () => ({
        start() {},
        stop() { return new Promise((resolve) => { finishTerminal = resolve; }); },
      }),
    });
    assert.equal(runtime.handle({
      type: 'launch_session',
      session: { id: 'sess_shutdown', sidecars: { codingSessionId: 'sess_shutdown' } },
    }).ok, true);

    const stopping = runtime.shutdown({ timeoutMs: 1_000 });
    assert.deepEqual(fake.ptys[0].kills, ['SIGTERM']);
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    await new Promise((resolve) => setImmediate(resolve));
    finishTerminal(true);
    assert.deepEqual(await stopping, { ok: true, credential_cleanup: 'confirmed' });
  });

  test('terminal presence failure is advisory once the exit journal is durable', async () => {
    const { runtime, fake } = makeRuntime({
      sidecarFactory: () => ({
        start() {},
        stop() { return false; },
      }),
    });
    assert.equal(runtime.handle({
      type: 'launch_session',
      session: { id: 'sess_terminal_advisory', sidecars: { codingSessionId: 'sess_terminal_advisory' } },
    }).ok, true);

    const removing = runtime.handle({ type: 'remove_session', id: 'sess_terminal_advisory' });
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    assert.deepEqual(await removing, { ok: true, removed: true });

    assert.equal(runtime.handle({
      type: 'launch_session',
      session: { id: 'sess_terminal_advisory_shutdown', sidecars: { codingSessionId: 'sess_terminal_advisory_shutdown' } },
    }).ok, true);
    const shutdown = runtime.shutdown();
    fake.ptys[1].emitExit({ exitCode: 0, signal: null });
    assert.deepEqual(await shutdown, { ok: true, credential_cleanup: 'confirmed' });
  });

  test('relaunch replaces the retained dead broker row for the same coding session id', () => {
    const firstGeneration = '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701';
    const nextGeneration = 'd5e6439f-54e2-493b-a10f-5e5e014a2904';
    const { runtime, fake, lifecycleWrites } = makeRuntime();
    const launch = (runtimeGeneration) => runtime.handle({
      type: 'launch_session',
      session: {
        id: 'sess_reopen',
        runtime_generation: runtimeGeneration,
      },
    });

    assert.equal(launch(firstGeneration).ok, true);
    fake.ptys[0].emitExit({ exitCode: 0, signal: null });
    assert.equal(runtime.listSessions()[0].session_state, 'dead');

    const reopened = launch(nextGeneration);

    assert.equal(reopened.ok, true);
    assert.equal(fake.ptys.length, 2);
    assert.equal(runtime.listSessions().length, 1);
    assert.equal(runtime.listSessions()[0].session_state, 'live');
    assert.equal(runtime.listSessions()[0].runtime_generation, nextGeneration);
    assert.deepEqual(
      lifecycleWrites.map((record) => [record.state, record.runtimeGeneration]),
      [
        ['live', firstGeneration],
        ['exited', firstGeneration],
        ['live', nextGeneration],
      ],
    );
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
    assert.deepEqual(runtime.handle({ type: 'session_status', id: 'missing' }), {
      ok: false,
      reason: 'session-not-found',
      error: 'unknown broker session: missing',
    });
    assert.match(runtime.handle({ type: 'write_session', id: 'missing', data: 'x' }).error, /unknown broker session/);
    assert.match(runtime.handle({ type: 'resize_session', id: 'missing', cols: 0, rows: 24 }).error, /cols/);
  });
});
