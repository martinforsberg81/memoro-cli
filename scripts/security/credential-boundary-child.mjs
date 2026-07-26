import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { spawnSync } from 'node:child_process';

const [canaryPath, socketPath, repoRoot] = process.argv.slice(2);

function canReadCanaryFile() {
  try {
    readFileSync(canaryPath);
    return true;
  } catch {
    return false;
  }
}

function environmentContainsCanary() {
  return Object.hasOwn(process.env, 'MC_BOUNDARY_CANARY');
}

function parentProcessExposesCanary() {
  try {
    if (process.platform === 'linux') {
      const body = readFileSync(`/proc/${process.ppid}/environ`);
      return body.includes(Buffer.from('MC_BOUNDARY_CANARY='));
    }
    const result = spawnSync('/bin/ps', ['eww', '-p', String(process.ppid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 2_000,
    });
    return result.status === 0 && String(result.stdout).includes('MC_BOUNDARY_CANARY=');
  } catch {
    return false;
  }
}

function canInvokeVaultAdminSurface() {
  const result = spawnSync(process.execPath, [
    `${repoRoot}/src/mc-cli.js`,
    'vault',
    '--help',
  ], {
    env: {
      PATH: process.env.PATH || '',
      MC_HOME: canaryPath.replace(/\/canary$/, ''),
    },
    encoding: 'utf8',
    timeout: 5_000,
  });
  return result.status === 0;
}

function canConnect(options, timeoutMs = 750) {
  return new Promise((resolve) => {
    const socket = connect(options);
    let settled = false;
    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

const result = {
  schema: 1,
  file_readable: canReadCanaryFile(),
  canary_in_environment: environmentContainsCanary(),
  canary_in_argv: process.argv.some((value) => value.includes('MC_BOUNDARY_CANARY=')),
  parent_process_exposes_canary: parentProcessExposesCanary(),
  credential_socket_reachable: await canConnect({ path: socketPath }),
  external_network_reachable: await canConnect({ host: '1.1.1.1', port: 443 }),
  vault_admin_surface_callable: canInvokeVaultAdminSurface(),
};

process.stdout.write(`${JSON.stringify(result)}\n`);
