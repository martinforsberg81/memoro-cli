import { randomUUID } from 'node:crypto';

import { resolveLaunch } from '../index.js';
import {
  abortManagedCredentialDomain,
  closeManagedCredentialDomain,
  inspectManagedProviderReadiness,
  prepareManagedCredentialDomain,
  resolveManagedProviderLaunch,
} from '../../mc/managed-provider-registry.js';

export const CERTIFIED_TOOL_ADAPTER_SCHEMA = 'mc-certified-tool-adapter/v1';

const ADAPTER_KEYS = Object.freeze([
  'schema',
  'tool',
  'provider_tool',
  'inspect_readiness',
  'prepare_boundary',
  'resolve_argv',
  'resolve_process',
  'abort_boundary',
  'close_boundary',
]);
const REQUIRED_FUNCTIONS = Object.freeze(ADAPTER_KEYS.slice(3));
const TOOL_RE = /^[a-z][a-z0-9_-]{0,63}$/u;

export function createCertifiedToolRegistry(adapters = builtinAdapters()) {
  if (!Array.isArray(adapters)) throw new TypeError('certified adapters must be an array');
  const byTool = new Map();
  for (const candidate of adapters) {
    const adapter = validateCertifiedToolAdapter(candidate);
    if (byTool.has(adapter.tool)) throw new TypeError('certified adapter tool is duplicated');
    byTool.set(adapter.tool, adapter);
  }
  return Object.freeze({
    list() {
      return [...byTool.values()].map((adapter) => Object.freeze({
        schema: adapter.schema,
        tool: adapter.tool,
        provider_tool: adapter.provider_tool,
      }));
    },
    forTool(tool) {
      return byTool.get(normalizeTool(tool)) || null;
    },
  });
}

export const certifiedToolRegistry = createCertifiedToolRegistry();

export function validateCertifiedToolAdapter(value) {
  if (!plain(value) || !exactKeys(value, ADAPTER_KEYS)
    || value.schema !== CERTIFIED_TOOL_ADAPTER_SCHEMA
    || !TOOL_RE.test(value.tool || '')
    || !TOOL_RE.test(value.provider_tool || '')
    || REQUIRED_FUNCTIONS.some((key) => typeof value[key] !== 'function')) {
    throw new TypeError('invalid certified tool adapter');
  }
  return Object.freeze({ ...value });
}

function builtinAdapters() {
  return [
    builtinAdapter({ tool: 'codex', providerTool: 'codex' }),
    builtinAdapter({ tool: 'claude', providerTool: 'claude-code' }),
  ];
}

function builtinAdapter({ tool, providerTool }) {
  return {
    schema: CERTIFIED_TOOL_ADAPTER_SCHEMA,
    tool,
    provider_tool: providerTool,
    async inspect_readiness(options = {}) {
      const inspect = options.deps?.inspectReadiness || inspectManagedProviderReadiness;
      const result = await Promise.resolve(inspect({
        ...options,
        tool: providerTool,
      })).catch(() => null);
      return result?.ok === true
        ? { ok: true }
        : failure(result?.reason || 'certified-readiness-unavailable');
    },
    async prepare_boundary(options = {}) {
      const prepare = options.deps?.prepareBoundary || prepareManagedCredentialDomain;
      const result = await Promise.resolve(prepare({
        ...options,
        tool: providerTool,
      })).catch(() => null);
      return result?.ok === true && plain(result.descriptor)
        ? result
        : failure(result?.reason || 'certified-boundary-unavailable');
    },
    resolve_argv({ launch, action, conversationHandle = null, uuid = randomUUID } = {}) {
      if (!launch?.ok || launch.id !== providerTool) return failure('certified-tool-mismatch');
      if (action === 'resume') {
        if (typeof conversationHandle !== 'string' || !conversationHandle) {
          return failure('certified-resume-handle-missing');
        }
        if (typeof launch.adapter?.resumeArgs !== 'function') {
          return failure('certified-resume-unsupported');
        }
        const argv = launch.adapter.resumeArgs({ sessionId: conversationHandle });
        return validArgv(argv)
          ? { ok: true, argv: [...argv], expected_handle: conversationHandle }
          : failure('certified-resume-argv-invalid');
      }
      if (!['start', 'replace', 'switch'].includes(action)) {
        return failure('certified-action-unsupported');
      }
      if (typeof launch.adapter?.newSessionArgs !== 'function') {
        return { ok: true, argv: [], expected_handle: null };
      }
      const expectedHandle = uuid();
      const argv = launch.adapter.newSessionArgs({ sessionId: expectedHandle });
      return validArgv(argv)
        ? { ok: true, argv: [...argv], expected_handle: expectedHandle }
        : failure('certified-new-conversation-argv-invalid');
    },
    resolve_process({ boundary, argv, env, launch: preparedLaunch = null, launchOptions = {}, deps = {} } = {}) {
      if (!plain(boundary?.descriptor)) return failure('certified-boundary-missing');
      const resolveTool = deps.resolveToolLaunch || resolveLaunch;
      const launch = preparedLaunch || resolveTool(providerTool);
      if (!launch?.ok || launch.id !== providerTool) {
        return failure(`certified-${tool}-release-unavailable`);
      }
      const resolveBoundary = deps.resolveBoundaryLaunch || resolveManagedProviderLaunch;
      const resolved = resolveBoundary({
        launch,
        input: {
          credential_domain: boundary.descriptor,
          argv: [...(argv || [])],
          env: { ...(env || {}) },
        },
      });
      if (!resolved?.ok
        || resolved.environmentMode !== 'replace'
        || !plain(resolved.descriptor)
        || resolved.descriptor.session_id !== boundary.descriptor.session_id
        || typeof resolved.launch?.spec?.spawn !== 'function'
        || !plain(resolved.env)) {
        return failure(resolved?.reason || 'certified-process-plan-invalid');
      }
      let spawn;
      try { spawn = resolved.launch.spec.spawn(argv || [], launchOptions); } catch {
        return failure('certified-process-plan-invalid');
      }
      if (!plain(spawn)
        || typeof spawn.bin !== 'string'
        || !spawn.bin
        || !validArgv(spawn.args)) return failure('certified-process-plan-invalid');
      return {
        ok: true,
        command: spawn.bin,
        args: [...spawn.args],
        env: { ...resolved.env },
      };
    },
    async abort_boundary({ descriptor, deps = {} } = {}) {
      const abort = deps.abortBoundary || abortManagedCredentialDomain;
      return Promise.resolve(abort({ descriptor })).catch(() => failure('certified-abort-failed'));
    },
    async close_boundary({ descriptor, deps = {}, ...options } = {}) {
      const close = deps.closeBoundary || closeManagedCredentialDomain;
      return Promise.resolve(close({ descriptor, ...options }))
        .catch(() => failure('certified-close-failed'));
    },
  };
}

function normalizeTool(value) {
  if (value === 'claude-code') return 'claude';
  return typeof value === 'string' && TOOL_RE.test(value) ? value : null;
}

function validArgv(value) {
  return Array.isArray(value)
    && value.length <= 256
    && value.every((item) => typeof item === 'string'
      && item.length <= 16_384
      && !item.includes('\u0000'));
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

function failure(reason) {
  return { ok: false, reason };
}
