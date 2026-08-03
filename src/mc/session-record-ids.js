import { randomBytes } from 'node:crypto';

export const WORKSPACE_ID_RE = /^mcw_[a-f0-9]{24}$/u;
export const RESOURCE_ID_RE = /^mcr_[a-f0-9]{24}$/u;
export const CONVERSATION_ID_RE = /^mcc_[a-f0-9]{24}$/u;
export const GENERATION_ID_RE = /^mcg_[a-f0-9]{24}$/u;

export function mintWorkspaceId(random = randomBytes) {
  return `mcw_${random(12).toString('hex')}`;
}

export function mintResourceId(random = randomBytes) {
  return `mcr_${random(12).toString('hex')}`;
}

export function mintConversationId(random = randomBytes) {
  return `mcc_${random(12).toString('hex')}`;
}

export function mintGenerationId(random = randomBytes) {
  return `mcg_${random(12).toString('hex')}`;
}

export function assertWorkspaceId(value) {
  if (!WORKSPACE_ID_RE.test(value || '')) throw new TypeError('invalid workspace id');
}

export function assertResourceId(value) {
  if (!RESOURCE_ID_RE.test(value || '')) throw new TypeError('invalid resource id');
}

export function assertConversationId(value) {
  if (!CONVERSATION_ID_RE.test(value || '')) throw new TypeError('invalid conversation id');
}

export function assertGenerationId(value) {
  if (!GENERATION_ID_RE.test(value || '')) throw new TypeError('invalid generation id');
}
