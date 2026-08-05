/**
 * Provider-agnostic immutable transcript archive.
 *
 * A managed adapter supplies only its provider root and the broker-validated
 * native artifact. The core owns publication, projection, resume restoration,
 * integrity checks, and private filesystem semantics.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

const ARCHIVE_SCHEMA = 'mc-managed-provider-generation-archive/v1';
const PROJECTION_SCHEMA = 'mc-managed-provider-session-projection/v1';
const ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_TRANSCRIPT_ENTRIES = 4096;

export function persistManagedProviderArchive({
  root,
  tool,
  descriptor,
  providerArtifact,
  providerRoot,
} = {}) {
  const checked = validateArchiveInput({
    root,
    tool,
    descriptor,
    providerArtifact,
    providerRoot,
  });
  if (!checked.ok) return checked;
  const stateRoot = providerStateRoot(root, tool, descriptor.session_id);
  const archiveRoot = join(
    stateRoot,
    'generations',
    providerArtifact.runtime_generation,
  );
  const transcriptPath = join(archiveRoot, checked.relativeTranscriptPath);
  const manifestPath = join(archiveRoot, 'manifest.json');
  const projectionPath = join(stateRoot, 'current.json');
  const temporaryTranscript = `${transcriptPath}.${randomUUID()}.tmp`;
  const temporaryManifest = `${manifestPath}.${randomUUID()}.tmp`;
  const temporaryProjection = `${projectionPath}.${randomUUID()}.tmp`;
  try {
    ensurePrivateDirectory(root, dirname(transcriptPath));
    const transcriptSha256 = sha256File(providerArtifact.transcript_path);
    const manifest = {
      schema: ARCHIVE_SCHEMA,
      tool,
      coding_session_id: descriptor.session_id,
      runtime_generation: providerArtifact.runtime_generation,
      provider_session_id: providerArtifact.provider_session_id,
      relative_transcript_path: checked.relativeTranscriptPath,
      transcript_sha256: transcriptSha256,
    };
    const manifestBody = `${JSON.stringify(manifest)}\n`;
    const archiveDigest = sha256(manifestBody);

    publishImmutableCopy({
      sourcePath: providerArtifact.transcript_path,
      targetPath: transcriptPath,
      temporaryPath: temporaryTranscript,
      expectedSha256: transcriptSha256,
    });
    publishImmutableBody({
      targetPath: manifestPath,
      temporaryPath: temporaryManifest,
      body: manifestBody,
    });

    const projection = {
      schema: PROJECTION_SCHEMA,
      tool,
      coding_session_id: descriptor.session_id,
      runtime_generation: providerArtifact.runtime_generation,
      provider_session_id: providerArtifact.provider_session_id,
      relative_manifest_path: relative(stateRoot, manifestPath),
      archive_digest: archiveDigest,
    };
    ensurePrivateDirectory(root, dirname(projectionPath));
    writeFileSync(temporaryProjection, `${JSON.stringify(projection)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    fsyncFile(temporaryProjection);
    renameSync(temporaryProjection, projectionPath);
    fsyncDirectory(dirname(projectionPath));
    return {
      ok: true,
      state: {
        provider_session_id: providerArtifact.provider_session_id,
        transcript_path: transcriptPath,
        runtime_generation: providerArtifact.runtime_generation,
        archive_digest: archiveDigest,
      },
    };
  } catch {
    removeTemporary([
      temporaryTranscript,
      temporaryManifest,
      temporaryProjection,
    ]);
    return failure('managed-provider-archive-persist-failed');
  }
}

export function restoreManagedProviderArchive({
  root,
  tool,
  codingSessionId,
  providerSessionId,
  providerRoot,
} = {}) {
  if (!isAbsolute(root || '')
    || !ID.test(tool || '')
    || !ID.test(codingSessionId || '')
    || !ID.test(providerSessionId || '')
    || !isAbsolute(providerRoot || '')) {
    return failure('managed-provider-archive-restore-invalid');
  }
  const stateRoot = providerStateRoot(root, tool, codingSessionId);
  const projection = readPrivateJson(join(stateRoot, 'current.json'), 4096);
  if (!projection.ok
    || !validProjection(projection.value)
    || projection.value.tool !== tool
    || projection.value.coding_session_id !== codingSessionId
    || projection.value.provider_session_id !== providerSessionId) {
    return failure('managed-provider-archive-missing');
  }
  const manifestPath = join(stateRoot, projection.value.relative_manifest_path);
  const manifest = readPrivateJson(manifestPath, 4096);
  if (!manifest.ok
    || !validManifest(manifest.value)
    || manifest.value.tool !== tool
    || manifest.value.coding_session_id !== codingSessionId
    || manifest.value.provider_session_id !== providerSessionId
    || manifest.value.runtime_generation !== projection.value.runtime_generation
    || sha256(manifest.body) !== projection.value.archive_digest) {
    return failure('managed-provider-archive-mismatch');
  }
  const sourcePath = join(
    dirname(manifestPath),
    manifest.value.relative_transcript_path,
  );
  const targetPath = join(
    providerRoot,
    manifest.value.relative_transcript_path,
  );
  try {
    const source = lstatSync(sourcePath);
    const realState = realpathSync(stateRoot);
    const realSource = realpathSync(sourcePath);
    if (!source.isFile()
      || source.isSymbolicLink()
      || !insideOrSame(realState, realSource)
      || sha256File(sourcePath) !== manifest.value.transcript_sha256
      || !insideOrSame(resolve(providerRoot), resolve(targetPath))) {
      return failure('managed-provider-archive-mismatch');
    }
    ensurePrivateDirectory(root, dirname(targetPath));
    if (existsSync(targetPath)) {
      return sha256File(targetPath) === manifest.value.transcript_sha256
        ? { ok: true, restored: true, transcript_path: targetPath, duplicate: true }
        : failure('managed-provider-archive-target-conflict');
    }
    copyFileSync(sourcePath, targetPath, constants.COPYFILE_EXCL);
    chmodSync(targetPath, 0o600);
    fsyncFile(targetPath);
    fsyncDirectory(dirname(targetPath));
    return { ok: true, restored: true, transcript_path: targetPath };
  } catch {
    return failure('managed-provider-archive-restore-failed');
  }
}

/**
 * Prove that an exited provider never established a new native session.
 *
 * Fresh launches must have an empty provider transcript tree. Resume launches
 * may contain exactly the immutable transcript restored from mc's archive,
 * byte-for-byte unchanged, and no additional transcript entries.
 */
export function inspectManagedProviderAbsence({
  root,
  tool,
  descriptor,
  providerRoot,
  transcriptRoot,
  generation,
} = {}) {
  const intent = generation?.intent?.data;
  if (!isAbsolute(root || '')
    || !ID.test(tool || '')
    || !plain(descriptor)
    || !ID.test(descriptor.session_id || '')
    || !isAbsolute(providerRoot || '')
    || !isAbsolute(transcriptRoot || '')
    || !plain(intent)
    || !['fresh', 'resume'].includes(intent.mode)
    || intent.tool !== tool) {
    return failure('managed-provider-absence-input-invalid');
  }
  let canonicalProviderRoot;
  let canonicalTranscriptRoot;
  try {
    const transcriptRelative = relative(resolve(providerRoot), resolve(transcriptRoot));
    if (!transcriptRelative
      || transcriptRelative.startsWith('..')
      || isAbsolute(transcriptRelative)) {
      return failure('managed-provider-absence-root-invalid');
    }
    canonicalProviderRoot = realpathSync(providerRoot);
    canonicalTranscriptRoot = join(canonicalProviderRoot, transcriptRelative);
  } catch {
    return failure('managed-provider-absence-root-invalid');
  }
  const scanned = scanTranscriptTree({
    transcriptRoot,
    providerRoot: canonicalProviderRoot,
    canonicalTranscriptRoot,
  });
  if (!scanned.ok) return scanned;
  if (intent.mode === 'fresh') {
    if (scanned.files.length !== 0) {
      return failure('managed-provider-absence-artifact-present');
    }
    return {
      ok: true,
      evidence_digest: sha256(JSON.stringify({
        tool,
        coding_session_id: descriptor.session_id,
        mode: 'fresh',
        provider_session_id: null,
        transcript_tree: 'empty',
      })),
    };
  }

  const providerSessionId = intent.resume_provider_session_id;
  if (!ID.test(providerSessionId || '')) {
    return failure('managed-provider-absence-resume-invalid');
  }
  const stateRoot = providerStateRoot(root, tool, descriptor.session_id);
  const projection = readPrivateJson(join(stateRoot, 'current.json'), 4096);
  if (!projection.ok
    || !validProjection(projection.value)
    || projection.value.tool !== tool
    || projection.value.coding_session_id !== descriptor.session_id
    || projection.value.provider_session_id !== providerSessionId) {
    return failure('managed-provider-absence-archive-missing');
  }
  const manifestPath = join(stateRoot, projection.value.relative_manifest_path);
  const manifest = readPrivateJson(manifestPath, 4096);
  if (!manifest.ok
    || !validManifest(manifest.value)
    || manifest.value.tool !== tool
    || manifest.value.coding_session_id !== descriptor.session_id
    || manifest.value.provider_session_id !== providerSessionId
    || manifest.value.runtime_generation !== projection.value.runtime_generation
    || sha256(manifest.body) !== projection.value.archive_digest) {
    return failure('managed-provider-absence-archive-mismatch');
  }
  const archivedPath = join(dirname(manifestPath), manifest.value.relative_transcript_path);
  const restoredPath = join(providerRoot, manifest.value.relative_transcript_path);
  try {
    const canonicalRestored = realpathSync(restoredPath);
    if (!insideOrSame(canonicalProviderRoot, canonicalRestored)
      || scanned.files.length !== 1
      || scanned.files[0] !== canonicalRestored
      || !privateFile(archivedPath)
      || !privateFile(restoredPath)
      || sha256File(archivedPath) !== manifest.value.transcript_sha256
      || sha256File(restoredPath) !== manifest.value.transcript_sha256) {
      return failure('managed-provider-absence-restored-state-changed');
    }
  } catch {
    return failure('managed-provider-absence-restored-state-changed');
  }
  return {
    ok: true,
    evidence_digest: sha256(JSON.stringify({
      tool,
      coding_session_id: descriptor.session_id,
      mode: 'resume',
      provider_session_id: providerSessionId,
      archive_digest: projection.value.archive_digest,
      transcript_sha256: manifest.value.transcript_sha256,
    })),
  };
}

function validateArchiveInput({
  root,
  tool,
  descriptor,
  providerArtifact,
  providerRoot,
}) {
  if (!isAbsolute(root || '')
    || !ID.test(tool || '')
    || !plain(descriptor)
    || !ID.test(descriptor.session_id || '')
    || !isAbsolute(providerRoot || '')
    || !plain(providerArtifact)
    || providerArtifact.tool !== tool
    || providerArtifact.coding_session_id !== descriptor.session_id
    || !UUID_V4.test(providerArtifact.runtime_generation || '')
    || !ID.test(providerArtifact.provider_session_id || '')
    || !isAbsolute(providerArtifact.transcript_path || '')) {
    return failure('managed-provider-archive-input-invalid');
  }
  try {
    const rootPath = realpathSync(providerRoot);
    const sourcePath = realpathSync(providerArtifact.transcript_path);
    const source = lstatSync(providerArtifact.transcript_path);
    const rel = relative(rootPath, sourcePath);
    if (!rel
      || rel.startsWith('..')
      || isAbsolute(rel)
      || !source.isFile()
      || source.isSymbolicLink()) {
      return failure('managed-provider-archive-source-invalid');
    }
    return { ok: true, relativeTranscriptPath: rel };
  } catch {
    return failure('managed-provider-archive-source-invalid');
  }
}

function scanTranscriptTree({
  transcriptRoot,
  providerRoot,
  canonicalTranscriptRoot,
}) {
  let rootInfo;
  try {
    rootInfo = lstatSync(transcriptRoot);
  } catch (error) {
    return error?.code === 'ENOENT'
      ? { ok: true, files: [] }
      : failure('managed-provider-absence-tree-unreadable');
  }
  try {
    if (!rootInfo.isDirectory()
      || rootInfo.isSymbolicLink()
      || realpathSync(transcriptRoot) !== canonicalTranscriptRoot
      || !insideOrSame(providerRoot, canonicalTranscriptRoot)) {
      return failure('managed-provider-absence-tree-unsafe');
    }
    const files = [];
    const pending = [transcriptRoot];
    let entries = 0;
    while (pending.length) {
      const directory = pending.pop();
      for (const name of readdirSync(directory)) {
        entries += 1;
        if (entries > MAX_TRANSCRIPT_ENTRIES) {
          return failure('managed-provider-absence-tree-oversized');
        }
        const path = join(directory, name);
        const info = lstatSync(path);
        if (info.isSymbolicLink()) {
          return failure('managed-provider-absence-tree-unsafe');
        }
        if (info.isDirectory()) {
          if (realpathSync(path) !== join(
            canonicalTranscriptRoot,
            relative(transcriptRoot, path),
          )) {
            return failure('managed-provider-absence-tree-unsafe');
          }
          pending.push(path);
        } else if (info.isFile()) {
          files.push(realpathSync(path));
        } else {
          return failure('managed-provider-absence-tree-unsafe');
        }
      }
    }
    return { ok: true, files: files.sort() };
  } catch {
    return failure('managed-provider-absence-tree-unreadable');
  }
}

function publishImmutableCopy({
  sourcePath,
  targetPath,
  temporaryPath,
  expectedSha256,
}) {
  if (existsSync(targetPath)) {
    if (!privateFile(targetPath)
      || sha256File(targetPath) !== expectedSha256) {
      throw new Error('immutable archive conflict');
    }
    return;
  }
  copyFileSync(sourcePath, temporaryPath, constants.COPYFILE_EXCL);
  chmodSync(temporaryPath, 0o600);
  fsyncFile(temporaryPath);
  try {
    linkSync(temporaryPath, targetPath);
  } catch (error) {
    if (error?.code !== 'EEXIST'
      || !privateFile(targetPath)
      || sha256File(targetPath) !== expectedSha256) throw error;
  } finally {
    try { unlinkSync(temporaryPath); } catch {}
  }
  fsyncDirectory(dirname(targetPath));
}

function publishImmutableBody({
  targetPath,
  temporaryPath,
  body,
}) {
  if (existsSync(targetPath)) {
    if (!privateFile(targetPath)
      || readFileSync(targetPath, 'utf8') !== body) {
      throw new Error('immutable manifest conflict');
    }
    return;
  }
  writeFileSync(temporaryPath, body, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  fsyncFile(temporaryPath);
  try {
    linkSync(temporaryPath, targetPath);
  } catch (error) {
    if (error?.code !== 'EEXIST'
      || !privateFile(targetPath)
      || readFileSync(targetPath, 'utf8') !== body) throw error;
  } finally {
    try { unlinkSync(temporaryPath); } catch {}
  }
  fsyncDirectory(dirname(targetPath));
}

/**
 * Where a provider's transcript archives live.
 *
 * This used to be `managed-provider-state/`, which the V1 cutover seals: the
 * interlock replaces that directory with a read-only file so an older binary
 * cannot write to migrated state. The V1 Claude path kept writing there, so
 * every archive failed with `ENOTDIR` on a migrated machine and no Claude
 * session could archive or resume anything.
 *
 * `provider-session-state/` is the V1 root — it is what the Codex domain has
 * always used, which is why Codex was unaffected — and the cutover does not
 * touch it. Nothing is lost by moving: the sealed directory's contents are
 * preserved in the cutover's quarantine and backup, and nothing could read
 * them through this path anyway.
 */
function providerStateRoot(root, tool, codingSessionId) {
  return join(
    resolve(root),
    'provider-session-state',
    safePart(tool),
    safePart(codingSessionId),
  );
}

function ensurePrivateDirectory(root, directory) {
  const trustedRoot = resolve(root);
  if (!insideOrSame(trustedRoot, resolve(directory))) {
    throw new Error('managed provider archive path escaped root');
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let current = trustedRoot;
  assertPrivateDirectory(current);
  for (const part of relative(trustedRoot, directory).split(/[\\/]+/u).filter(Boolean)) {
    current = join(current, part);
    chmodSync(current, 0o700);
    assertPrivateDirectory(current);
  }
}

function assertPrivateDirectory(path) {
  const info = statSync(path);
  if (!info.isDirectory()
    || (info.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())
    || realpathSync(path) !== resolve(path)) {
    throw new Error('managed provider archive directory is unsafe');
  }
}

function readPrivateJson(path, maxBytes) {
  try {
    const info = lstatSync(path);
    if (!info.isFile()
      || info.isSymbolicLink()
      || info.size <= 0
      || info.size > maxBytes
      || (info.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())
      || realpathSync(path) !== resolve(path)) return { ok: false };
    const body = readFileSync(path, 'utf8');
    return { ok: true, body, value: JSON.parse(body) };
  } catch {
    return { ok: false };
  }
}

function validManifest(value) {
  return exactRecord(value, [
    'schema',
    'tool',
    'coding_session_id',
    'runtime_generation',
    'provider_session_id',
    'relative_transcript_path',
    'transcript_sha256',
  ])
    && value.schema === ARCHIVE_SCHEMA
    && ID.test(value.tool || '')
    && ID.test(value.coding_session_id || '')
    && UUID_V4.test(value.runtime_generation || '')
    && ID.test(value.provider_session_id || '')
    && safeRelative(value.relative_transcript_path)
    && /^[a-f0-9]{64}$/u.test(value.transcript_sha256 || '');
}

function validProjection(value) {
  return exactRecord(value, [
    'schema',
    'tool',
    'coding_session_id',
    'runtime_generation',
    'provider_session_id',
    'relative_manifest_path',
    'archive_digest',
  ])
    && value.schema === PROJECTION_SCHEMA
    && ID.test(value.tool || '')
    && ID.test(value.coding_session_id || '')
    && UUID_V4.test(value.runtime_generation || '')
    && ID.test(value.provider_session_id || '')
    && value.relative_manifest_path
      === join('generations', value.runtime_generation, 'manifest.json')
    && /^[a-f0-9]{64}$/u.test(value.archive_digest || '');
}

function safeRelative(value) {
  return typeof value === 'string'
    && value
    && !isAbsolute(value)
    && !value.split(/[\\/]+/u).includes('..');
}

function exactRecord(value, keys) {
  if (!plain(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function privateFile(path) {
  try {
    const info = lstatSync(path);
    return info.isFile()
      && !info.isSymbolicLink()
      && (info.mode & 0o077) === 0
      && (typeof process.getuid !== 'function' || info.uid === process.getuid())
      && realpathSync(path) === resolve(path);
  } catch {
    return false;
  }
}

function sha256File(path) {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  let fd = null;
  try {
    fd = openSync(path, constants.O_RDONLY);
    let position = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, position);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      position += count;
    }
    return hash.digest('hex');
  } finally {
    buffer.fill(0);
    if (fd !== null) closeSync(fd);
  }
}

function fsyncFile(path) {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function fsyncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function removeTemporary(paths) {
  for (const path of paths) {
    try { rmSync(path, { force: true }); } catch {}
  }
}

function safePart(value) {
  const prefix = String(value || '').replace(/[^A-Za-z0-9_.-]/gu, '_').slice(0, 80);
  return `${prefix || 'unknown'}-${sha256(String(value)).slice(0, 12)}`;
}

function insideOrSame(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function failure(reason) {
  return { ok: false, reason, error: reason };
}

function plain(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}
