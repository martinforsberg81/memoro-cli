/**
 * Put an archived transcript back where the tool will look for it.
 *
 * mc archived transcripts into its own store while it ran managed sessions.
 * Now that it launches the tool directly, the tool reads its own home — so a
 * conversation whose only copy is in mc's archive is one mc can no longer
 * resume, even though it holds the bytes.
 *
 * This is the mirror of adoption, under the same rules: mc copies, the tool
 * never does; the destination is the tool's own home; an existing file is
 * left alone; what lands is private and digest-verified against the manifest
 * that recorded it.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { mcHome } from './paths.js';

const MAX_TRANSCRIPT_BYTES = 512 * 1024 * 1024;

/**
 * @returns {{ok: boolean, restored?: boolean, path?: string, reason?: string}}
 */
export function restoreArchivedTranscriptSync({
  mcHomeDir = mcHome(),
  tool,
  providerStateKey,
  providerSessionId,
} = {}) {
  if (!tool || !providerStateKey || !providerSessionId) {
    return { ok: false, reason: 'restore-input-invalid' };
  }
  const toolHome = tool === 'claude-code'
    ? join(homedir(), '.claude')
    : join(homedir(), '.codex');
  const found = findArchive({ mcHomeDir, tool, providerStateKey, providerSessionId });
  if (!found) return { ok: true, restored: false, reason: 'no-archive' };

  const target = join(toolHome, found.manifest.relative_transcript_path);
  if (existsSync(target)) return { ok: true, restored: false, reason: 'already-present' };

  try {
    const info = statSync(found.transcriptPath);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_TRANSCRIPT_BYTES) {
      return { ok: false, reason: 'archive-transcript-unusable' };
    }
    const digest = createHash('sha256')
      .update(readFileSync(found.transcriptPath))
      .digest('hex');
    if (found.manifest.transcript_sha256 && digest !== found.manifest.transcript_sha256) {
      return { ok: false, reason: 'archive-transcript-digest-mismatch' };
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(found.transcriptPath, target);
    chmodSync(target, 0o600);
    return { ok: true, restored: true, path: target };
  } catch {
    return { ok: false, reason: 'archive-restore-failed' };
  }
}

function findArchive({ mcHomeDir, tool, providerStateKey, providerSessionId }) {
  const part = `${providerStateKey}-${createHash('sha256')
    .update(String(providerStateKey)).digest('hex').slice(0, 12)}`;
  const stateRoot = join(mcHomeDir, 'provider-session-state');
  let toolDirs = [];
  try {
    toolDirs = readdirSync(stateRoot).filter((name) => (
      tool === 'claude-code' ? name.startsWith('claude-code') : name === 'codex'
    ));
  } catch { return null; }
  for (const toolDir of toolDirs) {
    const root = join(stateRoot, toolDir, part);
    for (const manifestPath of manifestCandidates(root)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (manifest.provider_session_id !== providerSessionId) continue;
        const transcriptPath = join(dirname(manifestPath), manifest.relative_transcript_path);
        if (existsSync(transcriptPath)) return { manifest, transcriptPath };
      } catch { /* try the next generation */ }
    }
  }
  return null;
}

function manifestCandidates(root) {
  const out = [];
  try {
    for (const generation of readdirSync(join(root, 'generations'))) {
      out.push(join(root, 'generations', generation, 'manifest.json'));
    }
  } catch { /* no generations directory */ }
  out.push(join(root, 'manifest.json'));
  return out;
}
