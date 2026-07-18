import { join } from 'node:path';
import { hostname } from 'node:os';

import { resolveLaunch } from '../../adapters/index.js';
import { installUpdateCommand } from '../../adapters/claude-code.js';
import { getSecret } from '../../lib/keychain.js';
import { ACCOUNTS } from '../../commands/auth.js';
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
import { prepareCloudCodexAuth } from '../cloud-codex-auth.js';

const CLOUD_BROKER_START_TIMEOUT_MS = 10_000;

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
  now = () => Date.now(),
  onLaunched = null,
  deps = {},
} = {}) {
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
  const token = await resolveLaunchAuthToken({ env, getSecretFn: deps.getSecret || getSecret });
  if (!token) {
    stderr.write('mc: no Memoro token. Run `mc` on a real TTY to start the device flow, or `memoro-cli login` for CI.\n');
    return { code: 1 };
  }

  const registryEntry = sessionName ? ((deps.findEntry || findEntry)(sessionName) || {}) : {};
  const effectivePolicy = (deps.resolvePolicyForWrap || resolvePolicyForWrap)({
    sessionName,
    cwd,
    tool: launch.shortName,
    config,
    deps,
  });
  const machineId = (deps.hostname || hostname)();
  const llmSessionId = `mc-${now()}-${process.pid}`;
  const codingSessionId = requestedCodingSessionId || await (deps.lookupOrMint || lookupOrMint)({
    repoIdentity: repoContext.remoteUrl,
    machineId,
    llmSessionId,
  });
  const repoRef = derivePublicRepoRef(repoContext);
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

  let spawnEnv = {
    ...env,
    MEMORO_MC_PARENT: '1',
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
  const paths = brokerSessionPaths(codingSessionId);
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
  const interactiveEnv = normalizeInteractivePtyEnv({
    baseEnv: spawnEnv,
    termName: env.TERM,
  });
  spawnEnv = interactiveEnv.env;

  const launchRes = await launchRequest({
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
        source: launch.spec.heartbeatSource,
        repo: deriveRepoName(repoContext),
        repoRef,
        branch: repoContext.branch,
        worktreeName: sessionName || null,
        tool: launch.shortName,
        sockPath: paths.sockPath,
        metaPath: paths.metaPath,
        transcriptPath: null,
      },
    },
  }).catch((err) => ({ ok: false, error: err.message || String(err) }));

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

  const code = await attach({
    id: effectiveCodingSessionId,
    ...(attachSocketPath ? { socketPath: attachSocketPath } : {}),
  });
  return { code, codingSessionId: effectiveCodingSessionId, broker: sessionHost.broker || null, attached: true };
}

export function brokerSessionPaths(codingSessionId) {
  return {
    sockPath: join(mcHome(), `${codingSessionId}.sock`),
    metaPath: join(mcHome(), `${codingSessionId}.json`),
  };
}

async function resolveLaunchAuthToken({ env = process.env, getSecretFn = getSecret } = {}) {
  const envToken = typeof env?.MEMORO_TOKEN === 'string' ? env.MEMORO_TOKEN.trim() : '';
  if (envToken) return envToken;
  return getSecretFn(ACCOUNTS.TOKEN);
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
  resolveLaunchAuthToken,
  isCloudBrokerLaunch,
  resolveLaunchBroker,
};
