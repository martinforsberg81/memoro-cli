/**
 * Fixed process-group authority for the broker-owned Claude C1 chain.
 *
 * Only the broker starts the lease host as a detached group leader. The host
 * gives its pid to trusted descendants through this internal environment
 * field. It is deliberately omitted from the sandboxed Claude environment.
 */

import { spawnSync } from 'node:child_process';

export const C1_INTERNAL_GROUP_ENV = 'MC_C1_INTERNAL_GROUP_LEADER_PID';
export const C1_INTERNAL_LEASE_HOST_ENV = 'MC_C1_INTERNAL_LEASE_HOST';

export function c1GroupEnvironmentForDescendant() {
  return Object.freeze({ [C1_INTERNAL_GROUP_ENV]: String(process.pid) });
}

export function isCurrentProcessC1GroupLeader() {
  const groupId = currentProcessGroupId();
  return Number.isInteger(groupId) && groupId === process.pid;
}

export function currentC1ProcessGroupLeader() {
  const raw = process.env[C1_INTERNAL_GROUP_ENV];
  if (!/^[1-9]\d{0,9}$/u.test(raw || '')) return null;
  const leaderPid = Number(raw);
  const groupId = currentProcessGroupId();
  return Number.isSafeInteger(leaderPid) && groupId === leaderPid ? leaderPid : null;
}

export function killCurrentC1ProcessGroup() {
  const leaderPid = currentC1ProcessGroupLeader();
  if (!leaderPid || process.platform === 'win32') return false;
  try {
    process.kill(-leaderPid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

function currentProcessGroupId() {
  if (process.platform === 'win32') return null;
  try {
    const result = spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)], {
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' },
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    });
    const raw = String(result?.stdout || '').trim();
    return /^[1-9]\d{0,9}$/u.test(raw) ? Number(raw) : null;
  } catch {
    return null;
  }
}
