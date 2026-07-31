import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { resolveLaunch } from '../../adapters/index.js';
import { installHooks, installUpdateCommand } from '../../adapters/claude-code.js';
import { installHooks as installCodexHooks } from '../../adapters/codex.js';
import { DEFAULT_TOOL, readConfig, getApiUrl } from '../../lib/config.js';
import { getRepoContext, deriveRepoName, resolvePublicRepoRef } from '../../lib/git-context.js';
import { lookupOrMint } from '../../lib/coding-session.js';
import { getPackageVersion } from '../../lib/version.js';
import { ensureCoordinatorSlashCommand } from '../coordinator-command.js';
import { groundSession } from '../ground.js';
import { normalizeInteractivePtyEnv } from '../interactive-env.js';
import { mcHome } from '../paths.js';
import { findEntry } from '../registry.js';
import { resolveRepositoryIdentity } from '../repository-identity.js';
import { resolvePolicyForWrap } from '../wrap-start.js';
import { requestBroker } from './client.js';
import { attachBrokerSession } from './attach-client.js';
import { renderIntro } from '../session-intro.js';
import { ensureBrokerRunning } from './supervisor.js';
import { ensureCloudBrokerConnected } from './cloud-supervisor.js';
import { scrubRuntimeSecretsInPlace } from '../runtime-secrets.js';
import { ensureSessionHostRunning } from './session-hosts.js';
import { providerArtifactPath } from './paths.js';
import { readProviderArtifactSync } from './provider-artifact-journal.js';
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
import {
  abortManagedCredentialDomain,
  managedProviderAdapterForTool,
  prepareManagedCredentialDomain,
} from '../managed-provider-registry.js';
import { deriveHandoffControllerRoot } from '../handoff-controller-capability.js';
import {
  appendManagedGenerationReceiptSync,
  beginManagedGenerationSync,
  claimManagedSessionIdentitySync,
  inspectManagedGenerationSync,
  managedTransactionFromIntent,
} from '../managed-generation-journal.js';

const CLOUD_BROKER_START_TIMEOUT_MS = 10_000;
const CODEX_SQLITE_STARTUP_WINDOW_MS = 20_000;
const LOCAL_BROKER_LAUNCH_TIMEOUT_MS = 10_000;
const BROKER_MUTATION_TIMEOUT_MS = 20_000;
const BROKER_RECONCILE_PROBE_TIMEOUT_MS = 2_000;
export const AMBIGUOUS_BROKER_RECONCILE_DELAYS_MS = Object.freeze([
  0,
  250,
  750,
  1_500,
  3_000,
]);
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
  handoffUserMessage = null,
  handoffTransaction = null,
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
  onAllocated = null,
  onLaunched = null,
  onExited = null,
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
  const managedPortable = localAuthMode === LOCAL_AUTH_MODES.MANAGED_PORTABLE;
  const hasHandoffMessage = typeof handoffUserMessage === 'string'
    && handoffUserMessage.length > 0;
  const hasHandoffTransaction = typeof handoffTransaction?.transaction_id === 'string'
    && handoffTransaction.transaction_id.length > 0
    && /^[a-f0-9]{64}$/.test(handoffTransaction.controller_capability || '')
    && (
      managedPortable
        ? handoffTransaction.target_custody === 'managed'
        : ['native', undefined].includes(handoffTransaction.target_custody)
    );
  if (hasHandoffMessage !== hasHandoffTransaction) {
    const reason = 'handoff-launch-pair-invalid';
    stderr.write('mc: provider handoff launch requires one bound message and transaction\n');
    return { code: 1, reason, error: reason };
  }

  const launch = resolveLaunch(tool);
  if (!launch.ok) {
    stderr.write(`mc: cannot launch "${tool}": ${launch.hint}\n`);
    return { code: 1 };
  }
  const managedProviderAdapter = managedPortable
    ? (deps.managedProviderAdapterForTool || managedProviderAdapterForTool)(launch.id)
    : null;
  if (managedPortable && !managedProviderAdapter) {
    const reason = 'managed-provider-tool-unsupported';
    stderr.write(`mc: no managed provider adapter is installed for ${launch.id}\n`);
    return { code: 1, reason, error: reason };
  }

  const repoContext = await (deps.getRepoContext || getRepoContext)(cwd);
  if (!repoContext) {
    stderr.write('mc: not inside a git repository. Coordinator is gated on repos.\n');
    return { code: 1 };
  }

  if (!managedPortable && launch.id === 'claude-code') {
    await (deps.ensureCoordinatorSlashCommand || ensureCoordinatorSlashCommand)();
    await (deps.installUpdateCommand || installUpdateCommand)().catch(() => {});
    try {
      await (deps.installClaudeArtifactHooks || installHooks)();
    } catch (error) {
      stderr.write(`mc: failed to install Claude provider artifact hook (${error.message}); refusing to launch\n`);
      return { code: 1, reason: 'claude-provider-artifact-hook-unavailable' };
    }
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

  const registryEntry = sessionName
    ? (deps.findEntry
      ? (deps.findEntry(sessionName) || {})
      : (findEntry(sessionName, { cwd }) || {}))
    : {};
  const repositoryIdentity = (deps.resolveRepositoryIdentity || resolveRepositoryIdentity)(cwd, {
    createLocal: true,
  });
  if (!repositoryIdentity.ok) {
    stderr.write(`mc: repository identity is unavailable (${repositoryIdentity.reason}); refusing to launch\n`);
    return { code: 1 };
  }
  if (registryEntry.repository_id
    && registryEntry.repository_id !== repositoryIdentity.id) {
    stderr.write('mc: registry repository identity does not match the launch repository; refusing to launch\n');
    return { code: 1 };
  }
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
    repoIdentity: registryEntry.repository_id || repositoryIdentity.id,
    machineId,
    llmSessionId,
  });
  const sessionControllerCapability = deriveHandoffControllerRoot({
    token,
    codingSessionId,
  });
  if (!sessionControllerCapability) {
    stderr.write('mc: session controller authority is unavailable\n');
    return {
      code: 1,
      reason: 'session-controller-capability-unavailable',
      error: 'session controller authority is unavailable',
    };
  }
  const runtimeGeneration = (deps.randomUUID || randomUUID)();
  let managedIntent = null;
  let managedTransaction = null;
  if (managedPortable) {
    if (sessionName) {
      let identity;
      try {
        identity = (deps.claimManagedSessionIdentity || claimManagedSessionIdentitySync)({
          sessionName,
          registrySessionId: registryEntry.session_id || null,
          codingSessionId,
          recordedAt: new Date(now()).toISOString(),
        });
      } catch {
        identity = { ok: false, reason: 'managed-session-identity-unavailable' };
      }
      if (!identity?.ok) {
        const reason = identity?.reason || 'managed-session-identity-conflict';
        stderr.write(`mc: managed session identity could not be claimed (${reason})\n`);
        return { code: 1, reason, error: reason };
      }
    }
    if (typeof onAllocated === 'function') {
      let allocated = null;
      try {
        allocated = await onAllocated({ codingSessionId, runtimeGeneration });
      } catch {
        allocated = { ok: false, reason: 'session-identity-commit-failed' };
      }
      if (allocated?.ok === false) {
        const reason = allocated.reason || allocated.code || 'session-identity-commit-failed';
        stderr.write(`mc: managed session identity could not be committed (${reason})\n`);
        return { code: 1, reason, error: reason };
      }
    }
  }
  const repoRef = await (deps.resolvePublicRepoRef || resolvePublicRepoRef)(repoContext);
  const paths = brokerSessionPaths(codingSessionId);
  let sessionCapabilities = unavailableGitHubSessionCapabilities();
  let startingPresenceRegistered = false;
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
  const githubReady = sessionCapabilities.github.state === 'ready';
  let groundingLaunchMessage = null;
  // A provider switch is grounded exclusively by the strict, scanner-approved
  // handoff projection. Normal grounding may contain transitional raw session
  // continuity, so it must never be fetched, rendered, or concatenated here.
  if (sendStartupMessage && !handoffUserMessage) {
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
  const brokerUserMessage = handoffUserMessage || null;
  if (brokerUserMessage) {
    // A switch handoff is one ordinary user turn for every provider. Claude
    // must not receive any part of it through --append-system-prompt.
    groundingLaunchMessage = null;
  }

  const devEnvironment = managedPortable
    ? {}
    : await resolveDevSessionEnvironment({
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
  if (!managedPortable && launch.id === 'codex' && isCloudBrokerLaunch(cloudBroker)) {
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
  if (launch.id === 'codex' && !managedPortable) {
    try {
      await (deps.installCodexArtifactHooks || installCodexHooks)({
        ...(spawnEnv.CODEX_HOME ? { codexHome: spawnEnv.CODEX_HOME } : {}),
      });
    } catch (error) {
      stderr.write(`mc: failed to install Codex provider artifact hook (${error.message}); refusing to launch\n`);
      return { code: 1, reason: 'codex-provider-artifact-hook-unavailable' };
    }
  }
  const sessionHost = await resolveLaunchBroker({
    codingSessionId,
    sessionControllerCapability,
    request,
    ensureBroker,
    cloudBroker,
    stderr,
    deps,
  });
  if (!sessionHost.ok) return { code: 1 };
  const launchRequest = sessionHost.request || request;
  const controllerRequest = bindSessionControllerCapability(
    launchRequest,
    sessionControllerCapability,
  );
  const attachSocketPath = sessionHost.socketPath || null;

  scrubRuntimeSecretsInPlace(spawnEnv);
  if (!managedPortable) {
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
  }
  const interactiveEnv = normalizeInteractivePtyEnv({
    baseEnv: spawnEnv,
    termName: env.TERM,
  });
  spawnEnv = interactiveEnv.env;
  let credentialDomain = null;
  if (managedPortable) {
    try {
      const started = (deps.beginManagedGeneration || beginManagedGenerationSync)({
        codingSessionId,
        runtimeGeneration,
        mode: argv[0] === 'resume' ? 'resume' : 'fresh',
        tool: launch.id,
        resumeProviderSessionId: argv[0] === 'resume'
          ? registryEntry.tool_session_id || null
          : null,
        recordedAt: new Date(now()).toISOString(),
      });
      managedIntent = started.intent;
      managedTransaction = managedTransactionFromIntent(managedIntent);
    } catch (error) {
      const reason = 'managed-generation-intent-unavailable';
      stderr.write(`mc: managed session transaction could not claim its generation (${error?.message || reason})\n`);
      return { code: 1, reason, error: reason };
    }
    const prepareDomain = deps.prepareManagedCredentialDomain
      || prepareManagedCredentialDomain;
    credentialDomain = await prepareDomain({
      codingSessionId,
      domainGeneration: runtimeGeneration,
      providerSessionId: argv[0] === 'resume'
        ? registryEntry.tool_session_id || null
        : null,
      cwd: repoContext.toplevel,
      tool: launch.id,
      githubCapability: githubReady,
      portal: {
        apiUrl,
        token,
        ...(deps.memoroFetch ? { memoroFetch: deps.memoroFetch } : {}),
      },
      env,
      deps: deps.localCredentialDomainDeps || {},
    }).catch(() => null);
    if (!credentialDomain?.ok) {
      const reason = credentialDomain?.reason || 'managed-portable-boundary-unavailable';
      const diagnostic = credentialDomain?.diagnostic_code || reason;
      try {
        (deps.appendManagedGenerationReceipt || appendManagedGenerationReceiptSync)({
          phase: 'aborted',
          codingSessionId,
          runtimeGeneration,
          intentDigest: managedIntent.intent_digest,
          recordedAt: new Date(now()).toISOString(),
          data: { reason: 'launch-failed-before-provider' },
        });
      } catch {}
      stderr.write(`mc: managed provider credential boundary is unavailable (${diagnostic})\n`);
      return { code: 1, reason, error: reason };
    }
    try {
      (deps.appendManagedGenerationReceipt || appendManagedGenerationReceiptSync)({
        phase: 'domain-ready',
        codingSessionId,
        runtimeGeneration,
        intentDigest: managedIntent.intent_digest,
        recordedAt: new Date(now()).toISOString(),
        data: {
          domain_generation: credentialDomain.descriptor.generation,
          manifest_digest: credentialDomain.descriptor.manifest_sha256,
        },
      });
    } catch (error) {
      const cleanup = (deps.abortManagedCredentialDomain || abortManagedCredentialDomain)({
        descriptor: credentialDomain.descriptor,
      });
      if (cleanup?.ok) {
        try {
          (deps.appendManagedGenerationReceipt || appendManagedGenerationReceiptSync)({
            phase: 'aborted',
            codingSessionId,
            runtimeGeneration,
            intentDigest: managedIntent.intent_digest,
            recordedAt: new Date(now()).toISOString(),
            data: { reason: 'launch-failed-before-provider' },
          });
        } catch {}
      }
      const reason = 'managed-generation-domain-receipt-unavailable';
      stderr.write(`mc: managed session transaction could not bind its credential domain (${error?.message || reason})\n`);
      return { code: 1, reason, error: reason };
    }
    spawnEnv = credentialDomain.env;
  }
  try {
    const githubRuntime = await (deps.prepareGitHubSessionForLaunch || prepareGitHubSessionForLaunch)({
      baseEnv: spawnEnv,
      capabilities: sessionCapabilities,
      sessionId: codingSessionId,
      socketPath: githubReady ? paths.sockPath : null,
      ...(managedPortable
        ? { shimDirectory: join(credentialDomain.descriptor.executor_root, 'bin') }
        : {}),
    });
    spawnEnv = githubRuntime.env;
  } catch (err) {
    if (managedPortable && credentialDomain?.descriptor) {
      abortUnacceptedManagedLaunch({
        codingSessionId,
        runtimeGeneration,
        managedIntent,
        descriptor: credentialDomain.descriptor,
        now,
        deps,
      });
    }
    stderr.write(`mc: failed to install GitHub session boundary (${err.message}); refusing to launch\n`);
    return { code: 1 };
  }

  const launchMessage = {
    type: 'launch_session',
    session: {
      id: codingSessionId,
      session_controller_capability: sessionControllerCapability,
      runtime_generation: runtimeGeneration,
      name: sessionName || label,
      cwd,
      tool,
      argv,
      launch_options: {
        startupMessage: groundingLaunchMessage,
        ...(brokerUserMessage ? { handoffUserMessage: brokerUserMessage } : {}),
        effectivePolicy: managedPortable ? null : effectivePolicy,
        ...(codexDeviceAuthBeforeLaunch ? { codexDeviceAuthBeforeLaunch } : {}),
      },
      cols: stdout.columns || 80,
      rows: stdout.rows || 24,
      term_name: interactiveEnv.termName,
      env: spawnEnv,
      sidecars: managedPortable
        ? {
            enabled: true,
            codingSessionId,
            runtimeGeneration,
            label: sessionName || label,
            machineId,
            ...sourceIdentity,
            source: launch.spec.heartbeatSource,
            repo: deriveRepoName(repoContext),
            repoRef,
            branch: repoContext.branch,
            tool: launch.shortName,
            sockPath: paths.sockPath,
            metaPath: paths.metaPath,
            presenceIdentity: 'broker-local',
            heartbeat: true,
            upload: false,
            transcriptAccess: false,
            githubCapabilities: sessionCapabilities,
          }
        : {
            codingSessionId,
            runtimeGeneration,
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
            // During a provider switch the persisted registry still names the
            // source provider until the broker-acknowledged target delivery is
            // committed. Never let target sidecars inherit source-native
            // transcript authority from that stale projection.
            toolSessionId: handoffTransaction
              ? null
              : registryEntry.tool_session_id || null,
            sockPath: paths.sockPath,
            metaPath: paths.metaPath,
            transcriptPath: handoffTransaction
              ? null
              : registryEntry.tool_transcript_path || null,
            ...(handoffTransaction
              ? {
                  transcriptAccess: false,
                  upload: false,
                }
              : {}),
          },
      ...(credentialDomain?.descriptor
        ? { credential_domain: credentialDomain.descriptor }
        : {}),
      ...(managedTransaction
        ? { managed_transaction: managedTransaction }
        : {}),
      ...(handoffTransaction?.transaction_id
        ? {
            handoff_transaction: {
              transaction_id: handoffTransaction.transaction_id,
              controller_capability: handoffTransaction.controller_capability,
              ...(handoffTransaction.target_custody
                ? { target_custody: handoffTransaction.target_custody }
                : {}),
            },
          }
        : {}),
    },
  };
  // Register immediately before the broker request. Earlier local setup has
  // legitimate failure paths; publishing presence only here gives the request
  // and its compensating terminal event one narrow ownership boundary.
  const registered = await (
    deps.registerSessionProjection
    || deps.registerGitHubSessionProjection
    || registerSessionProjection
  )({
    apiUrl,
    token,
    codingSessionId,
    runtimeGeneration,
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
    // The broker owns the recurring presence loop and will retry with its own
    // trusted local identity. The provider boundary is already prepared and
    // must not be mutated based on this advisory pre-launch attempt.
    stderr.write('mc: session starting presence registration failed; broker will retry\n');
  } else {
    startingPresenceRegistered = true;
  }
  let launchRes = null;
  let launchWasAmbiguous = false;
  try {
    launchRes = await controllerRequest(
      launchMessage,
      {
        timeoutMs: (brokerUserMessage || managedPortable)
          ? 60_000
          : LOCAL_BROKER_LAUNCH_TIMEOUT_MS,
      },
    );
    launchWasAmbiguous = launchRes?.ok !== false
      && !isExactLaunchedSession(launchRes?.session, { codingSessionId, runtimeGeneration });
  } catch {
    launchWasAmbiguous = true;
  }

  if (launchWasAmbiguous) {
    const reconciliation = await reconcileAmbiguousBrokerLaunch({
      launchRequest: controllerRequest,
      codingSessionId,
      runtimeGeneration,
      sleepFn: deps.sleep || sleep,
      retryDelaysMs: deps.ambiguousBrokerReconcileDelaysMs
        || AMBIGUOUS_BROKER_RECONCILE_DELAYS_MS,
    });
    if (reconciliation.state === 'live') {
      launchRes = { ok: true, session: reconciliation.session, recovered: true };
    } else if (reconciliation.state === 'dead') {
      const removal = await removeExactBrokerSession({
        launchRequest: controllerRequest,
        codingSessionId,
        runtimeGeneration,
        sleepFn: deps.sleep || sleep,
        retryDelaysMs: deps.ambiguousBrokerReconcileDelaysMs
          || AMBIGUOUS_BROKER_RECONCILE_DELAYS_MS,
      });
      if (removal.state === 'removed') {
        launchRes = { ok: false, reason: 'broker-session-exited' };
      } else {
        return reportUnknownBrokerLaunch({ stderr, codingSessionId });
      }
    } else {
      return reportUnknownBrokerLaunch({ stderr, codingSessionId });
    }
  }

  if (launchRes?.ok !== true) {
    const failureReason = brokerLaunchFailureReason(launchRes);
    if (startingPresenceRegistered) {
      await terminalizeStartingPresence({
        apiUrl,
        token,
        codingSessionId,
        runtimeGeneration,
        machineId,
        sourceIdentity,
        source: launch.spec.heartbeatSource,
        repo: repoRef || deriveRepoName(repoContext),
        branch: repoContext.branch,
        label: sessionName || label,
        now,
        postHeartbeat: deps.postHeartbeat,
        memoroFetchImpl: deps.memoroFetch,
      });
    }
    if (credentialDomain?.descriptor) {
      if (managedTransaction) {
        abortUnacceptedManagedLaunch({
          codingSessionId,
          runtimeGeneration,
          managedIntent,
          descriptor: credentialDomain.descriptor,
          failureReason,
          now,
          deps,
        });
      } else {
        (deps.abortManagedCredentialDomain || abortManagedCredentialDomain)({
          descriptor: credentialDomain.descriptor,
        });
      }
    }
    stderr.write(`mc: broker launch failed (${failureReason})\n`);
    return { code: 1, reason: failureReason, error: failureReason };
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
    let callbackResult = null;
    try {
      callbackResult = await onLaunched({
        codingSessionId: effectiveCodingSessionId,
        runtimeGeneration: launchRes.session?.runtime_generation || runtimeGeneration,
        launch: launchRes,
        brokerSocketPath: attachSocketPath,
        hostKind: sessionHost.hostKind || 'global-broker',
        sessionControllerCapability,
      });
    } catch {
      callbackResult = { ok: false, code: 'post-launch-commit-failed' };
    }
    if (callbackResult?.ok === false) {
      const removed = await controllerRequest({
        type: 'remove_session',
        id: effectiveCodingSessionId,
      }, { timeoutMs: 20_000 }).catch(() => null);
      stderr.write(`mc: broker launch rolled back because the local handoff commit failed (${callbackResult.code || callbackResult.reason || 'unknown'}).\n`);
      return {
        code: 1,
        reason: removed?.ok
          ? callbackResult.code || callbackResult.reason || 'post-launch-commit-failed'
          : 'post-launch-rollback-unconfirmed',
      };
    }
  }

  if (!attachAfterLaunch) {
    return { code: 0, codingSessionId: effectiveCodingSessionId, broker: sessionHost.broker || null, attached: false };
  }

  const attachOptions = {
    id: effectiveCodingSessionId,
    controllerCapability: sessionControllerCapability,
    ...(attachSocketPath ? { socketPath: attachSocketPath } : {}),
  };
  let code = await attach(attachOptions);
  if (launch.id === 'codex' && !managedPortable) {
    code = await retryCodexSqliteStartup({
      code,
      codingSessionId: effectiveCodingSessionId,
      launchMessage: {
        ...launchMessage,
        session: { ...launchMessage.session, id: effectiveCodingSessionId },
      },
      launchRequest: controllerRequest,
      attach,
      attachOptions,
      stderr,
      sleepFn: deps.sleep || sleep,
      retryDelaysMs: deps.codexSqliteRetryDelaysMs || CODEX_SQLITE_RETRY_DELAYS_MS,
      reconcileDelaysMs: deps.ambiguousBrokerReconcileDelaysMs
        || AMBIGUOUS_BROKER_RECONCILE_DELAYS_MS,
      runtimeGenerationFactory: deps.randomUUID || randomUUID,
    });
  }
  if (typeof onExited === 'function') {
    const ended = await controllerRequest({ type: 'session_status', id: effectiveCodingSessionId })
      .catch(() => null);
    const status = ended?.ok === true ? ended.session : null;
    const endedGeneration = status?.runtime_generation || runtimeGeneration;
    const artifactResult = (deps.readProviderArtifact || readProviderArtifactSync)({
      path: providerArtifactPath(effectiveCodingSessionId, endedGeneration),
      codingSessionId: effectiveCodingSessionId,
      runtimeGeneration: endedGeneration,
      trustedRoot: mcHome(),
    });
    await onExited({
      codingSessionId: effectiveCodingSessionId,
      runtimeGeneration: endedGeneration,
      providerArtifact: artifactResult?.kind === 'present' ? artifactResult.artifact : null,
      session: status,
    });
  }
  return { code, codingSessionId: effectiveCodingSessionId, broker: sessionHost.broker || null, attached: true };
}

async function reconcileAmbiguousBrokerLaunch({
  launchRequest,
  codingSessionId,
  runtimeGeneration,
  sleepFn = sleep,
  retryDelaysMs = AMBIGUOUS_BROKER_RECONCILE_DELAYS_MS,
} = {}) {
  for (const delayMs of normalizeReconcileDelays(retryDelaysMs)) {
    if (delayMs > 0) await sleepFn(delayMs);
    let status;
    try {
      status = await launchRequest(
        { type: 'session_status', id: codingSessionId },
        { timeoutMs: BROKER_RECONCILE_PROBE_TIMEOUT_MS },
      );
    } catch {
      continue;
    }
    if (status?.ok === false && status.reason === 'session-not-found') {
      // An accepted launch can still be queued behind broker-local work. An
      // empty read is therefore not proof that the timed-out mutation failed.
      continue;
    }
    if (status?.ok !== true || !status.session) continue;
    const session = status.session;
    if (session.id !== codingSessionId || session.runtime_generation !== runtimeGeneration) {
      return { state: 'conflict', session };
    }
    if (session.exit || session.session_state === 'dead' || session.attachable === false) {
      return { state: 'dead', session };
    }
    return { state: 'live', session };
  }
  return { state: 'unknown' };
}

async function removeExactBrokerSession({
  launchRequest,
  codingSessionId,
  runtimeGeneration,
  sleepFn = sleep,
  retryDelaysMs = AMBIGUOUS_BROKER_RECONCILE_DELAYS_MS,
} = {}) {
  let removal;
  try {
    removal = await launchRequest({
      type: 'remove_session',
      id: codingSessionId,
      expected_runtime_generation: runtimeGeneration,
    }, { timeoutMs: BROKER_MUTATION_TIMEOUT_MS });
  } catch {
    removal = null;
  }
  if (removal?.ok === true) return { state: 'removed', response: removal };
  if (removal?.reason === 'runtime-generation-mismatch') {
    return { state: 'conflict', response: removal };
  }

  for (const delayMs of normalizeReconcileDelays(retryDelaysMs)) {
    if (delayMs > 0) await sleepFn(delayMs);
    let status;
    try {
      status = await launchRequest(
        { type: 'session_status', id: codingSessionId },
        { timeoutMs: BROKER_RECONCILE_PROBE_TIMEOUT_MS },
      );
    } catch {
      continue;
    }
    if (status?.ok === false && status.reason === 'session-not-found') {
      return { state: 'removed', recovered: true };
    }
    if (status?.ok !== true || !status.session) continue;
    if (status.session.id !== codingSessionId
      || status.session.runtime_generation !== runtimeGeneration) {
      return { state: 'conflict', session: status.session };
    }
  }
  return {
    state: 'unknown',
    ...(removal ? { response: removal } : {}),
  };
}

function normalizeReconcileDelays(value) {
  if (!Array.isArray(value)) return AMBIGUOUS_BROKER_RECONCILE_DELAYS_MS;
  const delays = value.filter((delayMs) => Number.isFinite(delayMs) && delayMs >= 0);
  return delays.length > 0 ? delays : [0];
}

function reportUnknownBrokerLaunch({ stderr, codingSessionId } = {}) {
  stderr.write(`mc: broker launch outcome is unknown for ${codingSessionId}; refusing to create or terminalize a duplicate session\n`);
  return {
    code: 1,
    reason: 'broker-launch-unknown',
    error: 'broker launch outcome is unknown',
  };
}

function brokerLaunchFailureReason(result) {
  if (typeof result?.reason === 'string'
    && /^[a-z][a-z0-9-]{0,127}$/u.test(result.reason)) {
    return result.reason;
  }
  if (typeof result?.error === 'string'
    && /^[a-z][a-z0-9-]{0,127}$/u.test(result.error)) {
    return result.error;
  }
  return 'broker-launch-failed';
}

function abortUnacceptedManagedLaunch({
  codingSessionId,
  runtimeGeneration,
  managedIntent,
  descriptor,
  failureReason = null,
  now,
  deps,
} = {}) {
  let generation;
  try {
    generation = (deps.inspectManagedGeneration || inspectManagedGenerationSync)({
      codingSessionId,
      runtimeGeneration,
    });
  } catch {
    return { ok: false, reason: 'managed-generation-inspection-failed' };
  }
  if (generation?.kind !== 'present' || generation.phase !== 'domain-ready') {
    return { ok: false, reason: 'managed-generation-may-have-launched' };
  }
  const cleanup = (deps.abortManagedCredentialDomain || abortManagedCredentialDomain)({
    descriptor,
  });
  if (!cleanup?.ok) return cleanup;
  try {
    (deps.appendManagedGenerationReceipt || appendManagedGenerationReceiptSync)({
      phase: 'aborted',
      codingSessionId,
      runtimeGeneration,
      intentDigest: managedIntent.intent_digest,
      recordedAt: new Date(now()).toISOString(),
      data: {
        reason: 'launch-not-accepted',
        ...(typeof failureReason === 'string'
          && /^[a-z][a-z0-9-]{0,127}$/u.test(failureReason)
          ? { failure_reason: failureReason }
          : {}),
      },
    });
    return { ok: true };
  } catch {
    return { ok: false, reason: 'managed-generation-abort-receipt-unconfirmed' };
  }
}

function bindSessionControllerCapability(request, capability) {
  return (message, options) => request({
    ...message,
    ...([
      'attach_session',
      'write_session',
      'dispatch_session',
      'fetch_session_output',
      'resize_session',
      'stop_session',
      'remove_session',
    ].includes(message?.type)
      ? { session_controller_capability: capability }
      : {}),
  }, options);
}

function isExactLaunchedSession(session, { codingSessionId, runtimeGeneration } = {}) {
  return session?.id === codingSessionId
    && session?.runtime_generation === runtimeGeneration;
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
  reconcileDelaysMs,
  runtimeGenerationFactory,
}) {
  let currentCode = code;
  let currentLaunchMessage = launchMessage;
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

    const failedRuntimeGeneration = currentLaunchMessage.session?.runtime_generation;
    if (snapshot.session?.runtime_generation
      && snapshot.session.runtime_generation !== failedRuntimeGeneration) {
      stderr.write('mc: Codex SQLite startup retry found a different broker generation; refusing cleanup.\n');
      break;
    }
    const removal = await removeExactBrokerSession({
      launchRequest,
      codingSessionId,
      runtimeGeneration: failedRuntimeGeneration,
      sleepFn,
      retryDelaysMs: reconcileDelaysMs,
    });
    if (removal.state !== 'removed') {
      const diagnostic = removal.response?.reason
        || removal.response?.error
        || removal.state
        || 'unknown';
      stderr.write(`mc: Codex SQLite startup retry could not confirm removal of the failed broker session (${diagnostic}).\n`);
      break;
    }

    const delayMs = retryDelaysMs[index];
    stderr.write(`mc: Codex state database was briefly locked; retrying startup in ${formatRetryDelay(delayMs)} (${index + 1}/${retryDelaysMs.length}).\n`);
    await sleepFn(delayMs);

    const runtimeGeneration = runtimeGenerationFactory();
    currentLaunchMessage = withRuntimeGeneration(currentLaunchMessage, runtimeGeneration);
    let relaunched;
    let ambiguous = false;
    try {
      relaunched = await launchRequest(currentLaunchMessage);
      ambiguous = relaunched?.ok !== false
        && !isExactLaunchedSession(relaunched?.session, { codingSessionId, runtimeGeneration });
    } catch {
      ambiguous = true;
    }
    if (ambiguous) {
      const reconciliation = await reconcileAmbiguousBrokerLaunch({
        launchRequest,
        codingSessionId,
        runtimeGeneration,
        sleepFn,
        retryDelaysMs: reconcileDelaysMs,
      });
      if (reconciliation.state === 'live') {
        relaunched = { ok: true, session: reconciliation.session, recovered: true };
      } else {
        stderr.write('mc: Codex SQLite startup retry launch outcome is unknown; refusing another relaunch.\n');
        return 1;
      }
    }
    if (relaunched?.ok !== true) {
      stderr.write(`mc: Codex SQLite startup retry failed to relaunch (${relaunched?.error || relaunched?.reason || 'unknown'}).\n`);
      return 1;
    }
    currentCode = await attach(attachOptions);
  }
  return currentCode;
}

function withRuntimeGeneration(launchMessage, runtimeGeneration) {
  return {
    ...launchMessage,
    session: {
      ...launchMessage.session,
      runtime_generation: runtimeGeneration,
      sidecars: launchMessage.session?.sidecars?.enabled === false
        ? launchMessage.session.sidecars
        : {
            ...launchMessage.session?.sidecars,
            runtimeGeneration,
          },
    },
  };
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

export async function registerSessionProjection({
  apiUrl,
  token,
  codingSessionId,
  runtimeGeneration = null,
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
        runtimeGeneration,
        presenceState: runtimeGeneration ? 'active' : null,
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

// Transitional export for callers/tests from before presence ownership was
// separated from the GitHub capability.
export const registerGitHubSessionProjection = registerSessionProjection;

async function terminalizeStartingPresence({
  apiUrl,
  token,
  codingSessionId,
  runtimeGeneration,
  machineId,
  sourceIdentity,
  source,
  repo,
  branch,
  label = null,
  now = () => Date.now(),
  postHeartbeat = postHeartbeatWithRetry,
  memoroFetchImpl,
} = {}) {
  try {
    return await postHeartbeat({
      apiUrl,
      token,
      payload: buildSessionHeartbeatPayload({
        codingSessionId,
        runtimeGeneration,
        presenceState: 'terminal',
        machineId,
        sourceIdentity,
        source,
        repo,
        branch,
        idleSeconds: 0,
        at: new Date(now()).toISOString(),
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
  sessionControllerCapability,
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
      controllerBinding: {
        schema: 'mc-broker-controller-bootstrap-v1',
        session_id: codingSessionId,
        session_controller_capability: sessionControllerCapability,
      },
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
      request: (message, options = {}) => request(message, {
        socketPath: host.socketPath,
        ...options,
      }),
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
  abortUnacceptedManagedLaunch,
  brokerLaunchFailureReason,
  isCloudBrokerLaunch,
  resolveLaunchBroker,
  retryCodexSqliteStartup,
};
