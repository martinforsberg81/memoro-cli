import assert from 'node:assert/strict';
import { test } from 'node:test';

import { run as runCleanup } from '../../../src/mc/commands/cleanup.js';
import { run as runDelete } from '../../../src/mc/commands/delete.js';
import { run as runDoctor } from '../../../src/mc/commands/doctor.js';
import { run as runEnd } from '../../../src/mc/commands/end.js';
import { run as runGc } from '../../../src/mc/commands/gc.js';
import { run as runStorage } from '../../../src/mc/commands/storage.js';

const session = {
  mc_session_id: 'mcs_000000000000000000000001',
  metadata: { name: 'alpha' },
  projection: { lifecycle: 'open' },
};

test('end routes one resolved local session and reports that Git resources are kept', async () => {
  const io = streams();
  const calls = [];
  const code = await runEnd(['alpha'], {
    ...io,
    resolveLocalSession: () => ({ ok: true, session }),
    endSession: async (input) => {
      calls.push(input.session.mc_session_id);
      return { ok: true, name: 'alpha', mc_session_id: session.mc_session_id, lifecycle: 'archived' };
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [session.mc_session_id]);
  assert.match(io.out(), /Git resources were kept/u);
});

test('delete requires both an explicit verb and force confirmation', async () => {
  const missing = streams();
  assert.equal(await runDelete(['alpha'], missing), 2);
  assert.match(missing.err(), /--force/u);

  const applied = streams();
  const code = await runDelete(['alpha', '--force', '--json'], {
    ...applied,
    resolveLocalSession: () => ({ ok: true, session }),
    deleteSession: () => ({ ok: true, name: 'alpha', mc_session_id: session.mc_session_id }),
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(applied.out()).ok, true);
});

test('owned-resource cleanup requires an explicit dry-run or apply choice', async () => {
  const missing = streams();
  assert.equal(await runCleanup(['alpha'], missing), 2);
  let applied = false;
  const io = streams();
  const code = await runCleanup(['alpha', '--apply', '--json'], {
    ...io,
    resolveLocalSession: () => ({ ok: true, session }),
    applyCleanup: () => { applied = true; return { ok: true, plans: [], issues: [], results: [] }; },
  });
  assert.equal(code, 0);
  assert.equal(applied, true);
  assert.equal(JSON.parse(io.out()).applied, true);
});

test('gc rejects legacy worktree deletion flags and only calls session maintenance', async () => {
  const rejected = streams();
  assert.equal(await runGc(['--stale-worktrees'], rejected), 2);
  const io = streams();
  const code = await runGc(['--apply', '--json'], {
    ...io,
    maintain: ({ apply }) => ({
      ok: true,
      applied: apply,
      summary: { sessions: 1, archived: 0, runtime_active: 0, runtime_stale: 0, runtime_unsafe: 0 },
      actions: [],
      issues: [],
    }),
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(io.out()).applied, true);
});

test('storage and doctor expose only V1 maintenance state', async () => {
  const snapshot = {
    ok: true,
    summary: { sessions: 2, archived: 1, runtime_active: 0, runtime_stale: 0, runtime_unsafe: 0 },
    issues: [],
    runtime: [],
    catalog: { issues: [], actions: [] },
  };
  const storage = streams();
  assert.equal(await runStorage(['status', '--json'], { ...storage, scan: () => snapshot }), 0);
  assert.equal(JSON.parse(storage.out()).summary.sessions, 2);
  const doctor = streams();
  assert.equal(await runDoctor(['--json'], {
    ...doctor,
    scan: () => snapshot,
    inspectDevServers: () => ({
      ok: true,
      summary: { total: 0, bound: 0, unbound: 0, absent_session: 0 },
      issues: [],
    }),
  }), 0);
  assert.equal(JSON.parse(doctor.out()).ok, true);

  const failingDoctor = streams();
  assert.equal(await runDoctor(['--json'], {
    ...failingDoctor,
    scan: () => ({ ...snapshot, ok: false, issues: [{ scope: 'runtime', reason: 'unsafe' }] }),
    inspectDevServers: () => ({
      ok: true,
      summary: { total: 0, bound: 0, unbound: 0, absent_session: 0 },
      issues: [],
    }),
  }), 1);
});

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
