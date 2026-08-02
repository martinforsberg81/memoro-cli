import { join } from 'node:path';

import { mcHome } from '../../mc/paths.js';

export function brokerSocketPath() {
  return join(mcHome(), 'broker.sock');
}

export function brokerPidPath() {
  return join(mcHome(), 'broker.pid');
}

export function brokerLogPath() {
  return join(mcHome(), 'broker.log');
}

export function brokerCloudPidPath() {
  return join(mcHome(), 'broker-cloud.pid');
}

export function brokerCloudLogPath() {
  return join(mcHome(), 'broker-cloud.log');
}

export function sessionHostsDir() {
  return join(mcHome(), 'hosts');
}

export function sessionHostPaths(sessionId, { root = mcHome() } = {}) {
  const dir = join(root, 'hosts', sanitizePathPart(sessionId || 'unknown'));
  return {
    dir,
    socketPath: join(dir, 'broker.sock'),
    artifactSocketPath: join(dir, 'provider-artifact.sock'),
    pidPath: join(dir, 'broker.pid'),
    logPath: join(dir, 'broker.log'),
    manifestPath: join(dir, 'host.json'),
    lifecyclePath: join(dir, 'lifecycle.json'),
    handoffSwitchPath: join(dir, 'handoff-switch.json'),
    handoffLaunchTailPath: join(dir, 'handoff-launch-tail.txt'),
    providerArtifactsDir: join(dir, 'provider-artifacts'),
  };
}

export function providerArtifactPath(sessionId, runtimeGeneration, options = {}) {
  return join(
    sessionHostPaths(sessionId, options).providerArtifactsDir,
    `${sanitizePathPart(runtimeGeneration || 'unknown')}.json`,
  );
}

function sanitizePathPart(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .slice(0, 160) || 'unknown';
}
