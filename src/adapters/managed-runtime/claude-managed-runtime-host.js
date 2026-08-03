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
  '774bab6cfd680ffa7a9d14a7345b52ace73cb242dd89f8565fc5088f364b3bc9';

async function main() {
  if (!verifyFixedSourceClosure()) return 1;
  const parsed = parseHostArgv(process.argv.slice(2));
  if (!parsed) return 1;
  let manifestBody;
  let manifest;
  try {
    manifestBody = readFileSync(parsed.manifestPath, 'utf8');
    manifest = JSON.parse(manifestBody);
  } catch {
    return 1;
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
    return 1;
  }
  const checked = validateManagedClaudeDescriptor(descriptor);
  if (!checked.ok) return 1;
  const result = await runManagedClaudeRuntime({
    descriptor,
    argv: parsed.providerArgv,
    inheritedEnv: process.env,
  });
  return result?.ok ? 0 : 1;
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
