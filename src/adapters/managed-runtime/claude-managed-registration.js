/**
 * Complete managed-provider registration for Claude Code.
 *
 * The central lifecycle sees only this strict adapter object. Claude-specific
 * release, custody, runtime, refresh, archive-root, and artifact semantics
 * remain behind the adapter boundary.
 */
import {
  abortLocalClaudeCredentialDomain,
  closeLocalClaudeCredentialDomain,
  confirmLocalClaudeCredentialDomainAbsent,
  importManagedClaudeRecovery,
  inspectLocalClaudeCredentialDomainPresence,
  inspectPreparedLocalClaudeCredentialDomain,
  prepareLocalClaudeCredentialDomain,
} from '../../vault/credential-domain/local-claude.js';
import {
  verifyInstalledClaudeC1Artifacts,
} from '../../runtime/broker/c1-artifacts.js';
import {
  inspectManagedClaudeCertificationSync,
} from './claude-managed-certification.js';
import {
  inspectManagedClaudeCustody,
} from './claude-managed-custody.js';
import { resolveTrustedVaultPortal } from '../../vault/engine/trusted-portal.js';
import {
  MANAGED_CLAUDE_PROVIDER_ID,
  resolveManagedClaudeLaunch,
} from './claude-managed.js';
import {
  validate as validateClaudeProviderArtifact,
} from '../artifacts/claude-code.js';
import {
  inspectManagedProviderAbsence,
} from '../../mc/managed-provider-archive.js';

export const CLAUDE_MANAGED_PROVIDER_ADAPTER = Object.freeze({
  schema: 'mc-managed-provider-adapter/v2',
  tool_id: 'claude-code',
  provider_adapter_id: MANAGED_CLAUDE_PROVIDER_ID,
  prepareCredentialDomain: prepareLocalClaudeCredentialDomain,
  resolveLaunch: resolveManagedClaudeLaunch,
  closeCredentialDomain: closeLocalClaudeCredentialDomain,
  abortCredentialDomain: abortLocalClaudeCredentialDomain,
  inspectCredentialDomainPresence: inspectLocalClaudeCredentialDomainPresence,
  inspectPreparedCredentialDomain: inspectPreparedLocalClaudeCredentialDomain,
  confirmCredentialDomainAbsent: confirmLocalClaudeCredentialDomainAbsent,
  async inspectReadiness({ portal, root, deps = {} } = {}) {
    const certification = (deps.inspectCertification
      || inspectManagedClaudeCertificationSync)({
      ...(root ? { root } : {}),
    });
    if (!certification?.ok) {
      return unavailable(
        certification?.reason || 'managed-claude-certification-required',
        'Run the hostile Claude C1 check successfully for this exact mc build.',
      );
    }
    const artifacts = await Promise.resolve()
      .then(() => (deps.verifyArtifacts || verifyInstalledClaudeC1Artifacts)())
      .catch(() => null);
    if (!artifacts?.ok) {
      return unavailable(
        artifacts?.code || 'managed-claude-artifact-untrusted',
        'Install the pinned Claude and sandbox-runtime artifacts supplied by mc.',
      );
    }
    const effectivePortal = portal
      || await (deps.resolvePortal || resolveTrustedVaultPortal)({
        deps: deps.portalDeps || {},
      }).catch(() => null);
    if (!effectivePortal?.apiUrl || !effectivePortal?.token) {
      return unavailable(
        'managed-provider-memoro-auth-missing',
        'Sign in to Memoro before selecting Claude Code.',
      );
    }
    const custody = await Promise.resolve(
      (deps.inspectCustody || inspectManagedClaudeCustody)({
        portal: effectivePortal,
        deps: deps.custodyDeps || {},
      }),
    ).catch(() => null);
    if (!custody?.ok) {
      return unavailable(
        custody?.reason || 'managed-claude-custody-missing',
        'Unlock the vault and import exactly one tool-auth:claude-code record.',
      );
    }
    return ready();
  },
  inspectProviderAbsence({ descriptor, generation, root } = {}) {
    const inspected = inspectManagedProviderAbsence({
      root,
      tool: 'claude-code',
      descriptor,
      providerRoot: descriptor?.claude_config_dir,
      transcriptRoot: `${descriptor?.claude_config_dir || ''}/projects`,
      generation,
    });
    return absence(inspected, 'claude-code', MANAGED_CLAUDE_PROVIDER_ID);
  },
  credentialBoundaryEvidence(descriptor) {
    if (descriptor?.provider_adapter !== MANAGED_CLAUDE_PROVIDER_ID) return null;
    return {
      schema: 'mc-managed-credential-boundary-evidence-v1',
      provider_adapter: MANAGED_CLAUDE_PROVIDER_ID,
      boundary_profile: descriptor.profile,
      session_id: descriptor.session_id,
      generation: descriptor.generation,
      launch_nonce: descriptor.launch_nonce,
      release_digest: descriptor.native_binary_sha256,
      policy_digest: descriptor.c1_source_closure_sha256,
      manifest_digest: descriptor.manifest_sha256,
      c1_eligible: true,
    };
  },
  importLegacyRecovery: importManagedClaudeRecovery,
  captureProviderArtifactContext({ provider } = {}) {
    const descriptor = provider?.descriptor;
    if (descriptor?.provider_adapter !== MANAGED_CLAUDE_PROVIDER_ID
      || typeof descriptor.claude_config_dir !== 'string'
      || !descriptor.claude_config_dir) return null;
    return {
      projects_dir: `${descriptor.claude_config_dir.replace(/\/+$/u, '')}/projects`,
    };
  },
  observeProviderArtifact() {
    return {
      ok: false,
      reason: 'provider-artifact-observation-unsupported',
    };
  },
  validateProviderArtifact: validateClaudeProviderArtifact,
});

function ready() {
  return {
    schema: 'mc-managed-provider-readiness/v1',
    ok: true,
    tool_id: 'claude-code',
    provider_adapter_id: MANAGED_CLAUDE_PROVIDER_ID,
    reason: null,
    hint: null,
  };
}

function unavailable(reason, hint) {
  return {
    schema: 'mc-managed-provider-readiness/v1',
    ok: false,
    tool_id: 'claude-code',
    provider_adapter_id: MANAGED_CLAUDE_PROVIDER_ID,
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
