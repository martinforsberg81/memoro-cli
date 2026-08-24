/**
 * Who stands where, by prefix (standing.js, KP-08 point 7).
 *
 * Measured: a tool started in a subdirectory of its area was invisible to
 * occupation, addressing and the board at once, because lsof answers exact
 * paths exactly. One lsof for the user's processes, the matching done here.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cwdsOfUser, processesStandingIn, standsIn } from '../../src/mc/standing.js';

describe('standing in a directory', () => {
  it('is the directory itself or any ancestor — the longest known one wins', () => {
    const paths = ['/w/alpha', '/w/alpha/memoro-cli', '/w/beta'];
    assert.equal(standsIn('/w/alpha', paths), '/w/alpha');
    assert.equal(standsIn('/w/alpha/memoro-cli/src/mc', paths), '/w/alpha/memoro-cli', 'the worktree, not the area');
    assert.equal(standsIn('/w/alpha/docs', paths), '/w/alpha');
    assert.equal(standsIn('/w/alphabet', paths), null, 'a name that merely starts the same is not inside');
    assert.equal(standsIn('/w', paths), null);
    assert.equal(standsIn('/elsewhere', paths), null);
    assert.equal(standsIn('/w/beta/x', ['/w/beta/']), '/w/beta/', 'a trailing slash on the known path is tolerated');
  });

  it('reads lsof -F pn once for the user and matches every cwd against the known paths', () => {
    const calls = [];
    const run = (cmd, args) => {
      calls.push([cmd, ...args]);
      return ['p100', 'fcwd', 'n/w/alpha/memoro-cli/src', 'p200', 'fcwd', 'n/w/beta', 'p300', 'fcwd', 'n/Users/x', ''].join('\n');
    };
    const found = processesStandingIn(['/w/alpha/memoro-cli', '/w/beta'], { run, uid: 501 });
    assert.deepEqual(found, [
      { pid: 100, directory: '/w/alpha/memoro-cli', cwd: '/w/alpha/memoro-cli/src' },
      { pid: 200, directory: '/w/beta', cwd: '/w/beta' },
    ]);
    assert.equal(calls.length, 1, 'one lsof, whatever the number of paths');
    assert.deepEqual(calls[0], ['lsof', '-a', '-d', 'cwd', '-u', '501', '-F', 'pn'], 'scoped to the user, no paths');
    assert.deepEqual(processesStandingIn([], { run }), [], 'nothing to ask about asks nothing');
    assert.equal(calls.length, 1);
  });

  it('keeps what lsof printed before it complained, and answers nothing for nothing', () => {
    const failing = () => { const e = new Error('exit 1'); e.stdout = 'p7\nfcwd\nn/w/alpha\n'; throw e; };
    assert.deepEqual(cwdsOfUser({ run: failing }), [{ pid: 7, cwd: '/w/alpha' }]);
    assert.deepEqual(cwdsOfUser({ run: () => { throw new Error('no lsof'); } }), []);
  });

  it('sees this very process, wherever in its tree the question is asked', () => {
    const here = process.cwd();
    const above = here.split('/').slice(0, -1).join('/');
    const mine = (paths) => processesStandingIn(paths).filter((item) => item.pid === process.pid);
    assert.equal(mine([here]).length, 1);
    assert.equal(mine([above])[0]?.directory, above, 'asked about the parent, found by prefix');
  });
});
