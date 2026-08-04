import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, test } from 'node:test';

import { run } from '../../../src/cli/list.js';
import { writeSessionProjectionSync } from '../../../src/mc/session-home.js';
import {
  buildV1SessionListView,
  renderV1SessionList,
} from '../../../src/mc/session-v1-list.js';
import { captureStream, makeV1Fixture } from './v1-fixture.js';

let fixtures = [];

afterEach(() => {
  for (const fixture of fixtures) fixture.cleanup();
  fixtures = [];
});

describe('mc list V1', () => {
  test('renders source-owned sections with framed headers and blank entry rows', async () => {
    const fixture = makeFixture();
    const alpha = fixture.create('alpha');
    fixture.create('beta', { cwd: fixture.directory('other-workspace') });
    writeSessionProjectionSync({
      mcHomeDir: fixture.mcHomeDir,
      mcSessionId: alpha.session.mc_session_id,
      expectedRevision: 1,
      lifecycle: 'open',
      runtimeState: 'running',
      activeRuntimeGeneration: 'mcg_000000000000000000000001',
      tool: 'codex',
    });
    const stdout = captureStream({ columns: 110 });
    const stderr = captureStream();
    const code = await run([], {
      mcHomeDir: fixture.mcHomeDir,
      stdout,
      stderr,
      checkAndPrintFreshInstall: async () => false,
      fetchCloudSessions: async () => ({
        ok: true,
        warning: null,
        sessions: [cloudSession('cloud-one')],
      }),
    });

    assert.equal(code, 0, stderr.text());
    const output = stdout.text();
    assert.match(output, /^mc sessions · 2 local · 1 cloud$/mu);
    assert.match(output, /^Local sessions$/mu);
    assert.match(output, /^Cloud sessions$/mu);
    assert.match(output, /^─{110}$/mu);
    assert.match(output, /^#\s+Session\s+Tool\s+Workspace\s+Runtime\s+Source\s+mc-id$/mu);
    assert.match(output, /alpha.*active.*local.*mcs_/u);
    assert.match(output, /cloud-one.*cloud.*mcs_/u);

    const lines = output.split('\n');
    const alphaRow = lines.findIndex((line) => /\balpha\b/u.test(line));
    const betaRow = lines.findIndex((line) => /\bbeta\b/u.test(line));
    assert.equal(betaRow - alphaRow, 2);
    assert.equal(lines[alphaRow + 1], '');

    const localStart = lines.indexOf('Local sessions');
    const cloudStart = lines.indexOf('Cloud sessions');
    assert.equal(lines.slice(localStart, cloudStart).filter((line) => /^─+$/u.test(line)).length, 3);
    assert.equal(lines.slice(cloudStart).filter((line) => /^─+$/u.test(line)).length, 3);
  });

  test('returns stable JSON and keeps identical names separate by source', async () => {
    const fixture = makeFixture();
    const local = fixture.create('same-name');
    const stdout = captureStream();
    const code = await run(['--json'], {
      mcHomeDir: fixture.mcHomeDir,
      stdout,
      stderr: captureStream(),
      checkAndPrintFreshInstall: async () => false,
      fetchCloudSessions: async () => ({
        ok: true,
        warning: null,
        sessions: [cloudSession('same-name')],
      }),
    });

    assert.equal(code, 0);
    const payload = JSON.parse(stdout.text());
    assert.equal(payload.schema, 1);
    assert.equal(payload.entries.length, 2);
    assert.deepEqual(payload.entries.map((item) => item.source_kind), ['local', 'cloud']);
    assert.equal(payload.entries[0].mc_session_id, local.session.mc_session_id);
    assert.deepEqual(Object.keys(payload.entries[0]), [
      'source_kind',
      'source_id',
      'mc_session_id',
      'name',
      'objective',
      'lifecycle',
      'runtime_state',
      'runtime_generation',
      'tool',
      'updated_at',
      'workspace_id',
      'workspace_path',
      'workspace_state',
      'workspace_count',
    ]);
  });

  test('--local stays offline and never invokes the cloud client', async () => {
    const fixture = makeFixture();
    fixture.create('offline');
    let cloudCalls = 0;
    const stdout = captureStream();
    const code = await run(['--local', '--names'], {
      mcHomeDir: fixture.mcHomeDir,
      stdout,
      stderr: captureStream(),
      checkAndPrintFreshInstall: async () => false,
      fetchCloudSessions: async () => { cloudCalls += 1; throw new Error('network forbidden'); },
    });
    assert.equal(code, 0);
    assert.equal(stdout.text(), 'offline\n');
    assert.equal(cloudCalls, 0);
  });

  test('renders a 1,000-session bounded projection without runtime probes', () => {
    const sessions = Array.from({ length: 1000 }, (_, index) => ({
      source_kind: 'local',
      source_id: 'machine_test',
      mc_session_id: `mcs_${index.toString(16).padStart(24, '0')}`,
      name: `session-${index.toString().padStart(4, '0')}`,
      lifecycle: 'open',
      runtime_state: 'none',
      workspace_path: `/workspace/${index}`,
      workspace_count: 1,
    }));
    const started = performance.now();
    const output = renderV1SessionList({
      view: buildV1SessionListView({ localSessions: sessions }),
      terminalWidth: 120,
    });
    assert.equal(output.match(/^\d+\./gmu)?.length, 1000);
    assert.ok(performance.now() - started < 1000);
  });

  test('keeps adaptive tables within the terminal width', () => {
    const view = buildV1SessionListView({
      localSessions: [{
        source_kind: 'local',
        source_id: 'machine_test',
        mc_session_id: `mcs_${'a'.repeat(24)}`,
        name: 'compact-session-name',
        lifecycle: 'open',
        runtime_state: 'running',
        tool: 'codex',
        workspace_path: '/workspace/compact-session-name',
        workspace_count: 1,
      }],
    });

    for (const width of [41, 60, 72, 73, 88, 89, 109, 110, 120]) {
      const output = renderV1SessionList({ view, terminalWidth: width });
      const renderedWidth = Math.max(...output.split('\n').map((line) => line.length));
      assert.ok(renderedWidth <= width, `${renderedWidth} exceeded ${width}`);
    }
  });
});

function cloudSession(name) {
  return {
    source_kind: 'cloud',
    source_id: 'memoro-cloud',
    mc_session_id: `mcs_${name === 'same-name' ? 'f' : 'e'.repeat(1)}${'0'.repeat(23)}`,
    name,
    objective: null,
    lifecycle: 'open',
    runtime_state: 'running',
    runtime_generation: 'mcg_000000000000000000000002',
    tool: 'claude',
    updated_at: '2026-08-03T10:00:00.000Z',
    workspace_id: 'mcw_000000000000000000000001',
    workspace_path: '/cloud/workspace',
    workspace_state: 'present',
    workspace_count: 1,
    workspaces: [],
  };
}

function makeFixture() {
  const fixture = makeV1Fixture('mc-list-v1-');
  fixtures.push(fixture);
  return fixture;
}
