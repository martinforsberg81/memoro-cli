/** Internal Claude SessionStart bridge for broker-owned artifact capture. */
import { readHookEvent } from '../lib/hook-event.js';
import { requestBroker } from '../runtime/broker/client.js';
import { sessionHostPaths } from '../runtime/broker/paths.js';

export async function captureProviderArtifact(argv, {
  env = process.env,
  readEvent = readHookEvent,
  request = requestBroker,
  pathsForSession = sessionHostPaths,
} = {}) {
  const tool = parseTool(argv);
  if (tool !== 'claude-code' && tool !== 'codex') return 2;
  // Hooks are global; raw provider sessions must never gain an mc broker side
  // effect merely because the integration is installed.
  if (env.MEMORO_MC_PARENT !== '1'
    || !env.MC_CODING_SESSION_ID
    || !env.MC_RUNTIME_GENERATION) return 0;
  const event = await readEvent();
  if (event?.hook_event_name !== 'SessionStart'
    || !event?.session_id || !event?.transcript_path || !event?.cwd) return 1;
  const socketPath = env.MC_PROVIDER_ARTIFACT_SOCKET
    || pathsForSession(env.MC_CODING_SESSION_ID).artifactSocketPath;
  const result = await request({
    type: 'capture_provider_artifact',
    id: env.MC_CODING_SESSION_ID,
    runtime_generation: env.MC_RUNTIME_GENERATION,
    tool,
    cwd: event.cwd,
    provider_session_id: event.session_id,
    transcript_path: event.transcript_path,
  }, { socketPath }).catch(() => null);
  return result?.ok ? 0 : 1;
}

function parseTool(argv = []) {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--tool') return argv[index + 1] || null;
  }
  return null;
}
