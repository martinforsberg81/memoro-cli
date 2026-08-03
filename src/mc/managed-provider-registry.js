/**
 * Provider-agnostic registry for managed local coding tools.
 *
 * The lifecycle, broker, recovery, and tool-switch layers route through this
 * contract. They must not select credential-domain or provider-runtime
 * implementations with tool-specific conditionals.
 */
import {
  CODEX_MANAGED_PROVIDER_ADAPTER,
} from '../adapters/managed-runtime/codex-managed-registration.js';
import {
  CLAUDE_MANAGED_PROVIDER_ADAPTER,
} from '../adapters/managed-runtime/claude-managed-registration.js';
import { mcHome } from './paths.js';
import {
  appendManagedGenerationReceiptSync,
  inspectManagedGenerationSync,
  validateManagedGenerationTransaction,
} from './managed-generation-journal.js';

export const MANAGED_PROVIDER_ADAPTER_SCHEMA = 'mc-managed-provider-adapter/v2';
export const MANAGED_PROVIDER_READINESS_SCHEMA = 'mc-managed-provider-readiness/v1';
export const MANAGED_PROVIDER_ABSENCE_SCHEMA = 'mc-managed-provider-absence/v1';
export const MANAGED_PROVIDER_HANDOFF_SOURCE_SCHEMA =
  'mc-managed-provider-handoff-source/v1';

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SESSION_OWNER_ID_RE = /^(?:sess_[A-Za-z0-9_-]{6,}|mcs_[a-f0-9]{24})$/u;
const REQUIRED_FUNCTIONS = Object.freeze([
  'prepareCredentialDomain',
  'resolveLaunch',
  'closeCredentialDomain',
  'abortCredentialDomain',
  'inspectCredentialDomainPresence',
  'inspectPreparedCredentialDomain',
  'confirmCredentialDomainAbsent',
  'inspectReadiness',
  'inspectProviderAbsence',
  'credentialBoundaryEvidence',
  'importLegacyRecovery',
  'captureProviderArtifactContext',
  'observeProviderArtifact',
  'validateProviderArtifact',
]);

export function createManagedProviderRegistry(adapters = []) {
  if (!Array.isArray(adapters)) throw new TypeError('managed provider adapters must be an array');
  const byTool = new Map();
  const byProviderAdapter = new Map();
  for (const candidate of adapters) {
    const adapter = validateManagedProviderAdapter(candidate);
    if (byTool.has(adapter.tool_id)
      || byProviderAdapter.has(adapter.provider_adapter_id)) {
      throw new TypeError('managed provider adapter id is duplicated');
    }
    byTool.set(adapter.tool_id, adapter);
    byProviderAdapter.set(adapter.provider_adapter_id, adapter);
  }
  return Object.freeze({
    list() {
      return [...byTool.values()].map(publicManagedProviderAdapter);
    },
    forTool(toolId) {
      return byTool.get(normalizeProviderId(toolId)) || null;
    },
    forDescriptor(descriptor) {
      const providerAdapterId = normalizeProviderId(descriptor?.provider_adapter);
      const adapter = providerAdapterId
        ? byProviderAdapter.get(providerAdapterId) || null
        : null;
      return adapter && descriptor?.schema ? adapter : null;
    },
  });
}

export const managedProviderRegistry = createManagedProviderRegistry([
  CODEX_MANAGED_PROVIDER_ADAPTER,
  CLAUDE_MANAGED_PROVIDER_ADAPTER,
]);

export function prepareManagedCredentialDomain({
  tool,
  providerRegistry = managedProviderRegistry,
  ...options
} = {}) {
  const adapter = providerRegistry.forTool(tool);
  if (!adapter) return Promise.resolve(managedProviderFailure('managed-provider-tool-unsupported'));
  return Promise.resolve(adapter.prepareCredentialDomain({
    ...options,
    tool: adapter.tool_id,
  }));
}

export function resolveManagedProviderLaunch({
  launch,
  input,
  providerRegistry = managedProviderRegistry,
} = {}) {
  const descriptor = input?.credential_domain;
  if (!descriptor) {
    return {
      ok: true,
      launch,
      environmentMode: 'inherit',
      env: input?.env || {},
    };
  }
  const adapter = providerRegistry.forDescriptor(descriptor);
  if (!adapter || launch?.id !== adapter.tool_id) {
    return managedProviderFailure('managed-provider-adapter-unsupported');
  }
  return adapter.resolveLaunch({ launch, input });
}

export function closeManagedCredentialDomain({
  descriptor,
  providerRegistry = managedProviderRegistry,
  ...options
} = {}) {
  const adapter = providerRegistry.forDescriptor(descriptor);
  if (!adapter) return Promise.resolve(managedProviderFailure('managed-domain-descriptor-invalid'));
  return Promise.resolve(adapter.closeCredentialDomain({ descriptor, ...options }));
}

/**
 * Complete one managed domain after provider exit.
 *
 * A missing provider artifact is not assumed to mean that the provider did no
 * work. The selected adapter must prove the provider-specific storage
 * outcome first; the central lifecycle then publishes the bounded absence
 * receipt before custody persistence or cleanup can proceed.
 */
export async function finalizeManagedCredentialDomain({
  descriptor,
  providerArtifact = null,
  managedTransaction = null,
  root = mcHome(),
  providerRegistry = managedProviderRegistry,
  deps = {},
  ...options
} = {}) {
  const adapter = providerRegistry.forDescriptor(descriptor);
  if (!adapter) return managedProviderFailure('managed-domain-descriptor-invalid');
  if (managedTransaction != null && providerArtifact == null) {
    const checked = validateManagedGenerationTransaction(managedTransaction);
    if (!checked.ok) return managedProviderFailure('managed-domain-transaction-invalid');
    const inspect = deps.inspectManagedGeneration || inspectManagedGenerationSync;
    let generation;
    try {
      generation = inspect({
        mcHomeDir: root,
        codingSessionId: checked.value.coding_session_id,
        runtimeGeneration: checked.value.runtime_generation,
      });
    } catch {
      generation = null;
    }
    if (generation?.kind !== 'present'
      || generation.intent?.intent_digest !== checked.value.intent_digest
      || !generation.receipts?.exited
      || generation.receipts?.['provider-artifact']) {
      return managedProviderFailure('managed-provider-absence-outcome-unconfirmed');
    }
    if (!generation.receipts?.['provider-absent']) {
      let absence;
      try {
        absence = await Promise.resolve(adapter.inspectProviderAbsence({
          descriptor,
          managedTransaction: checked.value,
          generation,
          root,
          deps: deps.absenceDeps || {},
        }));
      } catch {
        absence = null;
      }
      if (!validManagedProviderAbsence(absence, adapter)) {
        return managedProviderFailure(
          absence?.reason || 'managed-provider-absence-unconfirmed',
        );
      }
      const append = deps.appendManagedReceipt
        || appendManagedGenerationReceiptSync;
      try {
        append({
          mcHomeDir: root,
          phase: 'provider-absent',
          codingSessionId: checked.value.coding_session_id,
          runtimeGeneration: checked.value.runtime_generation,
          intentDigest: checked.value.intent_digest,
          recordedAt: new Date().toISOString(),
          data: {
            evidence_digest: absence.evidence_digest,
            tool: adapter.tool_id,
          },
        });
      } catch {
        return managedProviderFailure('managed-provider-absence-receipt-unconfirmed');
      }
    }
  }
  return Promise.resolve(adapter.closeCredentialDomain({
    descriptor,
    providerArtifact,
    managedTransaction,
    deps,
    ...options,
  }));
}

export function abortManagedCredentialDomain({
  descriptor,
  providerRegistry = managedProviderRegistry,
} = {}) {
  const adapter = providerRegistry.forDescriptor(descriptor);
  return adapter
    ? adapter.abortCredentialDomain({ descriptor })
    : managedProviderFailure('managed-domain-descriptor-invalid');
}

export function inspectManagedCredentialDomainPresence({
  tool,
  providerRegistry = managedProviderRegistry,
  ...options
} = {}) {
  const adapter = providerRegistry.forTool(tool);
  return adapter
    ? adapter.inspectCredentialDomainPresence(options)
    : { kind: 'unknown', reason: 'managed-provider-tool-unsupported' };
}

export function inspectPreparedManagedCredentialDomain({
  tool,
  providerRegistry = managedProviderRegistry,
  ...options
} = {}) {
  const adapter = providerRegistry.forTool(tool);
  return adapter
    ? adapter.inspectPreparedCredentialDomain(options)
    : managedProviderFailure('managed-provider-tool-unsupported');
}

export function confirmManagedCredentialDomainAbsent({
  tool,
  providerRegistry = managedProviderRegistry,
  ...options
} = {}) {
  const adapter = providerRegistry.forTool(tool);
  return adapter
    ? adapter.confirmCredentialDomainAbsent(options)
    : managedProviderFailure('managed-provider-tool-unsupported');
}

export function managedProviderAdapterForTool(
  tool,
  providerRegistry = managedProviderRegistry,
) {
  const adapter = providerRegistry.forTool(tool);
  return adapter ? publicManagedProviderAdapter(adapter) : null;
}

export async function inspectManagedProviderReadiness({
  tool,
  providerRegistry = managedProviderRegistry,
  ...options
} = {}) {
  const adapter = providerRegistry.forTool(tool);
  if (!adapter) {
    return managedProviderReadinessFailure({
      toolId: normalizeProviderId(tool),
      reason: 'managed-provider-tool-unsupported',
      hint: 'No complete managed provider adapter is installed for this tool.',
    });
  }
  let result;
  try {
    result = await Promise.resolve(adapter.inspectReadiness(options));
  } catch {
    return managedProviderReadinessFailure({
      toolId: adapter.tool_id,
      providerAdapterId: adapter.provider_adapter_id,
      reason: 'managed-provider-readiness-failed',
      hint: 'Retry the managed provider readiness check.',
    });
  }
  return validateManagedProviderReadiness(result, adapter)
    ? Object.freeze({ ...result })
    : managedProviderReadinessFailure({
        toolId: adapter.tool_id,
        providerAdapterId: adapter.provider_adapter_id,
        reason: 'managed-provider-readiness-invalid',
        hint: 'The managed provider adapter returned invalid readiness evidence.',
      });
}

/**
 * Prove that one managed provider generation is safe to use as a handoff
 * source without publishing its private transcript path.
 *
 * The adapter already established provider-specific artifact ownership and
 * archive integrity before the terminal receipts were written. Handoff needs
 * only the immutable, path-free identity fence from that completed chain.
 */
export function inspectManagedProviderHandoffSource({
  tool,
  codingSessionId,
  providerSessionId,
  runtimeGeneration,
  root = mcHome(),
  providerRegistry = managedProviderRegistry,
  deps = {},
} = {}) {
  const adapter = providerRegistry.forTool(tool);
  if (!adapter) {
    return managedHandoffSourceFailure({
      toolId: normalizeProviderId(tool),
      reason: 'managed-provider-tool-unsupported',
    });
  }
  if (!PROVIDER_ID.test(codingSessionId || '')
    || !PROVIDER_ID.test(providerSessionId || '')
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(runtimeGeneration || '')) {
    return managedHandoffSourceFailure({
      adapter,
      reason: 'managed-handoff-source-identity-invalid',
    });
  }
  let generation;
  try {
    generation = (deps.inspectManagedGeneration || inspectManagedGenerationSync)({
      mcHomeDir: root,
      codingSessionId,
      runtimeGeneration,
    });
  } catch {
    generation = null;
  }
  const artifact = generation?.receipts?.['provider-artifact']?.data;
  const archive = generation?.receipts?.['archive-ready']?.data;
  const ready = generation?.receipts?.ready?.data;
  if (generation?.kind !== 'present'
    || generation.phase !== 'ready'
    || generation.terminal !== true
    || generation.intent?.data?.tool !== adapter.tool_id
    || generation.runtime_generation !== runtimeGeneration
    || generation.coding_session_id !== codingSessionId
    || artifact?.tool !== adapter.tool_id
    || artifact?.provider_session_id !== providerSessionId
    || archive?.provider_session_id !== providerSessionId
    || ready?.provider_session_id !== providerSessionId
    || !/^[a-f0-9]{64}$/u.test(archive?.archive_digest || '')
    || ready?.archive_digest !== archive.archive_digest) {
    return managedHandoffSourceFailure({
      adapter,
      reason: 'managed-handoff-source-artifact-unconfirmed',
    });
  }
  return Object.freeze({
    schema: MANAGED_PROVIDER_HANDOFF_SOURCE_SCHEMA,
    ok: true,
    tool_id: adapter.tool_id,
    provider_adapter_id: adapter.provider_adapter_id,
    coding_session_id: codingSessionId,
    provider_session_id: providerSessionId,
    runtime_generation: runtimeGeneration,
    archive_digest: archive.archive_digest,
    reason: null,
  });
}

export function importManagedProviderRecovery({
  tool,
  providerRegistry = managedProviderRegistry,
  ...options
} = {}) {
  const adapter = providerRegistry.forTool(tool);
  return adapter
    ? Promise.resolve(adapter.importLegacyRecovery(options))
    : Promise.resolve({
        ok: false,
        attempted: false,
        reason: 'managed-provider-tool-unsupported',
      });
}

export function managedCredentialBoundaryEvidence({
  descriptor,
  providerRegistry = managedProviderRegistry,
} = {}) {
  const adapter = providerRegistry.forDescriptor(descriptor);
  if (!adapter) return null;
  const evidence = adapter.credentialBoundaryEvidence(descriptor);
  return validateManagedCredentialBoundaryEvidence(evidence) ? Object.freeze({ ...evidence }) : null;
}

export function managedProviderArtifactContextForLaunch({
  tool,
  provider,
  input,
  providerRegistry = managedProviderRegistry,
} = {}) {
  const adapter = providerRegistry.forDescriptor(provider?.descriptor);
  if (!adapter || adapter.tool_id !== normalizeProviderId(tool)) return null;
  try {
    const context = adapter.captureProviderArtifactContext({
      tool: adapter.tool_id,
      provider,
      input,
    });
    return plain(context) ? Object.freeze(structuredClone(context)) : null;
  } catch {
    return null;
  }
}

export function validateManagedProviderArtifact({
  tool,
  evidence,
  context,
  providerRegistry = managedProviderRegistry,
  adapterDeps,
} = {}) {
  const adapter = providerRegistry.forTool(tool);
  if (!adapter) return managedProviderFailure('managed-provider-tool-unsupported');
  try {
    const result = adapter.validateProviderArtifact({ evidence, context }, adapterDeps);
    return result?.ok === true
      ? result
      : managedProviderFailure(result?.reason || 'managed-provider-artifact-invalid');
  } catch {
    return managedProviderFailure('managed-provider-artifact-validation-failed');
  }
}

export function observeManagedProviderArtifact({
  tool,
  context,
  cwd,
  providerRegistry = managedProviderRegistry,
  adapterDeps,
} = {}) {
  const adapter = providerRegistry.forTool(tool);
  if (!adapter) return managedProviderFailure('managed-provider-tool-unsupported');
  try {
    const result = adapter.observeProviderArtifact({ context, cwd }, adapterDeps);
    return result?.ok === true
      ? result
      : managedProviderFailure(
          result?.reason || 'managed-provider-artifact-not-observed',
        );
  } catch {
    return managedProviderFailure('managed-provider-artifact-observation-failed');
  }
}

export function validateManagedCredentialBoundaryEvidence(value) {
  return plain(value)
    && exactKeys(value, [
      'schema',
      'provider_adapter',
      'boundary_profile',
      'session_id',
      'generation',
      'launch_nonce',
      'release_digest',
      'policy_digest',
      'manifest_digest',
      'c1_eligible',
    ])
    && value.schema === 'mc-managed-credential-boundary-evidence-v1'
    && PROVIDER_ID.test(value.provider_adapter || '')
    && PROVIDER_ID.test(value.boundary_profile || '')
    && SESSION_OWNER_ID_RE.test(value.session_id || '')
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(value.generation || '')
    && /^[A-Za-z0-9_-]{43}$/u.test(value.launch_nonce || '')
    && [value.release_digest, value.policy_digest, value.manifest_digest]
      .every((digest) => /^[a-f0-9]{64}$/u.test(digest || ''))
    && value.c1_eligible === true;
}

export function validateManagedProviderAdapter(value) {
  if (!plain(value)
    || value.schema !== MANAGED_PROVIDER_ADAPTER_SCHEMA
    || !PROVIDER_ID.test(value.tool_id || '')
    || !PROVIDER_ID.test(value.provider_adapter_id || '')
    || REQUIRED_FUNCTIONS.some((name) => typeof value[name] !== 'function')) {
    throw new TypeError('managed provider adapter contract is invalid');
  }
  const exact = new Set([
    'schema',
    'tool_id',
    'provider_adapter_id',
    ...REQUIRED_FUNCTIONS,
  ]);
  if (Object.keys(value).some((key) => !exact.has(key))) {
    throw new TypeError('managed provider adapter contract has unexpected fields');
  }
  return Object.freeze({ ...value });
}

export function validateManagedProviderReadiness(value, adapter = null) {
  if (!plain(value)
    || !exactKeys(value, [
      'schema',
      'ok',
      'tool_id',
      'provider_adapter_id',
      'reason',
      'hint',
    ])
    || value.schema !== MANAGED_PROVIDER_READINESS_SCHEMA
    || typeof value.ok !== 'boolean'
    || !PROVIDER_ID.test(value.tool_id || '')
    || (value.provider_adapter_id !== null
      && !PROVIDER_ID.test(value.provider_adapter_id || ''))
    || (value.reason !== null
      && (typeof value.reason !== 'string'
        || !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(value.reason)))
    || (value.hint !== null
      && (typeof value.hint !== 'string'
        || value.hint.length < 1
        || value.hint.length > 512
        || /[\r\n]/u.test(value.hint)))
    || (value.ok && (value.reason !== null || value.hint !== null))
    || (!value.ok && value.reason === null)) {
    return false;
  }
  return !adapter
    || (value.tool_id === adapter.tool_id
      && value.provider_adapter_id === adapter.provider_adapter_id);
}

function validManagedProviderAbsence(value, adapter) {
  return plain(value)
    && exactKeys(value, [
      'schema',
      'ok',
      'tool_id',
      'provider_adapter_id',
      'evidence_digest',
      'reason',
    ])
    && value.schema === MANAGED_PROVIDER_ABSENCE_SCHEMA
    && value.ok === true
    && value.tool_id === adapter.tool_id
    && value.provider_adapter_id === adapter.provider_adapter_id
    && /^[a-f0-9]{64}$/u.test(value.evidence_digest || '')
    && value.reason === null;
}

function publicManagedProviderAdapter(adapter) {
  return Object.freeze({
    schema: adapter.schema,
    tool_id: adapter.tool_id,
    provider_adapter_id: adapter.provider_adapter_id,
  });
}

function normalizeProviderId(value) {
  return typeof value === 'string' && PROVIDER_ID.test(value) ? value : null;
}

function managedProviderFailure(reason) {
  return { ok: false, reason, error: reason };
}

function managedHandoffSourceFailure({
  adapter = null,
  toolId = null,
  reason,
} = {}) {
  return Object.freeze({
    schema: MANAGED_PROVIDER_HANDOFF_SOURCE_SCHEMA,
    ok: false,
    tool_id: adapter?.tool_id || toolId || null,
    provider_adapter_id: adapter?.provider_adapter_id || null,
    coding_session_id: null,
    provider_session_id: null,
    runtime_generation: null,
    archive_digest: null,
    reason,
  });
}

function managedProviderReadinessFailure({
  toolId,
  providerAdapterId = null,
  reason,
  hint,
}) {
  return Object.freeze({
    schema: MANAGED_PROVIDER_READINESS_SCHEMA,
    ok: false,
    tool_id: toolId || 'unknown-tool',
    provider_adapter_id: providerAdapterId,
    reason,
    hint,
  });
}

function plain(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}
