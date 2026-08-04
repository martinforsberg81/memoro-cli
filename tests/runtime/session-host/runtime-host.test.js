import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import {
  acceptRuntimeGenerationSync,
  beginRuntimeGenerationSync,
  failRuntimeGenerationSync,
  inspectSessionRuntimeSync,
} from '../../../src/mc/session-runtime-journal.js';
import {
  createSessionHomeSync,
  readSessionHomeSync,
  sessionHomePaths,
} from '../../../src/mc/session-home.js';
import { RuntimeClientQueue } from '../../../src/runtime/session-host/client-queue.js';
import {
  readRuntimeHostManifestSync,
  writeRuntimeHostManifestSync,
} from '../../../src/runtime/session-host/ephemeral-state.js';
import {
  SessionHostFrameDecoder,
} from '../../../src/runtime/session-host/protocol.js';
import {
  SessionRuntimeHost,
  reconcileRuntimeHostSync,
} from '../../../src/runtime/session-host/runtime-host.js';

const mcSessionId = 'mcs_000000000000000000000001';
const generationId = 'mcg_000000000000000000000001';
const replacementGenerationId = 'mcg_000000000000000000000002';
let temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
  temporaryRoots = [];
});

test('owns one journaled PTY generation and reconstructs attach state', async () => {
  const mcHomeDir = temporaryHome();
  const now = clock();
  preparePlannedGeneration(mcHomeDir);
  const pty = new FakePty(31001);
  const host = createHost({ mcHomeDir, now, pty });
  const started = host.start();
  assert.equal(started.state, 'live');
  assert.equal(inspectSessionRuntimeSync({ mcHomeDir, mcSessionId }).active_generation.phase, 'live');

  pty.emitData('first screen\r\n');
  pty.emitData('\u001b[?1049h\u001b[2J\u001b[Htool tui');
  const socket = new FakeSocket();
  const attached = await host.attach(socket, { cols: 100, rows: 30 });
  assert.match(attached.snapshot.ansi, /tool tui/u);
  assert.equal(attached.snapshot.cols, 100);
  assert.deepEqual(pty.resizes, [[100, 30]]);
  const attachedFrames = decodeFrames(socket.writes);
  assert.deepEqual(attachedFrames.slice(0, 2).map((frame) => frame.type), ['attached', 'screen']);
  assert.match(
    Buffer.from(attachedFrames[1].ansi_base64, 'base64').toString('utf8'),
    /tool tui/u,
  );

  pty.emitData('\r\nnext');
  await host.handleClientFrame(attached.client_id, {
    v: 1,
    type: 'input',
    mc_session_id: mcSessionId,
    generation_id: generationId,
    data_base64: Buffer.from('answer\r').toString('base64'),
  });
  assert.deepEqual(pty.writes, ['answer\r']);
  const exited = new Promise((resolve) => host.once('exit', resolve));
  pty.emitExit({ exitCode: 0, signal: null });
  await exited;

  const snapshot = inspectSessionRuntimeSync({ mcHomeDir, mcSessionId });
  assert.equal(snapshot.active_generation.phase, 'exited');
  assert.deepEqual(snapshot.generations[0].receipts.map((item) => item.phase), [
    'accepted',
    'live',
    'exited',
  ]);
  const manifest = readRuntimeHostManifestSync({ mcHomeDir, mcSessionId });
  assert.equal(manifest.value.state, 'exited');
  assert.deepEqual(manifest.value.exit.exit_code, 0);
  host.close();
});

test('delivers exit after the initial screen when the PTY exits during attach', async () => {
  const mcHomeDir = temporaryHome();
  const now = clock();
  preparePlannedGeneration(mcHomeDir);
  const pty = new FakePty(31005);
  const screen = attachExitScreen(() => pty.emitExit({ exitCode: 7, signal: null }));
  const host = createHost({ mcHomeDir, now, pty, screenFactory: () => screen });
  host.start();

  const socket = new FakeSocket();
  await host.attach(socket);
  const frames = decodeFrames(socket.writes);
  assert.deepEqual(frames.map((frame) => frame.type), ['attached', 'screen', 'exit']);
  assert.equal(frames.at(-1).exit_code, 7);
  assert.equal(inspectSessionRuntimeSync({ mcHomeDir, mcSessionId }).active_generation.phase,
    'exited');
  host.close();
});

test('keeps launch arguments, environment, and PTY output out of persisted state', async () => {
  const mcHomeDir = temporaryHome();
  const now = clock();
  preparePlannedGeneration(mcHomeDir);
  const pty = new FakePty(31002);
  const host = createHost({
    mcHomeDir,
    now,
    pty,
    spawnPlan: {
      command: '/usr/bin/tool',
      args: ['--secret-argv-canary'],
      cwd: '/projects/runtime',
      env: { TOKEN: 'secret-env-canary' },
    },
  });
  host.start();
  const projectionRevision = readSessionHomeSync({ mcHomeDir, mcSessionId }).projection.revision;
  const manifestUpdatedAt = readRuntimeHostManifestSync({ mcHomeDir, mcSessionId }).value.updated_at;
  pty.emitData('secret-output-canary');
  await host.screen.snapshot();
  assert.equal(readSessionHomeSync({ mcHomeDir, mcSessionId }).projection.revision,
    projectionRevision);
  assert.equal(readRuntimeHostManifestSync({ mcHomeDir, mcSessionId }).value.updated_at,
    manifestUpdatedAt);

  const paths = sessionHomePaths({ mcHomeDir, mcSessionId });
  const persisted = `${readTree(paths.home)}${readTree(paths.ephemeralRunPath)}`;
  for (const forbidden of [
    '--secret-argv-canary',
    'secret-env-canary',
    'secret-output-canary',
    'TOKEN',
    'args',
    'env',
  ]) assert.equal(persisted.includes(forbidden), false);
  assert.equal(JSON.stringify(host.status()).includes('secret'), false);
  host.close();
});

test('disconnects a slow client under output flood without stopping other clients or the PTY', async () => {
  const mcHomeDir = temporaryHome();
  const now = clock();
  preparePlannedGeneration(mcHomeDir);
  const pty = new FakePty(31003);
  const host = createHost({
    mcHomeDir,
    now,
    pty,
    queueFactory: (options) => new RuntimeClientQueue({
      ...options,
      maxQueuedBytes: 2 * 1024 * 1024,
      maxQueuedFrames: 64,
    }),
  });
  host.start();
  const fast = new FakeSocket({ writable: true });
  const slow = new FakeSocket({ writable: false });
  await host.attach(fast);
  await host.attach(slow);

  for (let index = 0; index < 20; index += 1) {
    pty.emitData(Buffer.alloc(100 * 1024, 65 + (index % 20)));
  }
  assert.equal(slow.destroyed, true);
  assert.equal(fast.destroyed, false);
  assert.equal(host.status().clients, 1);
  assert.equal(host.status().state, 'live');
  assert.deepEqual(pty.kills, []);
  assert.ok(host.screen.status().pending_bytes <= 4 * 1024 * 1024);
  assert.ok(fast.writes.length > 20);
  await host.screen.snapshot();
  host.close();
});

test('reconciles accepted outcomes only from an exact live host probe', () => {
  const mcHomeDir = temporaryHome();
  preparePlannedGeneration(mcHomeDir);
  acceptRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId,
    now: () => '2026-08-02T21:01:00.000Z',
  });
  writeRuntimeHostManifestSync({
    mcHomeDir,
    mcSessionId,
    generationId,
    state: 'live',
    hostPid: 32001,
    processPid: 32002,
    cols: 80,
    rows: 24,
    startedAt: '2026-08-02T21:01:00.000Z',
    updatedAt: '2026-08-02T21:01:01.000Z',
  });
  const uncertain = reconcileRuntimeHostSync({
    mcHomeDir,
    mcSessionId,
    processIsAlive: () => true,
    probe: { ok: false },
  });
  assert.equal(uncertain.action, 'reconcile-accepted-outcome');
  assert.equal(inspectSessionRuntimeSync({ mcHomeDir, mcSessionId }).active_generation.phase,
    'accepted');

  const exact = reconcileRuntimeHostSync({
    mcHomeDir,
    mcSessionId,
    processIsAlive: () => true,
    now: () => '2026-08-02T21:01:02.000Z',
    probe: {
      ok: true,
      mc_session_id: mcSessionId,
      generation_id: generationId,
      process_pid: 32002,
      state: 'live',
    },
  });
  assert.deepEqual(exact, { action: 'attach', generation_id: generationId });
  assert.equal(inspectSessionRuntimeSync({ mcHomeDir, mcSessionId }).active_generation.phase, 'live');
});

test('repairs an interrupted live-evidence write without launching a second process', () => {
  const mcHomeDir = temporaryHome();
  const now = clock();
  preparePlannedGeneration(mcHomeDir);
  const pty = new FakePty(32502);
  let manifestWrites = 0;
  const host = new SessionRuntimeHost({
    mcHomeDir,
    mcSessionId,
    generationId,
    spawnPlan: { command: '/usr/bin/tool', args: [], cwd: '/projects/runtime', env: {} },
    ptyFactory: { spawn: () => pty },
    now,
    hostPid: 32501,
    writeManifestSync: (options) => {
      manifestWrites += 1;
      if (options.state === 'live') throw new Error('injected live manifest interruption');
      return writeRuntimeHostManifestSync(options);
    },
  });
  const started = host.start();
  assert.equal(manifestWrites, 2);
  assert.equal(started.state, 'starting');
  assert.equal(started.reconciliation_required, true);
  assert.equal(inspectSessionRuntimeSync({ mcHomeDir, mcSessionId }).active_generation.phase,
    'accepted');
  assert.equal(readRuntimeHostManifestSync({ mcHomeDir, mcSessionId }).value.state, 'starting');

  const repaired = reconcileRuntimeHostSync({
    mcHomeDir,
    mcSessionId,
    now,
    processIsAlive: () => true,
    probe: {
      ok: true,
      mc_session_id: mcSessionId,
      generation_id: generationId,
      process_pid: pty.pid,
      state: 'live',
    },
  });
  assert.deepEqual(repaired, { action: 'attach', generation_id: generationId });
  assert.equal(inspectSessionRuntimeSync({ mcHomeDir, mcSessionId }).active_generation.phase, 'live');
  assert.equal(readRuntimeHostManifestSync({ mcHomeDir, mcSessionId }).value.process_pid, pty.pid);
  assert.deepEqual(pty.kills, []);
  host.close();
});

test('terminalizes an exact absent process and never authorizes a duplicate launch', () => {
  const mcHomeDir = temporaryHome();
  preparePlannedGeneration(mcHomeDir);
  acceptRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId,
    now: () => '2026-08-02T21:01:00.000Z',
  });
  writeRuntimeHostManifestSync({
    mcHomeDir,
    mcSessionId,
    generationId,
    state: 'live',
    hostPid: 33001,
    processPid: 33002,
    cols: 80,
    rows: 24,
    startedAt: '2026-08-02T21:01:00.000Z',
    updatedAt: '2026-08-02T21:01:01.000Z',
  });
  const result = reconcileRuntimeHostSync({
    mcHomeDir,
    mcSessionId,
    processIsAlive: () => false,
    now: () => '2026-08-02T21:01:02.000Z',
  });
  assert.deepEqual(result, {
    action: 'explicit-replacement-required',
    generation_id: generationId,
  });
  assert.equal(inspectSessionRuntimeSync({ mcHomeDir, mcSessionId }).generations[0].phase, 'failed');
  assert.throws(() => createHost({ mcHomeDir, now: clock(), pty: new FakePty(33003) }).start(),
    (error) => error.reason === 'generation-not-launchable');
});

test('blocks a planned replacement while prior ephemeral runtime evidence is live', () => {
  const mcHomeDir = temporaryHome();
  preparePlannedGeneration(mcHomeDir);
  failRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId,
    reason: 'launch-failure-proven',
    now: () => '2026-08-02T21:01:00.000Z',
  });
  beginRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId: replacementGenerationId,
    action: 'replace',
    tool: 'codex',
    launchCwd: '/projects/runtime',
    previousGenerationId: generationId,
    replacementReason: 'user-requested-replacement',
    now: () => '2026-08-02T21:01:01.000Z',
  });
  writeRuntimeHostManifestSync({
    mcHomeDir,
    mcSessionId,
    generationId,
    state: 'live',
    hostPid: 34001,
    processPid: 34002,
    cols: 80,
    rows: 24,
    startedAt: '2026-08-02T21:00:02.000Z',
    updatedAt: '2026-08-02T21:01:02.000Z',
  });
  assert.deepEqual(reconcileRuntimeHostSync({
    mcHomeDir,
    mcSessionId,
    processIsAlive: () => true,
  }), {
    action: 'manual-repair',
    reason: 'previous-runtime-not-terminal',
    generation_id: replacementGenerationId,
  });
  const host = new SessionRuntimeHost({
    mcHomeDir,
    mcSessionId,
    generationId: replacementGenerationId,
    spawnPlan: { command: '/usr/bin/tool', args: [], cwd: '/projects/runtime', env: {} },
    ptyFactory: { spawn: () => new FakePty(34003) },
    now: clock(),
    hostPid: 34004,
  });
  assert.throws(() => host.start(),
    (error) => error.reason === 'previous-runtime-not-terminal');
  host.close();
});

function temporaryHome() {
  const root = mkdtempSync(join(tmpdir(), 'mc-v1-runtime-host-'));
  temporaryRoots.push(root);
  return root;
}

function preparePlannedGeneration(mcHomeDir) {
  createSessionHomeSync({
    mcHomeDir,
    mcSessionId,
    sourceId: 'machine_test',
    name: 'runtime-host-test',
    now: () => '2026-08-02T21:00:00.000Z',
  });
  beginRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId,
    action: 'start',
    tool: 'codex',
    launchCwd: '/projects/runtime',
    now: () => '2026-08-02T21:00:01.000Z',
  });
}

function createHost({
  mcHomeDir,
  now,
  pty,
  spawnPlan = {
    command: '/usr/bin/tool',
    args: [],
    cwd: '/projects/runtime',
    env: {},
  },
  queueFactory,
  screenFactory,
}) {
  return new SessionRuntimeHost({
    mcHomeDir,
    mcSessionId,
    generationId,
    spawnPlan,
    ptyFactory: { spawn: () => pty },
    now,
    hostPid: 30001,
    ...(queueFactory ? { queueFactory } : {}),
    ...(screenFactory ? { screenFactory } : {}),
  });
}

function attachExitScreen(onSnapshot) {
  return {
    append() { return { ok: true, pending_bytes: 0 }; },
    async snapshot() {
      onSnapshot();
      await Promise.resolve();
      return {
        ansi: '',
        through_sequence: 0,
        cols: 80,
        rows: 24,
        scrollback_truncated: false,
      };
    },
    status() {
      return {
        cols: 80,
        rows: 24,
        parsed_sequence: 0,
        pending_bytes: 0,
        pending_operations: 0,
        scrollback_lines: 0,
      };
    },
    dispose() {},
  };
}

function clock() {
  let time = Date.parse('2026-08-02T21:00:02.000Z');
  return () => {
    const value = new Date(time).toISOString();
    time += 1000;
    return value;
  };
}

function decodeFrames(chunks) {
  const decoder = new SessionHostFrameDecoder({ direction: 'server' });
  return chunks.flatMap((chunk) => decoder.push(chunk));
}

function readTree(directory) {
  let result = '';
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result += readTree(path);
    if (entry.isFile()) result += readFileSync(path, 'utf8');
  }
  return result;
}

class FakePty {
  constructor(pid) {
    this.pid = pid;
    this.dataHandlers = [];
    this.exitHandlers = [];
    this.writes = [];
    this.resizes = [];
    this.kills = [];
  }

  onData(handler) { this.dataHandlers.push(handler); }
  onExit(handler) { this.exitHandlers.push(handler); }
  write(data) { this.writes.push(data); }
  resize(cols, rows) { this.resizes.push([cols, rows]); }
  kill(signal) { this.kills.push(signal); }
  emitData(data) { for (const handler of this.dataHandlers) handler(data); }
  emitExit(event) { for (const handler of this.exitHandlers) handler(event); }
}

class FakeSocket extends EventEmitter {
  constructor({ writable = true } = {}) {
    super();
    this.writable = writable;
    this.writableLength = 0;
    this.writes = [];
    this.destroyed = false;
  }

  write(data) {
    const copy = Buffer.from(data);
    this.writes.push(copy);
    if (!this.writable) this.writableLength += copy.length;
    return this.writable;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
}
