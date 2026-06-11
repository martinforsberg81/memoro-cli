import { join } from 'node:path';

import { mcHome } from '../paths.js';

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
