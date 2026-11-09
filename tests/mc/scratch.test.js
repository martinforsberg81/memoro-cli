/**
 * Registered source exports (scratch.js): the command and receipt lifecycle on
 * tiny real filesystem fixtures, with Git replaced at its boundary by a model
 * that answers `ls-tree` and streams object contents. The model proves the
 * mechanism's rules, not Git's semantics: those are the separate real-Git probe
 * (criterion 5, in LOG.md), which runs outside this file.
 *
 * What is protected: wrong-source reuse, deletion of source, evidence or
 * dependency targets, removal of a tree changed since its preview, and removal
 * that trusts a receipt without the tree it describes.
 */
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, cpSync, renameSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { defaultRepos } from '../../src/mc/repos.js';
import { runnerScratchDir } from '../../src/mc/paths.js';
import {
  DEPS_MARK, RECEIPTS_DIR, EXPORTS_DIR, createExport, exportKey, exportIdOf, normalizePaths, releaseExport, sweepSession, verifyExport,
} from '../../src/mc/scratch.js';
import { setLogPath } from '../../src/mc/logger.js';
import { blobId, gitModel, ZERO } from './_helpers/git-model.js';

const SESSION = { session: 'goal:mc/x', started: '2026-11-09T08:00:00Z' };
const nothingStands = () => [];
const nothingOpen = () => [];

setLogPath(join(mkdtempSync(join(tmpdir(), 'mc-scratch-log-')), 'mc.log'));

/** A runner's root with one memoro-cli repository, a scratch directory per session, and the model Git. */
function machine() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mc-scratch-')));
  const env = { HOME: join(root, 'home'), MC_HOME: join(root, 'mc-home'), MC_WORK_ROOT: join(root, 'work'), MC_REPOS_HOME: join(root, 'repos') };
  mkdirSync(env.HOME, { recursive: true });
  mkdirSync(join(root, 'repos', 'memoro-cli'), { recursive: true });
  const repos = defaultRepos(env).filter((repo) => repo.name === 'memoro-cli');
  const scratchRoot = runnerScratchDir(env);
  const git = gitModel();
  const first = git.commit('one', {
    'src/a.js': 'committed a\n',
    'src/sub/b.txt': 'committed b\n',
    'run.sh': { content: '#!/bin/sh\necho committed\n', mode: '100755' },
  });
  const second = git.commit('two', {
    'src/a.js': 'committed a, second\n',
    'src/sub/b.txt': 'committed b\n',
    'run.sh': { content: '#!/bin/sh\necho committed\n', mode: '100755' },
  });
  // The working tree differs from every commit: an export must not read it.
  writeFileSync(join(root, 'repos', 'memoro-cli', 'marker.txt'), 'working');
  const gitBoundary = { text: (cwd, args) => git.text(cwd, args), blobs: (cwd, shas) => git.blobs(cwd, shas) };
  const session = (stem, over = {}) => {
    const dir = join(scratchRoot, stem);
    mkdirSync(dir, { recursive: true });
    const marker = { schema: 'mc-scratch', version: 1, owner: 'runner', runner_pid: 4242, session: SESSION.session, kind: 'build', stem, started: SESSION.started, ...over };
    writeFileSync(join(dir, '.mc-scratch.json'), JSON.stringify(marker));
    return dir;
  };
  return {
    root, env, repos, scratchRoot, git, gitBoundary, first, second, session,
    create: (dir, over = {}) => createExport({
      scratch: dir, env, repos, repoName: 'memoro-cli', ref: 'HEAD', paths: ['src', 'run.sh'], git: gitBoundary, now: Date.parse('2026-11-09T08:30:00Z'), ...over,
    }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const read = (path) => readFileSync(path, 'utf8');
const exists = (path) => { try { lstatSync(path); return true; } catch { return false; } };
const receiptsOf = (dir) => (exists(join(dir, RECEIPTS_DIR)) ? readdirSync(join(dir, RECEIPTS_DIR)).sort() : []);

describe('scratch exports: creation from Git objects', () => {
  it('writes the committed bytes and modes, not the working files, and a repeated request in the same session reuses the one validated export', async () => {
    const m = machine();
    try {
      const dir = m.session('s1');
      const made = await m.create(dir);
      assert.equal(made.reused, false);
      assert.equal(read(join(made.path, 'src', 'a.js')), 'committed a, second\n', 'the committed bytes, from the object store');
      assert.equal(read(join(made.path, 'src', 'sub', 'b.txt')), 'committed b\n');
      assert.equal(read(join(made.path, 'run.sh')), '#!/bin/sh\necho committed\n');
      assert.equal(lstatSync(join(made.path, 'run.sh')).mode & 0o777, 0o755, 'the executable mode is kept');
      assert.equal(lstatSync(join(made.path, 'src', 'a.js')).mode & 0o111, 0, 'a regular file is not executable');
      assert.equal(exists(join(m.repos[0].path, '.git')), false, 'no checkout or copied .git is created');
      const again = await m.create(dir);
      assert.equal(again.reused, true, 'the same source and paths reuse the export');
      assert.equal(again.id, made.id);
      assert.deepEqual(readdirSync(join(dir, EXPORTS_DIR)), [made.id], 'one active path');
      assert.deepEqual(receiptsOf(dir), [`${made.id}.json`]);
    } finally { m.cleanup(); }
  });

  it('a different selection of the same commit gets its own export, and neither aliases the other', async () => {
    const m = machine();
    try {
      const dir = m.session('s2');
      const whole = await m.create(dir, { paths: ['.'] });
      const src = await m.create(dir, { paths: ['src'] });
      assert.notEqual(whole.id, src.id);
      assert.equal(read(join(src.path, 'src', 'a.js')), 'committed a, second\n');
      assert.deepEqual(readdirSync(src.path).sort(), ['src'], 'the narrower selection holds only what it names');
      assert.equal(exists(join(whole.path, 'run.sh')), true, 'the wider one is intact beside it');
      assert.equal(exists(join(src.path, 'run.sh')), false);
      assert.equal(normalizePaths(['src/', './src', 'src/sub/b.txt']).join(','), 'src,src/sub/b.txt', 'dedupe is literal, not a reduction of the set');
    } finally { m.cleanup(); }
  });

  it('a different commit of the same paths is a different source, and an earlier commit reconstructs its own bytes', async () => {
    const m = machine();
    try {
      const dir = m.session('s3');
      const later = await m.create(dir, { ref: m.second, paths: ['src/a.js'] });
      const earlier = await m.create(dir, { ref: m.first, paths: ['src/a.js'] });
      assert.notEqual(later.id, earlier.id);
      assert.equal(read(join(later.path, 'src', 'a.js')), 'committed a, second\n');
      assert.equal(read(join(earlier.path, 'src', 'a.js')), 'committed a\n');
    } finally { m.cleanup(); }
  });

  it('invalid owner, ref, path, wildcard, empty or Git-unsupported input publishes no ready receipt and creates no checkout', async () => {
    const m = machine();
    try {
      m.git.commit('links', { 'src/link': { target: 'a.js' }, 'src/a.js': 'a\n' });
      m.git.commit('gitlink', { 'vendor/lib': { gitlink: '1'.repeat(40) }, 'src/a.js': 'a\n' });
      const refused = [
        ['traversal', { paths: ['../etc'] }, /traversal/u],
        ['absolute', { paths: ['/etc/hosts'] }, /absolute/u],
        ['wildcard', { paths: ['src/*'] }, /wildcard/u],
        ['empty', { paths: [''] }, /empty/u],
        ['no paths', { paths: [] }, /no paths/u],
        ['repository internals', { paths: ['.git/config'] }, /internals/u],
        ['an unknown ref', { ref: 'no-such-ref' }, /names no commit/u],
        ['a ref that is an option', { ref: '--all' }, /refused/u],
        ['a path not in the commit', { paths: ['nope'] }, /is not in/u],
        ['a symbolic link in the selection', { ref: 'links', paths: ['src'] }, /symbolic link refused/u],
        ['a submodule in the selection', { ref: 'gitlink', paths: ['vendor'] }, /submodule/u],
      ];
      for (const [name, over, pattern] of refused) {
        const dir = m.session(`bad-${name.replace(/\W+/gu, '-')}`);
        await assert.rejects(() => m.create(dir, over), pattern, `${name} is refused`);
        assert.deepEqual(receiptsOf(dir), [], `${name} publishes no receipt`);
        assert.deepEqual(exists(join(dir, EXPORTS_DIR)) ? readdirSync(join(dir, EXPORTS_DIR)) : [], [], `${name} leaves no tree`);
      }
      await assert.rejects(() => m.create(null), /MC_SCRATCH is not set/u, 'an unset owner');
      const ended = m.session('ended-before', { ended: '2026-11-09T09:00:00Z', exit: 0 });
      await assert.rejects(() => m.create(ended), /has ended/u, 'an ended session makes nothing');
      assert.deepEqual(receiptsOf(ended), []);
      assert.equal(exists(join(m.repos[0].path, '.git')), false, 'no checkout is made anywhere');
    } finally { m.cleanup(); }
  });

  it('a retention conflict or a failed retention stops creation: no ready receipt, no tree', async () => {
    const m = machine();
    try {
      const dir = m.session('s8');
      m.git.faults.retainFails = true;
      await assert.rejects(() => m.create(dir), /could not retain/u);
      m.git.faults.retainFails = false;
      m.git.retained.set(m.first, 'f'.repeat(40));
      await assert.rejects(() => m.create(dir, { ref: m.first }), /already names/u);
      assert.deepEqual(receiptsOf(dir), [], 'no receipt is published');
      assert.equal(exists(join(dir, EXPORTS_DIR)) ? readdirSync(join(dir, EXPORTS_DIR)).length : 0, 0);
    } finally { m.cleanup(); }
  });

  it('a blob whose content differs from its id fails the creation and leaves no ready receipt', async () => {
    const m = machine();
    try {
      const dir = m.session('s9');
      m.git.faults.corrupt = blobId('committed a, second\n');
      await assert.rejects(() => m.create(dir), /does not match its id/u);
      assert.deepEqual(receiptsOf(dir), []);
      assert.equal(exists(join(dir, EXPORTS_DIR, exportIdOf(m.second, exportKey('memoro-cli', m.second, normalizePaths(['src', 'run.sh']))))), false, 'the partial tree is removed');
    } finally { m.cleanup(); }
  });

  it('an existing export that changed is kept with its reason and never overwritten', async () => {
    const m = machine();
    try {
      const dir = m.session('s10');
      const made = await m.create(dir);
      writeFileSync(join(made.path, 'src', 'a.js'), 'edited by hand\n');
      await assert.rejects(() => m.create(dir), /changed \(a file changed size: src\/a\.js\)/u);
      assert.equal(read(join(made.path, 'src', 'a.js')), 'edited by hand\n', 'the changed tree is not overwritten');
      assert.ok(exists(join(dir, RECEIPTS_DIR, `${made.id}.json`)), 'its receipt stays');
    } finally { m.cleanup(); }
  });

  it('a dependency link is recorded beside the tree, and a link into the tree itself is refused', async () => {
    const m = machine();
    try {
      const dir = m.session('s11');
      const deps = join(m.root, 'prepared', 'node_modules');
      mkdirSync(deps, { recursive: true });
      writeFileSync(join(deps, DEPS_MARK), '{"attached":true}\n');
      const made = await m.create(dir, { attachDeps: deps });
      assert.equal(readlinkSync(join(made.path, 'node_modules')), realpathSync(deps));
      assert.equal(made.receipt.attachment.target, realpathSync(deps));
      await assert.rejects(() => m.create(dir, { paths: ['src'], attachDeps: join(made.path, 'src') }), /no .*memoro-deps|not a directory|dependency/u);
    } finally { m.cleanup(); }
  });

  it('the receipt key is the repository, the commit and the canonical path set, and the id differs for different sets', () => {
    const commit = 'a'.repeat(40);
    const one = exportKey('memoro-cli', commit, ['src']);
    assert.notEqual(one, exportKey('memoro-cli', commit, ['src/sub']));
    assert.notEqual(one, exportKey('memoro', commit, ['src']));
    assert.notEqual(exportIdOf(commit, one), exportIdOf(commit, exportKey('memoro-cli', commit, ['.'])));
    assert.equal(exportKey('memoro-cli', commit, normalizePaths(['src/', './src'])), one);
  });
});

describe('scratch exports: explicit release', () => {
  it('a preview removes nothing; apply removes exactly the export tree and keeps the receipt, logs and patch bytes', async () => {
    const m = machine();
    try {
      const dir = m.session('s20', { ended: undefined });
      writeFileSync(join(dir, 'gate.log'), 'red log\n');
      writeFileSync(join(dir, 'fault.patch'), 'diff\n');
      const made = await m.create(dir);
      const id = made.id;
      const preview = releaseExport({ scratch: dir, env: m.env, id, git: m.gitBoundary, repos: m.repos, standing: nothingStands, openIn: nothingOpen, now: Date.parse('2026-11-09T08:40:00Z') });
      assert.equal(preview.applied, false);
      assert.equal(preview.target, true, 'the owning session may release while it still runs');
      assert.equal(read(join(made.path, 'src', 'a.js')), 'committed a, second\n', 'the preview removed nothing');
      const applied = releaseExport({ scratch: dir, env: m.env, id, apply: true, git: m.gitBoundary, repos: m.repos, standing: nothingStands, openIn: nothingOpen, now: Date.parse('2026-11-09T08:41:00Z') });
      assert.equal(applied.applied, true, applied.why);
      assert.equal(exists(made.path), false, 'the tree is gone');
      assert.equal(read(join(dir, 'gate.log')), 'red log\n', 'the logs stay');
      assert.equal(read(join(dir, 'fault.patch')), 'diff\n', 'the patch stays');
      const kept = JSON.parse(read(join(dir, RECEIPTS_DIR, `${id}.json`)));
      assert.equal(kept.state, 'released', 'the receipt remains, released');
      assert.equal(kept.commit, m.second, 'and still names its source');
      assert.equal(exists(join(dir, RECEIPTS_DIR, `${id}.plan.json`)), false, 'the preview is spent');
      assert.equal(exists(join(m.repos[0].path, '.git')), false);
      assert.equal(m.git.retained.get(m.second), m.second, 'the retained source remains');
    } finally { m.cleanup(); }
  });

  it('a forged filename/payload id cannot redirect release or sweep to an unselected export', async () => {
    const m = machine();
    try {
      const dir = m.session('forged-id');
      const a = await m.create(dir, { paths: ['src/a.js'] });
      const b = await m.create(dir, { paths: ['run.sh'] });
      const aReceipt = join(dir, RECEIPTS_DIR, `${a.id}.json`);
      writeFileSync(aReceipt, read(join(dir, RECEIPTS_DIR, `${b.id}.json`)));
      const base = { scratch: dir, env: m.env, id: a.id, git: m.gitBoundary, repos: m.repos, standing: nothingStands, openIn: nothingOpen };
      const preview = releaseExport(base);
      const applied = releaseExport({ ...base, apply: true });
      assert.equal(exists(b.path), true, 'an unselected export must survive release of another id');
      assert.equal(exists(a.path), true, 'the forged selected export stays too');
      assert.equal(preview.target, false);
      assert.equal(applied.applied, false);
      assert.match(preview.why, /another export/u);
      // Sweep sees only the forged filename; B is now unregistered and must stay.
      unlinkSync(join(dir, RECEIPTS_DIR, `${b.id}.json`));
      const marker = join(dir, '.mc-scratch.json');
      writeFileSync(marker, JSON.stringify({ ...JSON.parse(read(marker)), ended: '2026-11-09T09:00:00Z' }));
      const sweep = sweepSession({ ...base, stemDir: dir });
      assert.deepEqual(sweep.removed, []);
      assert.equal(read(join(b.path, 'run.sh')), '#!/bin/sh\necho committed\n');
      assert.equal(read(join(a.path, 'src/a.js')), 'committed a, second\n');
    } finally { m.cleanup(); }
  });

  it('explicit release inspects only its selected receipt and tree, never sibling contents', async () => {
    const m = machine();
    try {
      const dir = m.session('scoped');
      const a = await m.create(dir, { paths: ['src/a.js'] });
      const b = await m.create(dir, { paths: ['run.sh'] });
      const base = { scratch: dir, env: m.env, id: a.id, git: m.gitBoundary, repos: m.repos,
        standing: (path) => { assert.equal(path, a.path, 'never inspect the sibling'); return []; }, openIn: nothingOpen };
      assert.equal(releaseExport(base).target, true);
      assert.equal(releaseExport({ ...base, apply: true }).applied, true);
      assert.equal(exists(a.path), false);
      assert.equal(read(join(b.path, 'run.sh')), '#!/bin/sh\necho committed\n');
    } finally { m.cleanup(); }
  });

  it('sweep rechecks each candidate after sibling inspection, preserving newly changed evidence and using fresh activity and time', async () => {
    const m = machine();
    try {
      const dir = m.session('sweep-race');
      const exports = [await m.create(dir, { paths: ['src/a.js'] }), await m.create(dir, { paths: ['run.sh'] })].sort((a, b) => a.id.localeCompare(b.id));
      const [first, second] = exports;
      const file = join(first.path, first.receipt.inventory[0].path);
      const marker = join(dir, '.mc-scratch.json');
      writeFileSync(marker, JSON.stringify({ ...JSON.parse(read(marker)), ended: '2026-11-09T09:00:00Z' }));
      let changed = false;
      let time = Date.parse('2026-11-09T10:00:00Z');
      const base = { stemDir: dir, env: m.env, git: m.gitBoundary, repos: m.repos, standing: nothingStands,
        openIn: (path) => {
          if (path === second.path && !changed) { writeFileSync(file, 'NEW USER EVIDENCE'); changed = true; }
          return [];
        }, clock: () => { time += 1000; return time; } };
      const outcome = sweepSession(base);
      assert.equal(exists(file), true, 'changed content must survive deletion-time recheck');
      assert.equal(read(file), 'NEW USER EVIDENCE');
      assert.deepEqual(outcome.removed.map((item) => item.id), [second.id]);
      assert.match(outcome.kept.find((item) => item.id === first.id).why, /changed/u);
      const released = JSON.parse(read(join(dir, RECEIPTS_DIR, `${second.id}.json`)));
      assert.equal(released.released.at, new Date(time).toISOString());
      // Restore committed bytes, then let activity appear only at deletion.
      writeFileSync(file, first.receipt.inventory[0].path === 'run.sh' ? '#!/bin/sh\necho committed\n' : 'committed a, second\n');
      let inspections = 0;
      const busy = sweepSession({ ...base, openIn: () => ++inspections === 1 ? [] : [81] });
      assert.deepEqual(busy.removed, []);
      assert.match(busy.kept.find((item) => item.id === first.id).why, /process 81/u);
      assert.equal(exists(file), true);
    } finally { m.cleanup(); }
  });

  it('a dependency link is unlinked without following it: its target and its contents survive', async () => {
    const m = machine();
    try {
      const dir = m.session('s21', { ended: undefined });
      const deps = join(m.root, 'prepared', 'node_modules');
      mkdirSync(join(deps, 'left-pad'), { recursive: true });
      writeFileSync(join(deps, DEPS_MARK), '{"attached":true}\n');
      writeFileSync(join(deps, 'left-pad', 'index.js'), 'module.exports = 1;\n');
      const made = await m.create(dir, { attachDeps: deps });
      const opts = { scratch: dir, env: m.env, id: made.id, git: m.gitBoundary, repos: m.repos, standing: nothingStands, openIn: nothingOpen };
      releaseExport({ ...opts });
      assert.equal(releaseExport({ ...opts, apply: true }).applied, true);
      assert.equal(exists(join(made.path, 'node_modules')), false, 'the link is unlinked');
      assert.equal(read(join(deps, 'left-pad', 'index.js')), 'module.exports = 1;\n', 'the target is never traversed or removed');
      assert.equal(read(join(deps, DEPS_MARK)), '{"attached":true}\n');
    } finally { m.cleanup(); }
  });

  it('an added, changed or missing file, a replaced source, owner or dependency target keeps the export, with its reason', async () => {
    const m = machine();
    try {
      const cases = [
        ['added', (made) => writeFileSync(join(made.path, 'src', 'extra.txt'), 'x'), /added to the export: src\/extra\.txt/u],
        ['changed', (made) => writeFileSync(join(made.path, 'src', 'a.js'), 'Xommitted a, second\n'), /changed content: src\/a\.js/u],
        ['missing', (made) => unlinkSync(join(made.path, 'src', 'a.js')), /missing from the export: src\/a\.js/u],
        ['unretained', (made, mm) => mm.git.retained.delete(mm.second), /retained source ref is missing/u],
        ['owner replaced', (made, mm, dir) => writeFileSync(join(dir, '.mc-scratch.json'), JSON.stringify({ ...JSON.parse(read(join(dir, '.mc-scratch.json'))), session: 'goal:mc/y' })), /owning session of this export changed/u],
        ['symlink added', (made) => symlinkSync('/etc', join(made.path, 'escape')), /symbolic link is not part of the export: escape/u],
      ];
      for (const [name, change, pattern] of cases) {
        const dir = m.session(`case-${name.replace(/\W+/gu, '-')}`, { ended: undefined });
        const made = await m.create(dir);
        change(made, m, dir);
        const verdict = releaseExport({ scratch: dir, env: m.env, id: made.id, git: m.gitBoundary, repos: m.repos, standing: nothingStands, openIn: nothingOpen });
        assert.equal(verdict.target, false, `${name}: not a target`);
        assert.match(verdict.why, pattern, `${name}: the reason is named`);
        if (name !== 'owner replaced' && name !== 'unretained') assert.equal(exists(made.path), true, `${name}: the tree stays`);
      }
    } finally { m.cleanup(); }
  });

  it('a live process in the tree, an open file, or a state nobody can read keeps the export', async () => {
    const m = machine();
    try {
      const dir = m.session('s30', { ended: undefined });
      const made = await m.create(dir);
      const base = { scratch: dir, env: m.env, id: made.id, git: m.gitBoundary, repos: m.repos };
      assert.match(releaseExport({ ...base, standing: () => [77], openIn: nothingOpen }).why, /process 77 stands in it/u);
      assert.match(releaseExport({ ...base, standing: nothingStands, openIn: () => [78] }).why, /process 78 holds a file open/u);
      assert.match(releaseExport({ ...base, standing: () => null, openIn: nothingOpen }).why, /could not tell whether a process/u);
      assert.match(releaseExport({ ...base, standing: nothingStands, openIn: () => null }).why, /could not tell whether a file/u);
      assert.equal(exists(made.path), true, 'every uncertain case keeps the tree');
    } finally { m.cleanup(); }
  });

  it('a stale preview is not applied: a change after it keeps the export, and a receipt replaced after it is refused', async () => {
    const m = machine();
    try {
      const dir = m.session('s31', { ended: undefined });
      const made = await m.create(dir);
      const base = { scratch: dir, env: m.env, id: made.id, git: m.gitBoundary, repos: m.repos, standing: nothingStands, openIn: nothingOpen };
      releaseExport({ ...base });
      writeFileSync(join(made.path, 'src', 'sub', 'b.txt'), 'changed after the preview\n');
      const stale = releaseExport({ ...base, apply: true });
      assert.equal(stale.applied, false);
      assert.match(stale.why, /missing|changed|re-check|content/u);
      assert.equal(exists(join(made.path, 'src', 'sub', 'b.txt')), true, 'changed evidence must survive stale apply');
      assert.equal(read(join(made.path, 'src', 'sub', 'b.txt')), 'changed after the preview\n', 'the changed file survives');
      writeFileSync(join(made.path, 'src', 'sub', 'b.txt'), 'committed b\n');
      releaseExport({ ...base });
      const receipt = join(dir, RECEIPTS_DIR, `${made.id}.json`);
      writeFileSync(receipt, read(receipt).replace('"state": "ready"', '"state": "ready", "note": "edited"'));
      const replaced = releaseExport({ ...base, apply: true });
      assert.equal(replaced.applied, false, 'a changed receipt is not acted on');
      assert.equal(exists(made.path), true);
    } finally { m.cleanup(); }
  });

  it('permission and partial filesystem removal failures leave visible removing receipts and retry without losing evidence', async () => {
    const m = machine();
    try {
      for (const partial of [false, true]) {
        const dir = m.session(`failure-${partial}`);
        const made = await m.create(dir);
        writeFileSync(join(dir, 'gate.log'), 'preserve evidence');
        const base = { scratch: dir, env: m.env, id: made.id, git: m.gitBoundary, repos: m.repos, standing: nothingStands, openIn: nothingOpen };
        releaseExport(base);
        const failed = releaseExport({ ...base, apply: true, removeTree: (path) => {
          assert.equal(path, made.path);
          assert.equal(JSON.parse(read(join(dir, RECEIPTS_DIR, `${made.id}.json`))).state, 'removing');
          if (partial) unlinkSync(join(path, 'run.sh'));
          throw Object.assign(new Error('EACCES: fixture removal denied'), { code: 'EACCES' });
        } });
        assert.equal(failed.applied, false, 'an actual failed apply is visible');
        assert.match(failed.why, /partial removal: EACCES/u);
        assert.equal(exists(made.path), true);
        assert.equal(exists(join(made.path, 'run.sh')), !partial);
        assert.equal(read(join(made.path, 'src/a.js')), 'committed a, second\n');
        assert.equal(JSON.parse(read(join(dir, RECEIPTS_DIR, `${made.id}.json`))).state, 'removing');
        assert.equal(read(join(dir, 'gate.log')), 'preserve evidence');
        // Added evidence after a partial failure blocks the retry as well.
        writeFileSync(join(made.path, 'new-evidence'), 'keep');
        assert.match(releaseExport(base).why, /added to the export/u);
        assert.equal(read(join(made.path, 'new-evidence')), 'keep');
        unlinkSync(join(made.path, 'new-evidence'));
        assert.equal(releaseExport(base).target, true, 'a new preview reconciles remaining files');
        assert.equal(releaseExport({ ...base, apply: true }).applied, true);
        assert.equal(exists(made.path), false);
        assert.equal(JSON.parse(read(join(dir, RECEIPTS_DIR, `${made.id}.json`))).state, 'released');
        assert.equal(read(join(dir, 'gate.log')), 'preserve evidence');
      }
    } finally { m.cleanup(); }
  });

  it('preview replacements of root, export, generation, ancestors and dependency identity retain every candidate and outside byte', async () => {
    const m = machine();
    try {
      for (const kind of ['root', 'export', 'generation', 'ancestor', 'receipt-ancestor', 'attachment', 'link', 'local-deps', 'source-conflict']) {
        const dir = m.session(`replace-${kind}`);
        const deps = join(m.root, `deps-${kind}`);
        mkdirSync(deps); writeFileSync(join(deps, DEPS_MARK), '{}'); writeFileSync(join(deps, 'unique'), 'outside dependency bytes');
        const made = await m.create(dir, { attachDeps: deps });
        const base = { scratch: dir, env: m.env, id: made.id, git: m.gitBoundary, repos: m.repos, standing: nothingStands, openIn: nothingOpen };
        releaseExport(base);
        let expected;
        if (kind === 'root') { renameSync(dir, `${dir}-old`); cpSync(`${dir}-old`, dir, { recursive: true, verbatimSymlinks: true }); expected = /scratch directory was replaced/u; }
        if (kind === 'export') { renameSync(made.path, `${made.path}-old`); cpSync(`${made.path}-old`, made.path, { recursive: true, verbatimSymlinks: true }); expected = /export directory was replaced/u; }
        if (kind === 'generation') {
          const p = join(dir, RECEIPTS_DIR, `${made.id}.json`);
          writeFileSync(p, JSON.stringify({ ...JSON.parse(read(p)), generation: 2 })); expected = /changed since its preview/u;
        }
        if (kind === 'ancestor') { renameSync(join(dir, EXPORTS_DIR), join(dir, 'kept-exports')); symlinkSync(join(dir, 'kept-exports'), join(dir, EXPORTS_DIR)); expected = /exports directory is a link/u; }
        if (kind === 'receipt-ancestor') { renameSync(join(dir, RECEIPTS_DIR), join(dir, 'kept-receipts')); symlinkSync(join(dir, 'kept-receipts'), join(dir, RECEIPTS_DIR)); expected = /scratch ancestor is a link/u; }
        if (kind === 'link') { unlinkSync(join(made.path, 'node_modules')); symlinkSync(m.root, join(made.path, 'node_modules')); expected = /dependency link points elsewhere/u; }
        if (kind === 'attachment') { renameSync(deps, `${deps}-old`); mkdirSync(deps); writeFileSync(join(deps, DEPS_MARK), '{}'); writeFileSync(join(deps, 'unique'), 'replacement bytes'); expected = /dependency target changed/u; }
        if (kind === 'local-deps') { unlinkSync(join(made.path, 'node_modules')); mkdirSync(join(made.path, 'node_modules')); writeFileSync(join(made.path, 'node_modules/local'), 'unique local bytes'); expected = /directory was added|real directory/u; }
        if (kind === 'source-conflict') { m.git.retained.set(m.second, 'f'.repeat(40)); expected = /retained source ref/u; }
        if (kind === 'receipt-ancestor') {
          assert.throws(() => releaseExport({ ...base, apply: true }), expected);
          assert.equal(read(join(made.path, 'src/a.js')), 'committed a, second\n');
          assert.equal(read(join(deps, 'unique')), 'outside dependency bytes');
          continue;
        }
        const applied = releaseExport({ ...base, apply: true });
        assert.equal(applied.applied, false, kind);
        assert.match(applied.why, expected, kind);
        assert.equal(exists(made.path), true, `${kind}: tree survives`);
        assert.equal(read(join(made.path, 'src/a.js')), 'committed a, second\n');
        assert.equal(read(join(kind === 'attachment' ? `${deps}-old` : deps, 'unique')), 'outside dependency bytes');
        if (kind === 'local-deps') assert.equal(read(join(made.path, 'node_modules/local')), 'unique local bytes');
        m.git.retained.set(m.second, m.second);
      }
    } finally { m.cleanup(); }
  });

  it('the sweep of a session removes only that session\'s ended exports, and an unended sibling\'s stays byte for byte', async () => {
    const m = machine();
    try {
      const ended = m.session('ended-one');
      const running = m.session('running-one');
      const endedMade = await m.create(ended);
      const runningMade = await m.create(running);
      // The session ends after its export: the record says so, the export stays until a sweep.
      writeFileSync(join(ended, '.mc-scratch.json'), JSON.stringify({ ...JSON.parse(read(join(ended, '.mc-scratch.json'))), ended: '2026-11-09T09:00:00Z', exit: 0 }));
      writeFileSync(join(ended, 'gate.log'), 'keep');
      const answer = sweepSession({ stemDir: ended, env: m.env, git: m.gitBoundary, repos: m.repos, standing: nothingStands, openIn: nothingOpen });
      assert.deepEqual(answer.removed.map((item) => item.id), [endedMade.id]);
      assert.equal(exists(endedMade.path), false);
      assert.equal(read(join(ended, 'gate.log')), 'keep');
      const unended = sweepSession({ stemDir: running, env: m.env, git: m.gitBoundary, repos: m.repos, standing: nothingStands, openIn: nothingOpen });
      assert.deepEqual(unended.removed, []);
      assert.equal(read(join(runningMade.path, 'src', 'a.js')), 'committed a, second\n', 'the running session keeps its export');
    } finally { m.cleanup(); }
  });

  it('a session whose exports another mc process holds is left alone: release and sweep refuse, and the tree stays', async () => {
    const m = machine();
    try {
      const dir = m.session('s34', { ended: undefined });
      const made = await m.create(dir);
      // A lock held by a live process (this one): the create, reuse, release and sweep of the session wait their turn.
      writeFileSync(join(dir, RECEIPTS_DIR, '.lock'), `${process.pid}\n`);
      const base = { scratch: dir, env: m.env, id: made.id, git: m.gitBoundary, repos: m.repos, standing: nothingStands, openIn: nothingOpen };
      assert.throws(() => releaseExport({ ...base, apply: true }), /another mc process is changing this session/u);
      assert.throws(() => sweepSession({ stemDir: dir, env: m.env, git: m.gitBoundary, repos: m.repos, standing: nothingStands, openIn: nothingOpen }), /another mc process/u);
      await assert.rejects(() => m.create(dir), /another mc process/u);
      assert.equal(read(join(made.path, 'src', 'a.js')), 'committed a, second\n', 'the tree is untouched while it is held');
      unlinkSync(join(dir, RECEIPTS_DIR, '.lock'));
      releaseExport({ ...base });
      assert.equal(releaseExport({ ...base, apply: true }).applied, true, 'and released once the lock is gone');
    } finally { m.cleanup(); }
  });

  it('verifyExport refuses a receipt whose inventory does not reconcile with the retained commit', async () => {
    const m = machine();
    try {
      const dir = m.session('s33');
      const made = await m.create(dir);
      const forged = { ...made.receipt, inventory: made.receipt.inventory.map((entry) => (entry.path === 'run.sh' ? { ...entry, mode: '100644' } : entry)) };
      const proof = verifyExport({ stemDir: dir, id: made.id, receipt: forged, git: m.gitBoundary, repos: m.repos });
      assert.equal(proof.ok, false);
      assert.match(proof.why, /does not reconcile with the retained commit/u);
      assert.equal(read(join(made.path, 'run.sh')), '#!/bin/sh\necho committed\n', 'the tree is untouched by the check');
    } finally { m.cleanup(); }
  });
});
