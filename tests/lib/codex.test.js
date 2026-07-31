import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { findCodexSessionById, readCodexSessionMeta } from '../../src/lib/codex.js';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'memoro-codex-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('Codex transcript lookup', () => {
  test('reads session metadata from the first JSONL line without needing the full file body', async () => (
    withTempDir(async (dir) => {
      const file = join(dir, 'session.jsonl');
      writeFileSync(file, [
        JSON.stringify({
          type: 'session_meta',
          timestamp: '2026-06-21T00:00:00Z',
          payload: {
            id: 'cx_123',
            cwd: '/repo',
            timestamp: '2026-06-21T00:00:00Z',
            cli_version: '1.2.3',
          },
        }),
        'x'.repeat(128 * 1024),
      ].join('\n'));

      const meta = await readCodexSessionMeta(file);

      assert.deepEqual(meta, {
        sessionId: 'cx_123',
        cwd: '/repo',
        startedAt: '2026-06-21T00:00:00Z',
        toolVersion: '1.2.3',
      });
    })
  ));

  test('finds an exact older session instead of returning the newest workspace transcript', async () => (
    withTempDir(async (dir) => {
      const older = join(dir, 'older.jsonl');
      const newer = join(dir, 'newer.jsonl');
      const line = (id) => JSON.stringify({
        type: 'session_meta',
        payload: { id, cwd: '/repo', timestamp: '2026-06-21T00:00:00Z' },
      });
      writeFileSync(older, `${line('cx_wanted')}\n`);
      writeFileSync(newer, `${line('cx_other')}\n`);

      const found = await findCodexSessionById({
        sessionId: 'cx_wanted',
        cwd: '/repo',
        sessionsDir: dir,
      });

      assert.equal(found.sessionId, 'cx_wanted');
      assert.equal(found.path, older);
    })
  ));
});
