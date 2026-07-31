import {
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';

const DIGEST = /^[a-f0-9]{64}$/;
const ROOT_DOMAIN = 'mc-handoff-controller-root-v1';
const TRANSACTION_DOMAIN = 'mc-handoff-controller-transaction-v1';

/**
 * Derive a controller-only root from Memoro authority already held by mc.
 * The root and transaction capability stay in controller memory and broker
 * IPC; only the one-way capability digest may be persisted.
 */
export function deriveHandoffControllerRoot({ token, codingSessionId } = {}) {
  if (typeof token !== 'string' || token.length < 1
    || typeof codingSessionId !== 'string' || codingSessionId.length < 1) {
    return null;
  }
  return createHmac('sha256', token)
    .update(`${ROOT_DOMAIN}\0${codingSessionId}`)
    .digest('hex');
}

export function deriveHandoffControllerCapability({
  root,
  transactionId,
} = {}) {
  if (!DIGEST.test(root || '')
    || typeof transactionId !== 'string' || transactionId.length < 1) {
    return null;
  }
  return createHmac('sha256', root)
    .update(`${TRANSACTION_DOMAIN}\0${transactionId}`)
    .digest('hex');
}

export function handoffControllerCapabilityDigest(capability) {
  return DIGEST.test(capability || '')
    ? createHash('sha256').update(capability).digest('hex')
    : null;
}

export function matchesHandoffControllerCapability(capability, digest) {
  const actual = handoffControllerCapabilityDigest(capability);
  if (!actual || !DIGEST.test(digest || '')) return false;
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(digest, 'hex'));
}

export function matchesHandoffControllerRoot(candidate, expected) {
  if (!DIGEST.test(candidate || '') || !DIGEST.test(expected || '')) return false;
  return timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(expected, 'hex'));
}
