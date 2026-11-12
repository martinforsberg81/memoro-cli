import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArchive, inspectArchive, validateMemberPath, verifyArchive } from '../../src/mc/backup-archive.js';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mc-backup-archive-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('backup archive: atomically writes a private checksummed archive and verifies file and link records', (t) => {
  const root = fixture(t);
  const output = join(root, 'archive');
  const bytes = Buffer.from([0, 1, 0xff, 0x7f]);
  const records = [
    { path: 'programme/docs/.keep', type: 'file', size: bytes.length, sha256: digest(bytes), mode: 0o640, bytes },
    { path: 'programme/docs/shortcut', type: 'symlink', target: '.keep' },
  ];
  const result = createArchive(output, { programmes: ['programme'], members: records, bundles: [{ repository: 'repo', bytes: Buffer.from('bundle') }], now: () => '2026-11-12T00:00:00.000Z' });
  assert.equal(result.members, 2);
  assert.equal(lstatSync(output).mode & 0o777, 0o700);
  assert.deepEqual(inspectArchive(output), {
    schema: 'mc-programme-backup', version: 2, created_at: '2026-11-12T00:00:00.000Z',
    programmes: ['programme'], members: 2, bundles: 1, manifest_sha256: result.manifest_sha256,
  });
  assert.deepEqual(verifyArchive(output).manifest.members[0].path, 'programme/docs/.keep');
  assert.deepEqual(readFileSync(join(output, 'payload', digest(bytes))), bytes);
  assert.throws(() => createArchive(output, { programmes: ['programme'], members: [] }), /already exists/u);
});

test('backup archive: rejects unsafe, duplicate, case-folding and symlink-parent member trees', (t) => {
  const root = fixture(t);
  for (const name of ['/absolute', '../escape', 'a/../b', 'a\\b', 'a//b']) assert.throws(() => validateMemberPath(name), /invalid archive member path/u);
  const bytes = Buffer.from('x');
  const member = (path) => ({ path, type: 'file', size: 1, sha256: digest(bytes), mode: 0o600, bytes });
  assert.throws(() => createArchive(join(root, 'duplicate'), { programmes: ['p'], members: [member('p/a'), member('p/a')] }), /duplicate or case-colliding/u);
  assert.throws(() => createArchive(join(root, 'case'), { programmes: ['p'], members: [member('p/A'), member('p/a')] }), /duplicate or case-colliding/u);
  assert.throws(() => createArchive(join(root, 'parent'), { programmes: ['p'], members: [{ path: 'p/link', type: 'symlink', target: 'real' }, member('p/link/file')] }), /non-directory archive parent/u);
  assert.throws(() => createArchive(join(root, 'escape-link'), { programmes: ['p'], members: [{ path: 'p/link', type: 'symlink', target: '../../outside' }] }), /escaping symlink target/u);
});

test('backup archive: verification refuses changed payload bytes and unexpected symlink parents', (t) => {
  const root = fixture(t);
  const output = join(root, 'archive');
  const bytes = Buffer.from('recoverable');
  createArchive(output, { programmes: ['p'], members: [{ path: 'p/work/file', type: 'file', size: bytes.length, sha256: digest(bytes), mode: 0o600, bytes }] });
  const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
  const payload = join(output, manifest.members[0].payload);
  writeFileSync(payload, 'compromised');
  assert.throws(() => verifyArchive(output), /checksum mismatch/u);
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output);
  writeFileSync(join(output, 'outside'), 'not a manifest');
  rmSync(join(output, 'outside'));
  // A symlink in the archive's own path is never read through, even when its target exists.
  mkdirSync(join(output, 'payload'));
  writeFileSync(join(output, 'manifest.json'), '{}');
  rmSync(join(output, 'manifest.json'));
  mkdirSync(join(output, 'elsewhere'));
  writeFileSync(join(output, 'elsewhere', 'manifest.json'), '{}');
  symlinkSync(join(output, 'elsewhere', 'manifest.json'), join(output, 'manifest.json'));
  assert.throws(() => verifyArchive(output), /unexpected symlink/u);
});
