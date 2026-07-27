import { join } from 'node:path';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import { resolveLaunch } from '../../adapters/index.js';
import { installUpdateCommand } from '../../adapters/claude-code.js';
import { DEFAULT_TOOL, readConfig, getApiUrl } from '../../lib/config.js';
import { getRepoContext, deriveRepoName, derivePublicRepoRef } from '../../lib/git-context.js';
import { lookupOrMint } from '../../lib/coding-session.js';
import { getPackageVersion } from '../../lib/version.js';
import { ensureCoordinatorSlashCommand } from '../coordinator-command.js';
import { groundSession } from '../ground.js';
import { normalizeInteractivePtyEnv } from '../interactive-env.js';
import { mcHome } from '../paths.js';
import { findEntry } from '../registry.js';
import { resolvePolicyForWrap } from '../wrap-start.js';
import { requestBroker } from './client.js';
import { attachBrokerSession } from './attach-client.js';
import { renderIntro } from '../session-intro.js';
import { ensureBrokerRunning } from './supervisor.js';
import { ensureCloudBrokerConnected } from './cloud-supervisor.js';
import { scrubRuntimeSecretsInPlace } from '../runtime-secrets.js';
import { ensureSessionHostRunning } from './session-hosts.js';
import {
  buildSessionHeartbeatPayload,
  postHeartbeatWithRetry,
} from './session-sidecars.js';
import { prepareCloudCodexAuth } from '../cloud-codex-auth.js';
import {
  projectRuntimeSession,
  resolveSessionSourceIdentity,
} from '../session-projector.js';
import { resolveDevPlan, resolveDevSessionEnvironment } from '../dev-definition.js';
import {
  fetchGitHubSessionBootstrap,
  prepareGitHubSessionForLaunch,
  unavailableGitHubSessionCapabilities,
} from '../github-session.js';
import { createConnectionClient } from '../connections/client.js';
import {
  createBoundIdentityBroker,
  resolveBootstrapIdentity,
} from '../connections/identity.js';
import {
  LOCAL_AUTH_MODES,
  requireLocalAuthMode,
} from '../local-auth-mode.js';

const CLOUD_BROKER_START_TIMEOUT_MS = 10_000;
const CODEX_SQLITE_STARTUP_WINDOW_MS = 20_000;
export const CODEX_SQLITE_RETRY_DELAYS_MS = Object.freeze([2_000, 4_000]);

export async function launchBrokerOwnedSession({
  cwd,
  label = null,
  focus = null,
  tool = DEFAULT_TOOL,
  codingSessionId: requestedCodingSessionId = null,
  sessionName = null,
  argv = [],
  apiArgv = [],
  sendStartupMessage = true,
  attachAfterLaunch = true,
  cloudBroker = {},
  request = requestBroker,
  attach = attachBrokerSession,
  ensureBroker = ensureBrokerRunning,
  ensureCloudBroker = ensureCloudBrokerConnected,
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  localAuthMode = LOCAL_AUTH_MODES.NATIVE,
  now = () => Date.now(),
  onLaunched = null,
  deps = {},
} = {}) {
  const authMode = (deps.requireLocalAuthMode || requireLocalAuthMode)(localAuthMode);
  if (!authMode?.ok) {
    const error = authMode?.error || 'local auth mode unavailable';
    stderr.write(`mc: ${error}\n`);
    return {
      code: 1,
      error,
      reason: authMode?.reason || 'local-auth-mode-unavailable',
    };
  }

  const launch = resolveLaunch(tool);
  if (!launch.ok) {
    stderr.write(`mc: cannot launch "${tool}": ${launch.hint}\n`);
    return { code: 1 };
  }

  const repoContext = await (deps.getRepoContext || getRepoContext)(cwd);
  if (!repoContext) {
    stderr.write('mc: not inside a git repository. Coordinator is gated on repos.\n');
    return { code: 1 };
  }

  if (launch.id === 'claude-code') {
    await (deps.ensureCoordinatorSlashCommand || ensureCoordinatorSlashCommand)();
    await (deps.installUpdateCommand || installUpdateCommand)().catch(() => {});
  }

  const config = await (deps.readConfig || readConfig)();
  const apiUrl = (deps.getApiUrl || getApiUrl)(apiArgv) || config.apiUrl;
  const bootstrapIdentity = await (deps.resolveBootstrapIdentity || resolveBootstrapIdentity)({
    env,
    apiUrl,
    getSecret: deps.getSecret,
  });
  if (!bootstrapIdentity) {
    stderr.write('mc: no Memoro token. Run `mc` on a real TTY to start the device flow, or `memoro-cli login` for CI.\n');
    return { code: 1 };
  }
  const token = bootstrapIdentity.token;

  const registryEntry = sessionName ? ((deps.findEntry || findEntry)(sessionName) || {}) : {};
  const effectivePolicy = (deps.resolvePolicyForWrap || resolvePolicyForWrap)({
    sessionName,
    cwd,
    tool: launch.shortName,
    config,
    deps,
  });
  const machineId = (deps.hostname || hostname)();
  let sourceIdentity = resolveSessionSourceIdentity({
    sourceId: cloudBroker.sourceId || cloudBroker.source_id,
    sourceKind: cloudBroker.sourceKind || cloudBroker.source_kind,
    sourceName: cloudBroker.sourceName || cloudBroker.source_name,
    cloudSessionId: cloudBroker.cloudSessionId || cloudBroker.cloud_session_id,
    machineId,
    env,
  });
  const llmSessionId = `mc-${now()}-${process.pid}`;
  const codingSessionId = requestedCodingSessionId || await (deps.lookupOrMint || lookupOrMint)({
    repoIdentity: repoContext.remoteUrl,
    machineId,
    llmSessionId,
  });
  const repoRef = derivePublicRepoRef(repoContext);
  const paths = brokerSessionPaths(codingSessionId);
  let sessionCapabilities = unavailableGitHubSessionCapabilities();
  try {
    const connectionClient = deps.connectionClient || createConnectionClient({
      identityBroker: createBoundIdentityBroker({
        token,
        apiUrl,
        memoroFetch: deps.memoroFetch,
      }),
      memoroFetch: deps.memoroFetch,
    });
    const bootstrap = await (deps.fetchGitHubSessionBootstrap || fetchGitHubSessionBootstrap)({
      connectionClient,
      repository: repoRef,
      memoroFetchImpl: deps.memoroFetch,
    });
    sessionCapabilities = bootstrap.capabilities;
    if (bootstrap.source?.id && bootstrap.source?.kind) {
      sourceIdentity = resolveSessionSourceIdentity({
        sourceId: bootstrap.source.id,
        sourceKind: bootstrap.source.kind,
        cloudSessionId: sourceIdentity.cloud_session_id,
        sourceName: sourceIdentity.source_name,
        machineId,
      });
    }
  } catch {}
  if (sessionCapabilities.github.state === 'ready') {
    const registered = await (deps.registerGitHubSessionProjection || registerGitHubSessionProjection)({
      apiUrl,
      token,
      codingSessionId,
      machineId,
      sourceIdentity,
      source: launch.spec.heartbeatSource,
      repo: deriveRepoName(repoContext),
      repoRef,
      branch: repoContext.branch,
      label: sessionName || label,
      now,
      postHeartbeat: deps.postHeartbeat,
      memoroFetchImpl: deps.memoroFetch,
    });
    if (!registered) {
      sessionCapabilities = unavailableGitHubSessionCapabilities();
      stderr.write('mc: GitHub session registration failed; launching with GitHub unavailable\n');
    }
  }
  let groundingLaunchMessage = null;
  if (sendStartupMessage) {
    try {
      const res = await (deps.groundSession || groundSession)({
        cwd,
        adapter: launch.adapter,
        focus,
        repoContext,
        tool: launch.shortName,
        codingSessionId,
        sessionName,
        sessionCapabilities,
        deps: {
          grounding: config.grounding,
          mcContextDeps: { apiUrl, token },
        },
      });
      groundingLaunchMessage = res.message || null;
      if (!res.ok && res.reason) {
        stderr.write(`mc: grounding skipped (${res.reason}); continuing\n`);
      }
    } catch (err) {
      stderr.write(`mc: grounding failed (${err.message}); continuing without it\n`);
    }
  }

  const devEnvironment = await resolveDevSessionEnvironment({
    worktreePath: repoContext.toplevel,
    globalConfig: config,
    stderr,
    resolvePlan: deps.resolveDevPlan || resolveDevPlan,
  });
  let spawnEnv = {
    ...env,
    MEMORO_MC_PARENT: '1',
    MC_CODING_SESSION_ID: codingSessionId,
    ...((sessionName || label) ? { MC_SESSION_NAME: sessionName || label } : {}),
    ...devEnvironment,
  };
  let codexDeviceAuthBeforeLaunch = false;
  if (launch.id === 'codex' && isCloudBrokerLaunch(cloudBroker)) {
    const prepareAuth = deps.prepareCloudCodexAuth || prepareCloudCodexAuth;
    const auth = await prepareAuth({
      codingSessionId,
      env: spawnEnv,
      deps: deps.cloudCodexAuthDeps || {},
    }).catch((err) => ({ ok: false, error: err.message || String(err) }));
    if (!auth?.ok) {
      const error = auth?.error || 'Codex cloud auth failed';
      stderr.write(`mc: ${error}\n`);
      return { code: 1, error, reason: auth?.reason || 'cloud-codex-auth-failed' };
    }
    if (auth.startupMessageSafe === false) {
      groundingLaunchMessage = null;
    }
    if (auth.interactiveLogin === true) {
      codexDeviceAuthBeforeLaunch = true;
    }
  }
  const sessionHost = await resolveLaunchBroker({
    codingSessionId,
    request,
    ensureBroker,
    cloudBroker,
    stderr,
    deps,
  });
  if (!sessionHost.ok) return { code: 1 };
  const launchRequest = sessionHost.request || request;
  const attachSocketPath = sessionHost.socketPath || null;

  scrubRuntimeSecretsInPlace(spawnEnv);
  try {
    const { prepareLocalResourceGuardEnv } = await import('../local-resource-guard.js');
    spawnEnv = (deps.prepareLocalResourceGuardEnv || prepareLocalResourceGuardEnv)({
      baseEnv: spawnEnv,
      config,
      mcDir: mcHome(),
      codingSessionId,
    }).env;
  } catch (err) {
    stderr.write(`mc: failed to install local resource guard (${err.message}); refusing to launch\n`);
    return { code: 1 };
  }
  if (launch.id === 'codex') {
    try {
      const { prepareCloudflareGuardEnv } = await import('../cloudflare-guard.js');
      const {
        readRepoLocalConfig,
        readRepoPolicyConfig,
        resolveEffectiveConfig,
      } = await import('../config-model.js');
      const repoPolicyConfig = (deps.readRepoPolicyConfig || readRepoPolicyConfig)({ cwd });
      const repoLocalConfig = (deps.readRepoLocalConfig || readRepoLocalConfig)({ cwd });
      const effectiveConfig = (deps.resolveEffectiveConfig || resolveEffectiveConfig)({
        globalConfig: config,
        repoPolicy: repoPolicyConfig.config,
        localConfig: repoLocalConfig.config,
        entry: registryEntry,
        warnings: [
          ...(repoPolicyConfig.warnings || []),
          ...(repoLocalConfig.warnings || []),
        ],
      });
      spawnEnv = (deps.prepareCloudflareGuardEnv || prepareCloudflareGuardEnv)({
        baseEnv: spawnEnv,
        mcDir: mcHome(),
        codingSessionId,
        effectiveConfig,
      }).env;
    } catch (err) {
      stderr.write(`mc: failed to install Codex Cloudflare guard (${err.message}); refusing to launch\n`);
      return { code: 1 };
    }
  }
  try {
    const { prepareDevCommandGuardEnv } = await import('../dev-command-guard.js');
    spawnEnv = (deps.prepareDevCommandGuardEnv || prepareDevCommandGuardEnv)({
      baseEnv: spawnEnv,
      worktreePath: repoContext.toplevel,
      mcDir: mcHome(),
      codingSessionId,
    }).env;
  } catch (err) {
    stderr.write(`mc: failed to install dev command guard (${err.message}); refusing to launch\n`);
    return { code: 1 };
  }
  const interactiveEnv = normalizeInteractivePtyEnv({
    baseEnv: spawnEnv,
    termName: env.TERM,
  });
  spawnEnv = interactiveEnv.env;
  try {
    const githubRuntime = await (deps.prepareGitHubSessionForLaunch || prepareGitHubSessionForLaunch)({
      baseEnv: spawnEnv,
      capabilities: sessionCapabilities,
      sessionId: codingSessionId,
      socketPath: paths.sockPath,
    });
    spawnEnv = githubRuntime.env;
  } catch (err) {
    stderr.write(`mc: failed to install GitHub session boundary (${err.message}); refusing to launch\n`);
    return { code: 1 };
  }

  const launchMessage = {
    type: 'launch_session',
    session: {
      id: codingSessionId,
      name: sessionName || label,
      cwd,
      tool,
      argv,
      launch_options: {
        startupMessage: groundingLaunchMessage,
        effectivePolicy,
        ...(codexDeviceAuthBeforeLaunch ? { codexDeviceAuthBeforeLaunch } : {}),
      },
      cols: stdout.columns || 80,
      rows: stdout.rows || 24,
      term_name: interactiveEnv.termName,
      env: spawnEnv,
      sidecars: {
        codingSessionId,
        label,
        apiUrl,
        token,
        machineId,
        ...sourceIdentity,
        source: launch.spec.heartbeatSource,
        repo: deriveRepoName(repoContext),
        repoRef,
        branch: repoContext.branch,
        worktreeName: sessionName || null,
        tool: launch.shortName,
        toolSessionId: registryEntry.tool_session_id || null,
        sockPath: paths.sockPath,
        metaPath: paths.metaPath,
        transcriptPath: registryEntry.tool_transcript_path || null,
      },
    },
  };
  const launchRes = await launchRequest(launchMessage)
    .catch((err) => ({ ok: false, error: err.message || String(err) }));

  if (!launchRes.ok) {
    stderr.write(`mc: broker launch failed (${launchRes.error || launchRes.reason || 'unknown'})\n`);
    return { code: 1 };
  }
  const effectiveCodingSessionId = launchRes.session?.id || codingSessionId;

  stdout.write(renderIntro({
    version: await (deps.getPackageVersion || getPackageVersion)(),
    codingSessionId: effectiveCodingSessionId,
    repo: deriveRepoName(repoContext),
    branch: repoContext.branch,
    label,
    tool: launch.spec.label,
  }));

  const cloud = await Promise.resolve(ensureCloudBroker(cloudBroker))
    .catch((err) => ({ ok: false, error: err.message || String(err) }));
  if (!cloud?.ok) {
    stderr.write(`mc: broker cloud bridge not started (${cloud?.error || 'unknown'}); continuing with local broker only\n`);
  }

  if (typeof onLaunched === 'function') {
    await onLaunched({
      codingSessionId: effectiveCodingSessionId,
      launch: launchRes,
      brokerSocketPath: attachSocketPath,
      hostKind: sessionHost.hostKind || 'global-broker',
    });
  }

  if (!attachAfterLaunch) {
    return { code: 0, codingSessionId: effectiveCodingSessionId, broker: sessionHost.broker || null, attached: false };
  }

  const attachOptions = {
    id: effectiveCodingSessionId,
    ...(attachSocketPath ? { socketPath: attachSocketPath } : {}),
  };
  let code = await attach(attachOptions);
  if (launch.id === 'codex') {
    code = await retryCodexSqliteStartup({
      code,
      codingSessionId: effectiveCodingSessionId,
      launchMessage: {
        ...launchMessage,
        session: { ...launchMessage.session, id: effectiveCodingSessionId },
      },
      launchRequest,
      attach,
      attachOptions,
      stderr,
      sleepFn: deps.sleep || sleep,
      retryDelaysMs: deps.codexSqliteRetryDelaysMs || CODEX_SQLITE_RETRY_DELAYS_MS,
    });
  }
  return { code, codingSessionId: effectiveCodingSessionId, broker: sessionHost.broker || null, attached: true };
}

export function isRetryableCodexSqliteStartupFailure({ output, session } = {}) {
  if (session?.tool !== 'codex' || !session?.exit || session.exit.code === 0) return false;
  const startedAt = Date.parse(session.started_at || '');
  const exitedAt = Date.parse(session.exit.at || '');
  const elapsedMs = exitedAt - startedAt;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > CODEX_SQLITE_STARTUP_WINDOW_MS) {
    return false;
  }

  const text = String(output || '');
  const isSqliteLock = /database is locked/i.test(text);
  const isCodexStateInitialization = /(?:failed to initialize sqlite local db|failed to open log DB at .*logs_\d+\.sqlite)/i.test(text);
  return isSqliteLock && isCodexStateInitialization;
}

async function retryCodexSqliteStartup({
  code,
  codingSessionId,
  launchMessage,
  launchRequest,
  attach,
  attachOptions,
  stderr,
  sleepFn,
  retryDelaysMs,
}) {
  let currentCode = code;
  for (let index = 0; index < retryDelaysMs.length; index += 1) {
    const snapshot = await launchRequest({
      type: 'fetch_session_output',
      id: codingSessionId,
    }).catch(() => null);
    if (!snapshot?.ok || !isRetryableCodexSqliteStartupFailure({
      output: snapshot.output,
      session: snapshot.session,
    })) {
      break;
    }

    const removed = await launchRequest({
      type: 'remove_session',
      id: codingSessionId,
    }).catch((err) => ({ ok: false, error: err.message || String(err) }));
    if (!removed?.ok) {
      stderr.write(`mc: Codex SQLite startup retry could not remove the failed broker session (${removed?.error || 'unknown'}).\n`);
      break;
    }

    const delayMs = retryDelaysMs[index];
    stderr.write(`mc: Codex state database was briefly locked; retrying startup in ${formatRetryDelay(delayMs)} (${index + 1}/${retryDelaysMs.length}).\n`);
    await sleepFn(delayMs);

    const relaunched = await launchRequest(launchMessage)
      .catch((err) => ({ ok: false, error: err.message || String(err) }));
    if (!relaunched?.ok) {
      stderr.write(`mc: Codex SQLite startup retry failed to relaunch (${relaunched?.error || relaunched?.reason || 'unknown'}).\n`);
      return 1;
    }
    currentCode = await attach(attachOptions);
  }
  return currentCode;
}

function formatRetryDelay(delayMs) {
  return Number.isInteger(delayMs / 1_000) ? `${delayMs / 1_000}s` : `${delayMs}ms`;
}

export function brokerSessionPaths(codingSessionId) {
  return {
    sockPath: join(mcHome(), `${codingSessionId}.sock`),
    metaPath: join(mcHome(), `${codingSessionId}.json`),
  };
}

export async function registerGitHubSessionProjection({
  apiUrl,
  token,
  codingSessionId,
  machineId,
  sourceIdentity,
  source,
  repo,
  repoRef,
  branch,
  label = null,
  now = () => Date.now(),
  postHeartbeat = postHeartbeatWithRetry,
  memoroFetchImpl,
} = {}) {
  const timestamp = now();
  const sessionProjection = projectRuntimeSession({
    session: {
      started_at: new Date(timestamp).toISOString(),
      session_state: 'starting',
      attachable: false,
    },
    output: '',
    now: timestamp,
    git: null,
  });
  try {
    return await postHeartbeat({
      apiUrl,
      token,
      payload: buildSessionHeartbeatPayload({
        codingSessionId,
        machineId,
        sourceIdentity,
        source,
        repo: repoRef || repo,
        branch,
        idleSeconds: 0,
        at: new Date(timestamp).toISOString(),
        sessionProjection,
        label,
      }),
      maxAttempts: 1,
      memoroFetchImpl,
    });
  } catch {
    return false;
  }
}

function isCloudBrokerLaunch(cloudBroker) {
  return cloudBroker?.sourceKind === 'cloud'
    || typeof cloudBroker?.cloudSessionId === 'string'
    || typeof cloudBroker?.sourceId === 'string';
}

async function resolveLaunchBroker({
  codingSessionId,
  request,
  ensureBroker,
  cloudBroker,
  stderr,
  deps = {},
} = {}) {
  const useSessionHost = deps.useSessionHost === true
    || (deps.useSessionHost !== false && ensureBroker === ensureBrokerRunning);
  if (useSessionHost) {
    const ensureSessionHost = deps.ensureSessionHost || ensureSessionHostRunning;
    const host = await ensureSessionHost({
      sessionId: codingSessionId,
      request,
      spawnDaemon: deps.spawnBrokerDaemon,
    });
    if (!host.ok) {
      stderr.write(`mc: session host start failed (${host.error || 'unknown'})\n`);
      return { ok: false };
    }
    return {
      ok: true,
      hostKind: 'session',
      socketPath: host.socketPath,
      broker: host.broker || null,
      request: (message) => request(message, { socketPath: host.socketPath }),
    };
  }

  const broker = await ensureBroker({
    request,
    stderr,
    deps,
    ...(isCloudBrokerLaunch(cloudBroker) ? { timeoutMs: CLOUD_BROKER_START_TIMEOUT_MS } : {}),
  });
  if (!broker.ok) {
    stderr.write(`mc: broker start failed (${broker.error || 'unknown'})\n`);
    return { ok: false };
  }
  return {
    ok: true,
    hostKind: 'global-broker',
    broker: broker.broker || null,
    request,
  };
}

export { ensureBrokerRunning } from './supervisor.js';

export const __test__ = {
  isCloudBrokerLaunch,
  resolveLaunchBroker,
  retryCodexSqliteStartup,
};
