#!/usr/bin/env node

/**
 * Fixed executable host for a normal managed Claude session.
 *
 * It accepts one manifest path selected by the registered adapter and ordinary
 * provider argv after `--`. The manifest is hash-bound by the broker
 * descriptor; no credential or controller capability is accepted here.
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  verifyInstalledManagedClaudeRuntimeSourceClosure,
} from './claude-managed-runtime-source-closure.js';

const SOURCE_CLOSURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'claude-managed-runtime-source-closure.js',
);
const SOURCE_CLOSURE_SHA256 =
  '4f6c46bd1a6114e329383c6e4a44edce1133a4cb880f2ba021751ac679c94d73';

/**
 * Every refusal here used to be a bare `return 1`, so a managed Claude launch
 * that failed produced a process that lived a few hundred milliseconds, wrote
 * nothing at all, and left the session reporting `runtime-not-attachable` —
 * the echo of a decision taken several layers down. Naming the step costs one
 * line and no secrecy: these are refusal reasons, not credentials, argv, or
 * environment.
 */
function refuse(code) {
  try { process.stderr.write(`mc: managed claude runtime refused (${code})\n`); } catch {}
  return 1;
}

async function main() {
  if (!verifyFixedSourceClosure()) return refuse('source-closure-mismatch');
  const parsed = parseHostArgv(process.argv.slice(2));
  if (!parsed) return refuse('host-argv-invalid');
  let manifestBody;
  let manifest;
  try {
    manifestBody = readFileSync(parsed.manifestPath, 'utf8');
    manifest = JSON.parse(manifestBody);
  } catch {
    return refuse('manifest-unreadable');
  }
  const descriptor = {
    ...manifest,
    manifest_path: parsed.manifestPath,
    manifest_sha256: sha256(manifestBody),
  };
  let validateManagedClaudeDescriptor;
  let runManagedClaudeRuntime;
  try {
    ({ validateManagedClaudeDescriptor } = await import('./claude-managed.js'));
    ({ runManagedClaudeRuntime } = await import('./claude-managed-runtime.js'));
  } catch {
    return refuse('runtime-module-unavailable');
  }
  const checked = validateManagedClaudeDescriptor(descriptor);
  if (!checked.ok) return refuse(`descriptor-${checked.reason || 'invalid'}`);
  const result = await runManagedClaudeRuntime({
    descriptor,
    argv: parsed.providerArgv,
    inheritedEnv: process.env,
  });
  return result?.ok ? 0 : refuse(`runtime-${result?.reason || 'failed'}`);
}

function verifyFixedSourceClosure() {
  try {
    return realpathSync(SOURCE_CLOSURE_PATH) === SOURCE_CLOSURE_PATH
      && sha256(readFileSync(SOURCE_CLOSURE_PATH)) === SOURCE_CLOSURE_SHA256
      && verifyInstalledManagedClaudeRuntimeSourceClosure()?.ok === true;
  } catch {
    return false;
  }
}

export function parseHostArgv(value) {
  if (!Array.isArray(value)
    || value.length < 3
    || value[0] !== '--manifest'
    || typeof value[1] !== 'string'
    || !value[1].startsWith('/')
    || value[2] !== '--'
    || value.slice(3).some((part) => typeof part !== 'string')) return null;
  return {
    manifestPath: value[1],
    providerArgv: value.slice(3),
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
