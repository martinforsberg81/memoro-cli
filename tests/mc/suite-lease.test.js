/**
 * The suite right as a lease — one full suite at a time on this machine,
 * by agreement (D-0141), visible instead of hoped for (D-0155).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { claimSuiteLease, readSuiteLease, releaseSuiteLease, suiteLeaseLogPath } from '../../src/mc/suite-lease.js';
import { parseArgs, suiteRow } from '../../src/mc/commands/suite.js';
import { elapsed, painter } from '../../src/mc/status-render.js';

const A = { name: 'alpha', kind: 'work-area' };
const B = { name: 'beta', kind: 'work-area' };
const home = () => mkdtempSync(join(tmpdir(), 'mc-suite-lease-'));

describe('the suite right', () => {
  it('is free until claimed, held by one, and refused to a second', () => {
    const root = home();
    try {
      assert.equal(readSuiteLease({ root }).held, false);
      const first = claimSuiteLease({ errand: 'msr contract on #10820', holder: A, root, now: 1000 });
      assert.equal(first.ok, true);
      const second = claimSuiteLease({ errand: 'gate round', holder: B, root });
      assert.equal(second.ok, false);
      assert.equal(second.lease.holder, 'alpha');
      assert.equal(second.lease.errand, 'msr contract on #10820');
      // Claiming what you hold is not an error and does not restart the clock.
      const again = claimSuiteLease({ errand: 'again', holder: A, root, now: 61000 });
      assert.equal(again.already, true);
      assert.equal(readSuiteLease({ root, now: 61000 }).age_ms, 60000);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('is released by its holder, taken from them only with --force, and both are logged', () => {
    const root = home();
    try {
      claimSuiteLease({ errand: 'x', holder: A, root });
      const refused = releaseSuiteLease({ holder: B, root });
      assert.equal(refused.ok, false);
      assert.equal(refused.reason, 'not-yours');
      const forced = releaseSuiteLease({ holder: B, root, force: true });
      assert.equal(forced.released, true);
      assert.equal(forced.forced, true);
      assert.equal(readSuiteLease({ root }).held, false);
      const log = readFileSync(suiteLeaseLogPath(root), 'utf8');
      assert.match(log, /claim {4}holder=alpha/u);
      assert.match(log, /force {4}by=beta {2}was=alpha/u);
      assert.equal(releaseSuiteLease({ holder: A, root }).released, false, 'nothing to release');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('the row says the lease and what actually runs, for how long', () => {
    const c = painter(false);
    assert.equal(suiteRow(c, { held: false }, []), 'free  ·  nothing running');
    const row = suiteRow(c, { held: true, holder: 'alpha', errand: 'contract', age_ms: 7 * 60000 }, [
      { command: 'npm run test:msr:contract', area: 'msr-cleanup', pid: 4242, elapsed: '07:12' },
    ]);
    assert.equal(row, 'alpha “contract” held for 7m  ·  running: npm run test:msr:contract in msr-cleanup (pid 4242, 07:12)');
  });

  it('reads ps etime the way the board says time', () => {
    assert.equal(elapsed('00:42'), 'under a minute');
    assert.equal(elapsed('07:12'), '7m');
    assert.equal(elapsed('01:10:05'), '1h 10m');
    assert.equal(elapsed('2-03:00:00'), '51h 0m');
    assert.equal(elapsed(''), '?');
  });

  it('the grammar: claim needs an errand, release and who take nothing more', () => {
    assert.equal(parseArgs(['claim', 'gate', 'round']).errand, 'gate round');
    assert.match(parseArgs(['claim']).error, /what for/u);
    assert.equal(parseArgs(['release', '--force']).force, true);
    assert.match(parseArgs(['who', 'x']).error, /no further words/u);
    assert.match(parseArgs([]).error, /claim, release or who/u);
    assert.match(parseArgs(['take']).error, /does not know/u);
  });
});
