import { createConnection } from 'node:net';

import { brokerSocketPath } from './paths.js';

const DEFAULT_TIMEOUT_MS = 1_000;

export function requestBroker(message, {
  socketPath = brokerSocketPath(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  connect = createConnection,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let raw = '';
    let socket;

    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) {
        socket.removeAllListeners();
        try { socket.destroy(); } catch {}
      }
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      done(new Error(`broker request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    try {
      socket = connect(socketPath);
    } catch (err) {
      done(err);
      return;
    }

    socket.setEncoding('utf8');
    socket.on('error', (err) => done(err));
    socket.on('data', (chunk) => { raw += chunk; });
    socket.on('end', () => {
      try {
        const parsed = JSON.parse(raw || '{}');
        done(null, parsed);
      } catch (err) {
        done(new Error(`invalid broker response: ${err.message}`));
      }
    });
    socket.on('connect', () => {
      socket.end(JSON.stringify(message || {}) + '\n');
    });
  });
}

export const __test__ = { DEFAULT_TIMEOUT_MS };
