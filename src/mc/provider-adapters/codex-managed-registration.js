/**
 * Complete managed-provider registration for Codex.
 *
 * This is the only composition layer allowed to know which Codex credential,
 * launch, recovery, and boundary implementations satisfy the central managed
 * provider contract.
 */
import {
  abortLocalCodexCredentialDomain,
  closeLocalCodexCredentialDomain,
  confirmLocalCodexCredentialDomainAbsent,
  inspectCustodyCodexAuth,
  inspectLocalCodexProviderAbsence,
  inspectLocalCodexCredentialDomainPresence,
  inspectPreparedLocalCodexCredentialDomain,
  prepareLocalCodexCredentialDomain,
} from '../credential-domain/local-codex.js';
import { resolveRealCodexBinary } from '../../lib/codex.js';
import { resolveTrustedVaultPortal } from '../vault/trusted-portal.js';
import {
  verifyInstalledManagedCodexArtifact,
} from './codex-managed-artifacts.js';
import {
  MANAGED_CODEX_PROVIDER_ID,
  resolveManagedCodexLaunch,
} from './codex-managed.js';
import { importManagedCodexRecovery } from '../managed-codex-recovery.js';
import {
  observe as observeCodexProviderArtifact,
  validate as validateCodexProviderArtifact,
} from '../provider-artifact-adapters/codex.js';

export const CODEX_MANAGED_PROVIDER_ADAPTER = Object.freeze({
  schema: 'mc-managed-provider-adapter/v2',
  tool_id: 'codex',
  provider_adapter_id: MANAGED_CODEX_PROVIDER_ID,
  prepareCredentialDomain: prepareLocalCodexCredentialDomain,
  resolveLaunch: resolveManagedCodexLaunch,
  closeCredentialDomain: closeLocalCodexCredentialDomain,
  abortCredentialDomain: abortLocalCodexCredentialDomain,
  inspectCredentialDomainPresence: inspectLocalCodexCredentialDomainPresence,
  inspectPreparedCredentialDomain: inspectPreparedLocalCodexCredentialDomain,
  confirmCredentialDomainAbsent: confirmLocalCodexCredentialDomainAbsent,
  async inspectReadiness({ portal, deps = {} } = {}) {
    const release = await Promise.resolve(
      deps.inspectRelease
        ? deps.inspectRelease({
            launcherPath: deps.codexBinary || resolveRealCodexBinary(),
            deps: deps.releaseDeps || {},
          })
        : verifyInstalledManagedCodexArtifact(),
    ).catch(() => null);
    if (!release?.ok) {
      return unavailable(
        release?.reason || 'managed-portable-codex-release-untrusted',
        'Install the pinned Codex release supplied by mc before switching.',
      );
    }
    const effectivePortal = portal
      || await (deps.resolvePortal || resolveTrustedVaultPortal)({
        deps: deps.portalDeps || {},
      }).catch(() => null);
    if (!effectivePortal?.apiUrl || !effectivePortal?.token) {
      return unavailable(
        'managed-provider-memoro-auth-missing',
        'Sign in to Memoro before selecting Codex.',
      );
    }
    const custody = await Promise.resolve(
      (deps.inspectCustody || inspectCustodyCodexAuth)({
        portal: effectivePortal,
        deps: deps.custodyDeps || {},
      }),
    ).catch(() => null);
    if (!custody?.ok) {
      return unavailable(
        custody?.reason || 'managed-portable-codex-auth-missing',
        'Unlock the vault and import exactly one tool-auth:codex record.',
      );
    }
    return ready();
  },
  inspectProviderAbsence({ descriptor, generation, root } = {}) {
    const inspected = inspectLocalCodexProviderAbsence({
      root,
      descriptor,
      generation,
    });
    return absence(inspected, 'codex', MANAGED_CODEX_PROVIDER_ID);
  },
  credentialBoundaryEvidence(descriptor) {
    if (descriptor?.provider_adapter !== MANAGED_CODEX_PROVIDER_ID) return null;
    return {
      schema: 'mc-managed-credential-boundary-evidence-v1',
      provider_adapter: MANAGED_CODEX_PROVIDER_ID,
      boundary_profile: descriptor.profile,
      session_id: descriptor.session_id,
      generation: descriptor.generation,
      launch_nonce: descriptor.launch_nonce,
      release_digest: descriptor.native_binary_sha256,
      policy_digest: descriptor.provider_config_sha256,
      manifest_digest: descriptor.manifest_sha256,
      c1_eligible: true,
    };
  },
  importLegacyRecovery: importManagedCodexRecovery,
  captureProviderArtifactContext({ provider, input } = {}) {
    const descriptor = provider?.descriptor;
    if (descriptor?.provider_adapter !== MANAGED_CODEX_PROVIDER_ID
      || typeof descriptor.codex_home !== 'string'
      || !descriptor.codex_home) {
      return null;
    }
    return {
      sessions_dir: `${descriptor.codex_home.replace(/\/+$/u, '')}/sessions`,
      expected_provider_session_id: input?.argv?.[0] === 'resume'
        ? input.argv[1] || null
        : null,
    };
  },
  observeProviderArtifact: observeCodexProviderArtifact,
  validateProviderArtifact: validateCodexProviderArtifact,
});

function ready() {
  return {
    schema: 'mc-managed-provider-readiness/v1',
    ok: true,
    tool_id: 'codex',
    provider_adapter_id: MANAGED_CODEX_PROVIDER_ID,
    reason: null,
    hint: null,
  };
}

function unavailable(reason, hint) {
  return {
    schema: 'mc-managed-provider-readiness/v1',
    ok: false,
    tool_id: 'codex',
    provider_adapter_id: MANAGED_CODEX_PROVIDER_ID,
    reason,
    hint,
  };
}

function absence(result, toolId, providerAdapterId) {
  return {
    schema: 'mc-managed-provider-absence/v1',
    ok: result?.ok === true,
    tool_id: toolId,
    provider_adapter_id: providerAdapterId,
    evidence_digest: result?.ok === true ? result.evidence_digest : null,
    reason: result?.ok === true
      ? null
      : result?.reason || 'managed-provider-absence-unconfirmed',
  };
}
