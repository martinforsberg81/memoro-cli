/**
 * `mc shot dev --compare <ref>`: the other tree, the diff, and what is printed.
 *
 * Git, the servers and the capture script are injected: what is asserted is
 * which git commands mc would run (and on which directories), how two measure
 * lists pair up, and the lines a caller reads.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { run } from '../../src/mc/commands/shot.js';
import { compareTree, diffMeasure, refOutPath } from '../../src/mc/shot-compare.js';

const HERE_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REF_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const FOOTER = {
  element: 'footer.assistant-layout__footer',
  rect: { top: 760, bottom: 810, left: 0, right: 390, width: 390, height: 50 },
  position: 'absolute',
  padding: '0px 12px',
  margin: '0px',
  overflow_y: 'visible',
  z_index: '5',
  scroll: null,
  visible: true,
};
const CONTENT = {
  element: 'main.window-view__content',
  rect: { top: 0, bottom: 844, left: 0, right: 390, width: 390, height: 844 },
  position: 'relative',
  padding: '0px',
  margin: '0px',
  overflow_y: 'auto',
  z_index: 'auto',
  scroll: { top: 1200, height: 2044, client: 844 },
  visible: true,
};

describe('diffMeasure', () => {
  it('the same lists give nothing, and no measure on either side gives nothing', () => {
    assert.deepEqual(diffMeasure([CONTENT, FOOTER], [CONTENT, FOOTER]), []);
    assert.deepEqual(diffMeasure(undefined, undefined), []);
    assert.deepEqual(diffMeasure([], []), []);
  });

  it('a moved rect.bottom is one entry with both values; drift under 0.05 is not', () => {
    const moved = { ...FOOTER, rect: { ...FOOTER.rect, bottom: 776, top: 726.02 } };
    const diff = diffMeasure([CONTENT, { ...FOOTER, rect: { ...FOOTER.rect, top: 726 } }], [CONTENT, moved]);
    assert.deepEqual(diff, [
      { index: 1, element: 'footer.assistant-layout__footer', field: 'rect.bottom', ref: 810, here: 776 },
    ]);
  });

  it('an element only one side has is missing on the other', () => {
    assert.deepEqual(diffMeasure([CONTENT], [CONTENT, FOOTER]), [
      { index: 1, element: FOOTER.element, field: 'missing', ref: null, here: FOOTER.element },
    ]);
    assert.deepEqual(diffMeasure([CONTENT, FOOTER], [CONTENT]), [
      { index: 1, element: FOOTER.element, field: 'missing', ref: FOOTER.element, here: null },
    ]);
  });

  it('visible flipping is a difference, and so is a scroll key', () => {
    const diff = diffMeasure([CONTENT, FOOTER], [{ ...CONTENT, scroll: { ...CONTENT.scroll, top: 1100 } }, { ...FOOTER, visible: false }]);
    assert.deepEqual(diff.map((item) => [item.index, item.field, item.ref, item.here]), [
      [0, 'scroll.top', 1200, 1100],
      [1, 'visible', true, false],
    ]);
  });
});

/** A fake git answering from a table, recording every call. */
function fakeGit({ refs = { 'origin/main': REF_SHA }, head = HERE_SHA, status = '', heads = {}, failAdd = false } = {}) {
  const calls = [];
  const git = (args) => {
    calls.push(args);
    const [, dir, verb, ...rest] = args;
    if (verb === 'rev-parse' && rest[0] === '--verify') return { status: 0, stdout: refs[rest[2].replace('^{commit}', '')] || '' };
    if (verb === 'rev-parse' && rest[0] === 'HEAD') return { status: 0, stdout: heads[dir] ?? head };
    if (verb === 'status') return { status: 0, stdout: status };
    if (verb === 'worktree' && rest[0] === 'add') {
      if (failAdd) return { status: 128, stderr: 'fatal: nope' };
      mkdirSync(join(rest[2], 'node_modules'), { recursive: true });
      return { status: 0 };
    }
    return { status: 0, stdout: '' };
  };
  return { git, calls };
}

function roots() {
  const home = mkdtempSync(join(tmpdir(), 'mc-shot-compare-'));
  const root = join(home, 'compare');
  const worktree = join(home, 'memoro-fix');
  mkdirSync(root, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  return { home, root, worktree };
}

const removes = (calls) => calls.filter((args) => args[2] === 'worktree' && args[3] === 'remove').map((args) => args.at(-1));

describe('compareTree', () => {
  it('an unknown ref names the fetch', () => {
    const { root, worktree } = roots();
    const { git } = fakeGit();
    const tree = compareTree(worktree, 'origin/nope', { git, root });
    assert.equal(tree.ok, false);
    assert.equal(tree.error, `no commit origin/nope in ${worktree} (git fetch origin?)`);
  });

  it('HEAD with nothing edited is refused; HEAD with an edit is not', () => {
    const { root, worktree } = roots();
    const clean = fakeGit({ refs: { HEAD: HERE_SHA } });
    const tree = compareTree(worktree, 'HEAD', { git: clean.git, root });
    assert.equal(tree.error, "HEAD is this tree's HEAD and nothing is edited — nothing to compare");
    const edited = fakeGit({ refs: { HEAD: HERE_SHA }, status: ' M public/css/x.css\n' });
    assert.equal(compareTree(worktree, 'HEAD', { git: edited.git, root, serversFor: () => [] }).ok, true);
  });

  it('a tree already at the commit is reused, and no worktree is added', () => {
    const { root, worktree } = roots();
    const dir = join(root, `memoro-fix-${REF_SHA.slice(0, 10)}`);
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    const { git, calls } = fakeGit({ heads: { [dir]: REF_SHA } });
    const tree = compareTree(worktree, 'origin/main', { git, root, spawnSync: () => assert.fail('no deps:prepare') });
    assert.deepEqual(tree, { ok: true, dir, commit: REF_SHA, reused: true });
    assert.equal(calls.some((args) => args[3] === 'add'), false);
  });

  it('otherwise the tree is added detached at the commit, and deps:prepare runs without node_modules', () => {
    const { root, worktree } = roots();
    const dir = join(root, `memoro-fix-${REF_SHA.slice(0, 10)}`);
    const { calls } = fakeGit();
    const git = (args) => (args[2] === 'worktree' && args[3] === 'add'
      ? (calls.push(args), mkdirSync(args[5], { recursive: true }), { status: 0 })
      : fakeGit().git(args));
    const spawned = [];
    const tree = compareTree(worktree, 'origin/main', {
      git, root, serversFor: () => [], spawnSync: (cmd, args, opts) => { spawned.push([cmd, args, opts.cwd, opts.stdio[1]]); return { status: 0 }; },
    });
    assert.equal(tree.ok, true);
    assert.deepEqual(calls, [['-C', worktree, 'worktree', 'add', '--detach', dir, REF_SHA]]);
    assert.deepEqual(spawned, [['npm', ['run', 'deps:prepare'], dir, 2]], 'npm writes to stderr, never stdout');
    const failed = compareTree(worktree, 'origin/main', { git: fakeGit({ failAdd: true }).git, root: join(root, 'x'), serversFor: () => [] });
    assert.match(failed.error, /git worktree add .* failed: fatal: nope/u);
  });

  it('prune removes only an old directory with no server, and never one outside the root', () => {
    const { home, root, worktree } = roots();
    const old = join(root, 'memoro-other-1111111111');
    const served = join(root, 'memoro-served-2222222222');
    const fresh = join(root, 'memoro-fresh-3333333333');
    const outside = join(home, 'memoro-outside');
    for (const dir of [old, served, fresh, outside]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, 'a-file'), 'x');
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    for (const dir of [old, served, outside]) utimesSync(dir, twoDaysAgo, twoDaysAgo);
    const { git, calls } = fakeGit();
    const tree = compareTree(worktree, 'origin/main', {
      git, root, serversFor: (dir) => (dir === served ? [{ live: true }] : []),
    });
    assert.equal(tree.ok, true);
    assert.deepEqual(removes(calls), [old]);
  });
});

const SHOT_JSON = {
  schema_version: 1,
  argv: [process.execPath, 'fake-shot.mjs'],
  default_viewport: 'desktop',
  viewports: { desktop: { width: 1440, height: 900, dpr: 2 }, iphone: { width: 390, height: 844, dpr: 3, mobile: true } },
  shells: { base: '.base-view' },
  targets: [{ name: 'assistant', path: '/app/assistant' }],
  default_account: 'seeded',
  accounts: {
    seeded: { summary: 's', onboarding: { done: '/dev/login?account=seeded&ready=1', fresh: '/dev/login?account=seeded&reseed=1' } },
  },
};
const TEST_JSON = {
  schema_version: 1,
  environments: { dev: { service: 'memoro-measure' }, prod: { base_url: 'https://meetmemoro.app/' } },
  suites: [{ name: 'smoke', argv: ['true'] }],
};

function sink() {
  let text = '';
  return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } };
}

async function compare(argv, { measures = {}, warnings = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mc-shot-compare-cmd-'));
  const worktree = join(home, 'memoro');
  const refDir = join(home, 'compare', `memoro-${REF_SHA.slice(0, 10)}`);
  mkdirSync(join(worktree, '.mc'), { recursive: true });
  writeFileSync(join(worktree, '.mc', 'shot.json'), JSON.stringify(SHOT_JSON));
  writeFileSync(join(worktree, '.mc', 'test.json'), JSON.stringify(TEST_JSON));
  const stdout = sink();
  const stderr = sink();
  const captures = [];
  const servers = [];
  const code = await run(argv, {
    stdout,
    stderr,
    env: { ...process.env, MC_REPOS_HOME: home },
    cwd: home,
    callerWorktree: () => worktree,
    now: () => new Date(2026, 9, 15, 9, 0, 0),
    compareTree: (tree, ref) => ({ ok: true, dir: refDir, commit: REF_SHA, ref, from: tree }),
    readDeclaration: () => ({ ok: true, declaration: TEST_JSON }),
    ensureAppServer: async (dir) => {
      servers.push(dir);
      const port = dir === worktree ? 8787 : 8788;
      return { ok: true, baseUrl: `http://127.0.0.1:${port}`, server: { url: `http://127.0.0.1:${port}/` } };
    },
    servedTree: (dir) => ({ worktree: dir, branch: 'b', commit: 'c', line: dir === worktree ? 'here-tree' : 'ref-tree' }),
    runCapture: ({ worktree: ran, request }) => {
      captures.push({ ran, request });
      const side = request.base_url.endsWith('8787') ? 'here' : 'ref';
      return {
        ok: true,
        result: { ok: true, file: request.out, url: `${request.base_url}/app/assistant`, measure: measures[side], warnings: warnings[side] || [] },
      };
    },
  });
  return { code, stdout: stdout.text, stderr: stderr.text, captures, servers, worktree, refDir };
}

describe('mc shot dev --compare', () => {
  it('serves both trees, captures both with this tree\'s script, prints two paths then the diff', async () => {
    const result = await compare(['dev', 'assistant', '--viewport', 'iphone', '--measure', '@layout', '--compare', 'origin/main'], {
      measures: {
        ref: [CONTENT, FOOTER],
        here: [CONTENT, { ...FOOTER, rect: { ...FOOTER.rect, bottom: 776 } }],
      },
      warnings: { ref: ['2 elements match'] },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.servers, [result.worktree, result.refDir]);
    assert.match(result.stderr, /mc: here: serving here-tree/u);
    assert.match(result.stderr, /mc: origin\/main: serving ref-tree/u);
    assert.deepEqual(result.captures.map((item) => item.ran), [result.worktree, result.worktree], 'both run with this tree\'s script');
    const [here, ref] = result.captures.map((item) => item.request);
    assert.equal(here.sign_in.url, 'http://127.0.0.1:8787/dev/login?account=seeded&ready=1');
    assert.equal(ref.sign_in.url, 'http://127.0.0.1:8788/dev/login?account=seeded&ready=1');
    assert.equal(ref.measure, here.measure);
    assert.equal(ref.out, refOutPath(here.out, REF_SHA));
    assert.match(ref.out, /-bbbbbbb\.png$/u);
    const lines = result.stdout.trimEnd().split('\n');
    assert.deepEqual(lines, [
      here.out,
      ref.out,
      'diff  footer.assistant-layout__footer  rect.bottom  810 → 776',
      'mc: warning — ref: 2 elements match',
    ]);
  });

  it('says the numbers are the same when a measure was asked and nothing moved, and nothing without one', async () => {
    const same = await compare(['dev', 'assistant', '--measure', '@layout', '--compare', 'origin/main'], {
      measures: { ref: [FOOTER], here: [FOOTER] },
    });
    assert.equal(same.stdout.split('\n')[2], 'mc: the measured numbers are the same on both trees');
    const none = await compare(['dev', 'assistant', '--compare', 'origin/main']);
    assert.equal(none.stdout.trimEnd().split('\n').length, 2);
  });

  it('--json carries both results and the diff', async () => {
    const result = await compare(['dev', 'assistant', '--measure', '@layout', '--compare', 'origin/main', '--json'], {
      measures: { ref: [FOOTER], here: [{ ...FOOTER, visible: false }] },
    });
    assert.equal(result.code, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.here.served.line, 'here-tree');
    assert.equal(json.ref.ref, 'origin/main');
    assert.equal(json.ref.commit, REF_SHA);
    assert.equal(json.ref.result.served.line, 'ref-tree');
    assert.deepEqual(json.diff, [{ index: 0, element: FOOTER.element, field: 'visible', ref: true, here: false }]);
  });

  it('--compare with prod or with --out exits 2 before anything runs', async () => {
    for (const [argv, said] of [
      [['prod', 'assistant', '--compare', 'origin/main'], /--compare is for dev — production has one tree/u],
      [['dev', 'assistant', '--compare', 'origin/main', '--out', 'x.png'], /two files need two names/u],
    ]) {
      const result = await compare(argv);
      assert.equal(result.code, 2, argv.join(' '));
      assert.match(result.stderr, said);
      assert.deepEqual(result.servers, []);
      assert.deepEqual(result.captures, []);
    }
  });
});
