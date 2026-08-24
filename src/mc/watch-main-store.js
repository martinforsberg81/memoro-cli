/**
 * What the main-watch remembers between passes.
 *
 * One measurement of the base branch, keyed by nothing but "the last one" —
 * the whole point is the transition, and a transition is this pass's red set
 * against the one before it. The commit is what tells the round main has not
 * moved (and so needs no measurement); the red set is what tells it whether
 * the move went red; `measured_at` and `source` are for the person reading
 * `mc watch main status`.
 *
 * Under `<mc home>/watch/`, beside the other legs' files (watch-paths.js),
 * never inside a repository.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { mcHome } from './paths.js';
import { watchRoot } from './watch-paths.js';

export const MAIN_STATE_SCHEMA = 'mc-watch-main';
export const MAIN_STATE_VERSION = 1;

export function mainStatePath(root = mcHome()) {
  return join(watchRoot(root), 'main.json');
}

export function readMainState({ root = mcHome() } = {}) {
  let value = null;
  try { value = JSON.parse(readFileSync(mainStatePath(root), 'utf8')); } catch { return blank(); }
  if (value?.schema !== MAIN_STATE_SCHEMA || value?.version !== MAIN_STATE_VERSION) return blank();
  return {
    commit: typeof value.commit === 'string' ? value.commit : null,
    red: Array.isArray(value.red) ? value.red : [],
    measured_at: typeof value.measured_at === 'string' ? value.measured_at : null,
    source: typeof value.source === 'string' ? value.source : null,
    base: typeof value.base === 'string' ? value.base : null,
    last_round: typeof value.last_round === 'string' ? value.last_round : null,
    at: value.at || null,
  };
}

export function writeMainState(state, { root = mcHome(), now = new Date() } = {}) {
  return writeJsonAtomic(mainStatePath(root), {
    schema: MAIN_STATE_SCHEMA,
    version: MAIN_STATE_VERSION,
    at: now.toISOString(),
    commit: state.commit ?? null,
    red: [...(state.red || [])],
    measured_at: state.measured_at ?? null,
    source: state.source ?? null,
    base: state.base ?? null,
    last_round: state.last_round ?? null,
  });
}

function blank() {
  return { commit: null, red: [], measured_at: null, source: null, base: null, last_round: null, at: null };
}
