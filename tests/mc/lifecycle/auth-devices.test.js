/**
 * `mc auth devices` (§14e) — list + revoke verbs.
 *
 * Pure tests cover argv parsing, target resolution, table formatting,
 * and the no-token error path. The CLI integration tests confirm the
 * dispatcher wires through to the verb without hitting a real keychain
 * (MC_TEST_MODE=1 stubs out the device-flow auto-trigger, leaving the
 * verb to print its own "no token" line and exit 1).
 */
import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runMc, parseJsonOrNull } from '../_helpers/cli.js';
import { makeTempRepo } from '../_helpers/git-fixture.js';

import {
  resolveTarget,
  parseListArgs,
  parseRevokeArgs,
  formatDeviceTable,
  humanRelative,
  runList,
  runRevoke,
} from '../../../src/mc/commands/auth-devices.js';

describe('parseListArgs', () => {
  test('defaults to non-JSON', () => {
    assert.deepEqual(parseListArgs([]), { json: false });
  });
  test('--json sets json=true', () => {
    assert.deepEqual(parseListArgs(['--json']), { json: true });
  });
  test('"list" keyword is allowed (no-op)', () => {
    assert.deepEqual(parseListArgs(['list', '--json']), { json: true });
  });
  test('rejects unknown flags', () => {
    const o = parseListArgs(['--whatever']);
    assert.ok(o.error);
  });
});

describe('parseRevokeArgs', () => {
  test('requires a target', () => {
    assert.ok(parseRevokeArgs([]).error);
  });
  test('accepts a positional target', () => {
    assert.deepEqual(parseRevokeArgs(['mem_abcd']), {
      target: 'mem_abcd', confirmSelf: false, json: false,
    });
  });
  test('parses --confirm-self', () => {
    const o = parseRevokeArgs(['mem_x', '--confirm-self']);
    assert.equal(o.confirmSelf, true);
  });
  test('parses --json', () => {
    const o = parseRevokeArgs(['mem_x', '--json']);
    assert.equal(o.json, true);
  });
  test('rejects unknown flags', () => {
    assert.ok(parseRevokeArgs(['mem_x', '--what']).error);
  });
  test('rejects double positional', () => {
    assert.ok(parseRevokeArgs(['mem_x', 'mem_y']).error);
  });
});

describe('resolveTarget', () => {
  const devices = [
    { id: 'tok_aaa', name: 'Vanjas MacBook Air', token_prefix: 'mem_a1b2…', is_current: false },
    { id: 'tok_bbb', name: 'Studio MBP',          token_prefix: 'mem_a3c4…', is_current: true  },
    { id: 'tok_ccc', name: 'Server',              token_prefix: 'mem_zzzz…', is_current: false },
  ];

  test('exact id match', () => {
    const r = resolveTarget(devices, 'tok_bbb');
    assert.equal(r.kind, 'one');
    assert.equal(r.device.id, 'tok_bbb');
  });

  test('case-insensitive exact name match', () => {
    const r = resolveTarget(devices, 'studio mbp');
    assert.equal(r.kind, 'one');
    assert.equal(r.device.id, 'tok_bbb');
  });

  test('unique prefix match', () => {
    const r = resolveTarget(devices, 'mem_zzzz');
    assert.equal(r.kind, 'one');
    assert.equal(r.device.id, 'tok_ccc');
  });

  test('ambiguous prefix → ambiguous with candidates', () => {
    const r = resolveTarget(devices, 'mem_a');
    assert.equal(r.kind, 'ambiguous');
    assert.equal(r.candidates.length, 2);
  });

  test('no match → none', () => {
    assert.equal(resolveTarget(devices, 'nope').kind, 'none');
  });

  test('empty list → none', () => {
    assert.equal(resolveTarget([], 'anything').kind, 'none');
  });
});

describe('humanRelative', () => {
  test('returns empty string for missing input', () => {
    assert.equal(humanRelative(null), '');
    assert.equal(humanRelative(''), '');
  });
  test('formats seconds / minutes / hours / days', () => {
    const now = 1_700_000_000_000;
    const at = (deltaMs) => new Date(now - deltaMs).toISOString();
    assert.equal(humanRelative(at(10_000), { now: () => now }), '10s ago');
    assert.equal(humanRelative(at(90_000), { now: () => now }), '1m ago');
    assert.equal(humanRelative(at(3_600_000 * 2), { now: () => now }), '2h ago');
    assert.equal(humanRelative(at(86_400_000 * 3), { now: () => now }), '3d ago');
  });
});

describe('formatDeviceTable', () => {
  test('renders a header line + a row per device', () => {
    const out = formatDeviceTable([
      { name: 'Air', token_prefix: 'mem_a1…', expires_at: '2026-08-29T12:00:00Z',
        last_used_at: null, is_current: true },
    ]);
    assert.match(out, /name/);
    assert.match(out, /expires_at/);
    assert.match(out, /token_prefix/);
    assert.match(out, /Air/);
    assert.match(out, /mem_a1…/);
    assert.match(out, /\*/, 'current device marked');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runList / runRevoke — in-process tests with injected deps
// ─────────────────────────────────────────────────────────────────────────────

function makeWritable() {
  const writes = [];
  return {
    writes,
    write(s) { writes.push(s); return true; },
    get text() { return writes.join(''); },
  };
}

describe('runList (in-process)', () => {
  test('prints "No devices found" on an empty list', async () => {
    const stdout = makeWritable();
    const stderr = makeWritable();
    const code = await runList([], {
      apiUrl: 'http://test',
      getSecret: async () => 'mem_token',
      memoroFetch: async () => ({ ok: true, devices: [] }),
      stdout, stderr,
    });
    assert.equal(code, 0);
    assert.match(stdout.text, /No devices found/);
  });

  test('--json passes through the server array', async () => {
    const stdout = makeWritable();
    const stderr = makeWritable();
    const devices = [
      { id: 'tok_1', name: 'X', token_prefix: 'mem_x…', expires_at: null, last_used_at: null, is_current: false },
    ];
    const code = await runList(['--json'], {
      apiUrl: 'http://test',
      getSecret: async () => 'mem_token',
      memoroFetch: async () => ({ ok: true, devices }),
      stdout, stderr,
    });
    assert.equal(code, 0);
    const j = JSON.parse(stdout.text);
    assert.deepEqual(j.devices, devices);
  });

  test('no token → exit 1, friendly stderr', async () => {
    const stdout = makeWritable();
    const stderr = makeWritable();
    const code = await runList([], {
      apiUrl: 'http://test',
      getSecret: async () => null,
      memoroFetch: async () => { throw new Error('should not call'); },
      stdout, stderr,
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /no Memoro token/);
  });
});

describe('runRevoke (in-process)', () => {
  const baseDevices = [
    { id: 'tok_a', name: 'Air',    token_prefix: 'mem_aaa…', is_current: false, expires_at: null, last_used_at: null },
    { id: 'tok_b', name: 'Studio', token_prefix: 'mem_bbb…', is_current: true,  expires_at: null, last_used_at: null },
  ];

  test('happy path: revokes by name', async () => {
    const stdout = makeWritable();
    const stderr = makeWritable();
    const calls = [];
    const code = await runRevoke(['Air'], {
      apiUrl: 'http://test',
      getSecret: async () => 'mem_token',
      memoroFetch: async (_url, path, opts) => {
        calls.push({ path, method: opts?.method || 'GET' });
        if (path === '/api/auth/devices') return { ok: true, devices: baseDevices };
        return { ok: true };
      },
      stdout, stderr,
    });
    assert.equal(code, 0);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].path, '/api/auth/devices/tok_a/revoke');
    assert.equal(calls[1].method, 'POST');
    assert.match(stdout.text, /Revoked: Air/);
  });

  test('refuses to revoke current device without --confirm-self', async () => {
    const stdout = makeWritable();
    const stderr = makeWritable();
    let revokeCalled = false;
    const code = await runRevoke(['Studio'], {
      apiUrl: 'http://test',
      getSecret: async () => 'mem_token',
      memoroFetch: async (_url, path) => {
        if (path === '/api/auth/devices') return { ok: true, devices: baseDevices };
        revokeCalled = true;
        return { ok: true };
      },
      stdout, stderr,
    });
    assert.equal(code, 1);
    assert.equal(revokeCalled, false);
    assert.match(stderr.text, /refusing to revoke the current device/);
    assert.match(stderr.text, /--confirm-self/);
  });

  test('--confirm-self lets the current device be revoked', async () => {
    const stdout = makeWritable();
    const stderr = makeWritable();
    let revokeCalled = false;
    const code = await runRevoke(['Studio', '--confirm-self'], {
      apiUrl: 'http://test',
      getSecret: async () => 'mem_token',
      memoroFetch: async (_url, path) => {
        if (path === '/api/auth/devices') return { ok: true, devices: baseDevices };
        if (path === '/api/auth/devices/tok_b/revoke') { revokeCalled = true; return { ok: true }; }
        return { ok: true };
      },
      stdout, stderr,
    });
    assert.equal(code, 0);
    assert.equal(revokeCalled, true);
  });

  test('ambiguous prefix → exit 1, candidates listed on stderr', async () => {
    const stdout = makeWritable();
    const stderr = makeWritable();
    const devices = [
      { id: 'tok_a', name: 'A', token_prefix: 'mem_aa1…', is_current: false },
      { id: 'tok_b', name: 'B', token_prefix: 'mem_aa2…', is_current: false },
    ];
    const code = await runRevoke(['mem_aa'], {
      apiUrl: 'http://test',
      getSecret: async () => 'mem_token',
      memoroFetch: async () => ({ ok: true, devices }),
      stdout, stderr,
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /matched 2 devices/);
    assert.match(stderr.text, /mem_aa1…/);
    assert.match(stderr.text, /mem_aa2…/);
  });

  test('no match → exit 1', async () => {
    const stdout = makeWritable();
    const stderr = makeWritable();
    const code = await runRevoke(['nope'], {
      apiUrl: 'http://test',
      getSecret: async () => 'mem_token',
      memoroFetch: async () => ({ ok: true, devices: baseDevices }),
      stdout, stderr,
    });
    assert.equal(code, 1);
    assert.match(stderr.text, /no device matches "nope"/);
  });

  test('--json on success prints ok:true plus the revoked metadata', async () => {
    const stdout = makeWritable();
    const stderr = makeWritable();
    const code = await runRevoke(['Air', '--json'], {
      apiUrl: 'http://test',
      getSecret: async () => 'mem_token',
      memoroFetch: async () => ({ ok: true, devices: baseDevices }),
      stdout, stderr,
    });
    assert.equal(code, 0);
    const j = JSON.parse(stdout.text);
    assert.equal(j.ok, true);
    assert.equal(j.revoked.id, 'tok_a');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CLI dispatcher: `mc auth devices` is wired in and exits cleanly
// when no token is stored.
// ─────────────────────────────────────────────────────────────────────────────

describe('mc auth devices (CLI dispatcher)', () => {
  let repo;
  let pidDir;
  beforeEach(() => {
    repo = makeTempRepo({ name: 'auth-devices' });
    pidDir = mkdtempSync(join(tmpdir(), 'mc-auth-dev-'));
  });
  afterEach(() => {
    repo.cleanup();
    try { rmSync(pidDir, { recursive: true, force: true }); } catch {}
  });

  test('list with no token → exit 1, friendly stderr', () => {
    const r = runMc(['auth', 'devices'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /no Memoro token/);
  });

  test('revoke with no target → exit 2', () => {
    const r = runMc(['auth', 'devices', 'revoke'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /requires a prefix/);
  });

  test('unknown sub-verb → exit 2 with hint', () => {
    const r = runMc(['auth', 'devices', 'destroy'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown devices subcommand/);
  });

  test('--json with no token still uses the human stderr line (non-JSON error path)', () => {
    // Per drev 3+4 lesson: tests must cover the non-JSON error path,
    // not just the JSON branch. Auth pre-check happens before the
    // --json branch, so the user sees a human-readable error.
    const r = runMc(['auth', 'devices', '--json'], {
      cwd: repo.dir,
      env: { MC_HOME: repo.mcHome, MC_ORPHAN_PID_DIR: pidDir, HOME: repo.root },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no Memoro token/);
  });
});
