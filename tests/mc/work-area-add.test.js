/**
 * What `addWorktree` says when git refuses, and what it leaves behind.
 *
 * Both halves come from one report: `mc plan mc` answered
 *
 *     mc: could not add memoro to mc (Preparing worktree (new branch 'mc'))
 *
 * and left an empty `~/mc/mc/` standing. The parenthesis is git's progress
 * line, not its diagnosis, and the directory was made for a checkout that
 * never arrived — so the failure named nothing and littered on its way out.
 *
 * The branch name is not incidental to the fixture. `refs/heads/mc` cannot be
 * created while `refs/heads/mc/anything` exists, because git's ref namespace
 * is a directory tree; that is a real, fixable thing to be told, and it is
 * exactly what the old message threw away.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { git, makeTempRepo } from './_helpers/git-fixture.js';
import { addWorktree } from '../../src/mc/work-area.js';

describe('addWorktree, when git refuses', () => {
  let fx;
  let env;

  before(() => {
    fx = makeTempRepo({ name: 'work-area-add' });
    env = { ...process.env, MC_WORK_ROOT: join(fx.root, 'work') };
    mkdirSync(env.MC_WORK_ROOT, { recursive: true });
    // The collision: `mc/` is a directory in the ref namespace from here on,
    // so no branch may be called `mc`.
    git(fx.dir, 'branch mc/github-write-flag');
  });

  after(() => fx.cleanup());

  const failing = (name) => addWorktree({
    name, repo: fx.dir, branch: 'mc', from: 'origin/main', env,
  });

  it('reports the line git failed on, not the line it narrated first', () => {
    const result = failing('mc');
    assert.equal(result.ok, false);
    assert.match(result.reason, /^fatal:/u);
    assert.match(result.reason, /cannot create 'refs\/heads\/mc'/u);
    // The whole of the old bug: this is what used to be reported instead.
    assert.doesNotMatch(result.reason, /Preparing worktree/u);
  });

  it('leaves no area behind when it made one and could not fill it', () => {
    const area = join(env.MC_WORK_ROOT, 'mc');
    assert.equal(existsSync(area), false, 'the fixture starts without it');
    assert.equal(failing('mc').ok, false);
    assert.equal(existsSync(area), false);
  });

  it('keeps an area that was already there', () => {
    const area = join(env.MC_WORK_ROOT, 'standing');
    mkdirSync(area, { recursive: true });
    assert.equal(failing('standing').ok, false);
    assert.equal(existsSync(area), true);
  });

  it('keeps an area that holds anything at all', () => {
    const area = join(env.MC_WORK_ROOT, 'occupied');
    mkdirSync(area, { recursive: true });
    writeFileSync(join(area, 'notes.md'), 'not mine to remove\n');
    assert.equal(failing('occupied').ok, false);
    assert.equal(existsSync(join(area, 'notes.md')), true);
  });

  it('still adds the worktree when the branch name is one git will take', () => {
    const result = addWorktree({
      name: 'fine', repo: fx.dir, branch: 'mc-surface', from: 'origin/main', env,
    });
    assert.equal(result.ok, true, result.reason);
    assert.equal(existsSync(join(result.path, '.git')), true);
  });
});
