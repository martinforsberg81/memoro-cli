import { createConnection } from 'node:net';

import { requestBroker } from './client.js';
import { brokerSocketPath } from './paths.js';

export function attachBrokerSession({
  id,
  socketPath = brokerSocketPath(),
  connect = createConnection,
  request = requestBroker,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  cols = stdout.columns || 80,
  rows = stdout.rows || 24,
  writer = true,
} = {}) {
  if (!id) {
    stderr.write('mc: session id required\n');
    return Promise.resolve(2);
  }

  return new Promise((resolve) => {
    let socket = null;
    let settled = false;
    let attached = false;
    let header = Buffer.alloc(0);
    let rawModeSet = false;

    const cleanup = (code) => {
      if (settled) return;
      settled = true;
      socket?.removeAllListeners?.();
      stdin.off?.('data', onStdinData);
      stdout.off?.('resize', onResize);
      if (rawModeSet && stdin.isTTY) {
        try { stdin.setRawMode(false); } catch {}
      }
      try { stdin.pause?.(); } catch {}
      try { socket?.destroy?.(); } catch {}
      resolve(code);
    };

    const onStdinData = (chunk) => {
      if (socket && !socket.destroyed) socket.write(chunk);
    };

    const onResize = () => {
      request({
        type: 'resize_session',
        id,
        cols: stdout.columns || cols,
        rows: stdout.rows || rows,
      }).catch(() => {});
    };

    const onSocketData = (chunk) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (attached) {
        stdout.write(data);
        return;
      }

      const next = Buffer.concat([header, data]);
      const newline = next.indexOf(10);
      if (newline === -1) {
        header = next;
        return;
      }

      let ack;
      try {
        ack = JSON.parse(next.subarray(0, newline).toString('utf8') || '{}');
      } catch (err) {
        stderr.write(`mc: invalid attach response (${err.message})\n`);
        cleanup(1);
        return;
      }

      if (!ack.ok) {
        stderr.write(`mc: attach failed: ${ack.error || 'unknown'}\n`);
        cleanup(1);
        return;
      }
      if (ack.writer === false) {
        stderr.write('mc: attached read-only (another writer is active)\n');
      }

      attached = true;
      if (stdin.isTTY) {
        try {
          stdin.setRawMode(true);
          rawModeSet = true;
        } catch {}
      }
      stdin.resume?.();
      stdin.on?.('data', onStdinData);
      stdout.on?.('resize', onResize);

      const rest = next.subarray(newline + 1);
      if (rest.length) stdout.write(rest);
    };

    try {
      socket = connect(socketPath);
    } catch (err) {
      stderr.write(`mc: attach failed: ${err.message || String(err)}\n`);
      cleanup(1);
      return;
    }

    socket.on('connect', () => {
      socket.write(JSON.stringify({
        type: 'attach_session',
        id,
        cols,
        rows,
        writer,
        mode: writer ? 'write' : 'read-only',
      }) + '\n');
    });
    socket.on('data', onSocketData);
    socket.on('error', (err) => {
      if (!settled) stderr.write(`mc: attach failed: ${err.message || String(err)}\n`);
      cleanup(1);
    });
    socket.on('end', () => cleanup(attached ? 0 : 1));
    socket.on('close', () => cleanup(attached ? 0 : 1));
  });
}
