import {
  chmodSync,
  lstatSync,
  unlinkSync,
} from 'node:fs';
import { createServer } from 'node:net';

import { ensurePrivateDirectoryChainSync } from '../../mc/private-state.js';
import { sessionHomePaths } from '../../mc/session-home-paths.js';
import {
  SESSION_HOST_PROTOCOL_VERSION,
  SessionHostFrameDecoder,
  encodeSessionHostFrame,
} from './protocol.js';
import { runtimeHostError } from './runtime-host.js';

export class SessionRuntimeSocketServer {
  constructor({
    mcHomeDir,
    host,
    serverFactory = (handler) => createServer(handler),
  } = {}) {
    if (!host?.mcSessionId || !host?.generationId || typeof host.attach !== 'function') {
      throw new TypeError('SessionRuntimeHost is required');
    }
    this.host = host;
    this.paths = sessionHomePaths({ mcHomeDir, mcSessionId: host.mcSessionId });
    this.serverFactory = serverFactory;
    this.server = null;
    this.socketIdentity = null;
    this.started = false;
    this.connections = new Set();
  }

  async start() {
    if (this.started) return this.address();
    ensurePrivateDirectoryChainSync({
      trustedRoot: this.paths.mcHomeDir,
      directory: this.paths.ephemeralRunPath,
    });
    if (pathExists(this.paths.runtimeHostSocketPath)) {
      throw runtimeHostError('runtime-socket-already-exists');
    }
    this.server = this.serverFactory((socket) => this.acceptConnection(socket));
    await listenServer(this.server, this.paths.runtimeHostSocketPath);
    chmodSync(this.paths.runtimeHostSocketPath, 0o600);
    const stat = lstatSync(this.paths.runtimeHostSocketPath);
    if (!stat.isSocket() || stat.isSymbolicLink()) {
      await closeServer(this.server);
      throw runtimeHostError('runtime-socket-publication-unsafe');
    }
    this.socketIdentity = { dev: stat.dev, ino: stat.ino };
    this.started = true;
    return this.address();
  }

  address() {
    return {
      mc_session_id: this.host.mcSessionId,
      generation_id: this.host.generationId,
      socket_path: this.paths.runtimeHostSocketPath,
    };
  }

  async stop() {
    if (!this.server) return;
    for (const socket of this.connections) {
      try { socket.destroy(); } catch {}
    }
    this.connections.clear();
    await closeServer(this.server);
    this.server = null;
    this.started = false;
    try {
      const stat = lstatSync(this.paths.runtimeHostSocketPath);
      if (stat.isSocket()
        && !stat.isSymbolicLink()
        && stat.dev === this.socketIdentity?.dev
        && stat.ino === this.socketIdentity?.ino) {
        unlinkSync(this.paths.runtimeHostSocketPath);
      }
    } catch {}
    this.socketIdentity = null;
  }

  acceptConnection(socket) {
    this.connections.add(socket);
    socket.once?.('close', () => this.connections.delete(socket));
    const decoder = new SessionHostFrameDecoder({ direction: 'client' });
    let clientId = null;
    let chain = Promise.resolve();
    socket.on('data', (chunk) => {
      let frames;
      try { frames = decoder.push(chunk); } catch (error) {
        sendTerminalError(socket, error.reason || 'invalid-client-frame');
        return;
      }
      for (const frame of frames) {
        chain = chain.then(async () => {
          if (frame.type === 'status' && clientId === null) {
            socket.write(encodeSessionHostFrame(this.host.statusFrame(), { direction: 'server' }));
            return;
          }
          if (clientId === null) {
            if (frame.type !== 'attach'
              || frame.mc_session_id !== this.host.mcSessionId
              || frame.generation_id !== this.host.generationId) {
              throw runtimeHostError('runtime-identity-mismatch');
            }
            const attached = await this.host.attach(socket, {
              cols: frame.cols,
              rows: frame.rows,
            });
            clientId = attached.client_id;
            return;
          }
          await this.host.handleClientFrame(clientId, frame);
        }).catch((error) => {
          sendTerminalError(socket, stableErrorCode(error));
        });
      }
    });
  }
}

function sendTerminalError(socket, code) {
  const frame = encodeSessionHostFrame({
    v: SESSION_HOST_PROTOCOL_VERSION,
    type: 'error',
    code: /^[a-z][a-z0-9-]{0,63}$/u.test(code || '') ? code : 'runtime-request-failed',
  }, { direction: 'server' });
  try { socket.end(frame); } catch { try { socket.destroy(); } catch {} }
}

function stableErrorCode(error) {
  return /^[a-z][a-z0-9-]{0,63}$/u.test(error?.reason || '')
    ? error.reason
    : 'runtime-request-failed';
}

function listenServer(server, path) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off?.('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off?.('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(path);
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    try { server.close(() => resolve()); } catch { resolve(); }
  });
}

function pathExists(path) {
  try { lstatSync(path); return true; } catch { return false; }
}
