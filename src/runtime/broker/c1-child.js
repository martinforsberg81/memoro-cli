#!/usr/bin/env node

/** Fixed child for the C1 broker lease. It owns no vault or portal access. */

import { closeSync, readSync } from 'node:fs';

import { verifyInstalledClaudeC1Artifacts } from './c1-artifacts.js';
import { currentC1ProcessGroupLeader } from './c1-process-group.js';
import { verifyInstalledC1SourceClosure } from './c1-source-closure.js';

const CREDENTIAL_FD = 3;
const MAX_CREDENTIAL_BYTES = 256 * 1024;
const C1_CLAUDE_CHILD_SCHEMA = 1;

async function main() {
  let credentialBytes = null;
  try {
    if (!currentC1ProcessGroupLeader()) return writeStatus('failed');
    if (verifyInstalledC1SourceClosure()?.ok !== true) return writeStatus('failed');
    const verified = verifyInstalledClaudeC1Artifacts();
    if (!verified?.ok) return writeStatus('indeterminate');
    credentialBytes = readCredentialFd();
    if (!credentialBytes || credentialBytes.length === 0
      || credentialBytes.includes(0x0a) || credentialBytes.includes(0x0d)) {
      return writeStatus('failed');
    }
    // The harness and its runtime are dynamically evaluated only after the
    // complete project-source closure was verified, and immediately before
    // they receive the anonymous credential buffer.
    const { runManagedClaudeC1Harness } = await import(
      '../../../scripts/security/managed-claude-c1-harness.mjs'
    );
    const report = await runManagedClaudeC1Harness({
      credentialBytes,
    });
    return writeStatus(report?.pass === true ? 'passed' : 'failed');
  } catch {
    return writeStatus('indeterminate');
  } finally {
    if (credentialBytes) credentialBytes.fill(0);
    closeCredentialFd();
  }
}

function readCredentialFd() {
  const chunks = [];
  let size = 0;
  const block = Buffer.allocUnsafe(4096);
  try {
    for (;;) {
      const read = readSync(CREDENTIAL_FD, block, 0, block.length, null);
      if (read === 0) break;
      size += read;
      if (size > MAX_CREDENTIAL_BYTES) return null;
      chunks.push(Buffer.from(block.subarray(0, read)));
    }
    return Buffer.concat(chunks, size);
  } finally {
    block.fill(0);
    for (const chunk of chunks) chunk.fill(0);
    closeCredentialFd();
  }
}

function closeCredentialFd() {
  try { closeSync(CREDENTIAL_FD); } catch {}
}

function writeStatus(status) {
  process.stdout.write(`${JSON.stringify({ schema: C1_CLAUDE_CHILD_SCHEMA, status })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
