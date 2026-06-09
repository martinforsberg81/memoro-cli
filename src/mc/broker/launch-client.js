import { join } from 'node:path';
import { hostname } from 'node:os';

import { resolveLaunch } from '../../adapters/index.js';
import { installUpdateCommand } from '../../adapters/claude-code.js';
import { getSecret } from '../../lib/keychain.js';
import { ACCOUNTS } from '../../commands/auth.js';
import { readConfig, getApiUrl } from '../../lib/config.js';
import { getRepoContext, deriveRepoName } from '../../lib/git-context.js';
import { lookupOrMint } from '../../lib/coding-session.js';
import { getPackageVersion } from '../../lib/version.js';
import { ensureCoordinatorSlashCommand } from '../coordinator-command.js';
import { groundSession } from '../ground.js';
import { mcHome } from '../paths.js';
import { findEntry } from '../registry.js';
import { resolvePolicyForWrap } from '../wrap-start.js';
import { requestBroker } from './client.js';
import { attachBrokerSession } from './attach-client.js';
import { renderIntro } from '../session-intro.js';
import { ensureBrokerRunning } from './supervisor.js';

export async function launchBrokerOwnedSession({
  cwd,
  label = null,
  focus = null,
  tool = 'claude-code',
  sessionName = null,
  argv = [],
  apiArgv = [],
  request = requestBroker,
  attach = attachBrokerSession,
  ensureBroker = ensureBrokerRunning,
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
  const token = await (deps.getSecret || getSecret)(ACCOUNTS.TOKEN);
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
  let groundingLaunchMessage = null;
  try {
    const res = await (deps.groundSession || groundSession)({
      cwd,
      adapter: launch.adapter,
      focus,
    });
    groundingLaunchMessage = res.message || null;
    if (!res.ok && res.reason) {
      stderr.write(`mc: grounding skipped (${res.reason}); continuing\n`);
    }
  } catch (err) {
    stderr.write(`mc: grounding failed (${err.message}); continuing without it\n`);
  }

  const machineId = (deps.hostname || hostname)();
  const llmSessionId = `mc-${now()}-${process.pid}`;
  const codingSessionId = await (deps.lookupOrMint || lookupOrMint)({
    repoIdentity: repoContext.remoteUrl,
    machineId,
    llmSessionId,
  });
  const paths = brokerSessionPaths(codingSessionId);

  stdout.write(renderIntro({
    version: await (deps.getPackageVersion || getPackageVersion)(),
    codingSessionId,
    repo: deriveRepoName(repoContext),
    branch: repoContext.branch,
    label,
    tool: launch.spec.label,
  }));

  const broker = await ensureBroker({ request, stderr, deps });
  if (!broker.ok) {
    stderr.write(`mc: broker start failed (${broker.error || 'unknown'})\n`);
    return { code: 1 };
  }

  let spawnEnv = {
    ...env,
    MEMORO_MC_PARENT: '1',
  };
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

  const launchRes = await request({
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
      },
      cols: stdout.columns || 80,
      rows: stdout.rows || 24,
      term_name: env.TERM || 'xterm-256color',
      env: spawnEnv,
      sidecars: {
        codingSessionId,
        label,
        apiUrl,
        token,
        machineId,
        source: launch.spec.heartbeatSource,
        repo: deriveRepoName(repoContext),
        branch: repoContext.branch,
        worktreeName: sessionName || null,
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

  if (typeof onLaunched === 'function') {
    await onLaunched({ codingSessionId, launch: launchRes });
  }

  const code = await attach({ id: codingSessionId });
  return { code, codingSessionId, broker: broker.broker || null };
}

export function brokerSessionPaths(codingSessionId) {
  return {
    sockPath: join(mcHome(), `${codingSessionId}.sock`),
    metaPath: join(mcHome(), `${codingSessionId}.json`),
  };
}

export { ensureBrokerRunning } from './supervisor.js';
