import { resolveToolInput } from '../adapters/index.js';
import { DEFAULT_TOOL } from '../lib/config.js';
import { sourceForTool } from './broker/session-sidecars.js';
import { findLatestTranscriptForTool } from './session-upload.js';

export async function resolveToolSessionForResume({
  entry,
  launchTool = null,
  deps = {},
} = {}) {
  const source = toolSessionSource({ entry, launchTool });
  const stored = firstNonEmpty(
    entry?.tool_session_id,
    entry?.provider_session_id,
    entry?.llm_session_id,
  );
  if (stored) {
    return {
      ok: true,
      source,
      sessionId: stored,
      transcriptPath: firstNonEmpty(entry?.tool_transcript_path, entry?.transcript_path),
      from: 'registry',
    };
  }

  if (!source) {
    return {
      ok: false,
      reason: 'unknown-tool-source',
      source: null,
      sessionId: null,
      transcriptPath: null,
    };
  }

  const transcript = await (deps.findLatestTranscriptForTool || findLatestTranscriptForTool)({
    source,
    cwd: entry?.worktree_path || null,
    deps,
  });
  const sessionId = firstNonEmpty(transcript?.sessionId, transcript?.session_id);
  if (!sessionId) {
    return {
      ok: false,
      reason: 'no-tool-session-id',
      source,
      sessionId: null,
      transcriptPath: transcript?.path || null,
    };
  }

  return {
    ok: true,
    source,
    sessionId,
    transcriptPath: transcript.path || null,
    from: 'transcript',
  };
}

export function buildNativeResumeArgv({
  entry,
  launchTool = null,
  sessionId,
} = {}) {
  const adapter = launchTool?.adapter || resolveToolInput(entry?.tool || DEFAULT_TOOL)?.adapter || null;
  if (typeof adapter?.resumeArgs !== 'function') {
    return {
      ok: false,
      reason: 'unsupported-native-resume',
      tool: launchTool?.id || entry?.tool || null,
      argv: null,
    };
  }
  const argv = adapter.resumeArgs({ sessionId, entry });
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((arg) => typeof arg === 'string')) {
    return {
      ok: false,
      reason: 'invalid-native-resume-argv',
      tool: launchTool?.id || entry?.tool || null,
      argv: null,
    };
  }
  return { ok: true, argv };
}

export function toolSessionSource({ entry, launchTool = null } = {}) {
  return firstNonEmpty(
    entry?.tool_session_source,
    entry?.provider_session_source,
    sourceForTool(launchTool?.shortName),
    sourceForTool(launchTool?.id),
    sourceForTool(entry?.tool),
  );
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}
