/**
 * A plan directory still on the project's branch after its plan landed
 * (2026-10-12): `voice-session-resume` and `week-focus-rows` were blocked on
 * `worktree-missing` because git would not check the branch out twice.
 * Real git throughout, as in branch-landed.test.js: the squash is the subject.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { claimProjectBranch, freePlanBranch } from '../../src/mc/plan-branch.js';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const raw = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
const git = (cwd, args) => {
  try { return { ok: true, stdout: raw(cwd, args) }; } catch { return { ok: false, stdout: '' }; }
};
const noGh = () => ({ ok: false, stdout: '' });

/**
 * A repository and a plan directory under `<root>/plan/prog/repo` standing on
 * `proj`, whose one commit is squashed into `origin/main` when `landed`.
 */
function planned({ landed = true, under = 'plan/prog' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mc-plan-branch-')));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  raw(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  raw(repo, ['add', 'base.txt']);
  raw(repo, ['commit', '-q', '-m', 'root']);
  raw(repo, ['update-ref', 'refs/remotes/origin/main', 'main']);
  mkdirSync(join(root, under), { recursive: true });
  const holder = join(root, under, 'repo');
  raw(repo, ['worktree', 'add', '-q', '-b', 'proj', holder, 'main']);
  writeFileSync(join(holder, 'PLAN.json'), '{}\n');
  raw(holder, ['add', 'PLAN.json']);
  raw(holder, ['commit', '-q', '-m', 'plan']);
  if (landed) {
    writeFileSync(join(repo, 'PLAN.json'), '{}\n');
    raw(repo, ['add', 'PLAN.json']);
    raw(repo, ['commit', '-q', '-m', 'plan (#1)']);
    raw(repo, ['update-ref', 'refs/remotes/origin/main', 'main']);
  }
  return { root, repo, holder, planRoot: join(root, 'plan') };
}

describe('freePlanBranch', () => {
  it('detaches a clean plan directory on a landed branch and deletes the branch', () => {
    const p = planned();
    const tip = raw(p.holder, ['rev-parse', 'HEAD']);
    const r = freePlanBranch({ repo: p.repo, branch: 'proj', planRoot: p.planRoot, git, gh: noGh });
    assert.deepEqual(r, { freed: true, holder: p.holder, why: null });
    assert.equal(raw(p.holder, ['branch', '--show-current']), '', 'detached');
    assert.equal(raw(p.holder, ['rev-parse', 'HEAD']), tip, 'on the same commit');
    assert.equal(git(p.repo, ['rev-parse', '--verify', 'refs/heads/proj']).ok, false, 'the branch is gone');
    assert.ok(git(p.repo, ['worktree', 'add', '-q', '-b', 'proj', join(p.root, 'step'), 'origin/main']).ok, 'the step can have it');
  });

  it('leaves a plan directory with uncommitted changes', () => {
    const p = planned();
    writeFileSync(join(p.holder, 'draft.md'), 'x\n');
    const r = freePlanBranch({ repo: p.repo, branch: 'proj', planRoot: p.planRoot, git, gh: noGh });
    assert.equal(r.freed, false);
    assert.equal(r.why, 'uncommitted changes');
    assert.equal(raw(p.holder, ['branch', '--show-current']), 'proj');
  });

  it('leaves a branch that has not landed', () => {
    const p = planned({ landed: false });
    const r = freePlanBranch({ repo: p.repo, branch: 'proj', planRoot: p.planRoot, git, gh: noGh });
    assert.equal(r.freed, false);
    assert.equal(r.why, 'not landed');
    assert.equal(raw(p.holder, ['branch', '--show-current']), 'proj');
  });

  it('frees a branch held under programs/ in layout 2, where the planning root is', () => {
    const p = planned({ under: 'programs/prog' });
    const r = freePlanBranch({ repo: p.repo, branch: 'proj', planRoot: join(p.root, 'programs'), git, gh: noGh });
    assert.deepEqual(r, { freed: true, holder: p.holder, why: null });
    assert.equal(git(p.repo, ['rev-parse', '--verify', 'refs/heads/proj']).ok, false, 'the branch is gone');
  });

  it('leaves a worktree that is not under the plan home', () => {
    const p = planned({ under: 'elsewhere/prog' });
    const r = freePlanBranch({ repo: p.repo, branch: 'proj', planRoot: p.planRoot, git, gh: noGh });
    assert.equal(r.freed, false);
    assert.equal(r.why, 'not a plan directory');
    assert.equal(raw(p.holder, ['branch', '--show-current']), 'proj');
  });

  it('says nothing when no worktree holds the branch', () => {
    const p = planned();
    const r = freePlanBranch({ repo: p.repo, branch: 'other', planRoot: p.planRoot, git, gh: noGh });
    assert.deepEqual(r, { freed: false, holder: null, why: null });
  });
});

/**
 * Whether the project's branch is the runner's to use (2026-10-14): a planning
 * session held `morning-calls` in a scratchpad worktree, and with no holder the
 * step would have started on the planning branch's pre-squash head.
 */
describe('claimProjectBranch', () => {
  it('a branch nobody has is absent', () => {
    const p = planned();
    assert.deepEqual(claimProjectBranch({ repo: p.repo, branch: 'other', git }), { verdict: 'absent', holder: null, why: null });
  });

  it('a branch held outside the plan home is foreign', () => {
    const p = planned({ under: 'elsewhere/scratchpad' });
    const plan = freePlanBranch({ repo: p.repo, branch: 'proj', planRoot: p.planRoot, git, gh: noGh });
    assert.deepEqual(claimProjectBranch({ repo: p.repo, branch: 'proj', plan, git }), { verdict: 'foreign', holder: p.holder, why: 'not a plan directory' });
  });

  it('a landed branch no worktree holds is deleted', () => {
    const p = planned();
    raw(p.repo, ['worktree', 'remove', p.holder]);
    const r = claimProjectBranch({ repo: p.repo, branch: 'proj', git });
    assert.equal(r.verdict, 'recreated');
    assert.equal(git(p.repo, ['rev-parse', '--verify', 'refs/heads/proj']).ok, false, 'the branch is gone');
    assert.ok(git(p.repo, ['worktree', 'add', '-q', '-b', 'proj', join(p.root, 'step'), 'origin/main']).ok, 'the step can have it from origin/main');
  });

  it('an unlanded branch no worktree holds is foreign and kept', () => {
    const p = planned({ landed: false });
    raw(p.repo, ['worktree', 'remove', p.holder]);
    const r = claimProjectBranch({ repo: p.repo, branch: 'proj', git });
    assert.deepEqual(r, { verdict: 'foreign', holder: null, why: 'it has commits that are not on origin/main' });
    assert.ok(git(p.repo, ['rev-parse', '--verify', 'refs/heads/proj']).ok, 'the branch is kept');
  });

  it('a branch the register names is the runner\'s own', () => {
    const p = planned({ landed: false });
    raw(p.repo, ['worktree', 'remove', p.holder]);
    const r = claimProjectBranch({ repo: p.repo, branch: 'proj', registered: true, git });
    assert.equal(r.verdict, 'own');
    assert.ok(git(p.repo, ['rev-parse', '--verify', 'refs/heads/proj']).ok, 'the branch is kept');
  });
});
