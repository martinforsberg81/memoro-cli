#!/usr/bin/env node

/**
 * Fixed, short-lived custody host for the Claude C1 lease.
 *
 * This executable deliberately accepts no arguments or credential-bearing
 * environment input. It is started only by the fixed broker runner and emits
 * one redacted status record before terminating.
 */

import { Socket } from 'node:net';

import {
  C1_INTERNAL_GROUP_ENV,
  C1_INTERNAL_LEASE_HOST_ENV,
  isCurrentProcessC1GroupLeader,
  killCurrentC1ProcessGroup,
} from './c1-process-group.js';
import { verifyInstalledC1SourceClosure } from './c1-source-closure.js';

const C1_LEASE_HOST_SCHEMA = 1;
const BROKER_LIVENESS_FD = 3;
const STATUSES = new Set(['passed', 'failed', 'indeterminate']);

async function main() {
  let status = 'failed';
  try {
    if (process.env[C1_INTERNAL_LEASE_HOST_ENV] !== '1'
      || !isCurrentProcessC1GroupLeader()) {
      return writeStatus(status);
    }
    // This is an internal, non-secret authority for trusted descendants. The
    // sandboxed Claude child receives an explicitly rebuilt environment that
    // omits it.
    process.env[C1_INTERNAL_GROUP_ENV] = String(process.pid);
    const liveness = startBrokerLivenessMonitor();
    if (!liveness) return writeStatus(status);
    try {
      if (verifyInstalledC1SourceClosure()?.ok !== true) {
        return writeStatus(status);
      }
      // Custody code is intentionally loaded only after its complete source
      // dependency closure has been rebound and hashed by this short-lived
      // host. No vault module is imported by the long-lived broker.
      const { runC1ClaudeVaultLease } = await import('../vault/c1-claude-lease.js');
      const result = await runC1ClaudeVaultLease();
      if (isExactStatus(result)) status = result.status;
    } finally {
      // A normal terminal path must detach the EOF watcher before its own
      // descriptor closes. Broker crash/kill never reaches this point.
      liveness.stop();
    }
  } catch {
    status = 'failed';
  }
  writeStatus(status);
}

/** Token-free fixture for the broker-death EOF behaviour. */
export function watchBrokerLivenessFixture(stream, { killGroup } = {}) {
  if (!stream || typeof stream.once !== 'function' || typeof killGroup !== 'function') return null;
  let active = true;
  const terminal = () => {
    if (!active) return;
    active = false;
    killGroup();
  };
  stream.once('end', terminal);
  stream.once('close', terminal);
  stream.once('error', terminal);
  return Object.freeze({
    stop() {
      if (!active) return;
      active = false;
      stream.removeListener?.('end', terminal);
      stream.removeListener?.('close', terminal);
      stream.removeListener?.('error', terminal);
      try { stream.destroy?.(); } catch {}
    },
  });
}

function startBrokerLivenessMonitor() {
  try {
    const stream = new Socket({
      fd: BROKER_LIVENESS_FD,
      readable: true,
      writable: false,
    });
    const monitor = watchBrokerLivenessFixture(stream, {
      killGroup: () => { killCurrentC1ProcessGroup(); },
    });
    if (!monitor) {
      stream.destroy();
      return null;
    }
    stream.resume();
    return monitor;
  } catch {
    return null;
  }
}

function isExactStatus(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && STATUSES.has(value.status);
}

function writeStatus(status) {
  process.stdout.write(`${JSON.stringify({ schema: C1_LEASE_HOST_SCHEMA, status })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
