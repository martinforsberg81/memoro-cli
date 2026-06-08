import { createServer } from 'node:net';

export function handleDispatchSocketPayload(raw, { deliver } = {}) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { response: { ok: false, error: 'invalid JSON' } };
  }

  const message = payload?.message;
  if (typeof message !== 'string' || !message.trim()) {
    return { response: { ok: false, error: 'message required' } };
  }

  if (typeof deliver === 'function') deliver(message);
  return { response: { ok: true, message } };
}

export function responseLine(response) {
  return JSON.stringify(response) + '\n';
}

export function createDispatchSocketServer({ deliver } = {}) {
  return createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => { buf += chunk.toString('utf8'); });
    conn.on('end', () => {
      const { response } = handleDispatchSocketPayload(buf, { deliver });
      conn.end(responseLine(response));
    });
  });
}
