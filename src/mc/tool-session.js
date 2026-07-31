import { resolveToolInput } from '../adapters/index.js';
import { DEFAULT_TOOL } from '../lib/config.js';
import { sourceForTool } from './broker/session-sidecars.js';
import {
  findLatestTranscriptForTool,
  findTranscriptForToolSession,
} from './session-upload.js';
import {
  normalizeProviderSessions,
  providerSessionFor,
  withProviderSession,
} from './registry.js';

export async function resolveToolSessionForResume({
  entry,
  launchTool = null,
  deps = {},
} = {}) {
  const source = toolSessionSource({ entry, launchTool });
  const hasProviderSessions = entry?.provider_sessions != null;
  const normalized = normalizeProviderSessions(entry);
  if (!normalized.ok) {
    return { ok: false, reason: normalized.reason, source, sessionId: null, transcriptPath: null };
  }
  const providerSession = hasProviderSessions ? providerSessionFor(entry, source) : null;
  const stored = hasProviderSessions
    ? firstExplicitProviderValue(providerSession?.session_id)
    : firstExplicitProviderValue(
        entry?.tool_session_id,
        entry?.provider_session_id,
        entry?.llm_session_id,
      );
  if (stored !== null) {
    let transcriptPath = hasProviderSessions
      ? firstExplicitProviderValue(providerSession?.transcript_path)
      : firstExplicitProviderValue(entry?.tool_transcript_path, entry?.transcript_path);
    let from = providerSession ? 'provider-sessions' : 'registry';
    const identity = validateResolvedProviderSession({
      source,
      sessionId: stored,
      transcriptPath: null,
    });
    if (!identity.ok) {
      return { ok: false, reason: identity.reason, source, sessionId: null, transcriptPath: null };
    }

    // Older launches persisted the native provider session ID before the
    // transcript path was available. Repair that incomplete authority record
    // from the latest transcript, but only when its embedded session ID is an
    // exact match. Never guess from a path or from recency alone.
    if (!transcriptPath && source) {
      let discovered = null;
      try {
        discovered = await (
          deps.findTranscriptForToolSession || findTranscriptForToolSession
        )({
          source,
          sessionId: stored,
          cwd: entry?.worktree_path || null,
          deps,
        });
      } catch {
        // Discovery is opportunistic. Preserve the stored identity and let
        // callers fail closed if the provider root is unavailable.
      }
      const discoveredId = firstExplicitProviderValue(
        discovered?.sessionId,
        discovered?.session_id,
      );
      if (discovered?.path && discoveredId === stored) {
        transcriptPath = discovered.path;
        from = 'transcript-repaired';
      }
    }
    const validated = validateResolvedProviderSession({ source, sessionId: stored, transcriptPath });
    if (!validated.ok) {
      return { ok: false, reason: validated.reason, source, sessionId: null, transcriptPath: null };
    }
    return {
      ok: true,
      source,
      sessionId: stored,
      transcriptPath,
      from,
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
  const sessionId = firstExplicitProviderValue(transcript?.sessionId, transcript?.session_id);
  if (sessionId === null) {
    return {
      ok: false,
      reason: 'no-tool-session-id',
      source,
      sessionId: null,
      transcriptPath: transcript?.path || null,
    };
  }

  const transcriptPath = transcript.path || null;
  const validated = validateResolvedProviderSession({ source, sessionId, transcriptPath });
  if (!validated.ok) {
    return { ok: false, reason: validated.reason, source, sessionId: null, transcriptPath: null };
  }

  return {
    ok: true,
    source,
    sessionId,
    transcriptPath,
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
  const selected = firstNonEmpty(
    sourceForTool(launchTool?.shortName),
    sourceForTool(launchTool?.id),
    sourceForTool(entry?.tool),
  );
  if (entry?.provider_sessions != null) return selected;
  return firstNonEmpty(
    entry?.tool_session_source,
    entry?.provider_session_source,
    selected,
  );
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function firstExplicitProviderValue(...values) {
  for (const value of values) {
    if (value != null && value !== '') return value;
  }
  return null;
}

function validateResolvedProviderSession({ source, sessionId, transcriptPath }) {
  const validated = withProviderSession(
    { provider_sessions: { schema: 1, providers: {} } },
    source,
    { session_id: sessionId, transcript_path: transcriptPath },
  );
  return validated.ok
    ? { ok: true }
    : { ok: false, reason: validated.reason || 'invalid-provider-session' };
}
