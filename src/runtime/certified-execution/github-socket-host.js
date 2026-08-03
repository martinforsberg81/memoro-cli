import { createServer } from 'node:net';
import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  executeGitHubControlPlaneOperation,
} from '../../capabilities/github/github-session.js';
import { decodeSessionCapabilities } from '../../capabilities/github/github-contract.js';
import { ensurePrivateDirectoryChainSync } from '../../mc/private-state.js';
import { assertMcSessionId } from '../../mc/session-home-schema.js';
import { sessionHomePaths } from '../../mc/session-home-paths.js';

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_CONNECTIONS = 16;
const REQUEST_TIMEOUT_MS = 30_000;

export class CertifiedGitHubSocketHost {
  #capabilities;
  #clients = new Set();
  #connectionClient;
  #createServer;
  #mcHomeDir;
  #mcSessionId;
  #memoroFetch;
  #server = null;
  #socketIdentity = null;
  #socketPath;
  #sourceId;
  #state = 'idle';
  #workspaceId;

  constructor({
    mcHomeDir,
    mcSessionId,
    sourceId,
    workspaceId,
    socketPath,
    capabilities,
    connectionClient,
    createServerImpl = (handler) => createServer({ allowHalfOpen: true }, handler),
    memoroFetchImpl,
  } = {}) {
    assertMcSessionId(mcSessionId);
    const paths = sessionHomePaths({ mcHomeDir, mcSessionId });
    if (socketPath !== paths.githubCapabilitySocketPath) {
      throw githubSocketError('certified-github-socket-path-invalid');
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(sourceId || '')
      || sourceId === 'memoro-cloud'
      || !/^mcw_[a-f0-9]{24}$/u.test(workspaceId || '')) {
      throw githubSocketError('certified-github-projection-identity-invalid');
    }
    const decoded = decodeSessionCapabilities(capabilities);
    if (decoded.github.state !== 'ready' || !connectionClient?.withGrant) {
      throw githubSocketError('certified-github-transport-unavailable');
    }
    this.#mcHomeDir = paths.mcHomeDir;
    this.#mcSessionId = mcSessionId;
    this.#sourceId = sourceId;
    this.#workspaceId = workspaceId;
    this.#socketPath = socketPath;
    this.#capabilities = decoded;
    this.#connectionClient = connectionClient;
    this.#createServer = createServerImpl;
    this.#memoroFetch = memoroFetchImpl;
  }

  async start() {
    if (this.#state !== 'idle') throw githubSocketError('certified-github-host-consumed');
    if (existsSync(this.#socketPath)) {
      throw githubSocketError('certified-github-socket-already-exists');
    }
    ensurePrivateDirectoryChainSync({
      trustedRoot: this.#mcHomeDir,
      directory: dirname(this.#socketPath),
    });
    const server = this.#createServer((socket) => this.#handle(socket));
    server.maxConnections = MAX_CONNECTIONS;
    this.#server = server;
    this.#state = 'starting';
    try {
      await listen(server, this.#socketPath);
      const socketStat = lstatSync(this.#socketPath);
      if (!socketStat.isSocket()) {
        throw githubSocketError('certified-github-socket-evidence-invalid');
      }
      this.#socketIdentity = { dev: socketStat.dev, ino: socketStat.ino };
      chmodSync(this.#socketPath, 0o600);
      this.#state = 'ready';
      return this;
    } catch (error) {
      this.#state = 'failed';
      try { server.close(); } catch {}
      try { this.#unlinkOwnedSocket(); } catch {}
      throw githubSocketError('certified-github-socket-listen-failed', error);
    }
  }

  status() {
    return Object.freeze({
      mc_session_id: this.#mcSessionId,
      state: this.#state,
      socket_path: this.#socketPath,
    });
  }

  async close() {
    if (this.#state === 'closed') return;
    const server = this.#server;
    this.#state = 'closed';
    for (const client of this.#clients) client.destroy();
    this.#clients.clear();
    if (server) await closeServer(server);
    this.#unlinkOwnedSocket();
  }

  #handle(socket) {
    this.#clients.add(socket);
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
    socket.once('close', () => this.#clients.delete(socket));
    let size = 0;
    const chunks = [];
    let refused = false;
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      if (refused) return;
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        refused = true;
        socket.destroy();
        return;
      }
      chunks.push(chunk);
    });
    socket.on('end', async () => {
      if (refused) return;
      let request;
      try { request = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); } catch {
        socket.end(`${JSON.stringify(invalidResponse())}\n`);
        return;
      }
      const response = await executeGitHubControlPlaneOperation({
        connectionClient: this.#connectionClient,
        mcSessionId: this.#mcSessionId,
        sourceId: this.#sourceId,
        workspaceId: this.#workspaceId,
        request,
        allowedOperations: this.#capabilities.github.operations,
        memoroFetchImpl: this.#memoroFetch,
      });
      socket.end(`${JSON.stringify(response)}\n`);
    });
  }

  #unlinkOwnedSocket() {
    const expected = this.#socketIdentity;
    if (!expected) return;
    try {
      const current = lstatSync(this.#socketPath);
      if (current.isSocket() && current.dev === expected.dev && current.ino === expected.ino) {
        unlinkSync(this.#socketPath);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    } finally {
      this.#socketIdentity = null;
    }
  }
}

export function githubSocketError(reason, cause = null) {
  const error = new Error(`mc certified GitHub socket error (${reason})`,
    cause ? { cause } : undefined);
  error.code = 'MC_CERTIFIED_GITHUB_SOCKET_ERROR';
  error.reason = reason;
  return error;
}

function listen(server, socketPath) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    try { server.close(() => resolve()); } catch { resolve(); }
  });
}

function invalidResponse() {
  return {
    ok: false,
    request_id: 'mcr_invalid_request',
    error: {
      code: 'invalid_params',
      message: 'GitHub operation parameters are invalid.',
      repair_action: null,
    },
  };
}
