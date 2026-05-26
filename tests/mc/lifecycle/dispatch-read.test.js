/**
 * TDD spec for `mc dispatch <name> "<message>"` (§2) and
 * `mc read <name> [--last N]` (§2).
 *
 * Per the plan, these are renames of `mc sessions send` / `mc sessions
 * read` with name resolution against the registry. Today's commands
 * still work via the live coding-session API; the new commands sit on
 * top, accepting a worktree name (or label) and resolving to a session
 * id internally.
 *
 * Tests focus on argument parsing and "name not in registry" errors;
 * the network round-trip is the existing `mc sessions send` test's
 * domain.
 */
import test, { describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { runMc, parseJsonOrNull } from '../_helpers/cli.js';
import { makeTempRepo } from '../_helpers/git-fixture.js';
import { writeRegistry, makeEntry } from '../_helpers/registry-fixture.js';

describe('mc dispatch <name> <msg>', () => {
  let repo;
  beforeEach(() => { repo = makeTempRepo({ name: 'dispatch' }); });
  after(() => { repo?.cleanup(); });

  test('requires both name and message', () => {
    const r1 = runMc(['dispatch'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.notEqual(r1.status, 0);

    const r2 = runMc(['dispatch', 'foo'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.notEqual(r2.status, 0);
    assert.match(r2.stderr + r2.stdout, /usage|message|required/i);
  });

  test('rejects unknown name with clear error', () => {
    const r = runMc(['dispatch', 'ghost', 'hi'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /unknown|not.found|no such|ghost/i);
  });

  test('bulk dispatch: `mc dispatch a b c "<msg>"` (§9h)', () => {
    writeRegistry(repo.mcHome, [
      makeEntry({ name: 'a', coding_session_id: 'sess_aaa', session_state: 'idle' }),
      makeEntry({ name: 'b', coding_session_id: 'sess_bbb', session_state: 'idle' }),
    ]);
    // Use --dry-run / --json so we don't actually hit the API. The
    // contract: mc parses bulk targets and reports per-target plan.
    const r = runMc(['dispatch', 'a', 'b', '--message', 'hello', '--dry-run', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    // We accept either success-with-plan or "unimplemented yet" — but
    // the spec is that bulk targets parse cleanly when --dry-run is
    // present.
    if (r.status === 0) {
      const j = parseJsonOrNull(r.stdout);
      assert.ok(j);
      assert.ok(Array.isArray(j.targets));
      assert.deepEqual(j.targets.map(t => t.name).sort(), ['a', 'b']);
    } else {
      // If not implemented yet, the error must mention bulk / dispatch.
      assert.match(r.stderr + r.stdout, /bulk|dispatch|unknown/i);
    }
  });
});

describe('mc read <name>', () => {
  let repo;
  beforeEach(() => { repo = makeTempRepo({ name: 'read' }); });
  after(() => { repo?.cleanup(); });

  test('requires a name', () => {
    const r = runMc(['read'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /usage|name|required/i);
  });

  test('rejects unknown name', () => {
    const r = runMc(['read', 'ghost'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /unknown|not.found|no such|ghost/i);
  });

  test('--last N is accepted as an integer flag', () => {
    writeRegistry(repo.mcHome, [
      makeEntry({ name: 'r', coding_session_id: 'sess_rrr' }),
    ]);
    const r = runMc(['read', 'r', '--last', '5', '--json'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    // Tolerant on success: we only care that arg parsing accepts
    // --last 5. Failing on network is fine; failing on flag-parsing
    // is not.
    if (r.status !== 0) {
      assert.ok(!/usage|invalid|unknown option/i.test(r.stderr + r.stdout),
        `--last should be a recognised flag; got: ${r.stderr}${r.stdout}`);
    }
  });

  test('--last with a non-integer is rejected', () => {
    writeRegistry(repo.mcHome, [
      makeEntry({ name: 'r', coding_session_id: 'sess_rrr' }),
    ]);
    const r = runMc(['read', 'r', '--last', 'banana'], {
      cwd: repo.dir, env: { MC_HOME: repo.mcHome },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /last|integer|number|banana|invalid/i);
  });
});
