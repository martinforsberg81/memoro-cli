/**
 * Local certification receipt for the managed Claude substrate.
 *
 * A receipt is written only after the broker-owned hostile C1 run passes. It
 * is bound to the exact C1 source closure, Claude/SRT artifacts, platform,
 * architecture, and OS release. It contains no session identity or secret.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { arch, platform, release } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { C1_SOURCE_CLOSURE_SHA256 } from '../../runtime/broker/c1-source-closure.js';
import { CLAUDE_C1_ARTIFACT_PINS } from '../../runtime/broker/c1-artifacts.js';
import { mcHome } from '../../mc/paths.js';

const SCHEMA = 'mc-managed-claude-c1-certification/v1';

export function writeManagedClaudeCertificationSync({
  root = mcHome(),
  checkedAt = new Date().toISOString(),
} = {}) {
  if (!isAbsolute(root || '') || !validIso(checkedAt)) {
    return failure('managed-claude-certification-input-invalid');
  }
  const path = certificationPath(root);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const receipt = expectedReceipt({ checkedAt });
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    return { ok: true, path, receipt };
  } catch {
    return failure('managed-claude-certification-write-failed');
  }
}

export function inspectManagedClaudeCertificationSync({
  root = mcHome(),
} = {}) {
  if (!isAbsolute(root || '')) {
    return failure('managed-claude-certification-input-invalid');
  }
  const path = certificationPath(root);
  try {
    const info = lstatSync(path);
    if (!info.isFile()
      || info.isSymbolicLink()
      || (info.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())
      || realpathSync(path) !== resolve(path)) {
      return failure('managed-claude-certification-untrusted');
    }
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    if (!validReceipt(receipt)) {
      return failure('managed-claude-certification-stale');
    }
    return { ok: true, path, receipt };
  } catch {
    return failure('managed-claude-certification-missing');
  }
}

export function managedClaudeC1SourceClosureDigest() {
  return sha256(JSON.stringify(
    Object.fromEntries(
      Object.entries(C1_SOURCE_CLOSURE_SHA256)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  ));
}

function expectedReceipt({ checkedAt }) {
  return {
    schema: SCHEMA,
    status: 'passed',
    platform: platform(),
    arch: arch(),
    os_release: release(),
    claude_version: CLAUDE_C1_ARTIFACT_PINS.version,
    claude_sha256: CLAUDE_C1_ARTIFACT_PINS.sha256,
    srt_version: CLAUDE_C1_ARTIFACT_PINS.srtVersion,
    srt_tree_sha256: CLAUDE_C1_ARTIFACT_PINS.srtTreeSha256,
    source_closure_sha256: managedClaudeC1SourceClosureDigest(),
    checked_at: checkedAt,
  };
}

function validReceipt(value) {
  if (!exactRecord(value, [
    'schema',
    'status',
    'platform',
    'arch',
    'os_release',
    'claude_version',
    'claude_sha256',
    'srt_version',
    'srt_tree_sha256',
    'source_closure_sha256',
    'checked_at',
  ])
    || !validIso(value.checked_at)) return false;
  const expected = expectedReceipt({ checkedAt: value.checked_at });
  return Object.entries(expected).every(([key, expectedValue]) => (
    value[key] === expectedValue
  ));
}

function certificationPath(root) {
  return join(resolve(root), 'security', 'managed-claude-c1.json');
}

function validIso(value) {
  return typeof value === 'string'
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function exactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function failure(reason) {
  return { ok: false, reason, error: reason };
}
