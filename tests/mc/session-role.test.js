import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { personCommandRefusal, sessionIdentity, withoutSessionIdentity } from '../../src/mc/session-role.js';

const env = { MC_WORK_ROOT: '/mc' };
const identity = (cwd, extra = {}) => sessionIdentity({ cwd, env: { ...env, ...extra } });

describe('session identity', () => {
  it('prefers the launched role to the directory, supports a goal launch, and no longer reads a step', () => {
    assert.deepEqual(identity('/mc/programs/mc/memoro-cli', { MC_ROLE: 'review-session:goal', MC_PROGRAMME: 'other', MC_STEP: 'p:0' }),
      { role: 'review-session:goal', programme: 'other', source: 'MC_ROLE' });
    assert.equal(identity('/mc/programs/mc', { MC_GOAL: 'other/g' }).role, 'build-session:goal');
    assert.equal(identity('/mc/programs/mc', { MC_GOAL: 'other/g' }).programme, 'other');
    assert.equal(identity('/mc/programs/mc', { MC_STEP: 'p:0' }).role, null, 'MC_STEP is not an identity any more');
  });

  // The plan role went with `mc plan` (2026-11-21): a programme's directory and the old plan/ root name no role.
  it('recognises a goal checkout and the desks, and gives a programme directory no role', () => {
    for (const [cwd, role, programme = null] of [
      ['/mc/programs/mc', null], ['/mc/programs/mc/memoro-cli/src', null],
      ['/mc/plan/old/memoro', null], ['/mc/programs/mc/goals/g/memoro-cli', 'build-session:goal', 'mc'],
      ['/mc/runner/step/p/memoro', null], ['/mc/step/p', null],
      ['/mc/runner/mend/memoro-1', null], ['/mc/brief', 'manager'], ['/mc/manager', 'manager'],
      ['/mc/helper', 'helper'], ['/mc/intake', 'intake'],
      ['/mc/martin', 'martin'],
      ['/mc/martin', 'martin'],
      ['/elsewhere', null], ['/mc-other/programs/mc', null], ['/mc/programs/mc/goals', null],
    ]) {
      assert.deepEqual(identity(cwd), { role, programme, source: 'cwd' }, cwd);
    }
  });

  it('does not pass the caller identity into a new session', () => {
    assert.deepEqual(withoutSessionIdentity({ KEEP: 'yes', MC_ROLE: 'goal', MC_PROGRAMME: 'mc', MC_GOAL: 'mc/g', MC_STEP: 'p:0', MC_PROJECT: 'p' }), { KEEP: 'yes' });
  });

  it('refuses agent signals even outside mc, but does not mistake a tool installation for a session', () => {
    for (const key of ['CLAUDECODE', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CI']) {
      assert.match(personCommandRefusal('mc programs archive', { cwd: '/elsewhere', env: { ...env, [key]: 'yes' } }), new RegExp(key));
    }
    assert.equal(personCommandRefusal('mc programs archive', { cwd: '/elsewhere', env: { ...env, CODEX_HOME: '/tools/codex', CLAUDE_CONFIG_DIR: '/tools/claude' } }), null);
  });
});
