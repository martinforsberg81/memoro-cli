import assert from 'node:assert/strict';
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach, describe } from 'node:test';

import {
  LIFECYCLE_JOURNAL_SCHEMA,
  LIFECYCLE_JOURNAL_VERSION,
  buildLifecycleJournal,
  readSessionLifecycle,
  readLifecycleJournal,
  validateJournal,
  writeLifecycleJournal,
  writeSessionLifecycle,
  writeSessionLifecycleSync,
} from '../../../src/mc/broker/lifecycle-journal.js';

let root = null;

function journalPath() {
  root = mkdtempSync(join(tmpdir(), 'mc-lifecycle-journal-'));
  return join(root, 'lifecycle.json');
}

function input(overrides = {}) {
  return {
    codingSessionId: 'sess_journal_123',
    runtimeGeneration: '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701',
    state: 'live',
    observedAt: '2026-07-27T12:34:56.789Z',
    ...overrides,
  };
}

function expected() {
  return {
    codingSessionId: 'sess_journal_123',
    runtimeGeneration: '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701',
  };
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe('broker lifecycle journal', () => {
  test('atomically writes only versioned metadata with mode 0600', async () => {
    journalPath();
    const path = join(root, 'async', 'lifecycle.json');

    const journal = await writeLifecycleJournal(path, input());

    assert.deepEqual(journal, {
      schema: LIFECYCLE_JOURNAL_SCHEMA,
      version: LIFECYCLE_JOURNAL_VERSION,
      coding_session_id: 'sess_journal_123',
      runtime_generation: '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701',
      state: 'live',
      observed_at: '2026-07-27T12:34:56.789Z',
    });
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), journal);
    assert.equal(statSync(join(root, 'async')).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(await readLifecycleJournal(path, expected()), { kind: 'present', journal });
  });

  test('persists optional exclusive process termination metadata', async () => {
    const path = journalPath();
    const exited = await writeLifecycleJournal(path, input({ state: 'exited', exitCode: 17 }));
    assert.equal(exited.exit_code, 17);
    assert.equal('signal' in exited, false);

    const failed = buildLifecycleJournal(input({ state: 'launch_failed', signal: 'SIGTERM' }));
    assert.equal(failed.signal, 'SIGTERM');
  });

  test('provides BrokerRuntime and resume adapters with fail-closed verdicts', async () => {
    const path = journalPath();
    await writeSessionLifecycle({ path, ...input({ state: 'launch_failed' }) });

    assert.deepEqual(await readSessionLifecycle({ path, codingSessionId: 'sess_journal_123' }), {
      verdict: 'exited',
      record: buildLifecycleJournal(input({ state: 'launch_failed' })),
    });
    assert.deepEqual(await readSessionLifecycle({ path, codingSessionId: 'sess_other' }), {
      verdict: 'unknown',
      record: null,
      reason: 'session-mismatch',
    });
  });

  test('sync exit writer creates a 0700 parent and fsyncs before the atomic rename', () => {
    journalPath();
    const path = join(root, 'nested', 'lifecycle.json');
    const calls = [];
    const fs = {
      mkdirSync(...args) { calls.push('mkdir'); return mkdirSync(...args); },
      openSync(...args) { calls.push('open'); return openSync(...args); },
      writeFileSync(...args) { calls.push('write'); return writeFileSync(...args); },
      fsyncSync(...args) { calls.push('fsync'); return fsyncSync(...args); },
      fchmodSync(...args) { calls.push('chmod'); return fchmodSync(...args); },
      closeSync(...args) { calls.push('close'); return closeSync(...args); },
      renameSync(...args) { calls.push('rename'); return renameSync(...args); },
      rmSync(...args) { calls.push('rm'); return rmSync(...args); },
    };

    const journal = writeSessionLifecycleSync({ path, ...input({ state: 'exited', exitCode: 0 }), fs });

    assert.deepEqual(calls, ['mkdir', 'open', 'write', 'fsync', 'chmod', 'close', 'rename']);
    assert.equal(statSync(join(root, 'nested')).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), journal);
  });

  test('rejects non-metadata fields and inconsistent lifecycle shapes before writing', () => {
    assert.throws(
      () => buildLifecycleJournal({ ...input(), terminalText: 'do not persist' }),
      /unexpected-keys/,
    );
    assert.throws(
      () => buildLifecycleJournal(input({ exitCode: 1 })),
      /live-has-exit/,
    );
    assert.deepEqual(validateJournal({ ...buildLifecycleJournal(input()), env: { TOKEN: 'never' } }), {
      ok: false,
      reason: 'unexpected-keys',
    });
  });

  test('returns absent for no evidence and unknown for corrupt or insecure evidence', async () => {
    const path = journalPath();
    assert.deepEqual(await readLifecycleJournal(path, expected()), { kind: 'absent', journal: null });

    writeFileSync(path, '{not json', { mode: 0o600 });
    chmodSync(path, 0o600);
    assert.deepEqual(await readLifecycleJournal(path, expected()), {
      kind: 'unknown',
      journal: null,
      reason: 'corrupt',
    });

    writeFileSync(path, JSON.stringify(buildLifecycleJournal(input())), { mode: 0o644 });
    chmodSync(path, 0o644);
    assert.deepEqual(await readLifecycleJournal(path, expected()), {
      kind: 'unknown',
      journal: null,
      reason: 'unsafe-file',
    });
  });

  test('fails closed on a session or generation mismatch and invalid generations', async () => {
    const path = journalPath();
    await writeLifecycleJournal(path, input());

    assert.deepEqual(await readLifecycleJournal(path, {
      ...expected(),
      codingSessionId: 'sess_other',
    }), {
      kind: 'unknown',
      journal: null,
      reason: 'session-mismatch',
    });
    assert.deepEqual(await readLifecycleJournal(path, {
      ...expected(),
      runtimeGeneration: 'not-a-generation',
    }), {
      kind: 'unknown',
      journal: null,
      reason: 'invalid-expected-runtime-generation',
    });

    const malformedGeneration = buildLifecycleJournal(input());
    malformedGeneration.runtime_generation = 'not-a-generation';
    writeFileSync(path, JSON.stringify(malformedGeneration), { mode: 0o600 });
    chmodSync(path, 0o600);
    assert.deepEqual(await readSessionLifecycle({ path, codingSessionId: 'sess_journal_123' }), {
      verdict: 'unknown',
      record: null,
      reason: 'invalid-runtime-generation',
    });
  });
});
