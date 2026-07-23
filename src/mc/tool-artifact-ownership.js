import {
  lstat,
  open,
  opendir,
  realpath,
  rm,
  unlink,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from 'node:path';

const HEAD_BYTES = 64 * 1024;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export const TOOL_ARTIFACT_AUTHORITY_VERSION = 1;
export const DEFAULT_TOOL_ARTIFACT_SCAN_POLICY = Object.freeze({
  max_entries: 4_096,
  max_depth: 8,
  max_duration_ms: 250,
});

export function defaultToolArtifactRoots({
  home = homedir(),
  env = process.env,
} = {}) {
  const codexHome = nonEmpty(env.CODEX_HOME) || join(home, '.codex');
  const claudeHome = nonEmpty(env.CLAUDE_HOME) || join(home, '.claude');
  return {
    codex: {
      provider_root: codexHome,
      transcript_roots: [
        join(codexHome, 'sessions'),
        join(codexHome, 'archived_sessions'),
      ],
      generated_images_root: join(codexHome, 'generated_images'),
      shell_snapshots_root: join(codexHome, 'shell_snapshots'),
      negative_roots: codexNegativeRoots(codexHome),
    },
    'claude-code': {
      provider_root: claudeHome,
      transcript_roots: [join(claudeHome, 'projects')],
      file_history_root: join(claudeHome, 'file-history'),
      session_env_root: join(claudeHome, 'session-env'),
      tasks_root: join(claudeHome, 'tasks'),
      negative_roots: claudeNegativeRoots(claudeHome),
    },
  };
}

/**
 * Pure registry-to-authority classification. No filesystem reads happen here.
 *
 * The allowlist is intentionally provider-specific. It is not a generic glob
 * contract: every positive root must have its exact canonical basename under
 * the configured provider root.
 */
export function classifyToolArtifactAuthority(entry, {
  roots = defaultToolArtifactRoots(),
} = {}) {
  if (!entry || typeof entry !== 'object') {
    return unverified('missing-entry');
  }

  const source = nonEmpty(entry.tool_session_source);
  const sessionId = nonEmpty(entry.tool_session_id);
  const transcriptPath = nonEmpty(entry.tool_transcript_path);
  if (!source && !sessionId && !transcriptPath && entry.session_state === 'no-session-yet') {
    return {
      state: 'none',
      safe_to_delete: true,
      source: null,
      session_id: null,
      transcript_path: null,
      transcript_root: null,
      provider_root: null,
      issues: [],
    };
  }
  if (!source) return unverified('missing-tool-session-source');
  if (!sessionId) return unverified('missing-tool-session-id', { source });
  if (!transcriptPath) {
    return unverified('missing-tool-transcript-path', { source, session_id: sessionId });
  }
  if (!SESSION_ID_RE.test(sessionId)) {
    return unverified('invalid-tool-session-id', { source, session_id: sessionId });
  }
  if (!toolMatchesSource(entry.tool, source)) {
    return unverified('tool-source-mismatch', {
      source,
      session_id: sessionId,
      transcript_path: transcriptPath,
    });
  }

  const sourceRoots = roots?.[source];
  const rootsIssue = validateProviderRoots(source, sourceRoots);
  if (rootsIssue) {
    return unverified(rootsIssue, {
      source,
      session_id: sessionId,
      transcript_path: transcriptPath,
    });
  }
  if (!isAbsolute(transcriptPath) || normalize(transcriptPath) !== transcriptPath) {
    return unverified('invalid-transcript-path', {
      source,
      session_id: sessionId,
      transcript_path: transcriptPath,
    });
  }

  const transcriptRoot = deepestContainingRoot(transcriptPath, sourceRoots.transcript_roots);
  if (!transcriptRoot) {
    return unverified('transcript-outside-allowlist', {
      source,
      session_id: sessionId,
      transcript_path: transcriptPath,
    });
  }
  if (!matchesTranscriptLayout({ source, sessionId, transcriptPath, transcriptRoot })) {
    return unverified('transcript-layout-mismatch', {
      source,
      session_id: sessionId,
      transcript_path: transcriptPath,
      transcript_root: transcriptRoot,
    });
  }

  return {
    state: 'candidate',
    safe_to_delete: false,
    source,
    session_id: sessionId,
    transcript_path: transcriptPath,
    transcript_root: transcriptRoot,
    provider_root: sourceRoots.provider_root,
    issues: [],
  };
}

/**
 * Resolve and verify the provider-owned paths for one registry entry.
 *
 * Status work is bounded by scanPolicy. A truncated tree is never treated as
 * deletable: mc reports the exact reason and fails closed before teardown.
 */
export async function inspectOwnedToolArtifacts(entry, {
  roots = defaultToolArtifactRoots(),
  fs = nodeFsPortal(),
  scanPolicy = DEFAULT_TOOL_ARTIFACT_SCAN_POLICY,
  allowVerifiedMissingTranscript = false,
} = {}) {
  const authority = classifyToolArtifactAuthority(entry, { roots });
  const policy = normalizeScanPolicy(scanPolicy);
  const scan = createScanState(policy, fs.now || Date.now);
  if (authority.state === 'none') {
    return ownedResult(authority, [], scanSummary(scan));
  }
  if (authority.state !== 'candidate') {
    return {
      ...authority,
      artifacts: [],
      totals: emptyTotals(),
      scan: scanSummary(scan),
    };
  }

  const transcript = await inspectTranscript(authority, fs);
  let transcriptMissing = false;
  if (!transcript.ok) {
    transcriptMissing = transcript.missing === true;
    if (
      !transcriptMissing
      || !allowVerifiedMissingTranscript
      || !verifiedAuthorityMarkerMatches(entry, authority)
    ) {
      return unsafeResult(authority, transcript.issue, scan);
    }
  }

  const auxiliary = await inspectAuxiliaryArtifacts(authority, roots[authority.source], {
    fs,
    scan,
  });
  if (!auxiliary.ok) {
    return unsafeResult(authority, auxiliary.issue, scan);
  }

  const artifacts = [
    ...(transcript.ok ? [transcript.artifact] : []),
    ...auxiliary.artifacts,
  ];
  if (transcriptMissing && artifacts.length === 0) {
    return {
      ...authority,
      state: 'absent',
      safe_to_delete: true,
      artifacts: [],
      totals: emptyTotals(),
      issues: [],
      transcript_missing: true,
      scan: scanSummary(scan),
    };
  }
  return {
    ...ownedResult(authority, artifacts, scanSummary(scan)),
    ...(transcriptMissing ? { transcript_missing: true } : {}),
  };
}

/**
 * Delete only artifacts produced by inspectOwnedToolArtifacts.
 *
 * Every path is re-inspected immediately before its operation. Directories
 * are scanned again under the same bounds, symlinks fail closed, and the
 * default portal compares the final lstat fingerprint before unlink/rm.
 */
export async function deleteOwnedToolArtifacts(entry, {
  roots = defaultToolArtifactRoots(),
  fs = nodeFsPortal(),
  scanPolicy = DEFAULT_TOOL_ARTIFACT_SCAN_POLICY,
  allowVerifiedMissingTranscript = false,
  maxRounds = 3,
} = {}) {
  const removed = [];
  let allowMissing = allowVerifiedMissingTranscript;

  for (let round = 0; round < maxRounds; round += 1) {
    const inventory = await inspectOwnedToolArtifacts(entry, {
      roots,
      fs,
      scanPolicy,
      allowVerifiedMissingTranscript: allowMissing,
    });
    if (!inventory.safe_to_delete) {
      return {
        ok: false,
        removed,
        verification: inventory,
        leftovers: inventory.artifacts || [],
        issues: inventory.issues || [],
      };
    }
    if ((inventory.artifacts || []).length === 0) {
      return {
        ok: true,
        removed,
        verification: inventory,
        leftovers: [],
      };
    }

    const ordered = [...inventory.artifacts].sort((a, b) => (
      Number(a.kind === 'transcript') - Number(b.kind === 'transcript')
      || a.path.localeCompare(b.path)
    ));
    for (const expected of ordered) {
      const fresh = await inspectExactOwnedArtifact(entry, expected, {
        roots,
        fs,
        scanPolicy,
        allowVerifiedMissingTranscript: allowMissing,
      });
      if (!fresh.ok) {
        return {
          ok: false,
          removed,
          verification: fresh.verification,
          leftovers: [expected],
          issues: [fresh.issue],
        };
      }
      if (fresh.missing) continue;

      try {
        if (fresh.artifact.type === 'directory') {
          await fs.removeDir(fresh.artifact.path, fresh.artifact.fingerprint);
        } else {
          await fs.removeFile(fresh.artifact.path, fresh.artifact.fingerprint);
        }
      } catch (err) {
        if (!isMissing(err)) {
          return {
            ok: false,
            removed,
            verification: fresh.verification,
            leftovers: [fresh.artifact],
            issues: [fsIssue('artifact-delete-failed', fresh.artifact.path, err)],
          };
        }
      }
      if (await pathExists(fresh.artifact.path, fs)) {
        return {
          ok: false,
          removed,
          verification: fresh.verification,
          leftovers: [fresh.artifact],
          issues: [{ code: 'artifact-delete-leftover', path: fresh.artifact.path }],
        };
      }
      removed.push(withoutFingerprint(fresh.artifact));
      if (fresh.artifact.kind === 'transcript') allowMissing = true;
    }
  }

  const verification = await inspectOwnedToolArtifacts(entry, {
    roots,
    fs,
    scanPolicy,
    allowVerifiedMissingTranscript: allowMissing,
  });
  return {
    ok: verification.safe_to_delete && verification.artifacts.length === 0,
    removed,
    verification,
    leftovers: verification.artifacts || [],
    ...((verification.artifacts || []).length > 0 ? {
      issues: [{ code: 'artifact-delete-round-limit' }],
    } : {}),
  };
}

export function nodeFsPortal() {
  return {
    lstat,
    realpath,
    readHead: readHeadDefault,
    readDir: readDirDefault,
    removeFile: removeFileDefault,
    removeDir: removeDirDefault,
    now: Date.now,
  };
}

async function inspectExactOwnedArtifact(entry, expected, {
  roots,
  fs,
  scanPolicy,
  allowVerifiedMissingTranscript,
}) {
  const inventory = await inspectOwnedToolArtifacts(entry, {
    roots,
    fs,
    scanPolicy,
    allowVerifiedMissingTranscript,
  });
  if (!inventory.safe_to_delete) {
    return {
      ok: false,
      issue: inventory.issues?.[0] || { code: 'artifact-authority-unverified' },
      verification: inventory,
    };
  }
  const fresh = inventory.artifacts.find((artifact) => (
    artifact.kind === expected.kind
      && artifact.path === expected.path
      && artifact.type === expected.type
  ));
  if (!fresh) {
    if (!await pathExists(expected.path, fs)) {
      return { ok: true, missing: true, verification: inventory };
    }
    return {
      ok: false,
      issue: { code: 'artifact-authority-changed', path: expected.path },
      verification: inventory,
    };
  }
  return { ok: true, artifact: fresh, verification: inventory };
}

async function inspectTranscript(authority, fs) {
  const candidate = {
    kind: 'transcript',
    path: authority.transcript_path,
    root: authority.transcript_root,
    providerRoot: authority.provider_root,
    expected: 'file',
  };
  const inspected = await inspectFileArtifact(candidate, fs);
  if (!inspected.ok) {
    return {
      ok: false,
      missing: inspected.missing,
      issue: {
        ...(inspected.issue || {}),
        code: inspected.missing ? 'transcript-missing' : inspected.issue?.code,
        path: authority.transcript_path,
      },
    };
  }

  let head;
  try {
    head = await fs.readHead(authority.transcript_path, HEAD_BYTES);
  } catch (err) {
    return { ok: false, issue: fsIssue('transcript-read-failed', authority.transcript_path, err) };
  }
  const foundId = transcriptSessionId(authority.source, head);
  if (!foundId) {
    return {
      ok: false,
      issue: { code: 'transcript-id-unreadable', path: authority.transcript_path },
    };
  }
  if (foundId !== authority.session_id) {
    return {
      ok: false,
      issue: { code: 'transcript-id-mismatch', path: authority.transcript_path },
    };
  }
  return inspected;
}

async function inspectAuxiliaryArtifacts(authority, sourceRoots, { fs, scan }) {
  const directories = exactSessionDirectories(authority, sourceRoots);
  const artifacts = [];
  for (const candidate of directories) {
    const inspected = await inspectDirectoryArtifact(candidate, fs, scan);
    if (inspected.missing) continue;
    if (!inspected.ok) return inspected;
    artifacts.push(inspected.artifact);
  }

  if (authority.source === 'codex') {
    const snapshots = await inspectCodexShellSnapshots(authority, sourceRoots, { fs, scan });
    if (!snapshots.ok) return snapshots;
    artifacts.push(...snapshots.artifacts);
  }
  return { ok: true, artifacts: artifacts.sort((a, b) => a.path.localeCompare(b.path)) };
}

function exactSessionDirectories(authority, sourceRoots) {
  if (authority.source === 'codex') {
    return [{
      kind: 'codex-generated-images',
      path: join(sourceRoots.generated_images_root, authority.session_id),
      root: sourceRoots.generated_images_root,
      providerRoot: sourceRoots.provider_root,
      expected: 'directory',
    }];
  }
  const projectDir = dirname(authority.transcript_path);
  return [
    {
      kind: 'claude-project-session-data',
      path: join(projectDir, authority.session_id),
      root: projectDir,
      providerRoot: sourceRoots.provider_root,
      expected: 'directory',
    },
    ...[
      ['claude-file-history', sourceRoots.file_history_root],
      ['claude-session-env', sourceRoots.session_env_root],
      ['claude-tasks', sourceRoots.tasks_root],
    ].map(([kind, root]) => ({
      kind,
      path: join(root, authority.session_id),
      root,
      providerRoot: sourceRoots.provider_root,
      expected: 'directory',
    })),
  ];
}

async function inspectCodexShellSnapshots(authority, sourceRoots, { fs, scan }) {
  const root = sourceRoots.shell_snapshots_root;
  const rootInspection = await inspectRoot(root, sourceRoots.provider_root, fs);
  if (rootInspection.missing) return { ok: true, artifacts: [] };
  if (!rootInspection.ok) return rootInspection;

  const pattern = new RegExp(`^${escapeRegExp(authority.session_id)}\\.[0-9]+\\.sh$`);
  const artifacts = [];
  let entries;
  try {
    entries = fs.readDir(root);
    for await (const entry of entries) {
      const limitIssue = noteScanEntry(scan, { depth: 1 });
      if (limitIssue) return { ok: false, issue: limitIssue };
      if (!pattern.test(entry.name)) continue;
      const inspected = await inspectFileArtifact({
        kind: 'codex-shell-snapshot',
        path: join(root, entry.name),
        root,
        providerRoot: sourceRoots.provider_root,
        expected: 'file',
      }, fs);
      if (!inspected.ok) return inspected;
      noteScanBytes(scan, inspected.artifact.bytes);
      artifacts.push(inspected.artifact);
    }
  } catch (err) {
    if (isMissing(err)) return { ok: true, artifacts: [] };
    return {
      ok: false,
      issue: fsIssue('artifact-root-read-failed', root, err),
    };
  }
  return { ok: true, artifacts };
}

async function inspectDirectoryArtifact(candidate, fs, scan) {
  const inspected = await inspectNode(candidate, fs);
  if (!inspected.ok) return inspected;
  if (inspected.statType !== 'directory') {
    return unsafeArtifact('artifact-not-directory', candidate.path);
  }

  const totals = { files: 0, bytes: 0 };
  const stack = [{ path: candidate.path, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readDir(current.path);
      for await (const entry of entries) {
        const depth = current.depth + 1;
        const limitIssue = noteScanEntry(scan, { depth });
        if (limitIssue) return { ok: false, issue: limitIssue };
        const path = join(current.path, entry.name);
        let stat;
        try {
          stat = await fs.lstat(path);
        } catch (err) {
          return unsafeArtifact('artifact-stat-failed', path, err);
        }
        if (stat.isSymbolicLink()) return unsafeArtifact('symlink-not-allowed', path);
        if (stat.isDirectory()) {
          stack.push({ path, depth });
          continue;
        }
        if (!stat.isFile()) return unsafeArtifact('artifact-node-type-unsupported', path);
        totals.files += 1;
        totals.bytes += stat.size;
        noteScanBytes(scan, stat.size);
      }
    } catch (err) {
      if (isMissing(err)) return { ok: false, missing: true };
      return unsafeArtifact('artifact-directory-read-failed', current.path, err);
    }
  }

  return {
    ok: true,
    artifact: {
      kind: candidate.kind,
      path: candidate.path,
      type: 'directory',
      bytes: totals.bytes,
      file_count: totals.files,
      ownership: 'verified',
      fingerprint: inspected.fingerprint,
    },
  };
}

async function inspectFileArtifact(candidate, fs) {
  const inspected = await inspectNode(candidate, fs);
  if (!inspected.ok) return inspected;
  if (inspected.statType !== 'file') return unsafeArtifact('artifact-not-file', candidate.path);
  return {
    ok: true,
    artifact: {
      kind: candidate.kind,
      path: candidate.path,
      type: 'file',
      bytes: inspected.size,
      file_count: 1,
      ownership: 'verified',
      fingerprint: inspected.fingerprint,
    },
  };
}

async function inspectNode(candidate, fs) {
  const rootInspection = await inspectRoot(candidate.root, candidate.providerRoot, fs);
  if (!rootInspection.ok) return rootInspection;

  const chainIssue = await verifyPathChain(candidate.root, candidate.path, fs);
  if (chainIssue) return { ok: false, issue: chainIssue };

  let stat;
  try {
    stat = await fs.lstat(candidate.path);
  } catch (err) {
    if (isMissing(err)) return { ok: false, missing: true };
    return unsafeArtifact('artifact-stat-failed', candidate.path, err);
  }
  if (stat.isSymbolicLink()) return unsafeArtifact('symlink-not-allowed', candidate.path);

  try {
    const rootReal = await fs.realpath(candidate.root);
    const pathReal = await fs.realpath(candidate.path);
    if (!isWithin(pathReal, rootReal) || pathReal === rootReal) {
      return unsafeArtifact('artifact-realpath-outside-allowlist', candidate.path);
    }
  } catch (err) {
    return unsafeArtifact('artifact-realpath-failed', candidate.path, err);
  }

  return {
    ok: true,
    statType: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
    size: stat.size,
    fingerprint: fingerprint(stat),
  };
}

async function inspectRoot(root, providerRoot, fs) {
  try {
    const providerStat = await fs.lstat(providerRoot);
    if (providerStat.isSymbolicLink()) return unsafeArtifact('symlink-not-allowed', providerRoot);
    if (!providerStat.isDirectory()) return unsafeArtifact('provider-root-not-directory', providerRoot);
  } catch (err) {
    if (isMissing(err)) return { ok: false, missing: true };
    return unsafeArtifact('provider-root-stat-failed', providerRoot, err);
  }

  const rootChainIssue = await verifyPathChain(providerRoot, root, fs);
  if (rootChainIssue) return { ok: false, issue: rootChainIssue };
  try {
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink()) return unsafeArtifact('symlink-not-allowed', root);
    if (!stat.isDirectory()) return unsafeArtifact('artifact-root-not-directory', root);
    const providerReal = await fs.realpath(providerRoot);
    const rootReal = await fs.realpath(root);
    if (!isWithin(rootReal, providerReal) || rootReal === providerReal) {
      return unsafeArtifact('artifact-root-realpath-outside-provider', root);
    }
  } catch (err) {
    if (isMissing(err)) return { ok: false, missing: true };
    return unsafeArtifact('artifact-root-stat-failed', root, err);
  }
  return { ok: true };
}

async function verifyPathChain(root, path, fs) {
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return { code: 'artifact-outside-allowlist', path };
  }
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) return { code: 'symlink-not-allowed', path: current };
    } catch (err) {
      if (isMissing(err)) return null;
      return fsIssue('artifact-stat-failed', current, err);
    }
  }
  return null;
}

function validateProviderRoots(source, sourceRoots) {
  if (!sourceRoots || !isCanonicalAbsolute(sourceRoots.provider_root)) {
    return 'invalid-provider-artifact-roots';
  }
  const providerRoot = sourceRoots.provider_root;
  const expected = source === 'codex'
    ? {
        transcript_roots: [join(providerRoot, 'sessions'), join(providerRoot, 'archived_sessions')],
        generated_images_root: join(providerRoot, 'generated_images'),
        shell_snapshots_root: join(providerRoot, 'shell_snapshots'),
      }
    : source === 'claude-code'
      ? {
          transcript_roots: [join(providerRoot, 'projects')],
          file_history_root: join(providerRoot, 'file-history'),
          session_env_root: join(providerRoot, 'session-env'),
          tasks_root: join(providerRoot, 'tasks'),
        }
      : null;
  if (!expected) return 'unsupported-tool-source';
  if (
    !Array.isArray(sourceRoots.transcript_roots)
    || sourceRoots.transcript_roots.length !== expected.transcript_roots.length
    || sourceRoots.transcript_roots.some((root, index) => root !== expected.transcript_roots[index])
  ) {
    return 'invalid-provider-artifact-roots';
  }
  for (const [key, path] of Object.entries(expected)) {
    if (key === 'transcript_roots') continue;
    if (sourceRoots[key] !== path) return 'invalid-provider-artifact-roots';
  }
  return null;
}

function verifiedAuthorityMarkerMatches(entry, authority) {
  const marker = entry?.tool_artifact_authority_verified;
  return marker?.version === TOOL_ARTIFACT_AUTHORITY_VERSION
    && marker.source === authority.source
    && marker.session_id === authority.session_id
    && marker.transcript_path === authority.transcript_path;
}

function transcriptSessionId(source, head) {
  const lines = String(head || '').split('\n').filter((line) => line.trim());
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (source === 'codex') {
      if (entry?.type === 'session_meta') return nonEmpty(entry?.payload?.id);
      continue;
    }
    const id = nonEmpty(entry?.sessionId) || nonEmpty(entry?.session_id);
    if (id) return id;
  }
  return null;
}

function matchesTranscriptLayout({ source, sessionId, transcriptPath, transcriptRoot }) {
  const rel = relative(transcriptRoot, transcriptPath);
  const parts = rel.split(sep);
  if (source === 'claude-code') {
    return parts.length === 2
      && parts[0].startsWith('-')
      && parts[1] === `${sessionId}.jsonl`;
  }
  const file = parts.at(-1);
  if (!file?.startsWith('rollout-') || !file.endsWith(`-${sessionId}.jsonl`)) return false;
  const rootName = basename(transcriptRoot);
  if (rootName === 'archived_sessions') return parts.length === 1;
  return parts.length === 4
    && /^\d{4}$/.test(parts[0])
    && /^\d{2}$/.test(parts[1])
    && /^\d{2}$/.test(parts[2]);
}

function toolMatchesSource(tool, source) {
  const value = nonEmpty(tool);
  if (source === 'codex') return value === 'codex';
  if (source === 'claude-code') return value === 'claude' || value === 'claude-code';
  return false;
}

function deepestContainingRoot(path, roots) {
  return (roots || [])
    .map((root) => nonEmpty(root))
    .filter(Boolean)
    .map((root) => resolve(root))
    .filter((root) => isWithin(path, root) && path !== root)
    .sort((a, b) => b.length - a.length)[0] || null;
}

function isWithin(path, root) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function isCanonicalAbsolute(path) {
  return typeof path === 'string' && isAbsolute(path) && normalize(path) === path;
}

async function readHeadDefault(path, maxBytes = HEAD_BYTES) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function* readDirDefault(path) {
  const directory = await opendir(path);
  try {
    while (true) {
      const entry = await directory.read();
      if (!entry) break;
      yield entry;
    }
  } finally {
    await directory.close().catch((err) => {
      if (err?.code !== 'ERR_DIR_CLOSED') throw err;
    });
  }
}

async function removeFileDefault(path, expectedFingerprint) {
  await assertFingerprint(path, expectedFingerprint);
  await unlink(path);
}

async function removeDirDefault(path, expectedFingerprint) {
  await assertFingerprint(path, expectedFingerprint);
  await rm(path, { recursive: true, force: false });
}

async function assertFingerprint(path, expected) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !sameFingerprint(fingerprint(stat), expected)) {
    const err = new Error('artifact changed immediately before deletion');
    err.code = 'ARTIFACT_CHANGED';
    throw err;
  }
}

function fingerprint(stat) {
  return {
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    mode: Number(stat.mode),
    size: Number(stat.size),
  };
}

function sameFingerprint(a, b) {
  return a?.dev === b?.dev
    && a?.ino === b?.ino
    && a?.mode === b?.mode
    && a?.size === b?.size;
}

function withoutFingerprint(artifact) {
  const { fingerprint: _fingerprint, ...out } = artifact;
  return out;
}

async function pathExists(path, fs) {
  try {
    await fs.lstat(path);
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

function normalizeScanPolicy(policy) {
  const input = policy || {};
  return {
    max_entries: positiveInteger(input.max_entries, DEFAULT_TOOL_ARTIFACT_SCAN_POLICY.max_entries),
    max_depth: positiveInteger(input.max_depth, DEFAULT_TOOL_ARTIFACT_SCAN_POLICY.max_depth),
    max_duration_ms: positiveInteger(
      input.max_duration_ms,
      DEFAULT_TOOL_ARTIFACT_SCAN_POLICY.max_duration_ms,
    ),
  };
}

function createScanState(policy, now) {
  return {
    policy,
    now,
    started_at: now(),
    entries: 0,
    bytes: 0,
    max_depth_seen: 0,
    truncated: false,
    reason: null,
  };
}

function noteScanEntry(scan, { depth }) {
  scan.entries += 1;
  scan.max_depth_seen = Math.max(scan.max_depth_seen, depth);
  return scanLimitIssue(scan);
}

function noteScanBytes(scan, bytes) {
  scan.bytes += Math.max(0, Number(bytes) || 0);
}

function scanLimitIssue(scan) {
  let reason = null;
  if (scan.entries > scan.policy.max_entries) reason = 'max-entries';
  else if (scan.max_depth_seen > scan.policy.max_depth) reason = 'max-depth';
  else if (scan.now() - scan.started_at > scan.policy.max_duration_ms) reason = 'max-duration';
  if (!reason) return null;
  scan.truncated = true;
  scan.reason = reason;
  return {
    code: 'artifact-scan-truncated',
    reason,
    limits: { ...scan.policy },
    observed: {
      entries: scan.entries,
      bytes: scan.bytes,
      max_depth: scan.max_depth_seen,
    },
  };
}

function scanSummary(scan) {
  return {
    bounded: true,
    truncated: scan.truncated,
    reason: scan.reason,
    entries: scan.entries,
    bytes: scan.bytes,
    max_depth: scan.max_depth_seen,
    limits: { ...scan.policy },
  };
}

function ownedResult(authority, artifacts, scan) {
  return {
    ...authority,
    state: authority.state === 'none' ? 'none' : 'owned',
    safe_to_delete: true,
    artifacts,
    totals: summarizeArtifacts(artifacts),
    issues: [],
    scan,
  };
}

function unsafeResult(authority, issue, scan) {
  return {
    ...authority,
    state: 'unverified',
    safe_to_delete: false,
    artifacts: [],
    totals: emptyTotals(),
    issues: [issue],
    scan: scanSummary(scan),
  };
}

function unverified(code, fields = {}) {
  return {
    state: 'unverified',
    safe_to_delete: false,
    source: fields.source || null,
    session_id: fields.session_id || null,
    transcript_path: fields.transcript_path || null,
    transcript_root: fields.transcript_root || null,
    provider_root: fields.provider_root || null,
    issues: [{ code }],
  };
}

function summarizeArtifacts(artifacts) {
  return artifacts.reduce((totals, artifact) => ({
    paths: totals.paths + 1,
    files: totals.files + artifact.file_count,
    bytes: totals.bytes + artifact.bytes,
  }), emptyTotals());
}

function emptyTotals() {
  return { paths: 0, files: 0, bytes: 0 };
}

function unsafeArtifact(code, path, err = null) {
  return { ok: false, issue: fsIssue(code, path, err) };
}

function fsIssue(code, path, err = null) {
  return {
    code,
    path,
    ...(err?.code ? { fs_code: err.code } : {}),
  };
}

function codexNegativeRoots(root) {
  return [
    root,
    join(root, 'history.jsonl'),
    join(root, 'session_index.jsonl'),
    join(root, 'state_5.sqlite'),
    join(root, 'logs_2.sqlite'),
    join(root, 'goals_1.sqlite'),
    join(root, 'memories_1.sqlite'),
    join(root, 'memories'),
    join(root, 'config.toml'),
    join(root, 'auth.json'),
  ];
}

function claudeNegativeRoots(root) {
  return [
    root,
    join(root, 'history.jsonl'),
    join(root, 'settings.json'),
    join(root, 'shell-snapshots'),
    join(root, 'memory'),
    join(root, 'plugins'),
  ];
}

function isMissing(err) {
  return err?.code === 'ENOENT';
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
