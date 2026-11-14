/** The public, credential-free wire contract; both ends reject rather than guess. */
import { readFileSync } from 'node:fs';

export const MC_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
export const DESCRIPTOR_VERSION = 1;
export const ENTRANCES = new Set(['plan', 'manager', 'brief', 'martin', 'helper']);
const string = value => typeof value === 'string' && value.length > 0;
const nullable = value => value === null || string(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key));

export function validateDescriptor(value, { destination = 'server', localVersion = MC_VERSION } = {}) {
  const versions = `mc ${localVersion} here, mc ${value?.mcVersion ?? 'unknown'} on ${destination}`;
  const refuse = reason => { throw new Error(`${reason} (${versions})`); };
  if (value?.version !== DESCRIPTOR_VERSION) refuse(`mc here does not know descriptor v${value?.version ?? 'unknown'} from ${destination}`);
  const common = ['version', 'mcVersion', 'kind'];
  if (!string(value.mcVersion)) refuse('descriptor has no mc version');
  const shape = (keys) => { if (!exact(value, [...common, ...keys])) refuse('descriptor has unknown or missing fields'); };
  if (value.kind === 'handshake') shape([]);
  else if (value.kind === 'refusal') { shape(['reason']); if (!string(value.reason)) refuse('descriptor has no refusal reason'); }
  else if (value.kind === 'question') {
    shape(['title', 'items']);
    if (!string(value.title) || (value.items !== null && (!Array.isArray(value.items)
      || !value.items.every(item => exact(item, ['key', 'value', 'name', 'label'])
        && ['string', 'number'].includes(typeof item.key) && string(item.value) && string(item.name) && string(item.label))))) refuse('invalid question descriptor');
  } else if (value.kind === 'session') {
    const keys = ['provider', 'providerVersion', 'id', 'name', 'sessionId', 'started'];
    if (value.provider === 'codex') keys.push('socket', 'access');
    shape(keys);
    if (!['codex', 'claude-code'].includes(value.provider) || !string(value.providerVersion)
      || !string(value.id) || !string(value.name) || !nullable(value.sessionId) || !nullable(value.started)) refuse('invalid session descriptor');
    if (value.provider === 'codex') {
      if (!string(value.socket) || !value.socket.startsWith('/') || /[\x00\r\n:]/u.test(value.socket)) refuse('invalid server socket path');
      const access = value.access;
      if (!Array.isArray(access) || (value.sessionId !== null && access.length)) refuse('access flags are only for a new Codex thread');
      if (access.length && !(access.length === 2 || access.length === 4)) refuse('invalid client access flags');
      if (access.length && (access[0] !== '--sandbox' || !['read-only', 'workspace-write', 'danger-full-access'].includes(access[1]))) refuse('invalid client sandbox');
      if (access.length === 4 && (access[2] !== '--ask-for-approval' || !['untrusted', 'on-failure', 'on-request', 'never'].includes(access[3]))) refuse('invalid client approval policy');
    }
  } else if (value.kind === 'snapshot') {
    shape(['provider', 'providerVersion', 'chosen', 'sessions']);
    if (!['codex', 'claude-code'].includes(value.provider) || !string(value.providerVersion) || !nullable(value.chosen)
      || !Array.isArray(value.sessions)) refuse('invalid snapshot descriptor');
    for (const session of value.sessions) {
      validateDescriptor(session, { destination, localVersion });
      if (session.kind !== 'session' || session.provider !== value.provider) refuse('invalid snapshot member');
    }
  } else if (value.kind === 'result') {
    shape(['status', 'signal']);
    if (!Number.isInteger(value.status) || value.status < 0 || !nullable(value.signal)) refuse('invalid result descriptor');
  } else refuse(`unknown descriptor kind ${value.kind}`);
  return value;
}

export function descriptor(kind, fields = {}) {
  return validateDescriptor({ version: DESCRIPTOR_VERSION, mcVersion: MC_VERSION, kind, ...fields });
}

/** Only these explicitly enumerated members ever leave a provider launch. */
export function sessionDescriptor(session, provider, providerVersion) {
  return descriptor('session', { provider, providerVersion, id: session.id, name: session.name,
    sessionId: session.resume ?? null, started: session.started ?? null,
    ...(provider === 'codex' ? { socket: session.socket, access: session.resume ? [] : session.access ?? [] } : {}) });
}
