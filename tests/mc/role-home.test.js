/**
 * The role home bootstrap: the fixed layout, made whole idempotently.
 *
 * What matters most is what a re-run does NOT do: state.md and the READMEs
 * are the role's memory and are never overwritten, and the git repository
 * is initialised exactly once.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ensureRoleHome } from '../../src/mc/role-home.js';

describe('the PM home', () => {
  it('is born with the whole layout and a versioned first commit', () => {
    const home = mkdtempSync(join(tmpdir(), 'mc-pm-home-'));
    const made = ensureRoleHome('pm', home);
    for (const dir of ['inbox', 'queues', 'decisions', 'digests', 'handoff']) {
      assert.ok(existsSync(join(home, dir, 'README.md')), dir);
    }
    assert.ok(existsSync(join(home, 'state.md')));
    assert.match(readFileSync(join(home, 'state.md'), 'utf8'), /K8\.3/u);
    assert.equal(made.git_initialised, true, made.git_failed || '');
    const count = execFileSync('git', ['-C', home, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(count, '1');
  });

  it('a second start repairs what is missing and edits no memories', () => {
    const home = mkdtempSync(join(tmpdir(), 'mc-pm-home-'));
    ensureRoleHome('pm', home);
    writeFileSync(join(home, 'state.md'), '# PM — state\n\nEverything is on fire.\n');
    const again = ensureRoleHome('pm', home);
    assert.deepEqual(again.created, []);
    assert.equal(again.git_initialised, false);
    assert.match(readFileSync(join(home, 'state.md'), 'utf8'), /on fire/u);
    const count = execFileSync('git', ['-C', home, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(count, '1');
  });
});

describe('the helper home', () => {
  it('gets the v0.2 layout — intake first — an empty mirror, and no repository', () => {
    const home = mkdtempSync(join(tmpdir(), 'mc-helper-home-'));
    ensureRoleHome('pm-helper', home);
    // Design note §2: intake/ (with processed/), sweeps, briefs (né
    // underlag — renamed before the home ever existed on disk), improve,
    // the mirror, the channel's inbox, logs.
    for (const dir of ['intake', join('intake', 'processed'), 'sweeps', 'briefs', 'improve', 'memoro-mirror', 'inbox', 'logs']) {
      assert.ok(existsSync(join(home, dir, 'README.md')), dir);
    }
    assert.equal(existsSync(join(home, 'underlag')), false, 'nothing creates the pre-v0.2 name');
    assert.equal(existsSync(join(home, 'state.md')), false);
    assert.equal(existsSync(join(home, '.git')), false);
  });
});

describe('an unknown role', () => {
  it('has no home to make', () => {
    const home = mkdtempSync(join(tmpdir(), 'mc-none-home-'));
    assert.equal(ensureRoleHome('worker', home).known, false);
  });
});
