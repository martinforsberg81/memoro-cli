/** Private, checksummed storage and validation for programme backup archives. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, posix, resolve, sep } from 'node:path';

export const BACKUP_SCHEMA = 'mc-programme-backup';
export const BACKUP_VERSION = 2;
const HASH = /^[a-f0-9]{64}$/u;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Portable archive names are POSIX-relative; paths cannot alias on common filesystems. */
export function validateMemberPath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.includes('\0') || isAbsolute(path)) {
    throw new Error(`invalid archive member path ${JSON.stringify(path)}`);
  }
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`invalid archive member path ${JSON.stringify(path)}`);
  }
  return path;
}

function validateMembers(members) {
  if (!Array.isArray(members)) throw new Error('archive members must be an array');
  const exact = new Set();
  const folded = new Set();
  const byPath = new Map();
  for (const member of members) {
    const path = validateMemberPath(member?.path);
    const key = path.toLocaleLowerCase('en-US');
    if (exact.has(path) || folded.has(key)) throw new Error(`duplicate or case-colliding archive member ${path}`);
    exact.add(path); folded.add(key); byPath.set(path, member);
    if (!['file', 'directory', 'symlink'].includes(member.type)) throw new Error(`unsupported archive member type at ${path}`);
    if (member.type === 'file' && (!Number.isSafeInteger(member.size) || member.size < 0 || !HASH.test(member.sha256) || !Number.isInteger(member.mode))) throw new Error(`invalid file record at ${path}`);
    if (member.type === 'symlink' && (typeof member.target !== 'string' || !member.target || isAbsolute(member.target))) throw new Error(`invalid symlink record at ${path}`);
  }
  for (const member of members) {
    const parts = member.path.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const parent = byPath.get(parts.slice(0, i).join('/'));
      if (parent && parent.type !== 'directory') throw new Error(`non-directory archive parent for ${member.path}`);
    }
    if (member.type === 'symlink') {
      const resolvedTarget = posix.normalize(posix.join(posix.dirname(member.path), member.target));
      if (resolvedTarget === '..' || resolvedTarget.startsWith('../') || resolvedTarget.startsWith('/')) throw new Error(`escaping symlink target at ${member.path}`);
    }
  }
}

function writeDurable(path, bytes, mode = 0o600) {
  const fd = openSync(path, 'wx', mode);
  try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
}

function rejectSymlinkAncestors(path, { includeLeaf = true } = {}) {
  const absolute = resolve(path);
  const { root } = parse(absolute);
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  const limit = includeLeaf ? parts.length : Math.max(0, parts.length - 1);
  for (let i = 0; i < limit; i += 1) {
    current = join(current, parts[i]);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`unexpected symlink in archive path ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      break;
    }
  }
}

/** Publish a complete private archive atomically; callers provide only typed records and bytes. */
export function createArchive(output, { programmes, members, bundles = [], metadata = {}, now = () => new Date().toISOString() }) {
  if (!isAbsolute(output)) throw new Error('archive output must be absolute');
  if (existsSync(output)) throw new Error(`archive output already exists: ${output}`);
  validateMembers(members);
  if (!Array.isArray(programmes) || programmes.some((name) => typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name))) throw new Error('invalid programme inventory');
  const requested = resolve(output);
  mkdirSync(dirname(requested), { recursive: true });
  const root = join(realpathSync(dirname(requested)), basename(requested));
  rejectSymlinkAncestors(dirname(root));
  const temp = `${root}.tmp-${process.pid}-${randomUUID()}`;
  mkdirSync(temp, { mode: 0o700 });
  try {
    mkdirSync(join(temp, 'payload'), { mode: 0o700 });
    mkdirSync(join(temp, 'bundles'), { mode: 0o700 });
    const files = new Map();
    const manifestMembers = members.map((member) => ({ ...member }));
    for (const item of manifestMembers) {
      if (item.type !== 'file') continue;
      const bytes = Buffer.from(item.bytes ?? []);
      if (bytes.length !== item.size || sha256(bytes) !== item.sha256) throw new Error(`payload does not match file record ${item.path}`);
      const payload = join('payload', item.sha256);
      if (!files.has(item.sha256)) {
        writeDurable(join(temp, payload), bytes);
        files.set(item.sha256, payload);
      }
      item.payload = payload;
      // Keep the manifest index-only: content lives once in its checked payload.
      delete item.bytes;
    }
    const bundleRecords = bundles.map((bundle, index) => {
      if (!bundle || typeof bundle.repository !== 'string' || !Buffer.isBuffer(bundle.bytes)) throw new Error('invalid repository bundle');
      const digest = sha256(bundle.bytes);
      const path = `bundles/${String(index).padStart(4, '0')}-${digest}.bundle`;
      writeDurable(join(temp, path), bundle.bytes);
      return { repository: bundle.repository, path, size: bundle.bytes.length, sha256: digest };
    });
    const manifest = { schema: BACKUP_SCHEMA, version: BACKUP_VERSION, created_at: now(), programmes: [...new Set(programmes)].sort(), metadata, members: manifestMembers, bundles: bundleRecords };
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    writeDurable(join(temp, 'manifest.json'), bytes);
    writeDurable(join(temp, 'manifest.sha256'), Buffer.from(`${sha256(bytes)}  manifest.json\n`));
    verifyArchive(temp);
    renameSync(temp, root);
    return { path: root, manifest_sha256: sha256(bytes), programmes: manifest.programmes, members: members.length, bundles: bundleRecords.length };
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

function readRegular(root, rel) {
  validateMemberPath(rel);
  let current = root;
  for (const part of rel.split('/')) {
    current = join(current, part);
    const st = lstatSync(current);
    if (st.isSymbolicLink()) throw new Error(`unexpected symlink in archive path ${rel}`);
  }
  if (!statSync(current).isFile()) throw new Error(`archive member is not a regular file: ${rel}`);
  return readFileSync(current);
}

/** Validate schema, checksums, member tree and every payload without following links. */
export function verifyArchive(path) {
  const requested = resolve(path);
  const rootStat = lstatSync(requested);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('archive must be a real directory');
  const root = realpathSync(requested);
  rejectSymlinkAncestors(root);
  const manifestBytes = readRegular(root, 'manifest.json');
  const check = readRegular(root, 'manifest.sha256').toString('utf8').trim();
  if (check !== `${sha256(manifestBytes)}  manifest.json`) throw new Error('manifest checksum mismatch');
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch (error) { throw new Error(`invalid archive manifest: ${error.message}`); }
  if (!manifest || manifest.schema !== BACKUP_SCHEMA || manifest.version !== BACKUP_VERSION) throw new Error('unsupported archive schema or version');
  if (!Array.isArray(manifest.programmes) || !Array.isArray(manifest.bundles)) throw new Error('invalid archive inventory');
  validateMembers(manifest.members);
  for (const member of manifest.members) {
    if (member.type !== 'file') continue;
    const bytes = readRegular(root, member.payload);
    if (bytes.length !== member.size || sha256(bytes) !== member.sha256) throw new Error(`payload checksum mismatch for ${member.path}`);
  }
  for (const bundle of manifest.bundles) {
    validateMemberPath(bundle.path);
    if (!bundle.path.startsWith('bundles/')) throw new Error('repository bundle outside bundle directory');
    const bytes = readRegular(root, bundle.path);
    if (bytes.length !== bundle.size || sha256(bytes) !== bundle.sha256) throw new Error(`bundle checksum mismatch for ${bundle.repository}`);
  }
  return { manifest, manifest_sha256: sha256(manifestBytes), bytes: manifestBytes.length };
}

export function inspectArchive(path) {
  const { manifest, manifest_sha256 } = verifyArchive(path);
  return { schema: manifest.schema, version: manifest.version, created_at: manifest.created_at, programmes: manifest.programmes, members: manifest.members.length, bundles: manifest.bundles.length, manifest_sha256 };
}
