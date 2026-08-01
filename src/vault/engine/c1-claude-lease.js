/**
 * Fixed Claude C1 custody lease.
 *
 * This module deliberately has no callback, destination, label, path, or
 * environment arguments. It opens exactly one mc-vault record and starts the
 * installed broker child over the single anonymous credential pipe. The child
 * emits only a fixed status report; neither the credential nor child output is
 * ever returned to the caller.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getSecret as keychainGet } from '../../lib/keychain.js';
import { memoroFetch } from '../../lib/api.js';
import { readConfig } from '../../lib/config.js';
import { readCachedVaultKey } from './key-cache.js';
import {
  decryptEnvelopeLabel,
  decryptEnvelopeSecret,
  isEnvelopeSecret,
  unwrapCustodyRoot,
} from './custody-crypto.js';
import * as VaultApi from './api.js';
import {
  c1GroupEnvironmentForDescendant,
  currentC1ProcessGroupLeader,
  killCurrentC1ProcessGroup,
} from '../../runtime/broker/c1-process-group.js';
import { verifyInstalledC1SourceClosure } from '../../runtime/broker/c1-source-closure.js';

export const C1_CLAUDE_TOOL_AUTH_LABEL = 'tool-auth:claude-code';
export const C1_CLAUDE_TOOL_AUTH_CLASS = 'tool-auth';
export const C1_CLAUDE_CHILD_SCHEMA = 1;

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CHILD_PATH = join(PACKAGE_ROOT, 'src', 'runtime', 'broker', 'c1-child.js');
const C1_CHILD_SOURCE_SHA256 = '3a869dc7c3de2e6ec4e084b763d8bf4ac6486691b02269b6da6d567cd8e2c8bb';
const MEMORO_PRIMARY_AUTH_TOKEN_ACCOUNT = 'memoro-api-token';
const MAX_AUTH_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ACCESS_TOKEN_BYTES = 256 * 1024;
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;
const CHILD_TIMEOUT_MS = 10 * 60_000;

/**
 * Production entrypoint. It has no dependency portal and no callback by
 * design: controller authority reaches this point only through the broker's
 * fixed C1 operation.
 */
export async function runC1ClaudeVaultLease() {
  return runC1ClaudeVaultLeaseCore();
}

/**
 * Token-free parser used by tests before a fixture is encrypted. It does not
 * discover or lend credentials; callers can only parse bytes they supplied.
 */
export function extractExactC1ClaudeToolAuthPayload(data) {
  if (!isExactRecord(data, ['body', 'kind', 'source', 'tool'])) return null;
  if (data.kind !== 'tool_auth'
    || data.tool !== 'claude-code'
    || !['file', 'keychain'].includes(data.source)
    || typeof data.body !== 'string'
    || Buffer.byteLength(data.body, 'utf8') === 0
    || Buffer.byteLength(data.body, 'utf8') > MAX_AUTH_BODY_BYTES) return null;
  let body;
  try { body = JSON.parse(data.body); } catch { return null; }
  if (!isExactRecord(body, ['claudeAiOauth']) || !isKnownClaudeOauthShape(body.claudeAiOauth)) return null;
  const token = body.claudeAiOauth.accessToken;
  if (typeof token !== 'string'
    || token.length === 0
    || Buffer.byteLength(token, 'utf8') > MAX_ACCESS_TOKEN_BYTES
    || /[\u0000\r\n]/u.test(token)) return null;
  return Buffer.from(token, 'utf8');
}

/**
 * Pure envelope selector for fixtures. It has no vault, portal, or lookup
 * authority; it only checks data already supplied by the caller.
 */
export function extractExactC1ClaudeToolAuthEnvelopeFixture(wire, opened) {
  if (!wire || wire.class !== C1_CLAUDE_TOOL_AUTH_CLASS
    || opened?.label !== C1_CLAUDE_TOOL_AUTH_LABEL) return null;
  return extractExactC1ClaudeToolAuthPayload(opened.data);
}

/** Strict, redacted child report parser. */
export function parseC1ClaudeChildReport(raw) {
  if (!Buffer.isBuffer(raw) || raw.length === 0 || raw.length > MAX_CHILD_OUTPUT_BYTES) return null;
  let value;
  try { value = JSON.parse(raw.toString('utf8').trim()); } catch { return null; }
  if (!isExactRecord(value, ['schema', 'status'])
    || value.schema !== C1_CLAUDE_CHILD_SCHEMA
    || !['passed', 'failed', 'indeterminate'].includes(value.status)) return null;
  return { status: value.status };
}

/**
 * Chunk-safe detector. It returns only a boolean, while checking raw, base64,
 * hexadecimal, URI-escaped and JSON-escaped forms of the supplied bytes.
 */
export function createC1CredentialLeakScanner(credentialBytes) {
  if (!Buffer.isBuffer(credentialBytes) || credentialBytes.length === 0) {
    throw new TypeError('credential bytes required');
  }
  const text = credentialBytes.toString('utf8');
  const needles = [...new Set([
    text,
    credentialBytes.toString('base64'),
    credentialBytes.toString('hex'),
    encodeURIComponent(text),
    JSON.stringify(text).slice(1, -1),
  ])].filter(Boolean);
  const tailLength = Math.max(0, ...needles.map((needle) => needle.length - 1));
  let tail = '';
  let leaked = false;
  return Object.freeze({
    push(chunk) {
      if (leaked) return true;
      const value = tail + Buffer.from(chunk).toString('utf8');
      leaked = needles.some((needle) => value.includes(needle));
      tail = value.slice(-tailLength);
      return leaked;
    },
    clear() {
      tail = '';
      leaked = false;
    },
  });
}

async function runC1ClaudeVaultLeaseCore() {
  // The lease host must be the only detached group leader. Refuse custody
  // work if this no longer belongs to that broker-owned group.
  if (currentC1ProcessGroupLeader() !== process.pid) return leaseFailure('failed');
  const portal = await resolveTrustedPortal();
  if (!portal) return leaseFailure('failed');

  const cache = await readCachedVaultKey().catch(() => null);
  if (!cache?.vaultKey) return leaseFailure('indeterminate');
  try {
    return await runC1ClaudeVaultLeaseWithCache(portal, cache);
  } finally {
    cache.vaultKeyBytes?.fill?.(0);
  }
}

async function runC1ClaudeVaultLeaseWithCache(portal, cache) {
  const status = await VaultApi.getStatus(portal).catch(() => null);
  if (!status?.ok || !status.vault?.setup || !status.vault.wrapped_crk || !status.vault.crk_iv) {
    return leaseFailure('indeterminate');
  }
  if (cache.authHash) {
    const unlocked = await VaultApi.unlockVault(portal, {
      authHash: cache.authHash,
      deviceId: cache.deviceId || null,
    }).catch(() => null);
    if (!unlocked?.ok) return leaseFailure('indeterminate');
  }
  let custodyRoot;
  try {
    custodyRoot = await unwrapCustodyRoot(cache.vaultKey, status.vault.wrapped_crk, status.vault.crk_iv);
  } catch {
    return leaseFailure('indeterminate');
  }
  const listed = await VaultApi.listSecrets(portal).catch(() => null);
  if (!listed?.ok || !Array.isArray(listed.secrets)) return leaseFailure('indeterminate');

  const matching = [];
  for (const wire of listed.secrets) {
    if (!isEnvelopeSecret(wire) || wire.class !== C1_CLAUDE_TOOL_AUTH_CLASS) continue;
    let label;
    try { label = await decryptEnvelopeLabel(custodyRoot, wire); } catch { continue; }
    if (label === C1_CLAUDE_TOOL_AUTH_LABEL) matching.push(wire);
  }
  if (matching.length !== 1) return leaseFailure('indeterminate');
  let opened;
  try { opened = await decryptEnvelopeSecret(custodyRoot, matching[0]); } catch {
    return leaseFailure('indeterminate');
  }
  const credentialBytes = extractExactC1ClaudeToolAuthEnvelopeFixture(matching[0], opened);
  if (!credentialBytes) return leaseFailure('indeterminate');
  try {
    return await spawnFixedC1Child(credentialBytes);
  } finally {
    credentialBytes.fill(0);
  }
}

async function resolveTrustedPortal() {
  const token = await keychainGet(MEMORO_PRIMARY_AUTH_TOKEN_ACCOUNT).catch(() => null);
  if (!token) return null;
  const config = await readConfig().catch(() => ({}));
  return {
    apiUrl: config.apiUrl || 'https://meetmemoro.app',
    token,
    memoroFetch,
  };
}

async function spawnFixedC1Child(credentialBytes) {
  if (verifyInstalledC1SourceClosure()?.ok !== true) {
    return leaseFailure('failed');
  }
  let childPath;
  try {
    childPath = realpathSync(CHILD_PATH);
    if (childPath !== CHILD_PATH
      || sha256(readFileSync(childPath)) !== C1_CHILD_SOURCE_SHA256) {
      return leaseFailure('failed');
    }
  } catch {
    return leaseFailure('failed');
  }

  return new Promise((resolveLease) => {
    let child = null;
    let done = false;
    let outputBytes = 0;
    const stdout = [];
    let terminationStatus = null;
    const scanner = createC1CredentialLeakScanner(credentialBytes);
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      scanner.clear();
      for (const chunk of stdout) chunk.fill(0);
      resolveLease(value);
    };
    const requestTermination = (status) => {
      terminationStatus = terminationStatus === 'failed' ? 'failed' : status;
      killC1Chain(child);
      // The authoritative group kill includes this lease host. The outer
      // broker runner owns the final close acknowledgement and status.
      setTimeout(() => killC1Chain(child), 2_000).unref?.();
    };
    const timeout = setTimeout(() => {
      requestTermination('indeterminate');
    }, CHILD_TIMEOUT_MS);
    try {
      child = spawn(process.execPath, [childPath], {
        cwd: PACKAGE_ROOT,
        env: {
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          LANG: 'C',
          LC_ALL: 'C',
          ...c1GroupEnvironmentForDescendant(),
        },
        shell: false,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      });
      const inspect = (chunk, collect) => {
        outputBytes += chunk.length;
        const leaked = scanner.push(chunk);
        if (leaked || outputBytes > MAX_CHILD_OUTPUT_BYTES) {
          requestTermination('failed');
          return;
        }
        if (collect) stdout.push(Buffer.from(chunk));
      };
      child.stdout.on('data', (chunk) => inspect(chunk, true));
      child.stderr.on('data', (chunk) => inspect(chunk, false));
      child.once('error', () => {
        requestTermination('failed');
        if (!child?.pid) finish(leaseFailure('failed'));
      });
      child.once('close', () => {
        if (terminationStatus) {
          finish(leaseFailure(terminationStatus));
          return;
        }
        const raw = Buffer.concat(stdout);
        const report = parseC1ClaudeChildReport(raw);
        raw.fill(0);
        finish(report ? { status: report.status } : leaseFailure('failed'));
      });
      const credentialPipe = child.stdio[3];
      if (!credentialPipe) {
        requestTermination('failed');
        return;
      }
      credentialPipe.once('error', () => requestTermination('failed'));
      credentialPipe.end(credentialBytes, () => credentialBytes.fill(0));
    } catch {
      killC1Chain(child);
      finish(leaseFailure('failed'));
    }
  });
}

function killC1Chain(child) {
  if (killCurrentC1ProcessGroup()) return;
  if (!child) return;
  try { child.kill('SIGKILL'); } catch {}
}

function leaseFailure(status) {
  return { status: status === 'indeterminate' ? 'indeterminate' : 'failed' };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isExactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isKnownClaudeOauthShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const known = new Set([
    'accessToken',
    'refreshToken',
    'expiresAt',
    'scopes',
    'subscriptionType',
    'rateLimitTier',
  ]);
  const keys = Object.keys(value);
  if (!keys.includes('accessToken') || keys.some((key) => !known.has(key))) return false;
  if ('refreshToken' in value && typeof value.refreshToken !== 'string') return false;
  if ('expiresAt' in value && typeof value.expiresAt !== 'string' && typeof value.expiresAt !== 'number') return false;
  if ('scopes' in value && (!Array.isArray(value.scopes) || !value.scopes.every((scope) => typeof scope === 'string'))) return false;
  return (!('subscriptionType' in value) || typeof value.subscriptionType === 'string')
    && (!('rateLimitTier' in value) || typeof value.rateLimitTier === 'string');
}
