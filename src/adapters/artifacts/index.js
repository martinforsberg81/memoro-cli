/**
 * Tool-neutral registry for provider-native session artifact evidence.
 *
 * The broker owns the protocol and journal. Each tool adapter owns the shape
 * and location checks for its provider-native session artifact.
 */
import * as claudeCode from './claude-code.js';
import * as codex from './codex.js';

export const PROVIDER_ARTIFACT_ADAPTER_SCHEMA = 'mc-provider-artifact-adapter/v1';

const TOOL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function adapter(module) {
  return {
    schema: PROVIDER_ARTIFACT_ADAPTER_SCHEMA,
    tool_id: module.TOOL_ID,
    captureContext: module.captureContext,
    validate: module.validate,
  };
}

export function createProviderArtifactAdapterRegistry(adapters = []) {
  if (!Array.isArray(adapters)) {
    throw new TypeError('provider artifact adapters must be an array');
  }
  const byTool = new Map();
  for (const candidate of adapters) {
    const checked = validateProviderArtifactAdapter(candidate);
    if (byTool.has(checked.tool_id)) {
      throw new TypeError('provider artifact adapter id is duplicated');
    }
    byTool.set(checked.tool_id, checked);
  }
  return Object.freeze({
    list() {
      return [...byTool.values()].map(({ schema, tool_id }) => Object.freeze({
        schema,
        tool_id,
      }));
    },
    forTool(toolId) {
      return byTool.get(normalizeToolId(toolId)) || null;
    },
  });
}

export const providerArtifactAdapterRegistry = createProviderArtifactAdapterRegistry([
  adapter(claudeCode),
  adapter(codex),
]);

export function providerArtifactContextForLaunch({
  tool,
  registry = providerArtifactAdapterRegistry,
  ...input
} = {}) {
  const selected = registry.forTool(tool);
  if (!selected) return null;
  const context = selected.captureContext(input);
  return plain(context) ? Object.freeze(structuredClone(context)) : null;
}

export function validateProviderArtifactEvidence({
  tool,
  evidence,
  context,
  registry = providerArtifactAdapterRegistry,
  adapterDeps,
} = {}) {
  const selected = registry.forTool(tool);
  if (!selected) return { ok: false, reason: 'provider-artifact-tool-unsupported' };
  try {
    const result = selected.validate({ evidence, context }, adapterDeps);
    return result?.ok === true
      ? result
      : { ok: false, reason: result?.reason || 'provider-artifact-invalid' };
  } catch {
    return { ok: false, reason: 'provider-artifact-validation-failed' };
  }
}

export function validateProviderArtifactAdapter(value) {
  if (!plain(value)
    || value.schema !== PROVIDER_ARTIFACT_ADAPTER_SCHEMA
    || !TOOL_ID.test(value.tool_id || '')
    || typeof value.captureContext !== 'function'
    || typeof value.validate !== 'function'
    || !exactKeys(value, [
      'schema',
      'tool_id',
      'captureContext',
      'validate',
    ])) {
    throw new TypeError('provider artifact adapter contract is invalid');
  }
  return Object.freeze({ ...value });
}

function normalizeToolId(value) {
  return typeof value === 'string' && TOOL_ID.test(value) ? value : null;
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
