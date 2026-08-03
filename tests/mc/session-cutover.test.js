import assert from 'node:assert/strict';
import test, { afterEach, describe } from 'node:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildLifecycleJournal } from '../../src/runtime/broker/lifecycle-journal.js';
import {
  appendManagedGenerationReceiptSync,
  beginManagedGenerationSync,
  claimManagedSessionIdentitySync,
} from '../../src/mc/managed-generation-journal.js';
import { readRegistry } from '../../src/mc/registry.js';
import { readSessionHomeSync } from '../../src/mc/session-home.js';
import {
  decideSessionRuntimeAction,
  inspectSessionRuntimeSync,
} from '../../src/mc/session-runtime-journal.js';
import { readSessionLegacyReferenceSync } from '../../src/mc/session-legacy-reference.js';
import {
  applySessionCutoverSync,
  createSessionCutoverPlanSync,
  inspectSessionCutoverSync,
  rollbackSessionCutoverSync,
  __test__,
} from '../../src/mc/session-cutover.js';

const SESSION_ID = 'mcs_aaaaaaaaaaaaaaaaaaaaaaaa';
const CODING_ID = 'sess_legacy_a';
const GENERATION = '11111111-1111-4111-8111-111111111111';
const CREATED_AT = '2026-08-03T08:00:00.000Z';

let roots = [];
const originalHome = process.env.MC_HOME;

afterEach(() => {
  for (const root of roots) {
    makeTreeRemovable(root);
    rmSync(root, { recursive: true, force: true });
  }
  roots = [];
  if (originalHome === undefined) delete process.env.MC_HOME;
  else process.env.MC_HOME = originalHome;
});

describe('V1 session cutover', () => {
  test('preserves a valid mcs id, exact backup, workspaces, and resumable conversation evidence', () => {
    const fixture = makeFixture();
    const rawRegistry = readFileSync(join(fixture.root, 'registry.json'));

    const plan = createPlan(fixture);
    assert.equal(readRegistry().entries.length, 1);
    assert.equal(plan.sessions[0].mc_session_id, SESSION_ID);
    assert.equal(createPlan(fixture).plan_sha256, plan.plan_sha256);
    assert.equal(plan.backup_items.length, 1);
    const backup = join(fixture.root, 'session-cutover-v1', 'backup', 'files', '00000001.bin');
    assert.deepEqual(readFileSync(backup), rawRegistry);

    const applied = applySessionCutoverSync({
      mcHomeDir: fixture.root,
      now: clock(),
      random: deterministicRandom(),
    });
    assert.equal(applied.ok, true);
    assert.equal(inspectSessionCutoverSync({ mcHomeDir: fixture.root }).state, 'complete');

    const home = readSessionHomeSync({ mcHomeDir: fixture.root, mcSessionId: SESSION_ID });
    assert.equal(home.kind, 'present');
    assert.equal(home.identity.owner.source_id, 'local:test-machine');
    assert.equal(home.metadata.preferred_launch_cwd, fixture.workspace);
    const runtime = inspectSessionRuntimeSync({ mcHomeDir: fixture.root, mcSessionId: SESSION_ID });
    assert.equal(runtime.active_generation, null);
    assert.equal(runtime.generations[0].phase, 'imported');
    assert.equal(runtime.conversations[0].handle, 'codex-conversation-1');
    assert.deepEqual(decideSessionRuntimeAction(runtime), {
      action: 'resume',
      conversation_id: runtime.conversations[0].conversation_id,
      tool: 'codex',
    });
    const references = readSessionLegacyReferenceSync({
      mcHomeDir: fixture.root,
      mcSessionId: SESSION_ID,
    });
    assert.equal(references.kind, 'present');
    assert.equal(references.value.migration_plan_sha256, plan.plan_sha256);
    assert.throws(() => readRegistry(), { code: 'MC_V1_CUTOVER_COMPLETE' });
  });

  test('mints one id exactly once for every supported legacy registry schema', () => {
    for (const schemaVersion of [1, 2, 3]) {
      const fixture = makeFixture({
        schemaVersion,
        entry: { session_id: undefined, tool_sessions: null, tool_session_id: null },
      });
      const first = createPlan(fixture);
      const second = createPlan(fixture);
      assert.match(first.sessions[0].mc_session_id, /^mcs_[a-f0-9]{24}$/u);
      assert.equal(second.sessions[0].mc_session_id, first.sessions[0].mc_session_id);
      assert.equal(second.plan_sha256, first.plan_sha256);
    }
  });

  test('replaces an invalid legacy session id once while retaining bounded reference evidence', () => {
    const fixture = makeFixture({ entry: { session_id: 'sess_old_local_id' } });
    const first = createPlan(fixture);
    const second = createPlan(fixture);
    assert.match(first.sessions[0].mc_session_id, /^mcs_[a-f0-9]{24}$/u);
    assert.equal(second.sessions[0].mc_session_id, first.sessions[0].mc_session_id);
    assert.equal(
      first.sessions[0].legacy_references.registry.legacy_session_id,
      'sess_old_local_id',
    );
  });

  test('blocks source-wide duplicate names and ambiguous managed identity', () => {
    const duplicate = makeFixture({
      entries: [
        baseEntry({ session_id: SESSION_ID, repository_id: 'repo_aaaaaaaaaaaaaaaaaaaaaaaa' }),
        baseEntry({
          session_id: 'mcs_bbbbbbbbbbbbbbbbbbbbbbbb',
          repository_id: 'repo_bbbbbbbbbbbbbbbbbbbbbbbb',
        }),
      ],
    });
    assert.throws(() => createPlan(duplicate), { reason: 'duplicate-session-name' });

    const identity = makeFixture();
    claimManagedSessionIdentitySync({
      mcHomeDir: identity.root,
      sessionName: 'alpha',
      registrySessionId: SESSION_ID,
      codingSessionId: 'sess_conflicting',
      recordedAt: CREATED_AT,
      randomBytes: deterministicRandom(),
    });
    assert.throws(() => createPlan(identity), { reason: 'managed-identity-conflict' });
  });

  test('imports terminal managed generation and provider-artifact evidence', () => {
    const fixture = makeFixture({ entry: { tool_sessions: null } });
    writeTerminalManagedGeneration(fixture);
    const plan = createPlan(fixture);
    assert.equal(plan.sessions[0].conversations[0].handle, 'managed-provider-1');
    assert.equal(plan.sessions[0].legacy_references.managed_generations[0].state, 'ready');
    applySessionCutoverSync({ mcHomeDir: fixture.root, now: clock() });
    const runtime = inspectSessionRuntimeSync({ mcHomeDir: fixture.root, mcSessionId: SESSION_ID });
    assert.equal(runtime.kind, 'present');
    assert.equal(runtime.conversations[0].handle, 'managed-provider-1');
  });

  test('blocks a nonterminal managed generation as an incompatible runtime claim', () => {
    const fixture = makeFixture({ entry: { session_state: 'idle', tool_sessions: null } });
    beginManagedGenerationSync({
      mcHomeDir: fixture.root,
      codingSessionId: CODING_ID,
      runtimeGeneration: GENERATION,
      mode: 'fresh',
      tool: 'codex',
      recordedAt: CREATED_AT,
      randomBytes: deterministicRandom(),
    });
    assert.throws(() => createPlan(fixture), (error) => {
      assert.equal(error.reason, 'live-incompatible-runtimes');
      assert.deepEqual(error.sessions, [CODING_ID]);
      return true;
    });
  });

  test('refuses exact live legacy sessions without killing or guessing them', () => {
    const fixture = makeFixture({ entry: { session_state: 'live' } });
    writeLifecycle(fixture, 'live');
    assert.throws(() => createPlan(fixture), (error) => {
      assert.equal(error.reason, 'live-incompatible-runtimes');
      assert.deepEqual(error.sessions, [CODING_ID]);
      return true;
    });
    assert.equal(existsSync(join(fixture.root, 'registry.json')), true);
    assert.equal(existsSync(join(fixture.root, 'sessions')), false);
  });

  test('refuses an exact live host pid even when registry projection is idle', () => {
    const fixture = makeFixture({ entry: { session_state: 'idle' } });
    const host = join(fixture.root, 'hosts', CODING_ID);
    mkdirSync(host, { recursive: true, mode: 0o700 });
    writeFileSync(join(host, 'host.json'), `${JSON.stringify({
      session_id: CODING_ID,
      broker_pid: 4242,
    })}\n`, { mode: 0o600 });
    writeFileSync(join(host, 'broker.pid'), '4242\n', { mode: 0o600 });
    assert.throws(() => createSessionCutoverPlanSync({
      mcHomeDir: fixture.root,
      sourceId: 'local:test-machine',
      now: clock(),
      random: deterministicRandom(),
      isAlive: (pid) => pid === 4242,
    }), (error) => {
      assert.equal(error.reason, 'live-incompatible-runtimes');
      assert.deepEqual(error.sessions, [CODING_ID]);
      return true;
    });
  });

  test('uses exact exited lifecycle evidence over a stale live registry projection', () => {
    const fixture = makeFixture({ entry: { session_state: 'live' } });
    writeLifecycle(fixture, 'exited', { exitCode: 1 });
    const plan = createPlan(fixture);
    assert.equal(plan.sessions[0].legacy_references.runtime_hosts[0].state, 'exited');
    assert.equal(applySessionCutoverSync({ mcHomeDir: fixture.root, now: clock() }).ok, true);
  });

  test('uses exact launch-failed lifecycle evidence over a stale live registry projection', () => {
    const fixture = makeFixture({ entry: { session_state: 'live' } });
    writeLifecycle(fixture, 'launch_failed');
    const plan = createPlan(fixture);
    assert.equal(plan.sessions[0].legacy_references.runtime_hosts[0].state, 'launch_failed');
    assert.equal(applySessionCutoverSync({ mcHomeDir: fixture.root, now: clock() }).ok, true);
  });

  test('rejects self-consistent plans and backup manifests with unsafe paths', () => {
    const planFixture = makeFixture();
    const plan = createPlan(planFixture);
    const tamperedPlan = structuredClone(plan);
    tamperedPlan.sources[0].relative_path = '../outside';
    const unsigned = { ...tamperedPlan };
    delete unsigned.plan_sha256;
    tamperedPlan.plan_sha256 = __test__.digestValue(unsigned);
    writeFileSync(
      join(planFixture.root, 'session-cutover-v1', 'plan.json'),
      `${JSON.stringify(tamperedPlan)}\n`,
    );
    assert.throws(() => applySessionCutoverSync({ mcHomeDir: planFixture.root }), {
      reason: 'invalid-cutover-source',
    });

    const backupFixture = makeFixture();
    createPlan(backupFixture);
    const manifestPath = join(
      backupFixture.root,
      'session-cutover-v1',
      'backup',
      'manifest.json',
    );
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.files[0].relative_path = '../outside';
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    assert.throws(() => applySessionCutoverSync({ mcHomeDir: backupFixture.root }), {
      reason: 'backup-unavailable',
    });
    assert.equal(lstatSync(join(backupFixture.root, 'registry.json')).isFile(), true);
  });

  test('detects a changed legacy source before installing any cutover interlock', () => {
    const fixture = makeFixture();
    createPlan(fixture);
    writeFileSync(join(fixture.root, 'registry.json'), '{"schema_version":3,"entries":[]}\n');
    assert.throws(() => applySessionCutoverSync({ mcHomeDir: fixture.root }), {
      reason: 'legacy-source-registry-changed',
    });
    assert.equal(lstatSync(join(fixture.root, 'registry.json')).isFile(), true);
    assert.equal(existsSync(join(fixture.root, 'broker.sock')), false);
    assert.equal(existsSync(join(fixture.root, 'hosts')), false);
  });

  test('resumes after every published apply boundary without a second authority', () => {
    const baseline = makeFixture();
    createPlan(baseline);
    const boundaries = [];
    applySessionCutoverSync({
      mcHomeDir: baseline.root,
      now: clock(),
      random: deterministicRandom(),
      afterWrite(label) { boundaries.push(label); },
    });
    assert.ok(boundaries.includes('complete'));
    assert.ok(boundaries.some((label) => label.includes(':runtime:') && label.endsWith(':receipt')));

    for (const boundary of boundaries) {
      const fixture = makeFixture();
      createPlan(fixture);
      let interrupted = false;
      assert.throws(() => applySessionCutoverSync({
        mcHomeDir: fixture.root,
        now: clock(),
        random: deterministicRandom(),
        afterWrite(label) {
          if (!interrupted && label === boundary) {
            interrupted = true;
            throw new Error(`interrupt:${label}`);
          }
        },
      }), /interrupt:/u);
      const retried = applySessionCutoverSync({
        mcHomeDir: fixture.root,
        now: clock(),
        random: deterministicRandom(),
      });
      assert.equal(retried.ok, true);
      assert.equal(inspectSessionCutoverSync({ mcHomeDir: fixture.root }).state, 'complete');
    }
  });

  test('resumes plan and backup creation after every publication boundary', () => {
    const baseline = makeFixture();
    const boundaries = [];
    createSessionCutoverPlanSync({
      mcHomeDir: baseline.root,
      sourceId: 'local:test-machine',
      now: clock(),
      random: deterministicRandom(),
      afterWrite(label) { boundaries.push(label); },
    });
    assert.deepEqual(boundaries, ['plan', 'backup:00000001.bin', 'backup-manifest']);

    for (const boundary of boundaries) {
      const fixture = makeFixture();
      let interrupted = false;
      assert.throws(() => createSessionCutoverPlanSync({
        mcHomeDir: fixture.root,
        sourceId: 'local:test-machine',
        now: clock(),
        random: deterministicRandom(),
        afterWrite(label) {
          if (!interrupted && label === boundary) {
            interrupted = true;
            throw new Error(`interrupt:${label}`);
          }
        },
      }), /interrupt:/u);
      const retried = createPlan(fixture);
      assert.equal(retried.sessions[0].mc_session_id, SESSION_ID);
      assert.equal(inspectSessionCutoverSync({ mcHomeDir: fixture.root }).backup.kind, 'present');
    }
  });

  test('rolls back an interrupted pre-publication cutover from exact evidence', () => {
    const fixture = makeFixture();
    const original = readFileSync(join(fixture.root, 'registry.json'));
    createPlan(fixture);
    assert.throws(() => applySessionCutoverSync({
      mcHomeDir: fixture.root,
      now: clock(),
      random: deterministicRandom(),
      afterWrite(label) {
        if (label === `session:${SESSION_ID}`) throw new Error('stop-before-publication');
      },
    }), /stop-before-publication/u);
    assert.throws(() => readRegistry(), { code: 'MC_V1_CUTOVER_IN_PROGRESS' });

    const rolledBack = rollbackSessionCutoverSync({ mcHomeDir: fixture.root, now: clock() });
    assert.equal(rolledBack.ok, true);
    assert.equal(inspectSessionCutoverSync({ mcHomeDir: fixture.root }).state, 'rolled-back');
    assert.deepEqual(readFileSync(join(fixture.root, 'registry.json')), original);
    assert.equal(readRegistry().entries.length, 1);
    assert.equal(readSessionHomeSync({ mcHomeDir: fixture.root, mcSessionId: SESSION_ID }).kind, 'absent');
    assert.throws(() => applySessionCutoverSync({ mcHomeDir: fixture.root }), {
      reason: 'cutover-rolled-back',
    });
  });

  test('rolls back safely before every legacy target has been quarantined', () => {
    const fixture = makeFixture();
    const original = readFileSync(join(fixture.root, 'registry.json'));
    createPlan(fixture);
    assert.throws(() => applySessionCutoverSync({
      mcHomeDir: fixture.root,
      now: clock(),
      afterWrite(label) {
        if (label === 'quarantine:global-broker-socket:receipt') throw new Error('early-stop');
      },
    }), /early-stop/u);
    assert.equal(rollbackSessionCutoverSync({ mcHomeDir: fixture.root, now: clock() }).ok, true);
    assert.deepEqual(readFileSync(join(fixture.root, 'registry.json')), original);
    assert.equal(existsSync(join(fixture.root, 'broker.sock')), false);
  });

  test('resumes rollback after every restoration boundary', () => {
    const baseline = makeInterruptedAppliedFixture();
    const boundaries = [];
    rollbackSessionCutoverSync({
      mcHomeDir: baseline.root,
      now: clock(),
      afterWrite(label) { boundaries.push(label); },
    });
    assert.ok(boundaries.includes('rollback'));
    assert.equal(
      boundaries.filter((label) => label.startsWith('rollback-source:')).length,
      __test__.LEGACY_TARGETS.length,
    );

    for (const boundary of boundaries) {
      const fixture = makeInterruptedAppliedFixture();
      let interrupted = false;
      assert.throws(() => rollbackSessionCutoverSync({
        mcHomeDir: fixture.root,
        now: clock(),
        afterWrite(label) {
          if (!interrupted && label === boundary) {
            interrupted = true;
            throw new Error(`interrupt:${label}`);
          }
        },
      }), /interrupt:/u);
      const retried = rollbackSessionCutoverSync({ mcHomeDir: fixture.root, now: clock() });
      assert.equal(retried.ok, true);
      assert.equal(inspectSessionCutoverSync({ mcHomeDir: fixture.root }).state, 'rolled-back');
      assert.equal(lstatSync(join(fixture.root, 'registry.json')).isFile(), true);
      assert.equal(
        readSessionHomeSync({ mcHomeDir: fixture.root, mcSessionId: SESSION_ID }).kind,
        'absent',
      );
    }
  });

  test('backs up only bounded metadata while quarantining legacy logs unchanged', () => {
    const fixture = makeFixture();
    const host = join(fixture.root, 'hosts', CODING_ID);
    mkdirSync(host, { recursive: true, mode: 0o700 });
    writeFileSync(join(host, 'broker.log'), Buffer.alloc(512 * 1024, 0x78), { mode: 0o600 });
    writeLifecycle(fixture, 'exited', { exitCode: 1 });
    const plan = createPlan(fixture);
    assert.equal(plan.backup_items.some((item) => item.relative_path.endsWith('broker.log')), false);
    applySessionCutoverSync({ mcHomeDir: fixture.root, now: clock() });
    const quarantinedLog = join(
      fixture.root,
      'session-cutover-v1',
      'quarantine',
      'runtime-hosts',
      CODING_ID,
      'broker.log',
    );
    assert.equal(lstatSync(quarantinedLog).size, 512 * 1024);
  });

  test('physical tombstones block older registry, host, and broker writers', () => {
    const fixture = makeFixture();
    createPlan(fixture);
    applySessionCutoverSync({ mcHomeDir: fixture.root, now: clock() });

    assert.equal(lstatSync(join(fixture.root, 'registry.json')).isDirectory(), true);
    writeFileSync(join(fixture.root, 'registry.json.tmp'), '{}');
    assert.throws(() => renameSync(
      join(fixture.root, 'registry.json.tmp'),
      join(fixture.root, 'registry.json'),
    ));
    assert.equal(lstatSync(join(fixture.root, 'hosts')).isFile(), true);
    assert.throws(() => mkdirSync(join(fixture.root, 'hosts', CODING_ID), { recursive: true }));
    assert.equal(lstatSync(join(fixture.root, 'broker.sock')).isDirectory(), true);
    assert.throws(() => writeFileSync(join(fixture.root, 'broker.sock'), 'socket'));
  });

  test('refuses rollback after completion publication', () => {
    const fixture = makeFixture();
    createPlan(fixture);
    applySessionCutoverSync({ mcHomeDir: fixture.root, now: clock() });
    assert.throws(() => rollbackSessionCutoverSync({ mcHomeDir: fixture.root }), {
      reason: 'rollback-after-publication-refused',
    });
  });
});

function makeFixture({ schemaVersion = 3, entry = {}, entries = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mc-session-cutover-'));
  roots.push(root);
  chmodSync(root, 0o700);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const registryEntries = entries || [baseEntry({ worktree_path: workspace, ...entry })];
  const registry = {
    ...(schemaVersion === 1 ? {} : { schema_version: schemaVersion }),
    entries: registryEntries.map((value) => stripUndefined(value)),
  };
  writeFileSync(join(root, 'registry.json'), `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  process.env.MC_HOME = root;
  return { root, workspace };
}

function baseEntry(patch = {}) {
  return {
    name: 'alpha',
    session_id: SESSION_ID,
    repository_id: null,
    repository_identity: null,
    worktree_path: '/tmp/mc-cutover-workspace',
    primary_worktree: null,
    branch: 'sess/alpha',
    tool: 'codex',
    coding_session_id: CODING_ID,
    session_state: 'idle',
    session_objective: 'Preserve this work',
    tool_session_id: null,
    tool_session_source: null,
    tool_transcript_path: null,
    tool_session_adapter: null,
    tool_session_generation: null,
    tool_sessions: {
      schema: 1,
      providers: {
        codex: {
          session_id: 'codex-conversation-1',
          transcript_path: null,
          runtime_generation: null,
          last_consumed_handoff_sequence: 0,
        },
      },
    },
    created_at: CREATED_AT,
    ...patch,
  };
}

function createPlan(fixture) {
  return createSessionCutoverPlanSync({
    mcHomeDir: fixture.root,
    sourceId: 'local:test-machine',
    now: clock(),
    random: deterministicRandom(),
  });
}

function makeInterruptedAppliedFixture() {
  const fixture = makeFixture();
  createPlan(fixture);
  assert.throws(() => applySessionCutoverSync({
    mcHomeDir: fixture.root,
    now: clock(),
    random: deterministicRandom(),
    afterWrite(label) {
      if (label === `session:${SESSION_ID}`) throw new Error('stop-before-publication');
    },
  }), /stop-before-publication/u);
  return fixture;
}

function writeLifecycle(fixture, state, { exitCode } = {}) {
  const host = join(fixture.root, 'hosts', CODING_ID);
  mkdirSync(host, { recursive: true, mode: 0o700 });
  const value = buildLifecycleJournal({
    codingSessionId: CODING_ID,
    runtimeGeneration: GENERATION,
    state,
    observedAt: CREATED_AT,
    ...(exitCode === undefined ? {} : { exitCode }),
  });
  writeFileSync(join(host, 'lifecycle.json'), `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function writeTerminalManagedGeneration(fixture) {
  const started = beginManagedGenerationSync({
    mcHomeDir: fixture.root,
    codingSessionId: CODING_ID,
    runtimeGeneration: GENERATION,
    mode: 'fresh',
    tool: 'codex',
    recordedAt: CREATED_AT,
    randomBytes: deterministicRandom(),
  });
  const digestA = 'a'.repeat(64);
  const digestB = 'b'.repeat(64);
  const phases = [
    ['domain-ready', { domain_generation: 'domain_1', manifest_digest: digestA }],
    ['broker-accepted', {}],
    ['live', {}],
    ['provider-artifact', {
      provider_session_id: 'managed-provider-1',
      artifact_digest: digestA,
      tool: 'codex',
      transcript_path: '/private/tmp/managed-provider.jsonl',
      captured_at: CREATED_AT,
    }],
    ['exited', { exit_code: 0, signal: null }],
    ['custody-persisted', { record_digest: digestA }],
    ['archive-ready', { provider_session_id: 'managed-provider-1', archive_digest: digestB }],
    ['domain-cleaned', { domain_generation: 'domain_1' }],
    ['ready', { provider_session_id: 'managed-provider-1', archive_digest: digestB }],
  ];
  for (const [phase, data] of phases) {
    appendManagedGenerationReceiptSync({
      mcHomeDir: fixture.root,
      codingSessionId: CODING_ID,
      runtimeGeneration: GENERATION,
      intentDigest: started.intent.intent_digest,
      phase,
      data,
      recordedAt: CREATED_AT,
      randomBytes: deterministicRandom(),
    });
  }
}

function clock() {
  let tick = 0;
  return () => new Date(Date.parse(CREATED_AT) + (tick++) * 1000).toISOString();
}

function deterministicRandom() {
  let next = 0;
  return (size) => Buffer.alloc(size, (++next) & 0xff);
}

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function makeTreeRemovable(path) {
  let stat;
  try { stat = lstatSync(path); } catch { return; }
  if (!stat.isDirectory()) {
    try { chmodSync(path, 0o600); } catch {}
    return;
  }
  try { chmodSync(path, 0o700); } catch {}
  let names = [];
  try { names = readdirSync(path); } catch {}
  for (const name of names) makeTreeRemovable(join(path, name));
}
