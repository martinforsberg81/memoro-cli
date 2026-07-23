import {
  lstat,
  open,
  readdir,
  realpath,
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

export function defaultToolArtifactRoots({
  home = homedir(),
  env = process.env,
} = {}) {
  const codexHome = nonEmpty(env.CODEX_HOME) || join(home, '.codex');
  const claudeHome = nonEmpty(env.CLAUDE_HOME) || join(home, '.claude');
  return {
    codex: {
      transcript_roots: [
        join(codexHome, 'sessions'),
        join(codexHome, 'archived_sessions'),
      ],
      generated_images_root: join(codexHome, 'generated_images'),
      shell_snapshots_root: join(codexHome, 'shell_snapshots'),
    },
    'claude-code': {
      transcript_roots: [join(claudeHome, 'projects')],
    },
  };
}

/**
 * Pure registry-to-authority classification. No filesystem reads happen here.
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
  if (!sourceRoots || !Array.isArray(sourceRoots.transcript_roots)) {
    return unverified('unsupported-tool-source', {
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
    issues: [],
  };
}

/**
 * Resolve and verify all provider-native paths owned by one registry entry.
 *
 * This function never deletes. Its result is intentionally shaped so a later
 * teardown command can show counts and pass only verified `artifacts[].path`
 * values to its own injected filesystem portal.
 */
export async function inspectOwnedToolArtifacts(entry, {
  roots = defaultToolArtifactRoots(),
  fs = nodeFsPortal(),
} = {}) {
  const authority = classifyToolArtifactAuthority(entry, { roots });
  if (authority.state === 'none') {
    return ownedResult(authority, []);
  }
  if (authority.state !== 'candidate') {
    return {
      ...authority,
      artifacts: [],
      totals: emptyTotals(),
    };
  }

  const transcript = await inspectTranscript(authority, fs);
  if (!transcript.ok) {
    return unsafeResult(authority, transcript.issue);
  }

  const candidates = await derivedArtifactCandidates(authority, roots, fs);
  const artifacts = [transcript.artifact];
  const issues = [];
  for (const candidate of candidates) {
    const inspected = await inspectArtifact(candidate, fs);
    if (inspected.missing) continue;
    if (!inspected.ok) {
      issues.push(inspected.issue);
      continue;
    }
    artifacts.push(inspected.artifact);
  }
  if (issues.length) {
    return {
      ...authority,
      state: 'unverified',
      safe_to_delete: false,
      artifacts,
      totals: summarizeArtifacts(artifacts),
      issues,
    };
  }
  return ownedResult(authority, artifacts);
}

export function nodeFsPortal() {
  return {
    lstat,
    realpath,
    readdir,
    readHead: readHeadDefault,
  };
}

async function inspectTranscript(authority, fs) {
  const candidate = {
    kind: 'transcript',
    path: authority.transcript_path,
    root: authority.transcript_root,
    expected: 'file',
  };
  const inspected = await inspectArtifact(candidate, fs);
  if (!inspected.ok) {
    return {
      ok: false,
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

async function derivedArtifactCandidates(authority, roots, fs) {
  if (authority.source === 'claude-code') {
    return [{
      kind: 'claude-session-data',
      path: join(dirname(authority.transcript_path), authority.session_id),
      root: authority.transcript_root,
      expected: 'directory',
    }];
  }

  const sourceRoots = roots.codex;
  const candidates = [];
  if (nonEmpty(sourceRoots?.generated_images_root)) {
    candidates.push({
      kind: 'codex-generated-images',
      path: join(sourceRoots.generated_images_root, authority.session_id),
      root: sourceRoots.generated_images_root,
      expected: 'directory',
    });
  }
  if (nonEmpty(sourceRoots?.shell_snapshots_root)) {
    let entries = [];
    try {
      const rootStat = await fs.lstat(sourceRoots.shell_snapshots_root);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        candidates.push({
          expected: 'invalid',
          issue: {
            code: rootStat.isSymbolicLink()
              ? 'symlink-not-allowed'
              : 'artifact-root-not-directory',
            path: sourceRoots.shell_snapshots_root,
          },
        });
        return candidates;
      }
      entries = await fs.readdir(sourceRoots.shell_snapshots_root, { withFileTypes: true });
    } catch (err) {
      if (!isMissing(err)) {
        candidates.push({
          expected: 'invalid',
          issue: fsIssue(
            'artifact-root-read-failed',
            sourceRoots.shell_snapshots_root,
            err,
          ),
        });
      }
      return candidates;
    }
    const prefix = `${authority.session_id}.`;
    for (const entry of entries) {
      if (!entry.name.startsWith(prefix) || !entry.name.endsWith('.sh')) continue;
      candidates.push({
        kind: 'codex-shell-snapshot',
        path: join(sourceRoots.shell_snapshots_root, entry.name),
        root: sourceRoots.shell_snapshots_root,
        expected: 'file',
      });
    }
  }
  return candidates;
}

async function inspectArtifact(candidate, fs) {
  if (candidate.expected === 'invalid') return { ok: false, issue: candidate.issue };
  try {
    const rootStat = await fs.lstat(candidate.root);
    if (rootStat.isSymbolicLink()) {
      return unsafeArtifact('symlink-not-allowed', candidate.path);
    }
    if (!rootStat.isDirectory()) {
      return unsafeArtifact('artifact-root-not-directory', candidate.path);
    }
  } catch (err) {
    if (isMissing(err)) return { ok: false, missing: true };
    return unsafeArtifact('artifact-root-stat-failed', candidate.path, err);
  }

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
  if (candidate.expected === 'file' && !stat.isFile()) {
    return unsafeArtifact('artifact-not-file', candidate.path);
  }
  if (candidate.expected === 'directory' && !stat.isDirectory()) {
    return unsafeArtifact('artifact-not-directory', candidate.path);
  }

  try {
    const rootReal = await fs.realpath(candidate.root);
    const pathReal = await fs.realpath(candidate.path);
    if (!isWithin(pathReal, rootReal) || pathReal === rootReal) {
      return unsafeArtifact('artifact-realpath-outside-allowlist', candidate.path);
    }
  } catch (err) {
    return unsafeArtifact('artifact-realpath-failed', candidate.path, err);
  }

  const measured = await measurePath(candidate.path, stat, fs);
  if (!measured.ok) return measured;
  return {
    ok: true,
    artifact: {
      kind: candidate.kind,
      path: candidate.path,
      type: candidate.expected,
      bytes: measured.bytes,
      file_count: measured.file_count,
      ownership: 'verified',
    },
  };
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

async function measurePath(path, stat, fs) {
  if (stat.isFile()) {
    return { ok: true, bytes: stat.size, file_count: 1 };
  }
  if (!stat.isDirectory()) return unsafeArtifact('unsupported-artifact-type', path);

  let entries;
  try {
    entries = await fs.readdir(path, { withFileTypes: true });
  } catch (err) {
    return unsafeArtifact('artifact-read-failed', path, err);
  }
  let bytes = 0;
  let fileCount = 0;
  for (const entry of entries) {
    const child = join(path, entry.name);
    let childStat;
    try {
      childStat = await fs.lstat(child);
    } catch (err) {
      return unsafeArtifact('artifact-stat-failed', child, err);
    }
    if (childStat.isSymbolicLink()) return unsafeArtifact('symlink-not-allowed', child);
    const measured = await measurePath(child, childStat, fs);
    if (!measured.ok) return measured;
    bytes += measured.bytes;
    fileCount += measured.file_count;
  }
  return { ok: true, bytes, file_count: fileCount };
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

function ownedResult(authority, artifacts) {
  return {
    ...authority,
    state: authority.state === 'none' ? 'none' : 'owned',
    safe_to_delete: true,
    artifacts,
    totals: summarizeArtifacts(artifacts),
    issues: [],
  };
}

function unsafeResult(authority, issue) {
  return {
    ...authority,
    state: 'unverified',
    safe_to_delete: false,
    artifacts: [],
    totals: emptyTotals(),
    issues: [issue],
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

function isMissing(err) {
  return err?.code === 'ENOENT';
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
