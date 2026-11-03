/** The repository model answers what the suite was measured to ask git — without a process. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '../../src/mc/git.js';
import { captureWorktree, sameContent } from '../../src/mc/session-gate-evidence.js';
import { FakeGit } from './_helpers/fake-git.js';

const fake = new FakeGit();
let restore;
let root;
before(() => { restore = fake.install(); root = mkdtempSync(join(tmpdir(), 'fake-git-')); });
after(() => { restore(); rmSync(root, { recursive: true, force: true }); });

/** A fixture's git: argv in, trimmed stdout out, a throw on failure. */
const git = (cwd, ...args) => {
  const result = run(cwd, args);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trimEnd();
};
const sha = /^[0-9a-f]{40}$/u;

function repository(name) {
  const cwd = join(root, name);
  mkdirSync(cwd, { recursive: true });
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Model Test');
  writeFileSync(join(cwd, 'README.md'), '# fixture\n');
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src', 'a.js'), 'export const a = 1;\n');
  writeFileSync(join(cwd, '.gitignore'), 'node_modules/\n*.log\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'baseline');
  const remote = join(root, `${name}-origin.git`);
  git(cwd, 'clone', '--bare', '-q', cwd, remote);
  git(cwd, 'remote', 'add', 'origin', remote);
  git(cwd, 'fetch', '-q', 'origin');
  return { cwd, remote };
}

describe('the publication fixture flow', () => {
  it('init, commit, bare clone, remote, fetch and switch leave the refs git would leave', () => {
    const { cwd } = repository('flow');
    const head = git(cwd, 'rev-parse', 'HEAD');
    assert.match(head, sha);
    assert.equal(git(cwd, 'branch', '--show-current'), 'main');
    assert.equal(git(cwd, 'rev-parse', 'origin/main'), head);
    assert.equal(git(cwd, 'rev-parse', 'origin/main^{commit}'), head);
    assert.equal(git(cwd, 'rev-parse', '--verify', 'HEAD'), head);
    assert.equal(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(git(cwd, 'rev-parse', '--show-toplevel'), realpathSync(cwd), 'the real path, as git answers on macOS');
    assert.equal(git(cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD'), 'main');
    assert.equal(git(cwd, 'log', '-1', '--format=%B'), 'baseline');
    git(cwd, 'switch', '-qc', 'test-project');
    assert.equal(git(cwd, 'branch', '--show-current'), 'test-project');
    assert.equal(git(cwd, 'rev-parse', 'HEAD'), head, 'a new branch starts at HEAD');
    assert.equal(run(cwd, ['rev-parse', '--verify', '--quiet', 'refs/heads/nope^{commit}']).status, 1);
    assert.equal(git(cwd, 'check-ref-format', 'refs/heads/test-project'), 'refs/heads/test-project');
    assert.equal(run(cwd, ['check-ref-format', '--branch', 'bad name']).status, 1);
  });

  it('push, ls-remote and a rejected non-fast-forward', () => {
    const { cwd, remote } = repository('push');
    git(cwd, 'switch', '-qc', 'feature');
    writeFileSync(join(cwd, 'src', 'b.js'), 'export const b = 2;\n');
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-m', 'Implement schema');
    const tip = git(cwd, 'rev-parse', 'HEAD');
    assert.equal(git(cwd, 'ls-remote', '--heads', 'origin', 'feature'), '', 'not pushed yet');
    git(cwd, 'push', '-u', 'origin', 'feature');
    assert.equal(git(cwd, 'ls-remote', '--heads', 'origin', 'feature'), `${tip}\trefs/heads/feature`);
    assert.equal(git(cwd, 'ls-remote', '--heads', 'origin', 'refs/heads/feature'), `${tip}\trefs/heads/feature`);
    assert.equal(git(remote, 'rev-parse', 'refs/heads/feature'), tip, 'the bare remote has the commit');
    // Main moves on the remote; a stale push of main is refused like git refuses it.
    const other = join(root, 'push-other');
    git(root, 'clone', '-q', remote, other);
    writeFileSync(join(other, 'moved.txt'), 'Main movement.\n');
    git(other, 'add', 'moved.txt');
    git(other, 'commit', '-qm', 'Move main');
    git(other, 'push', '-q', 'origin', 'main');
    const moved = git(other, 'rev-parse', 'HEAD');
    assert.equal(git(cwd, 'ls-remote', '--heads', 'origin', 'main').split('\t')[0], moved);
    git(cwd, 'switch', '-q', 'main');
    writeFileSync(join(cwd, 'stale.txt'), 'stale\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'stale');
    const refused = run(cwd, ['push', '-q', 'origin', 'main']);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /rejected/u);
    git(cwd, 'fetch', '--no-tags', 'origin', 'main');
    assert.equal(git(cwd, 'rev-parse', 'FETCH_HEAD'), moved);
    assert.equal(git(cwd, 'rev-parse', 'origin/main'), moved);
  });

  it('merge-base, ancestry, rev-list and diff --name-only across commits', () => {
    const { cwd } = repository('history');
    const base = git(cwd, 'rev-parse', 'HEAD');
    git(cwd, 'switch', '-qc', 'work');
    writeFileSync(join(cwd, 'src', 'a.js'), 'export const a = 2;\n');
    git(cwd, 'commit', '-am', 'change a');
    const tip = git(cwd, 'rev-parse', 'HEAD');
    git(cwd, 'switch', '-q', 'main');
    writeFileSync(join(cwd, 'docs.md'), 'docs\n');
    git(cwd, 'add', 'docs.md');
    git(cwd, 'commit', '--allow-empty', '-qm', 'Move main');
    const main = git(cwd, 'rev-parse', 'HEAD');
    assert.equal(git(cwd, 'merge-base', 'HEAD', tip), base);
    assert.equal(run(cwd, ['merge-base', '--is-ancestor', base, 'HEAD']).status, 0);
    assert.equal(run(cwd, ['merge-base', '--is-ancestor', tip, 'HEAD']).status, 1);
    assert.equal(git(cwd, 'rev-list', '--count', `${base}..HEAD`), '1');
    assert.equal(git(cwd, 'rev-list', '--left-right', '--count', `${tip}...${main}`), '1\t1');
    assert.equal(git(cwd, 'diff', '--name-only', '--no-renames', '-z', tip).replace(/\0/gu, ' ').trim(), 'docs.md src/a.js', 'tip against the working tree');
    assert.equal(git(cwd, 'diff', '--name-only', `${base}..${tip}`), 'src/a.js');
    assert.equal(git(cwd, 'log', '--oneline', `${base}..HEAD`).split('\n').length, 1);
    assert.equal(git(cwd, 'cat-file', '-e', `${tip}^{commit}`), '');
    assert.equal(git(cwd, 'show', `${tip}:src/a.js`), 'export const a = 2;');
  });
});

describe('content identity', () => {
  it('captureWorktree agrees with the committed tree, sees edits, respects .gitignore, and never starts git', () => {
    const { cwd } = repository('content');
    const committed = git(cwd, 'rev-parse', 'HEAD^{tree}');
    const before = captureWorktree(cwd);
    assert.equal(before.tree, committed);
    assert.match(before.tree, sha);
    mkdirSync(join(cwd, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(cwd, 'node_modules', 'x', 'index.js'), 'ignored\n');
    writeFileSync(join(cwd, 'debug.log'), 'ignored\n');
    assert.equal(captureWorktree(cwd).tree, committed, 'ignored files are not content');
    assert.equal(sameContent(before, captureWorktree(cwd)), true);
    writeFileSync(join(cwd, 'generated.js'), 'untracked but counted\n');
    const after = captureWorktree(cwd);
    assert.notEqual(after.tree, committed, 'an untracked file is content');
    assert.equal(sameContent(before, after), false);
    assert.equal(git(cwd, 'ls-files', '--others', '--exclude-standard'), 'generated.js');
    assert.equal(git(cwd, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z').replace(/\0/gu, ' ').trim(), 'debug.log node_modules/x/index.js');
    assert.equal(git(cwd, 'status', '--porcelain'), '?? generated.js');
    writeFileSync(join(cwd, 'src', 'a.js'), 'export const a = 3;\n');
    assert.equal(git(cwd, 'status', '--porcelain=v1', '--untracked-files=all'), ' M src/a.js\n?? generated.js');
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-qm', 'edit');
    assert.equal(git(cwd, 'rev-parse', 'HEAD^{tree}'), captureWorktree(cwd).tree, 'the new commit\'s tree is the worktree\'s');
    assert.equal(git(cwd, 'status', '--porcelain'), '');
  });

  it('two worktrees with the same files have the same tree; worktree add refuses a second checkout', () => {
    const { cwd, remote } = repository('trees');
    const area = join(root, 'trees-area');
    git(cwd, 'worktree', 'add', '-q', '-b', 'step-1', area, 'origin/main');
    assert.equal(captureWorktree(area).tree, captureWorktree(cwd).tree);
    assert.equal(git(area, 'branch', '--show-current'), 'step-1');
    assert.equal(git(area, 'rev-parse', '--git-common-dir'), join(realpathSync(cwd), '.git'));
    const porcelain = git(cwd, 'worktree', 'list', '--porcelain');
    assert.match(porcelain, new RegExp(`worktree ${realpathSync(area).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\nHEAD [0-9a-f]{40}\\nbranch refs/heads/step-1`, 'u'));
    assert.match(run(cwd, ['worktree', 'add', '-q', join(root, 'trees-again'), 'step-1']).stderr, /already checked out/u);
    git(area, 'push', '-q', 'origin', 'step-1');
    assert.equal(git(remote, 'rev-parse', 'refs/heads/step-1'), git(area, 'rev-parse', 'HEAD'));
    git(cwd, 'worktree', 'remove', '--force', area);
    assert.doesNotMatch(git(cwd, 'worktree', 'list', '--porcelain'), /step-1/u);
  });

  it('worktree move renames the worktree whole, into a directory under its name, and never over anything', () => {
    const { cwd } = repository('moves');
    const area = join(root, 'moves-area');
    git(cwd, 'worktree', 'add', '-q', '--detach', area);
    const to = join(root, 'moves-moved');
    git(cwd, 'worktree', 'move', area, to);
    assert.equal(existsSync(area), false);
    assert.equal(git(to, 'status', '--porcelain'), '');
    assert.equal(git(to, 'rev-parse', '--path-format=absolute', '--git-common-dir'), join(realpathSync(cwd), '.git'));
    const listed = git(cwd, 'worktree', 'list', '--porcelain');
    assert.match(listed, new RegExp(`worktree ${realpathSync(to).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\n`, 'u'));
    assert.doesNotMatch(listed, /moves-area/u);

    const into = join(root, 'moves-into');
    mkdirSync(into);
    git(cwd, 'worktree', 'move', to, into);
    assert.equal(existsSync(join(into, 'moves-moved', '.git')), true, 'an existing directory takes it under its own name');
    mkdirSync(join(root, 'moves-taken', 'moves-moved'), { recursive: true });
    assert.match(run(cwd, ['worktree', 'move', join(into, 'moves-moved'), join(root, 'moves-taken')]).stderr, /already exists/u);
    assert.match(run(cwd, ['worktree', 'move', cwd, join(root, 'moves-main')]).stderr, /is a main working tree/u);
    assert.match(run(cwd, ['worktree', 'move', join(root, 'nowhere'), join(root, 'moves-x')]).stderr, /is not a working tree/u);
  });
});

describe("the model's edges", () => {
  it('a question it does not know is a loud error, recorded', () => {
    const { cwd } = repository('edges');
    assert.throws(() => run(cwd, ['bisect', 'start']), /fake git: unsupported — git bisect start/u);
    assert.equal(fake.unsupported.length, 1);
    fake.unsupported.length = 0;
  });

  it('outside a repository it fails as git fails', () => {
    const outside = mkdtempSync(join(root, 'outside-'));
    const result = run(outside, ['rev-parse', '--is-inside-work-tree']);
    assert.equal(result.status, 128);
    assert.match(result.stderr, /not a git repository/u);
  });

  it('a child process answers from the same model and its writes come back', () => {
    const { cwd, remote } = repository('child');
    const script = `
      import { run } from ${JSON.stringify(new URL('../../src/mc/git.js', import.meta.url).href)};
      const cwd = process.argv[1];
      const out = run(cwd, ['rev-parse', 'HEAD']);
      process.stdout.write(out.stdout);
      run(cwd, ['switch', '-qc', 'from-child']);
      run(cwd, ['push', '-q', '-u', 'origin', 'from-child']);
    `;
    const result = fake.inChild(process.env, (env) => spawnSync(process.execPath, ['--input-type=module', '-e', script, cwd], { env, encoding: 'utf8' }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), git(cwd, 'rev-parse', 'HEAD'));
    assert.equal(git(remote, 'rev-parse', 'refs/heads/from-child'), git(cwd, 'rev-parse', 'HEAD'), 'the child\'s push is in the parent\'s model');
    assert.equal(git(cwd, 'branch', '--show-current'), 'from-child');
  });

  it('merge-tree --write-tree, commit-tree and update-ref squash a branch onto main as the lifecycle fixture\'s GitHub does', () => {
    const { cwd, remote } = repository('squash');
    git(cwd, 'switch', '-qc', 'feature');
    writeFileSync(join(cwd, 'feature.txt'), 'feature\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'feature work');
    git(cwd, 'push', '-q', 'origin', 'feature');
    const main = git(remote, 'rev-parse', 'refs/heads/main');
    const tip = git(remote, 'rev-parse', 'refs/heads/feature');
    const tree = git(remote, 'merge-tree', '--write-tree', main, tip).split('\n')[0];
    assert.match(tree, sha);
    const commit = git(remote, 'commit-tree', tree, '-p', main, '-m', 'feature work (#1)');
    git(remote, 'update-ref', 'refs/heads/main', commit, main);
    assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), commit);
    git(cwd, 'fetch', '-q', 'origin');
    assert.equal(git(cwd, 'rev-parse', 'origin/main^{tree}'), git(cwd, 'rev-parse', 'HEAD^{tree}'), 'the squash has the branch\'s tree');
    assert.equal(git(cwd, 'merge-base', 'origin/main', 'HEAD'), main, 'and is not the branch\'s commit');
    assert.match(run(remote, ['update-ref', 'refs/heads/main', tip, main]).stderr, /expected/u, 'a stale compare-and-swap is refused');
  });

  it('this file started no git process', () => {
    // tests/_isolate-home.mjs logs every real git call this process and its
    // children make; the model answered them all.
    const log = process.env.MC_GIT_CALLS ? readFileSync(process.env.MC_GIT_CALLS, 'utf8') : '';
    assert.deepEqual(log.split('\n').filter((line) => line.startsWith(`${process.env.MC_GIT_TEST}\t`)), []);
  });
});

describe('what an archive asks of a worktree', () => {
  it('grep -l -F names the tracked files holding the text, and exits 1 when none does', () => {
    const { cwd } = repository('greps');
    mkdirSync(join(cwd, 'docs', 'sub'), { recursive: true });
    writeFileSync(join(cwd, 'docs', 'sub', 'k.md'), '# k\n');
    writeFileSync(join(cwd, 'src', 'b.js'), "read('docs/sub/k.md');\n");
    writeFileSync(join(cwd, 'src', 'c.js'), "read('docs/sub-two/k.md');\n");
    writeFileSync(join(cwd, 'untracked.js'), "read('docs/sub/k.md');\n");
    git(cwd, 'add', 'docs', 'src');
    assert.equal(git(cwd, 'grep', '-l', '-F', '--', 'docs/sub/', '--', 'src', 'tests'), 'src/b.js', 'tracked only, within the pathspecs');
    assert.equal(run(cwd, ['grep', '-l', '-F', '--', 'nowhere/', '--', 'src']).status, 1);
    assert.throws(() => run(cwd, ['grep', 'docs']), /unsupported — git grep docs/u, 'a grep it does not model is refused, not guessed');
  });

  it('a glob pathspec crosses directories, as ls-files -- "*.md" does in git', () => {
    const { cwd } = repository('globs');
    mkdirSync(join(cwd, 'docs', 'deep'), { recursive: true });
    writeFileSync(join(cwd, 'docs', 'deep', 'x.md'), 'x\n');
    git(cwd, 'add', 'docs');
    assert.deepEqual(git(cwd, 'ls-files', '--', '*.md').split('\n'), ['README.md', 'docs/deep/x.md']);
    assert.deepEqual(git(cwd, 'ls-files', '--', 'docs').split('\n'), ['docs/deep/x.md']);
  });

  it('ls-tree -d names a directory itself, or with a trailing slash the directories inside it', () => {
    const { cwd } = repository('dir-trees');
    mkdirSync(join(cwd, 'docs', 'project', 'one', 'deep'), { recursive: true });
    mkdirSync(join(cwd, 'docs', 'project', 'two'), { recursive: true });
    writeFileSync(join(cwd, 'docs', 'project', 'one', 'deep', 'a.md'), 'a\n');
    writeFileSync(join(cwd, 'docs', 'project', 'two', 'b.md'), 'b\n');
    writeFileSync(join(cwd, 'docs', 'project', 'log.md'), 'log\n');
    git(cwd, 'add', 'docs');
    git(cwd, 'commit', '-qm', 'docs');
    assert.deepEqual(git(cwd, 'ls-tree', '-d', '--name-only', 'HEAD', 'docs/project/').split('\n'), ['docs/project/one', 'docs/project/two']);
    assert.match(git(cwd, 'ls-tree', '-d', 'HEAD', 'docs/project/one'), /^040000 tree [0-9a-f]{40}\tdocs\/project\/one$/u);
    assert.equal(git(cwd, 'ls-tree', '-d', 'HEAD', 'docs/project/log.md'), '', 'a file is no tree');
    assert.equal(git(cwd, 'ls-tree', '-d', 'HEAD', 'docs/project/gone'), '');
  });

  it('push origin HEAD pushes the branch under its own name; branch --list and refname:short name it', () => {
    const { cwd, remote } = repository('heads');
    git(cwd, 'switch', '-qc', 'archive/x-1');
    git(cwd, 'push', '-q', '-u', 'origin', 'HEAD');
    assert.equal(git(remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'), 'archive/x-1\nmain');
    assert.equal(git(cwd, 'branch', '--list', 'archive/x-1'), '* archive/x-1');
    git(cwd, 'switch', '-q', 'main');
    git(cwd, 'branch', '-D', 'archive/x-1');
    assert.equal(git(cwd, 'branch', '--list', 'archive/x-1'), '', 'the other branches are not listed');
  });
});
