import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArchive, inspectArchive, restoreArchive, validateMemberPath, verifyArchive } from '../../src/mc/backup-archive.js';
import { run as backupCommand } from '../../src/mc/commands/backup.js';
import { admitWriter, beginBackup, programmeLifecycle, transitionBackup } from '../../src/mc/programme-lifecycle.js';

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
  assert.equal(Object.hasOwn(verifyArchive(output).manifest.members[0], 'bytes'), false,
    'manifest records refer to content-addressed payloads instead of embedding a second copy');
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

test('backup archive: verification rejects unknown manifest fields and unmanifested storage bytes', (t) => {
  const root = fixture(t);
  const output = join(root, 'archive');
  createArchive(output, { programmes: ['p'], members: [] });
  const manifestPath = join(output, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, silentlyIgnored: true })}\n`);
  writeFileSync(join(output, 'manifest.sha256'), `${digest(readFileSync(manifestPath))}  manifest.json\n`);
  assert.throws(() => verifyArchive(output), /invalid archive manifest fields/u,
    'unknown schema fields must not be silently accepted as complete');

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(output, 'manifest.sha256'), `${digest(readFileSync(manifestPath))}  manifest.json\n`);
  writeFileSync(join(output, 'unmanifested'), 'unaccounted bytes');
  assert.throws(() => verifyArchive(output), /storage members do not match/u,
    'extra archive bytes must not disappear behind a verified inventory');
});

test('backup archive: create and restore refuse symlinked output parents without writing through them', (t) => {
  const root = fixture(t);
  const elsewhere = join(root, 'elsewhere');
  mkdirSync(elsewhere);
  const link = join(root, 'linked-parent');
  symlinkSync(elsewhere, link);
  const bytes = Buffer.from('safe');
  const members = [{ path: 'p/file', type: 'file', size: bytes.length, sha256: digest(bytes), mode: 0o600, bytes }];

  assert.throws(() => createArchive(join(link, 'archive'), { programmes: ['p'], members }), /symlink in archive path/u);
  assert.throws(() => lstatSync(join(elsewhere, 'archive')),
    { code: 'ENOENT' }, 'archive creation must not follow the output parent link');

  const archive = join(elsewhere, 'archive');
  createArchive(archive, { programmes: ['p'], members });
  assert.throws(() => restoreArchive(archive, join(link, 'restored')), /symlink in archive path/u);
  assert.throws(() => lstatSync(join(elsewhere, 'restored')),
    { code: 'ENOENT' }, 'restore must not follow the destination parent link');
  assert.throws(() => verifyArchive(join(link, 'archive')), /symlink in archive path/u,
    'verification must not open archive members through a caller-supplied symlink parent');
});

test('backup restore: verifies then atomically publishes byte- and mode-preserving inactive content; refuses unsupported bundles', async (t) => {
  const root = fixture(t);
  const archive = join(root, 'archive');
  const output = join(root, 'restored');
  const bytes = Buffer.from([0, 0xff, 7, 13]);
  createArchive(archive, { programmes: ['p'], members: [
    { path: 'p', type: 'directory', mode: 0o750 },
    { path: 'p/work', type: 'directory', mode: 0o710 },
    { path: 'p/work/tool', type: 'file', mode: 0o751, size: bytes.length, sha256: digest(bytes), bytes },
    { path: 'p/work/alias', type: 'symlink', target: 'tool' },
  ] });
  const restored = restoreArchive(archive, output, { now: () => '2026-11-12T00:00:00.000Z' });
  assert.equal(restored.state, 'inactive');
  assert.deepEqual(readFileSync(join(output, 'p/work/tool')), bytes);
  assert.equal(lstatSync(join(output, 'p/work/tool')).mode & 0o777, 0o751);
  assert.equal(readlinkSync(join(output, 'p/work/alias')), 'tool');
  assert.equal(JSON.parse(readFileSync(join(output, '.mc-inactive-restore.json'), 'utf8')).archive_sha256, restored.archive_sha256);
  assert.throws(() => restoreArchive(archive, output), /already exists/u);

  const bundled = join(root, 'bundled');
  createArchive(bundled, { programmes: ['p'], members: [], bundles: [{ repository: 'repo', bytes: Buffer.from('git bundle') }] });
  const refused = join(root, 'must-not-exist');
  assert.throws(() => restoreArchive(bundled, refused), /local repository declarations/u);
  assert.equal(lstatSync(root).isDirectory(), true);
  assert.throws(() => lstatSync(refused), { code: 'ENOENT' });
});

test('backup command: restore routes only explicit archive and output paths', async (t) => {
  const root = fixture(t);
  const archive = join(root, 'archive');
  const bytes = Buffer.from('inactive');
  createArchive(archive, { programmes: ['p'], members: [{ path: 'p/README.md', type: 'file', size: bytes.length, sha256: digest(bytes), mode: 0o600, bytes }] });
  const stdout = { value: '', write(text) { this.value += text; } };
  const stderr = { value: '', write(text) { this.value += text; } };
  assert.equal(await backupCommand(['restore', '--archive', archive, '--output', join(root, 'output'), '--json'], { stdout, stderr }), 0);
  assert.equal(JSON.parse(stdout.value).state, 'inactive');
  assert.equal(await backupCommand(['restore', '--archive', archive, '--json'], { stdout, stderr }), 2);
  assert.match(stderr.value, /needs --archive.*--output/u);
});

test('backup command: inspect and verify expose checksummed inventory; status and release preserve explicit hold semantics', async (t) => {
  const root = fixture(t);
  const output = join(root, 'archive');
  const bytes = Buffer.from('receipt');
  createArchive(output, { programmes: ['p'], members: [{ path: 'p/README.md', type: 'file', size: bytes.length, sha256: digest(bytes), mode: 0o600, bytes }] });
  const out = { value: '', write(text) { this.value += text; } };
  const err = { value: '', write(text) { this.value += text; } };
  assert.equal(await backupCommand(['inspect', '--archive', output, '--json'], { stdout: out, stderr: err }), 0);
  assert.equal(JSON.parse(out.value).manifest_sha256, inspectArchive(output).manifest_sha256);
  out.value = '';
  assert.equal(await backupCommand(['verify', '--archive', output, '--json'], { stdout: out, stderr: err }), 0);
  assert.equal(JSON.parse(out.value).verified, true);

  const env = { MC_HOME: join(root, 'home'), MC_WORK_ROOT: join(root, 'work') };
  const tx = beginBackup(['p'], { env, id: '00000000-0000-4000-8000-000000000005' });
  out.value = '';
  assert.equal(await backupCommand(['release', '--id', tx.id, '--json'], { env, stdout: out, stderr: err }), 2);
  assert.equal(programmeLifecycle('p', { env }).state, 'draining');
  assert.match(err.value, /release requires a held backup/u);
  transitionBackup(tx.id, tx.generation, 'held', { env });
  out.value = '';
  assert.equal(await backupCommand(['release', '--id', tx.id, '--json'], { env, stdout: out, stderr: err }), 0);
  assert.equal(programmeLifecycle('p', { env }).state, 'active');
});

test('backup resume: a completed drain becomes held, but an admitted writer keeps it draining', async (t) => {
  const root = fixture(t);
  const env = { MC_HOME: join(root, 'home'), MC_WORK_ROOT: root };
  const writer = admitWriter(['selected'], { env, name: 'admitted writer' });
  const tx = beginBackup(['selected'], { env, id: '00000000-0000-4000-8000-000000000008' });
  const out = { value: '', write(text) { this.value += text; } };
  const err = { value: '', write(text) { this.value += text; } };

  assert.equal(await backupCommand(['resume', '--id', tx.id, '--json'], { env, stdout: out, stderr: err }), 1);
  assert.equal(programmeLifecycle('selected', { env }).state, 'draining');
  assert.match(err.value, /1 admitted writer lease/u);

  writer.release();
  out.value = '';
  assert.equal(await backupCommand(['resume', '--id', tx.id, '--json'], { env, stdout: out, stderr: err }), 0);
  assert.equal(JSON.parse(out.value).transaction.state, 'held');
  assert.equal(programmeLifecycle('selected', { env }).state, 'held');
});
