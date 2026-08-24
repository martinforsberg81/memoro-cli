/**
 * Mechanisms that should be in force, and whether they are (PM's order,
 * 2026-08-24). Five instances in a week of built-and-not-in-force, each
 * found by accident: the list exists so nobody has to remember to ask, and
 * it is read by something that already runs — mc doctor, every PM round.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { notInForce } from '../../src/mc/enforcement.js';
import { diagnose, run } from '../../src/mc/commands/doctor.js';

const QUIET_WATCHERS = {
  pm: { running: true, stale: false, stale_code: false, abandoned: false },
  sessions: { running: true, stale: false, stale_code: false, abandoned: false },
  repo: { running: false, stale: null, stale_code: null, abandoned: false },
};

function deps(overrides = {}) {
  return {
    repos: () => ['/repos/memoro', '/repos/memoro-cli'],
    guardState: () => ({ installed: true }),
    watchers: () => QUIET_WATCHERS,
    rounds: () => [],
    ratchet: () => ({ present: true }),
    ...overrides,
  };
}

describe('what the list says', () => {
  it('is empty when everything that exists here is doing its job', () => {
    assert.deepEqual(notInForce({ deps: deps() }), []);
  });

  it('names a repository whose push-guard is not installed, with the way in', () => {
    const broken = notInForce({
      deps: deps({ guardState: (repo) => (repo.endsWith('memoro') ? { installed: false, reason: 'no pre-push hook' } : { installed: true }) }),
    });
    assert.deepEqual(broken, ['push-guard is not in force on memoro — no pre-push hook; mc repo guard memoro']);
  });

  it('names a watcher on old code, one gone stale, and one stopped without telling anyone', () => {
    const broken = notInForce({
      deps: deps({
        watchers: () => ({
          pm: { running: true, stale: false, stale_code: true, abandoned: false },
          sessions: { running: true, stale: true, stale_code: false, abandoned: false },
          repo: { running: false, stale: null, stale_code: null, abandoned: true },
        }),
      }),
    });
    assert.match(broken[0], /mc watch pm runs OLD code/u);
    assert.match(broken[1], /mc watch sessions is alive but stale/u);
    assert.match(broken[2], /mc watch repo is NOT RUNNING — stopped without telling anyone/u);
  });

  it('a watcher never started on this machine is absent, not broken', () => {
    assert.deepEqual(notInForce({ deps: deps() }), []);
  });

  it('a repository whose last round stood on red needs a floor; a green one earns no line', () => {
    const broken = notInForce({
      deps: deps({
        rounds: () => [
          { repo: 'memoro', standing_red: 5 },
          { repo: 'memoro-cli', standing_red: 0 },
        ],
        ratchet: () => ({ present: false }),
      }),
    });
    assert.deepEqual(broken, ['red-ratchet is not in force on memoro — the last gate round stood on 5 red and no floor is recorded']);
  });

  it('a check that cannot run reports itself instead of staying quiet', () => {
    const broken = notInForce({ deps: deps({ guardState: () => { throw new Error('git is gone'); } }) });
    assert.deepEqual(broken, ['push-guard could not be checked: git is gone']);
  });
});

describe('identical findings fold into one counted line', () => {
  it('a crowd is named once with a count and a first id; one of a kind keeps its row', async () => {
    // Twenty-eight identical dev-server-session-unbound rows stood in every
    // heartbeat for a day and nobody read them (2026-08-24) — a counter,
    // not information.
    const crowd = Array.from({ length: 28 }, (_, index) => ({ scope: 'session', mc_session_id: `s-${index}`, reason: 'dev-server-session-unbound' }));
    const lone = { scope: 'session', mc_session_id: 'x-1', reason: 'runtime stale' };
    let out = '';
    const code = await run([], {
      stdout: { write: (text) => { out += text; } },
      scan: () => ({ ok: false, summary: { sessions: 29, runtime_active: 0, runtime_stale: 1 }, issues: [...crowd, lone] }),
      inspectDevServers: () => ({ ok: true, summary: {}, issues: [] }),
      enforcement: () => [],
    });
    assert.equal(code, 1);
    assert.match(out, /! session {2}dev-server-session-unbound × 28 {2}\(first: s-0\)/u);
    assert.match(out, /! session {2}x-1 {2}runtime stale/u);
    assert.equal((out.match(/dev-server-session-unbound/gu) || []).length, 1, 'the crowd took one line, not twenty-eight');
  });
});

describe('mc doctor carries it, apart from the 28', () => {
  it('as its own field, counted in no issue list and moving no ok', () => {
    const result = diagnose({
      deps: {
        scan: () => ({ ok: true, summary: { sessions: 0, runtime_active: 0, runtime_stale: 0 }, issues: [] }),
        inspectDevServers: () => ({ ok: true, summary: {}, issues: [] }),
        enforcement: () => ['push-guard is not in force on memoro — no pre-push hook; mc repo guard memoro'],
      },
    });
    assert.equal(result.ok, true, 'enforcement does not move ok — it answers for the machinery, not the sessions');
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.not_in_force, ['push-guard is not in force on memoro — no pre-push hook; mc repo guard memoro']);
  });
});
